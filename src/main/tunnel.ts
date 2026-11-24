// Optional public HTTPS address for cloud-hosted agents (Grok Bot runs its
// connectors in the cloud, so it cannot reach 127.0.0.1). Default is a
// Cloudflare quick tunnel (no account; address changes on restart). A named
// tunnel (Cloudflare account + hostname in settings) keeps a fixed address.
// Tunnelled requests must carry the connector token (see server.ts).
//
// The tunnel process is started detached and remembered in tunnel.json, so if
// the app crashes or is restarted the same tunnel (and address) is picked up
// again. Quitting from the tray stops it. Unexpected death auto-restarts when
// the tunnel preference is still on.
import { app, safeStorage } from "electron";
import { execFileSync, spawn } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

const CANDIDATES = [
  path.join(process.env["ProgramFiles(x86)"] ?? "", "cloudflared", "cloudflared.exe"),
  path.join(process.env.ProgramFiles ?? "", "cloudflared", "cloudflared.exe"),
  path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WinGet", "Links", "cloudflared.exe"),
];

export function findCloudflared(): string | null {
  return CANDIDATES.find((p) => fs.existsSync(p)) ?? null;
}

const userFile = (name: string) => path.join(app.getPath("userData"), name);

// Quick tunnels and named tunnel hostnames (any https URL in the log / settings).
const URL_RE = /https:\/\/[a-z0-9.-]+(?::\d+)?/i;

export type AppSettings = {
  tunnel?: boolean;
  /** "quick" (default) or "named" for a fixed Cloudflare hostname. */
  tunnelMode?: "quick" | "named";
  /** Cloudflare named-tunnel name (from `cloudflared tunnel list`). */
  namedTunnelName?: string;
  /** Public hostname for a named tunnel, e.g. buddy.example.com (no scheme). */
  namedHostname?: string;
  startWithWindows?: boolean;
  /** Sounds on state changes. Default on. */
  sounds?: boolean;
  /** 0 to 1. Default 0.6. */
  volume?: number;
  /** Windows notifications when an agent needs you. Default on. */
  notifications?: boolean;
  /** Global keyboard shortcuts. Default on. */
  shortcuts?: boolean;
  /** Index of the monitor the notch sits on (0 = primary). */
  display?: number;
  /** Minutes a finished bot stays in the notch. Default 5. */
  lingerFinishedMin?: number;
  /** See-through and click-through while the cursor is on the notch. Default on. */
  glass?: boolean;
  /** Colour per agent, keyed by the normalised name ("claudecode": "#d97757"). */
  agentColours?: Record<string, string>;
  /** True once the quick start has been shown. */
  onboarded?: boolean;
};

function readSettings(): AppSettings {
  try {
    return JSON.parse(fs.readFileSync(userFile("settings.json"), "utf8")) as AppSettings;
  } catch {
    return {};
  }
}

function writeSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...readSettings(), ...patch };
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(userFile("settings.json"), JSON.stringify(next, null, 2));
  return next;
}

// ---------- Connector token (encrypted with Windows DPAPI) ----------
let cachedToken: string | null = null;
let tokenError: string | null = null;

export function getTokenError(): string | null {
  return tokenError;
}

function mintToken(): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Windows encryption is not available, so the connector token cannot be stored.");
  }
  const token = crypto.randomBytes(32).toString("base64url");
  const file = userFile("connector-token.bin");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, safeStorage.encryptString(token));
  cachedToken = token;
  tokenError = null;
  return token;
}

export function getConnectorToken(): string {
  // Tests only, and only in dev mode. A stray AGENT_BUDDY_TOKEN in a normal run
  // once made the tray copy a throwaway token into Grok Bot, which then got
  // 401s as soon as the app was restarted without it.
  if (process.env.AGENT_BUDDY_DEV === "1" && process.env.AGENT_BUDDY_TOKEN) return process.env.AGENT_BUDDY_TOKEN;
  if (cachedToken) return cachedToken;
  const file = userFile("connector-token.bin");
  if (!fs.existsSync(file)) {
    try {
      return mintToken();
    } catch (err) {
      tokenError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      tokenError = "Windows encryption is not available; cannot read the connector token.";
      throw new Error(tokenError);
    }
    cachedToken = safeStorage.decryptString(fs.readFileSync(file));
    tokenError = null;
    return cachedToken;
  } catch (err) {
    // Fail closed: never overwrite an existing token file on decrypt error.
    tokenError = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not read the connector token (${tokenError}). ` +
        "Fix Windows encryption or use Connect an agent → Rotate connector token."
    );
  }
}

/** Explicitly mint a new token. Caller must re-paste into Grok Bot. */
export function rotateConnectorToken(): string {
  cachedToken = null;
  tokenError = null;
  return mintToken();
}

// ---------- Settings ----------
export function loadTunnelEnabled(): boolean {
  return readSettings().tunnel === true;
}
export function saveTunnelEnabled(on: boolean): void {
  writeSettings({ tunnel: on });
}
export function loadAppSettings(): AppSettings {
  return readSettings();
}
export function saveAppSettings(patch: Partial<AppSettings>): AppSettings {
  return writeSettings(patch);
}
export function loadStartWithWindows(): boolean {
  return readSettings().startWithWindows === true;
}
export function saveStartWithWindows(on: boolean): void {
  writeSettings({ startWithWindows: on });
}

// ---------- Tunnel process ----------
export type TunnelStatus = {
  state: "off" | "starting" | "on" | "error";
  url: string | null;
  error?: string;
  adopted?: boolean;
  mode?: "quick" | "named";
};
type Saved = { pid: number; url: string };

function isCloudflaredAlive(pid: number): boolean {
  try {
    const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { windowsHide: true }).toString();
    return out.toLowerCase().includes("cloudflared");
  } catch {
    return false;
  }
}

function extractUrl(text: string): string | null {
  const m = URL_RE.exec(text);
  return m ? m[0].replace(/\/$/, "") : null;
}

export class Tunnel {
  private pid: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartAttempts = 0;
  private wantRunning = false;
  status: TunnelStatus = { state: "off", url: null };

  constructor(private port: number, private onChange: (s: TunnelStatus) => void) {}

  private set(s: TunnelStatus): void {
    this.status = s;
    this.onChange(s);
  }

  private clearTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private clearRestart(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private scheduleRestart(reason: string): void {
    if (!this.wantRunning || !loadTunnelEnabled()) return;
    this.clearRestart();
    const delay = Math.min(60_000, 2000 * Math.pow(2, this.restartAttempts));
    this.restartAttempts += 1;
    this.set({ state: "error", url: null, error: `${reason}; restarting in ${Math.round(delay / 1000)}s…` });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.wantRunning && loadTunnelEnabled()) this.start();
    }, delay);
  }

  /** Watches a running tunnel; auto-restarts if the process disappears while wanted. */
  private watch(pid: number): void {
    this.clearTimer();
    this.timer = setInterval(() => {
      if (this.pid !== pid || isCloudflaredAlive(pid)) return;
      this.clearTimer();
      this.pid = null;
      fs.rmSync(userFile("tunnel.json"), { force: true });
      this.scheduleRestart("tunnel stopped unexpectedly");
    }, 15000);
  }

  private namedPublicUrl(settings: AppSettings): string | null {
    const host = settings.namedHostname?.trim();
    if (!host) return null;
    return host.startsWith("http") ? host.replace(/\/$/, "") : `https://${host}`;
  }

  start(): void {
    this.wantRunning = true;
    this.clearRestart();
    if (this.pid !== null) return;

    const settings = readSettings();
    const mode: "quick" | "named" = settings.tunnelMode === "named" ? "named" : "quick";

    // Pick up a tunnel left running by a previous run of the app.
    try {
      const saved = JSON.parse(fs.readFileSync(userFile("tunnel.json"), "utf8")) as Saved;
      if (Number.isInteger(saved.pid) && extractUrl(saved.url) && isCloudflaredAlive(saved.pid)) {
        this.pid = saved.pid;
        this.restartAttempts = 0;
        this.set({ state: "on", url: saved.url, adopted: true, mode });
        this.watch(saved.pid);
        return;
      }
    } catch { /* no saved tunnel */ }

    const exe = findCloudflared();
    if (!exe) return this.set({ state: "error", url: null, error: "cloudflared is not installed", mode });

    if (mode === "named") {
      const name = settings.namedTunnelName?.trim();
      const publicUrl = this.namedPublicUrl(settings);
      if (!name || !publicUrl) {
        return this.set({
          state: "error",
          url: null,
          error: "named tunnel needs namedTunnelName and namedHostname in settings.json",
          mode,
        });
      }
      this.set({ state: "starting", url: null, mode });
      const proc = spawn(exe, ["tunnel", "--no-autoupdate", "run", name], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      proc.on("error", (err) => {
        this.pid = null;
        this.clearTimer();
        this.scheduleRestart(err.message);
      });
      proc.unref();
      const pid = proc.pid;
      if (pid === undefined) return;
      this.pid = pid;
      fs.writeFileSync(userFile("tunnel.json"), JSON.stringify({ pid, url: publicUrl } satisfies Saved));
      this.restartAttempts = 0;
      this.set({ state: "on", url: publicUrl, mode });
      this.watch(pid);
      return;
    }

    this.set({ state: "starting", url: null, mode: "quick" });

    const logFile = userFile("cloudflared.log");
    fs.rmSync(logFile, { force: true });
    const proc = spawn(exe, ["tunnel", "--no-autoupdate", "--logfile", logFile, "--url", `http://127.0.0.1:${this.port}`], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    proc.on("error", (err) => {
      this.pid = null;
      this.clearTimer();
      this.scheduleRestart(err.message);
    });
    proc.unref();
    const pid = proc.pid;
    if (pid === undefined) return;
    this.pid = pid;

    // The public address appears in the log a few seconds after start.
    let tries = 0;
    this.clearTimer();
    this.timer = setInterval(() => {
      if (this.pid !== pid) return;
      let log = "";
      try { log = fs.readFileSync(logFile, "utf8"); } catch { /* not written yet */ }
      const found = extractUrl(log);
      // Prefer trycloudflare.com when present in the log.
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(log);
      const url = m?.[0] ?? found;
      if (url && /trycloudflare\.com/i.test(url)) {
        fs.writeFileSync(userFile("tunnel.json"), JSON.stringify({ pid, url } satisfies Saved));
        this.restartAttempts = 0;
        this.set({ state: "on", url, mode: "quick" });
        this.watch(pid);
      } else if (++tries > 120) {
        this.pid = null;
        this.clearTimer();
        try { process.kill(pid); } catch { /* already gone */ }
        fs.rmSync(userFile("tunnel.json"), { force: true });
        this.scheduleRestart("no public address after 60 s");
      }
    }, 500);
  }

  stop(): void {
    this.wantRunning = false;
    this.clearRestart();
    this.restartAttempts = 0;
    const pid = this.pid;
    this.pid = null;
    this.clearTimer();
    fs.rmSync(userFile("tunnel.json"), { force: true });
    this.set({ state: "off", url: null });
    if (pid !== null) { try { process.kill(pid); } catch { /* already gone */ } }
  }
}
