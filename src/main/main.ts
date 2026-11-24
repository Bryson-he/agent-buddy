import { app, BrowserWindow, Menu, Notification, Tray, clipboard, dialog, globalShortcut, nativeImage, screen, ipcMain, shell } from "electron";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { AskUserArgs, AskUserResult, AskWait, BuddyBackend } from "../mcp/tools.js";
import { BUDDY_PORT, startBuddyServer } from "./server.js";
import { pickModel, runGrokChat, type ChatMessage } from "./grok.js";
import { clearApiKey, getApiKey, saveApiKey } from "./keystore.js";
import { formatActivityPeek } from "./activity.js";
import { historySnapshot, recordHistory, seedHistoryFromLog, type HistoryKind } from "./history.js";
import {
  Tunnel,
  getConnectorToken,
  getTokenError,
  loadTunnelEnabled,
  saveTunnelEnabled,
  loadStartWithWindows,
  saveStartWithWindows,
  loadAppSettings,
  saveAppSettings,
  type AppSettings,
  rotateConnectorToken,
} from "./tunnel.js";

// Overlay: a small "pill" docked to the top-centre of the primary display,
// the Windows stand-in for the Mac notch from the case study.
// One data folder whether the app is run from the project or installed. The
// installed app is called "Agent Buddy" and would otherwise get its own folder,
// losing the connector token (and with it the link to Grok Bot), settings and rules.
// Snapshot mode (pictures for the docs) uses a throwaway folder, so the pictures
// never show the owner's real bots, rules or settings.
const SNAPSHOT_MODE = process.argv.some((a) => a.startsWith("--snapshot-dir=") || a.startsWith("--record-dir="));
app.setPath("userData", SNAPSHOT_MODE
  ? path.join(app.getPath("temp"), "agent-buddy-snapshots")
  : path.join(app.getPath("appData"), "agent-buddy"));

/** Files that outside programs must run (the hook scripts) cannot live inside the packed app archive. */
function resourcePath(...parts: string[]): string {
  const root = path.join(__dirname, "..", "..");
  return path.join(app.isPackaged ? root.replace(/app\.asar$/, "app.asar.unpacked") : root, ...parts);
}

/** Sets or clears the Windows start-up entry for whichever copy is running. */
function setStartWithWindows(on: boolean): void {
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: on });
  else app.setLoginItemSettings({ openAtLogin: on, path: process.execPath, args: [path.join(__dirname, "..", "..")] });
}

const OVERLAY_WIDTH = 420;
const OVERLAY_HEIGHT = 400; // room for a question with four choices
const DEFAULT_AGENT = "Agent Buddy";
const CURSOR_NEAR_PX = 80;
const CURSOR_MOVE_MIN = 2;

type AgentState = "idle" | "greeting" | "working" | "needsYou" | "error" | "finished" | "upload";
type Reaction = "annoyed" | "slap" | "dizzy";
type Rect = { x: number; y: number; width: number; height: number };

let overlay: BrowserWindow | null = null;
let tray: Tray | null = null;
let pillRect: Rect = { x: 0, y: 0, width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT };
let interactive = true;
let demoTimers: NodeJS.Timeout[] = [];
let activityLogPath = "";
let grokBusy = false;
let grokAbort: AbortController | null = null;

// ---------- Window ----------
function topCentre(): { x: number; y: number } {
  const { bounds } = notchDisplay();
  return { x: Math.round(bounds.x + (bounds.width - OVERLAY_WIDTH) / 2), y: bounds.y };
}

/** Monitors in a stable order: the primary first, then left to right. */
function orderedDisplays(): Electron.Display[] {
  const primary = screen.getPrimaryDisplay();
  const rest = screen.getAllDisplays().filter((d) => d.id !== primary.id).sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
  return [primary, ...rest];
}
function notchDisplay(): Electron.Display {
  const all = orderedDisplays();
  return all[loadAppSettings().display ?? 0] ?? all[0];
}

// ---------- Settings window ----------
let settingsWin: BrowserWindow | null = null;

function settingsView() {
  return {
    settings: loadAppSettings(),
    displays: orderedDisplays().map((d, index) => ({
      index,
      label: `${index === 0 ? "Main screen" : `Screen ${index + 1}`} (${d.bounds.width} × ${d.bounds.height})`,
    })),
    shortcutKeys: { first: "Ctrl+Alt+Y", second: "Ctrl+Alt+N", toggle: "Ctrl+Alt+B", panel: "Ctrl+Alt+H" },
    rules: loadRules(),
    agents: knownAgents(),
  };
}

/** Every agent seen so far, plus any that has a colour set, for the colour pickers in Settings. */
function knownAgents(): { key: string; name: string }[] {
  const out = new Map<string, string>();
  for (const b of historySnapshot()) out.set(agentKey(b.name), b.name);
  for (const key of Object.keys(loadAppSettings().agentColours ?? {})) if (!out.has(key)) out.set(key, key);
  out.delete(agentKey(DEFAULT_AGENT));
  return [...out].map(([key, name]) => ({ key, name })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Sends the settings the notch page cares about (sounds, volume, how long bots linger, quiet mode). */
function pushSettings(): void {
  if (!overlay || overlay.isDestroyed()) return;
  const s = loadAppSettings();
  overlay.webContents.send("buddy:settings", { sounds: s.sounds, volume: s.volume, lingerFinishedMin: s.lingerFinishedMin, glass: s.glass, colours: s.agentColours ?? {}, quiet: dndOn() });
}

// ---------- Do not disturb ----------
// No sounds, no notifications, and the notch stays small. Questions still show
// on the notch, quietly. When it ends, one notification sums up what happened.
// Not saved: a restart turns it off.
let dndUntil = 0; // 0 = off, Infinity = until turned off
let dndTimer: NodeJS.Timeout | null = null;
const dndTally = { finished: 0, errors: 0, questions: 0 };
const dndOn = () => dndUntil > Date.now();

function setDnd(minutes: number | "forever" | "off"): void {
  const wasOn = dndOn();
  if (dndTimer) clearTimeout(dndTimer);
  dndTimer = null;
  if (minutes === "off") dndUntil = 0;
  else if (minutes === "forever") dndUntil = Infinity;
  else {
    dndUntil = Date.now() + minutes * 60_000;
    dndTimer = setTimeout(() => setDnd("off"), minutes * 60_000);
  }
  if (wasOn && !dndOn()) {
    const parts = [
      dndTally.finished ? `${dndTally.finished} finished` : "",
      dndTally.errors ? `${dndTally.errors} error${dndTally.errors === 1 ? "" : "s"}` : "",
      dndTally.questions ? `${dndTally.questions} question${dndTally.questions === 1 ? "" : "s"} asked` : "",
    ].filter(Boolean);
    if (parts.length > 0 && Notification.isSupported() && loadAppSettings().notifications !== false) {
      new Notification({ title: "While do not disturb was on", body: parts.join(", ") }).show();
    }
  }
  if (!wasOn || !dndOn()) { dndTally.finished = 0; dndTally.errors = 0; dndTally.questions = 0; }
  tray?.setToolTip(dndOn() ? "Agent Buddy (do not disturb)" : "Agent Buddy");
  pushSettings();
  refreshTrayMenu();
}

function dndLabel(): string {
  if (!dndOn()) return "Do not disturb";
  if (dndUntil === Infinity) return "Do not disturb: on";
  return `Do not disturb: until ${new Date(dndUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

/** Saves only known settings with sane values, then applies them straight away. */
function applySettings(patch: unknown): void {
  if (!patch || typeof patch !== "object") return;
  const p = patch as Record<string, unknown>;
  const clean: Partial<AppSettings> = {};
  for (const key of ["sounds", "notifications", "shortcuts", "startWithWindows", "glass", "onboarded"] as const) {
    if (typeof p[key] === "boolean") clean[key] = p[key];
  }
  if (typeof p.volume === "number" && Number.isFinite(p.volume)) clean.volume = Math.min(1, Math.max(0, p.volume));
  if (typeof p.display === "number" && Number.isInteger(p.display) && p.display >= 0 && p.display < 16) clean.display = p.display;
  if (typeof p.lingerFinishedMin === "number" && [1, 5, 15, 60].includes(p.lingerFinishedMin)) clean.lingerFinishedMin = p.lingerFinishedMin;
  // Colour per agent: { key: "#rrggbb" } sets one, { key: null } goes back to the built-in colour.
  if (p.agentColours && typeof p.agentColours === "object") {
    const colours = { ...(loadAppSettings().agentColours ?? {}) };
    for (const [k, v] of Object.entries(p.agentColours as Record<string, unknown>)) {
      if (!/^[a-z0-9]{1,40}$/.test(k)) continue;
      if (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v)) colours[k] = v.toLowerCase();
      else if (v === null) delete colours[k];
    }
    if (Object.keys(colours).length <= 60) clean.agentColours = colours;
  }
  if (Object.keys(clean).length === 0) return;

  saveAppSettings(clean);
  if (clean.agentColours !== undefined && panelWin && !panelWin.isDestroyed()) panelWin.webContents.reload();
  if (clean.startWithWindows !== undefined) applyStartWithWindows(clean.startWithWindows);
  if (clean.display !== undefined) resetOverlayPosition();
  if (clean.shortcuts !== undefined) { syncToggleShortcut(); syncAnswerShortcuts(); }
  pushSettings();
  refreshTrayMenu();
}

function openSettings(): BrowserWindow {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return settingsWin; }
  settingsWin = new BrowserWindow({
    width: 480,
    height: 760,
    title: "Settings · Agent Buddy",
    backgroundColor: "#111216",
    autoHideMenuBar: true,
    resizable: false,
    maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "settings-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWin.loadFile(path.join(__dirname, "..", "..", "renderer", "settings.html"));
  settingsWin.on("closed", () => { settingsWin = null; });
  return settingsWin;
}

function registerSettingsIpc(): void {
  ipcMain.handle("settings:get", () => settingsView());
  ipcMain.handle("settings:set", (_e, patch: unknown) => { applySettings(patch); return settingsView(); });
  ipcMain.handle("settings:forget-rule", (_e, agent: unknown, question: unknown) => {
    if (typeof agent === "string" && typeof question === "string") {
      saveRules(loadRules().filter((r) => !(r.agent === agent && r.question === question)));
    }
    return settingsView();
  });
  ipcMain.on("settings:test-sound", (_e, name: unknown) => {
    if (typeof name === "string" && /^[a-zA-Z]{1,20}$/.test(name)) overlay?.webContents.send("buddy:play-sound", name);
  });
}

function resetOverlayPosition(): void {
  if (!overlay || overlay.isDestroyed()) return;
  const { x, y } = topCentre();
  overlay.setPosition(x, y);
}

function createOverlay(): BrowserWindow {
  const win = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
    ...topCentre(),
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    focusable: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.setAlwaysOnTop(true, "screen-saver");
  win.loadFile(path.join(__dirname, "..", "..", "renderer", "index.html"));
  win.once("ready-to-show", () => win.showInactive());
  win.webContents.on("did-finish-load", () => pushSettings());
  // Dev mode: keep the notch page's console output and errors in a file, for debugging.
  if (process.env.AGENT_BUDDY_DEV === "1") {
    const consoleLog = path.join(app.getPath("userData"), "renderer-console.log");
    win.webContents.on("console-message", (_e, level, message, line, source) => {
      try { fs.appendFileSync(consoleLog, `${new Date().toISOString()} [${level}] ${message} (${path.basename(source)}:${line})\n`); } catch { /* ignore */ }
    });
  }
  win.on("closed", () => { overlay = null; });
  if (process.argv.includes("--dev")) win.webContents.openDevTools({ mode: "detach" });
  return win;
}

function setInteractive(on: boolean): void {
  if (!overlay || overlay.isDestroyed() || on === interactive) return;
  interactive = on;
  overlay.setIgnoreMouseEvents(!on, { forward: true });
}

// Polls the global cursor so the eyes follow it anywhere on screen.
// Throttled: only send when moved enough, or when near the overlay.
let lastCursor = { x: NaN, y: NaN };
let lastSentCursor = { x: NaN, y: NaN };
function startCursorPolling(): void {
  setInterval(() => {
    if (!overlay || overlay.isDestroyed() || !overlay.isVisible()) return;
    const p = screen.getCursorScreenPoint();
    const b = overlay.getBounds();
    const x = p.x - b.x;
    const y = p.y - b.y;
    lastCursor = { x, y };

    const pad = 3; // match renderer face pad
    const inside =
      x >= pillRect.x - pad && x <= pillRect.x + pillRect.width + pad &&
      y >= pillRect.y - pad && y <= pillRect.y + pillRect.height + pad;
    const near =
      x >= -CURSOR_NEAR_PX && x <= OVERLAY_WIDTH + CURSOR_NEAR_PX &&
      y >= -CURSOR_NEAR_PX && y <= OVERLAY_HEIGHT + CURSOR_NEAR_PX;
    const moved =
      !Number.isFinite(lastSentCursor.x) ||
      Math.hypot(x - lastSentCursor.x, y - lastSentCursor.y) >= CURSOR_MOVE_MIN;

    if ((near || inside) && moved) {
      lastSentCursor = { x, y };
      overlay.webContents.send("buddy:cursor", { x, y });
    }
    if (!inside) setInteractive(false);
  }, 33);
}

// ---------- State API ----------
function setState(
  state: AgentState,
  text?: string,
  agent?: string,
  options?: string[],
  next?: string,
  ask?: { input?: boolean; canRemember?: boolean; list?: boolean; other?: boolean },
): void {
  overlay?.webContents.send("buddy:state", { state, text, agent, options, next, input: ask?.input === true, canRemember: ask?.canRemember === true, list: ask?.list === true, other: ask?.other === true });
}

// ---------- Activity panel ----------
let panelWin: BrowserWindow | null = null;

/** Notes a step in the history and refreshes the panel if it is open. */
function note(agent: string, kind: HistoryKind, text: string): void {
  recordHistory(agent, kind, text);
  if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send("panel:update", historySnapshot());
}

function openPanel(): BrowserWindow {
  if (panelWin && !panelWin.isDestroyed()) { panelWin.show(); panelWin.focus(); return panelWin; }
  const { bounds } = notchDisplay();
  const width = 400;
  panelWin = new BrowserWindow({
    width,
    height: 620,
    x: Math.round(bounds.x + (bounds.width - width) / 2),
    y: bounds.y + 96,
    title: "Activity · Agent Buddy",
    backgroundColor: "#111216",
    autoHideMenuBar: true,
    maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "panel-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  panelWin.loadFile(path.join(__dirname, "..", "..", "renderer", "panel.html"));
  panelWin.on("closed", () => { panelWin = null; });
  return panelWin;
}

// ---------- Remembered answers ("Always") ----------
// A rule is one bot + one exact question (ignoring case and spacing) + the
// answer to give. Listed, and removable, in Settings.
type Rule = { agent: string; question: string; answer: string; at: number };
const rulesFile = () => path.join(app.getPath("userData"), "rules.json");
const normalise = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

function loadRules(): Rule[] {
  try {
    const raw = JSON.parse(fs.readFileSync(rulesFile(), "utf8")) as unknown;
    return Array.isArray(raw) ? raw.filter((r): r is Rule => !!r && typeof r.agent === "string" && typeof r.question === "string" && typeof r.answer === "string") : [];
  } catch {
    return [];
  }
}
function saveRules(rules: Rule[]): void {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(rulesFile(), JSON.stringify(rules.slice(-200), null, 2));
}
function findRule(agent: string, question: string): Rule | undefined {
  const a = normalise(agent);
  const q = normalise(question);
  return loadRules().find((r) => r.agent === a && r.question === q);
}
function rememberAnswer(agent: string, question: string, answer: string): void {
  const a = normalise(agent);
  const q = normalise(question);
  saveRules([...loadRules().filter((r) => !(r.agent === a && r.question === q)), { agent: a, question: q, answer, at: Date.now() }]);
}

function agentKey(name?: string): string {
  return (name?.trim() || DEFAULT_AGENT);
}

// ---------- Backend shared by the MCP connector and the Ask Grok chat ----------
//
// Questions are shown one at a time. If a second agent asks while one is on
// screen, it waits its turn (up to MAX_QUEUED). An ask's timeout covers its
// whole wait, queue included, so no caller waits longer than it asked to.
type Ask = {
  agent: string;
  question: string;
  options: string[]; // two to four answers
  list: boolean;     // shown as a lettered list (more than two answers, or long ones) instead of two buttons
  allowOther: boolean; // the list ends with "Something else", which takes a typed answer
  freeText: boolean; // the user types an answer instead of choosing
  deadline: number;
  nonce: string; // one-time code that notification buttons must echo back
  /** The request waiting for the answer. Null while the question is up but its request has gone back as "pending". */
  resolve: ((r: AskUserResult) => void) | null;
  timer?: NodeJS.Timeout;
  detachTimer?: NodeJS.Timeout;
  toast?: Notification;
};
/** Labels this long or longer do not fit a button, so the question becomes a list. */
const BUTTON_LABEL_MAX = 24;

// An answer given while no request was waiting for it (the agent's request had
// gone back as "pending"). Handed over when the agent asks the same question again.
const parkedAnswers = new Map<string, { answer: string | null; at: number }>();
const PARKED_KEEP_MS = 15 * 60_000;
const askKey = (agent: string, question: string) => `${agent}|${normalise(question)}`;

/** Gives the answer to whoever is waiting, or keeps it for when the agent asks again. */
function deliver(q: Ask, r: AskUserResult): void {
  clearTimeout(q.detachTimer);
  if (q.resolve) q.resolve(r);
  else parkedAnswers.set(askKey(q.agent, q.question), { answer: r.answer, at: Date.now() });
  q.resolve = null;
}

/** Hands the request back as "pending" after a while, leaving the question where it is. */
function armDetach(q: Ask, wait?: AskWait): void {
  clearTimeout(q.detachTimer);
  if (!wait?.detachAfterSec) return;
  q.detachTimer = setTimeout(() => {
    if (!q.resolve) return;
    q.resolve({ answer: null, pending: true });
    q.resolve = null;
  }, wait.detachAfterSec * 1000);
}
const MAX_QUEUED = 5;
const askQueue: Ask[] = [];
let currentAsk: Ask | null = null;

const xmlEscape = (s: string) =>
  s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);

/** A Windows toast with the answers as buttons. Each button opens an agentbuddy:// link. */
function askToastXml(q: Ask): string {
  const link = (choice: number) => xmlEscape(`${PROTOCOL}://answer/${choice}?n=${q.nonce}`);
  return (
    `<toast scenario="reminder" activationType="protocol" launch="${PROTOCOL}://show">` +
    `<visual><binding template="ToastGeneric">` +
    `<text>${xmlEscape(`${q.agent} needs you`)}</text><text>${xmlEscape(q.question.slice(0, 200))}</text>` +
    `</binding></visual>` +
    // A typed answer has to be given on the notch, so that toast has no buttons.
    (q.freeText
      ? ""
      : `<actions>` +
        q.options.map((o, i) => `<action content="${xmlEscape(o)}" activationType="protocol" arguments="${link(i)}"/>`).join("") +
        `</actions>`) +
    `</toast>`
  );
}

function presentAsk(q: Ask): void {
  currentAsk = q;
  stopDemo();
  setState("needsYou", q.question, q.agent, q.options, undefined, { input: q.freeText, canRemember: !q.freeText && !q.list, list: q.list, other: q.allowOther });
  note(q.agent, "needsYou", q.question);
  overlay?.showInactive();
  if (dndOn()) dndTally.questions += 1;
  if (!dndOn() && Notification.isSupported() && loadAppSettings().notifications !== false) {
    try {
      q.toast = new Notification({ toastXml: askToastXml(q) });
      q.toast.on("click", () => overlay?.showInactive());
      q.toast.show();
    } catch { /* the notch still shows the question */ }
  }
  q.timer = setTimeout(() => settleAsk(q, null), Math.max(0, q.deadline - Date.now()));
  syncAnswerShortcuts();
}

/** Ends the question on screen (label = the user's answer, null = timed out) and shows the next. */
function settleAsk(q: Ask, label: string | null): void {
  if (currentAsk !== q) return;
  clearTimeout(q.timer);
  try { q.toast?.close(); } catch { /* already gone */ }
  currentAsk = null;
  if (label === null) {
    setState("idle", "Question timed out (no answer)", q.agent);
    note(q.agent, "timedOut", "No answer in time");
    deliver(q, { answer: null, timedOut: true });
  } else {
    const typed = q.freeText || !q.options.includes(label);
    const shown = typed ? `You answered: ${label.slice(0, 60)}` : `You chose "${label.slice(0, 60)}"`;
    setState("working", shown, q.agent);
    note(q.agent, "answered", shown);
    deliver(q, { answer: label, timedOut: false });
  }
  showNextAsk();
}

function showNextAsk(): void {
  while (askQueue.length > 0) {
    const q = askQueue.shift()!;
    clearTimeout(q.timer);
    if (q.deadline - Date.now() < 3000) { // too late to be answered
      setState("idle", "Question timed out (no answer)", q.agent);
      deliver(q, { answer: null, timedOut: true });
      continue;
    }
    presentAsk(q);
    return;
  }
  syncAnswerShortcuts();
}

function askUserQueued(a: AskUserArgs, wait?: AskWait): Promise<AskUserResult> {
  return new Promise((resolve) => {
    const agent = agentKey(a.agent);
    const freeText = a.free_text === true;
    // The same question asked again: the agent is still waiting for an answer it was told was pending.
    const key = askKey(agent, a.question);
    for (const [k, v] of parkedAnswers) if (Date.now() - v.at > PARKED_KEEP_MS) parkedAnswers.delete(k);
    const parked = parkedAnswers.get(key);
    if (parked) {
      parkedAnswers.delete(key);
      return resolve({ answer: parked.answer, timedOut: parked.answer === null });
    }
    const open = [currentAsk, ...askQueue].find((x) => x && !x.resolve && askKey(x.agent, x.question) === key);
    if (open) {
      open.resolve = resolve;
      return armDetach(open, wait);
    }
    // An answer the user asked to be remembered is given at once, without showing the question.
    const rule = freeText ? undefined : findRule(agent, a.question);
    if (rule) {
      const shown = `Auto-answered "${rule.answer}" (remembered)`;
      setState("working", shown, agent);
      note(agent, "answered", `${shown}: ${a.question.slice(0, 80)}`);
      return resolve({ answer: rule.answer, timedOut: false });
    }
    if (askQueue.length >= MAX_QUEUED) return resolve({ answer: null, busy: true });
    const options = a.options && a.options.length >= 2 ? a.options.slice(0, 4) : ["Approve", "Deny"];
    const allowOther = a.allow_other === true && !freeText;
    const q: Ask = {
      agent,
      question: a.question,
      options,
      list: !freeText && (options.length > 2 || allowOther || options.some((o) => o.length > BUTTON_LABEL_MAX)),
      allowOther,
      freeText,
      deadline: Date.now() + (a.timeout_sec ?? 120) * 1000,
      nonce: crypto.randomBytes(12).toString("hex"),
      resolve,
    };
    armDetach(q, wait);
    if (!currentAsk) return presentAsk(q);
    // Wait in line; give up when its own time runs out.
    askQueue.push(q);
    setState("working", "Waiting to ask you something…", q.agent);
    q.timer = setTimeout(() => {
      const i = askQueue.indexOf(q);
      if (i < 0) return;
      askQueue.splice(i, 1);
      setState("idle", "Question timed out (no answer)", q.agent);
      deliver(q, { answer: null, timedOut: true });
    }, Math.max(0, q.deadline - Date.now()));
  });
}

/** Answers the question on screen. A nonce, when given, must match (notification buttons). */
function answerCurrent(choice: number, nonce?: string, remember = false): boolean {
  const q = currentAsk;
  if (!q || q.freeText || (nonce !== undefined && nonce !== q.nonce)) return false;
  if (!Number.isInteger(choice) || choice < 0 || choice >= q.options.length) return false;
  if (remember && !q.list) rememberAnswer(q.agent, q.question, q.options[choice]);
  settleAsk(q, q.options[choice]);
  return true;
}

/** Answers a question that asked for typed text. */
function answerWithText(text: string): boolean {
  const q = currentAsk;
  const clean = text.replace(/\s+/g, " ").trim().slice(0, 500);
  if (!q || !(q.freeText || q.allowOther) || clean.length === 0) return false;
  settleAsk(q, clean);
  return true;
}

const hasOpenAsk = (agent: string) => currentAsk?.agent === agent || askQueue.some((q) => q.agent === agent);

const backend: BuddyBackend = {
  async setStatus({ state, message, agent, next }) {
    stopDemo();
    const key = agentKey(agent);
    // A bot's own status must not replace its question while that is still
    // waiting for the user; other bots keep updating their own line.
    if (hasOpenAsk(key)) return;
    if (dndOn()) {
      if (state === "finished") dndTally.finished += 1;
      else if (state === "error") dndTally.errors += 1;
    }
    setState(state, message, key, undefined, next);
    note(key, state, message ?? "");
    if (overlay && !overlay.isDestroyed() && !overlay.isVisible()) overlay.showInactive();
  },
  askUser: (a, wait) => askUserQueued(a, wait),
};

// ---------- Answering without the mouse ----------
// Ctrl+Alt+Y / Ctrl+Alt+N answer the question on screen. They are registered
// only while a question is showing, so they never steal keys otherwise.
// Ctrl+Alt+B shows or hides the notch.
const KEY_FIRST = "Control+Alt+Y";
const KEY_SECOND = "Control+Alt+N";
const KEY_TOGGLE = "Control+Alt+B";
const KEY_PANEL = "Control+Alt+H";
let answerKeysFor = ""; // the question the answer keys are registered for

function syncAnswerShortcuts(): void {
  // Not for typed answers: there is nothing a single key could choose.
  const want = currentAsk !== null && !currentAsk.freeText && loadAppSettings().shortcuts !== false;
  // Which keys are wanted depends on the question, so compare the question too.
  const sig = want && currentAsk ? currentAsk.nonce : "";
  if (sig === answerKeysFor) return;
  answerKeysFor = sig;
  // A list is answered by number (Ctrl+Alt+1 to 4); two buttons by Y and N.
  const digits = [1, 2, 3, 4].map((n) => `Control+Alt+${n}`);
  for (const k of [KEY_FIRST, KEY_SECOND, ...digits]) globalShortcut.unregister(k);
  if (!want || !currentAsk) return;
  if (currentAsk.list) {
    currentAsk.options.forEach((_o, i) => globalShortcut.register(digits[i], () => { answerCurrent(i); }));
  } else {
    globalShortcut.register(KEY_FIRST, () => { answerCurrent(0); });
    globalShortcut.register(KEY_SECOND, () => { answerCurrent(1); });
  }
}

function toggleOverlay(): void {
  if (!overlay || overlay.isDestroyed()) return;
  if (overlay.isVisible()) overlay.hide(); else overlay.showInactive();
}

function syncToggleShortcut(): void {
  globalShortcut.unregister(KEY_TOGGLE);
  globalShortcut.unregister(KEY_PANEL);
  if (loadAppSettings().shortcuts === false) return;
  globalShortcut.register(KEY_TOGGLE, toggleOverlay);
  globalShortcut.register(KEY_PANEL, () => { openPanel(); });
}

// ---------- agentbuddy:// links (used by notification buttons) ----------
const PROTOCOL = "agentbuddy";

function handleProtocolUrl(raw: string): void {
  let url: URL;
  try { url = new URL(raw); } catch { return; }
  if (url.protocol !== `${PROTOCOL}:`) return;
  if (url.hostname === "answer") {
    const choice = /^\/[0-3]$/.test(url.pathname) ? Number(url.pathname.slice(1)) : null;
    const nonce = url.searchParams.get("n") ?? "";
    // The one-time code means a link from a web page or another app cannot answer for the user.
    if (choice !== null && nonce.length > 0) answerCurrent(choice, nonce);
    return;
  }
  overlay?.showInactive();
}

// ---------- Ask Grok window (Route B: xAI API) ----------
let chatWin: BrowserWindow | null = null;
let grokModel: string | null = null;

function openChat(): void {
  if (chatWin && !chatWin.isDestroyed()) { chatWin.show(); chatWin.focus(); return; }
  chatWin = new BrowserWindow({
    width: 440,
    height: 600,
    title: "Ask Grok · Agent Buddy",
    backgroundColor: "#111216",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "chat-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  chatWin.loadFile(path.join(__dirname, "..", "..", "renderer", "chat.html"));
  chatWin.on("closed", () => { chatWin = null; grokAbort?.abort(); grokAbort = null; grokBusy = false; });
}

const chatMessageSchema = (msgs: unknown): msgs is ChatMessage[] =>
  Array.isArray(msgs) &&
  msgs.every(
    (m) =>
      m &&
      typeof m === "object" &&
      (m.role === "user" || m.role === "assistant") &&
      typeof m.content === "string"
  );

function registerGrokIpc(): void {
  ipcMain.handle("grok:has-key", () => getApiKey() !== null);
  ipcMain.handle("grok:clear-key", () => { clearApiKey(); grokModel = null; });
  ipcMain.handle("grok:save-key", async (_e, key: string) => {
    try {
      const model = await pickModel(String(key).trim());
      saveApiKey(String(key).trim());
      grokModel = model;
      return { ok: true, model };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle("grok:cancel", () => {
    grokAbort?.abort();
    grokAbort = null;
    grokBusy = false;
    return { ok: true };
  });
  ipcMain.handle("grok:chat", async (_e, messages: unknown) => {
    if (grokBusy) return { error: "Grok is already answering. Wait or cancel." };
    if (!chatMessageSchema(messages)) return { error: "Invalid chat messages." };
    const apiKey = getApiKey();
    if (!apiKey) return { error: "No xAI API key saved yet." };
    grokBusy = true;
    grokAbort = new AbortController();
    const signal = grokAbort.signal;
    try {
      grokModel ??= await pickModel(apiKey);
      await backend.setStatus({ state: "working", message: "Grok is thinking…", agent: "Grok" });
      const result = await runGrokChat({
        apiKey,
        model: grokModel,
        messages,
        backend,
        signal,
      });
      if (signal.aborted) {
        await backend.setStatus({ state: "idle", message: "Cancelled", agent: "Grok" });
        return { error: "Cancelled." };
      }
      await backend.setStatus({ state: "finished", message: "Grok replied", agent: "Grok" });
      return result;
    } catch (err) {
      if (signal.aborted) {
        await backend.setStatus({ state: "idle", message: "Cancelled", agent: "Grok" });
        return { error: "Cancelled." };
      }
      const message = err instanceof Error ? err.message : String(err);
      await backend.setStatus({ state: "error", message: message.slice(0, 80), agent: "Grok" });
      return { error: message };
    } finally {
      grokBusy = false;
      grokAbort = null;
    }
  });
}

// ---------- Connector configs ----------
function stdioConfig(): string {
  const bridge = path.join(__dirname, "..", "mcp", "stdio-bridge.js");
  return JSON.stringify(
    { mcpServers: { "agent-buddy": { command: process.execPath, args: [bridge], env: { ELECTRON_RUN_AS_NODE: "1" } } } },
    null,
    2
  );
}
function httpConfig(): string {
  return JSON.stringify({ mcpServers: { "agent-buddy": { url: `http://127.0.0.1:${BUDDY_PORT}/mcp` } } }, null, 2);
}

function skillText(botName: string): string {
  const templatePath = path.join(__dirname, "..", "..", "docs", "skill-agent-buddy.md");
  let text: string;
  try {
    text = fs.readFileSync(templatePath, "utf8");
  } catch {
    text = "Always use agent \"BOTNAME\" with the agent-buddy connector (set_status / ask_user).";
  }
  return text.replace(/BOTNAME/g, botName);
}

function cursorHooksConfig(): string {
  const hooksDir = resourcePath("connectors", "cursor", "hooks");
  const toCmd = (name: string) =>
    process.platform === "win32"
      ? `node "${path.join(hooksDir, name)}"`
      : `node "${path.join(hooksDir, name)}"`;
  return JSON.stringify(
    {
      version: 1,
      hooks: {
        beforeShellExecution: [{ command: toCmd("before-shell.mjs"), failClosed: false }],
        afterFileEdit: [{ command: toCmd("after-edit.mjs") }],
        stop: [{ command: toCmd("stop.mjs") }],
      },
    },
    null,
    2
  );
}

/** The hooks block for Claude Code's settings.json (user-wide: %USERPROFILE%\.claude\settings.json). */
function claudeHooksConfig(): string {
  const cmd = (name: string) => `node "${resourcePath("connectors", "claude-code", "hooks", name).replace(/\\/g, "/")}"`;
  const matcher = "Bash|PowerShell|Edit|Write";
  return JSON.stringify(
    {
      hooks: {
        // The timeout is longer than the 120 s a question waits, so a slow answer is not cut off.
        PreToolUse: [{ matcher, hooks: [{ type: "command", command: cmd("pre-tool.mjs"), timeout: 130 }] }],
        PostToolUse: [{ matcher, hooks: [{ type: "command", command: cmd("post-tool.mjs") }] }],
        Stop: [{ hooks: [{ type: "command", command: cmd("stop.mjs") }] }],
      },
    },
    null,
    2
  );
}

/** A prompt the owner can paste into Claude Code or Cursor so it wires itself up to Agent Buddy. */
function aiSetupPrompt(): string {
  return [
    "Please connect yourself to Agent Buddy, a small desktop companion already running on this Windows PC. It shows what you are doing in a notch at the top of my screen and asks me before risky commands.",
    "",
    "Rules",
    "- Only edit the two files named below. Back each one up first (same name plus .bak) if it exists.",
    "- Merge into what is already there. Never remove or overwrite my other hooks or settings.",
    "- If something does not match what you expect, stop and tell me instead of guessing.",
    "",
    "Steps",
    `1. Check Agent Buddy is running: GET http://127.0.0.1:${BUDDY_PORT}/health should return {"ok":true,"name":"agent-buddy"}. If it does not, ask me to start Agent Buddy and stop.`,
    "2. Check Node.js is installed (node -v). The hooks are small Node scripts. If it is missing, tell me to install Node.js LTS and stop.",
    "3. If the folder %USERPROFILE%\\.claude exists (Claude Code): merge this \"hooks\" block into %USERPROFILE%\\.claude\\settings.json, keeping any hooks already there:",
    "",
    claudeHooksConfig(),
    "",
    "4. If the folder %USERPROFILE%\\.cursor exists (Cursor): merge this into %USERPROFILE%\\.cursor\\hooks.json, keeping any hooks already there:",
    "",
    cursorHooksConfig(),
    "",
    `5. Test it: POST http://127.0.0.1:${BUDDY_PORT}/api/status with JSON {"state":"working","message":"Setup test","agent":"<your name, e.g. Claude Code or Cursor>"} and ask me whether the notch showed it. Then POST {"state":"finished","message":"Setup done","agent":"<same name>"}.`,
    "6. Tell me which files you changed, where the backups are, and that the hooks start working in a new session (Claude Code: /hooks lists them; Cursor: restart Cursor).",
    "",
    "For any other agent that supports MCP servers, this is the server to add instead (two tools: set_status and ask_user):",
    "",
    httpConfig(),
  ].join("\n");
}

// ---------- Quick start window ----------
let welcomeWin: BrowserWindow | null = null;

function openWelcome(): BrowserWindow {
  if (welcomeWin && !welcomeWin.isDestroyed()) { welcomeWin.show(); welcomeWin.focus(); return welcomeWin; }
  welcomeWin = new BrowserWindow({
    width: 760,
    height: 680,
    useContentSize: true,
    title: "Quick start · Agent Buddy",
    backgroundColor: "#111216",
    autoHideMenuBar: true,
    resizable: false,
    maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "welcome-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  welcomeWin.loadFile(path.join(__dirname, "..", "..", "renderer", "welcome.html"));
  welcomeWin.on("closed", () => { welcomeWin = null; });
  return welcomeWin;
}

function welcomeView() {
  return {
    ...settingsView(),
    version: app.getVersion(),
    tunnel: { state: tunnel.status.state, url: tunnel.status.url },
    aiPrompt: aiSetupPrompt(),
  };
}

function registerWelcomeIpc(): void {
  ipcMain.handle("welcome:get", () => welcomeView());
  // Copying happens here, so the secret token never reaches a page.
  ipcMain.handle("welcome:copy", (_e, what: unknown, arg: unknown) => {
    const name = typeof arg === "string" && arg.trim() ? arg.trim().slice(0, 40) : "BOTNAME";
    const token = safeGetToken();
    const texts: Record<string, () => string | null> = {
      aiPrompt: aiSetupPrompt,
      claudeHooks: claudeHooksConfig,
      cursorHooks: cursorHooksConfig,
      http: httpConfig,
      stdio: stdioConfig,
      skill: () => skillText(name),
      serverUrl: () => (tunnel.status.url ? `${tunnel.status.url}/mcp` : null),
      headerKey: () => "Authorization",
      headerValue: () => (token ? `Bearer ${token}` : null),
    };
    const text = typeof what === "string" && Object.prototype.hasOwnProperty.call(texts, what) ? texts[what]() : null;
    if (text === null) return false;
    clipboard.writeText(text);
    return true;
  });
  ipcMain.handle("welcome:tunnel", (_e, on: unknown) => {
    saveTunnelEnabled(on === true);
    if (on === true) tunnel.start();
    else tunnel.stop();
    refreshTrayMenu();
    return welcomeView();
  });
  ipcMain.on("welcome:demo", () => runDemo());
  ipcMain.on("welcome:open", (_e, what: unknown) => {
    if (what === "settings") openSettings();
    else if (what === "activity") openPanel();
  });
  ipcMain.on("welcome:done", () => {
    applySettings({ onboarded: true });
    welcomeWin?.close();
  });
}

function triggerReaction(reaction: Reaction, ms?: number): void {
  overlay?.webContents.send("buddy:react", { reaction, ms });
}

function stopDemo(): void {
  demoTimers.forEach(clearTimeout);
  demoTimers = [];
}

function runDemo(): void {
  stopDemo();
  const steps: [number, AgentState, string?, string?, [string, string]?][] = [
    [0, "greeting"],
    [2500, "working", "Reading src/app.ts", "Demo"],
    [5000, "working", "Editing 3 files", "Demo"],
    [7500, "upload", "Uploading screenshot.png", "Demo"],
    [10000, "needsYou", "Run `npm test`?", "Demo", ["Approve", "Deny"]],
  ];
  for (const [at, state, text, agent, options] of steps) {
    demoTimers.push(setTimeout(() => setState(state, text, agent, options), at));
  }
}

function applyStartWithWindows(on: boolean): void {
  saveStartWithWindows(on);
  setStartWithWindows(on);
}

// ---------- Tray ----------
function makeTrayIcon(needsYou = false): Electron.NativeImage {
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const isEye = Math.hypot(x - 10, y - 13) < 2.6 || Math.hypot(x - 21, y - 13) < 2.6;
      if (Math.hypot(x - c, y - c) <= 15) {
        const [b, g, r] = isEye
          ? [255, 255, 255]
          : needsYou
            ? [40, 180, 255] // amber-ish in BGRA
            : [60, 42, 31];
        buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; buf[i + 3] = 255;
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

const tunnel = new Tunnel(BUDDY_PORT, (s) => {
  refreshTrayMenu();
  if (s.state === "on" && !s.adopted && Notification.isSupported()) {
    new Notification({
      title: "Agent Buddy tunnel is on",
      body: s.mode === "named"
        ? "Named tunnel is up. Confirm the URL in Grok Bot if you changed hostname."
        : "The public address is new. Update it in Grok Bot: tray icon → Connect an agent.",
    }).show();
  }
  if (s.state === "error" && s.error?.includes("restarting") && Notification.isSupported()) {
    new Notification({ title: "Agent Buddy tunnel", body: s.error }).show();
  }
});

function tunnelLabel(): string {
  const s = tunnel.status;
  const mode = s.mode === "named" ? "named" : "quick";
  if (s.state === "on") return `Tunnel: on (${mode})`;
  if (s.state === "starting") return `Tunnel: starting… (${mode})`;
  if (s.state === "error") return `Tunnel: error (${s.error})`;
  return "Tunnel: off";
}

function refreshTrayMenu(): void {
  tray?.setContextMenu(buildTrayMenu());
}

function createTray(): Tray {
  const t = new Tray(makeTrayIcon());
  t.setToolTip("Agent Buddy");
  t.on("click", () => overlay?.showInactive());
  return t;
}

function safeGetToken(): string | null {
  try {
    return getConnectorToken();
  } catch {
    return null;
  }
}

function buildTrayMenu(): Menu {
  const stateItem = (label: string, state: AgentState, text?: string, options?: [string, string]) => ({
    label,
    click: () => { stopDemo(); setState(state, text, undefined, options); },
  });
  const tunnelUrl = tunnel.status.url;
  const tunnelOn = tunnel.status.state === "on" || tunnel.status.state === "starting";
  const settings = loadAppSettings();
  const token = safeGetToken();
  const tokenErr = getTokenError();

  return Menu.buildFromTemplate([
    {
      label: "Show / hide buddy",
      click: () => { if (overlay) overlay.isVisible() ? overlay.hide() : overlay.showInactive(); },
    },
    { label: "Reset position", click: () => resetOverlayPosition() },
    { label: "Activity…", click: () => { openPanel(); } },
    { label: "Settings…", click: () => { openSettings(); } },
    { label: "Quick start…", click: () => { openWelcome(); } },
    {
      label: dndLabel(),
      submenu: [
        { label: "Off", type: "radio", checked: !dndOn(), click: () => setDnd("off") },
        { label: "For 30 minutes", type: "radio", checked: false, click: () => setDnd(30) },
        { label: "For 1 hour", type: "radio", checked: false, click: () => setDnd(60) },
        { label: "Until I turn it off", type: "radio", checked: dndUntil === Infinity, click: () => setDnd("forever") },
      ],
    },
    { type: "separator" },
    { label: "Ask Grok…", click: openChat },
    {
      label: "Connect an agent",
      submenu: [
        { label: "Copy connector config (command / stdio)", click: () => clipboard.writeText(stdioConfig()) },
        { label: "Copy connector config (URL / HTTP)", click: () => clipboard.writeText(httpConfig()) },
        { label: "Copy Cursor hooks.json", click: () => clipboard.writeText(cursorHooksConfig()) },
        { label: "Copy Claude Code hooks (settings.json)", click: () => clipboard.writeText(claudeHooksConfig()) },
        {
          label: "Copy skill for bot…",
          submenu: [...knownAgents().map((a) => a.name).slice(0, 12), "BOTNAME"].map((name) => ({
            label: name === "BOTNAME" ? "Another bot (edit BOTNAME yourself)" : name,
            click: () => clipboard.writeText(skillText(name)),
          })),
        },
        { type: "separator" },
        { label: "For cloud agents (Grok Bot)", enabled: false },
        {
          label: "Public tunnel",
          type: "checkbox",
          checked: tunnelOn,
          click: (item) => {
            saveTunnelEnabled(item.checked);
            if (item.checked) tunnel.start();
            else tunnel.stop();
            refreshTrayMenu();
          },
        },
        { label: tunnelLabel(), enabled: false },
        {
          label: settings.tunnelMode === "named" ? "Mode: named (fixed host)" : "Mode: quick tunnel",
          enabled: false,
        },
        {
          label: "Copy server URL",
          enabled: tunnelUrl !== null,
          click: () => clipboard.writeText(`${tunnelUrl}/mcp`),
        },
        { label: "Copy header key (Authorization)", click: () => clipboard.writeText("Authorization") },
        {
          label: "Copy header value (secret token)",
          enabled: token !== null,
          click: () => {
            if (token) clipboard.writeText(`Bearer ${token}`);
          },
        },
        {
          label: "Rotate connector token…",
          click: () => {
            const res = dialog.showMessageBoxSync({
              type: "warning",
              buttons: ["Cancel", "Rotate"],
              defaultId: 0,
              cancelId: 0,
              title: "Rotate connector token",
              message: "Create a new connector token?",
              detail: "You must re-paste the new Bearer value into Grok Bot (uninstall/re-add the connector if needed). The old token will stop working.",
            });
            if (res !== 1) return;
            try {
              const next = rotateConnectorToken();
              clipboard.writeText(`Bearer ${next}`);
              dialog.showMessageBox({
                type: "info",
                title: "Token rotated",
                message: "New token copied to the clipboard.",
                detail: "Paste it as the Authorization header value in Grok Bot.",
              });
              refreshTrayMenu();
            } catch (err) {
              dialog.showErrorBox("Could not rotate token", err instanceof Error ? err.message : String(err));
            }
          },
        },
        ...(tokenErr
          ? [{ label: `Token error: ${tokenErr.slice(0, 40)}…`, enabled: false as const }]
          : []),
        { type: "separator" },
        {
          label: "Copy recent activity",
          click: () => clipboard.writeText(formatActivityPeek(activityLogPath)),
        },
        {
          label: "Open activity log folder",
          click: () => shell.openPath(app.getPath("userData")),
        },
      ],
    },
    {
      label: "Start with Windows",
      type: "checkbox",
      checked: loadStartWithWindows(),
      click: (item) => applyStartWithWindows(item.checked),
    },
    { type: "separator" },
    {
      label: "Demo",
      submenu: [
        { label: "Play demo sequence", click: runDemo },
        { type: "separator" },
        stateItem("Greeting", "greeting"),
        stateItem("Idle", "idle"),
        stateItem("Working", "working", "Editing src/app.ts"),
        stateItem("Needs you", "needsYou", "Run `npm test`?", ["Approve", "Deny"]),
        stateItem("Upload", "upload", "Uploading build.zip"),
        stateItem("Error", "error", "Tests failed (2)"),
        stateItem("Finished", "finished", "Done: 4 files changed"),
        { type: "separator" },
        { label: "Annoy it", click: () => triggerReaction("annoyed", 1800) },
        { label: "Slap it", click: () => triggerReaction("slap", 600) },
        { label: "Make it dizzy", click: () => triggerReaction("dizzy", 3200) },
      ],
    },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);
}

// ---------- Dev aid: `electron . --snapshot-dir=DIR` ----------
async function snapshotAll(dir: string): Promise<void> {
  if (!overlay) return;
  fs.mkdirSync(dir, { recursive: true });
  // Sample bots get fixed colours so the pictures look the same every time.
  saveAppSettings({ agentColours: { scout: "#f3f3f1", atlas: "#f0353f", juno: "#2f7cf6", pixel: "#19b8a6" }, glass: true, onboarded: true });
  pushSettings();
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const shots: [string, () => void, number][] = [
    ["opening", () => {}, 230],
    ["greeting", () => setState("greeting"), 1300],
    ["icon-terminal", () => setState("working", "Running the tests", "Scout"), 900],
    ["icon-send", () => setState("working", "Sending the email to Sam", "Scout"), 900],
    ["icon-edit", () => setState("working", "Updating the tracker", "Scout"), 900],
    ["icon-search", () => setState("working", "Checking Outlook and Teams", "Scout"), 900],
    ["icon-wait", () => setState("working", "Waiting for a reply", "Scout"), 900],
    // Elapsed time and the "gone quiet" flag need old timestamps: ask the page to age the bot.
    ["elapsed", () => { void overlay?.webContents.executeJavaScript(`(() => { const b = bots.get("scout"); b.startedAt -= 12 * 60000; refresh(); })()`); }, 700],
    ["stale", () => { void overlay?.webContents.executeJavaScript(`(() => { const b = bots.get("scout"); b.updatedAt -= 7 * 60000; refresh(); })()`); }, 700],
    ["working-scout", () => setState("working", "Checking Outlook", "Scout"), 1100],
    ["working-step-2", () => setState("working", "Checking Teams", "Scout"), 1100],
    ["needsYou-scout", () => setState("needsYou", "Send the email to Sam?", "Scout", ["Send", "Don't send"]), 1100],
    ["finished-mid-roll", () => setState("finished", "Outlook and Teams checked: nothing new", "Scout"), 330],
    ["finished-scout", () => {}, 1600],
    ["upload-scout", () => setState("upload", "Uploading the report", "Scout"), 1200],
    ["error-scout", () => setState("error", "Couldn't reach SharePoint", "Scout"), 1700],
    ["annoyed", () => triggerReaction("annoyed", 4000), 700],
    ["slap", () => triggerReaction("slap", 4000), 700],
    ["compact-scout", () => setState("working", "Checking Outlook and Teams", "Scout"), 9500],
    ["two-bots", () => setState("working", "Updating the tracker", "Atlas"), 900],
    ["three-bots", () => setState("upload", "Syncing 8 config PDFs", "Juno"), 900],
    ["four-bots-finished", () => setState("finished", "No new mail; 2 new rows on Repairs", "Pixel"), 1900],
    ["needsYou-with-others", () => setState("needsYou", "Send the email to Sam?", "Scout", ["Send", "Don't send"]), 900],
    ["error-with-others", () => { setState("working", "You chose \"Send\"", "Scout"); setState("error", "Couldn't reach SharePoint", "Juno"); }, 1300],
    ["compact-multi", () => setState("working", "Sending the email to Sam", "Scout"), 6500],
    // The block character (Claude Code) in each state, then beside the others
    ["claude-working", () => setState("working", "Editing renderer.ts", "Claude Code"), 1200],
    ["claude-needsYou", () => setState("needsYou", "Allow this command? (deletes files)", "Claude Code", ["Approve", "Deny"]), 1200],
    ["claude-finished", () => setState("finished", "Claude Code turn done", "Claude Code"), 1700],
    ["claude-error", () => setState("error", "Build failed", "Claude Code"), 1700],
    ["claude-upload", () => setState("upload", "Pushing to GitHub", "Claude Code"), 1200],
    ["claude-as-other", () => { setState("working", "Editing renderer.ts", "Claude Code"); setState("working", "Checking Outlook", "Scout"); }, 1200],
    // The hexagon character (Cursor)
    ["cursor-working", () => setState("working", "Shell: npm run build", "Cursor"), 1200],
    ["cursor-needsYou", () => setState("needsYou", "Allow this command? (deletes files)", "Cursor", ["Approve", "Deny"]), 1200],
    ["cursor-finished", () => setState("finished", "Cursor turn done", "Cursor"), 1700],
    ["cursor-error", () => setState("error", "Build failed", "Cursor"), 1700],
    // Idle personality: a glance, then dozing (the page is told to skip the two-minute wait)
    ["idle-glance", () => { void overlay?.webContents.executeJavaScript(`(() => { bots.clear(); refresh(); glance.x = 0.9; glance.y = -0.3; glanceUntil = performance.now() + 5000; wakeAnimation(); })()`); }, 1300],
    ["idle-dozing", () => { void overlay?.webContents.executeJavaScript(`(() => { glanceUntil = 0; lastStirAt = performance.now() - 200000; idleTick(); })()`); }, 2600],
    ["dizzy", () => triggerReaction("dizzy", 5000), 700],
  ];
  for (const [name, act, settle] of shots) {
    act();
    await wait(settle);
    const img = await overlay.webContents.capturePage();
    fs.writeFileSync(path.join(dir, `${name}.png`), img.toPNG());
  }
  // The two other ways to answer: "Always", and a typed answer.
  for (const [name, act] of [
    ["ask-always", () => setState("needsYou", "Send the daily report?", "Scout", ["Send", "Don't send"], undefined, { canRemember: true })],
    ["ask-text", () => setState("needsYou", "Which row should I update?", "Atlas", undefined, undefined, { input: true })],
    ["ask-list", () => { void overlay?.webContents.executeJavaScript("bots.clear(); window.clearTimeout(reactionTimer); reaction = \"none\"; body.dataset.reaction = \"none\"; refresh();").then(() => setState("needsYou", "Row 516 went to the wrong company. How should I handle it?", "Atlas", ["Clone it into the right company and delete the copy", "Clone it and keep the copy", "I'll fix it myself; carry on with the rest"], undefined, { list: true, other: true })); }],
  ] as const) {
    act();
    await wait(1300);
    fs.writeFileSync(path.join(dir, `${name}.png`), (await overlay.webContents.capturePage()).toPNG());
  }
  // The Activity panel, with some sample history.
  const t = Date.now();
  recordHistory("Atlas", "working", "Checking the Depot 4 row", t - 9 * 60_000);
  recordHistory("Atlas", "working", "Updating the tracker", t - 7 * 60_000);
  recordHistory("Atlas", "finished", "Oct 2026 tracker statuses updated", t - 6 * 60_000);
  recordHistory("Juno", "working", "Syncing 8 config PDFs", t - 4 * 60_000);
  recordHistory("Juno", "error", "Couldn't reach SharePoint", t - 3 * 60_000);
  recordHistory("Scout", "working", "Checking Outlook and Teams", t - 2 * 60_000);
  recordHistory("Scout", "needsYou", "Send the email to Sam?", t - 90_000);
  recordHistory("Scout", "answered", "You chose \"Send\"", t - 60_000);
  recordHistory("Scout", "working", "Sending the email to Sam", t - 20_000);
  const pw = openPanel();
  await wait(1800);
  fs.writeFileSync(path.join(dir, "activity-panel.png"), (await pw.webContents.capturePage()).toPNG());
  // The Settings window too.
  const sw = openSettings();
  await wait(1800);
  fs.writeFileSync(path.join(dir, "settings-window.png"), (await sw.webContents.capturePage()).toPNG());
  // The quick start, page by page.
  const ww = openWelcome();
  await wait(1500);
  for (let i = 0; i < 5; i++) {
    await ww.webContents.executeJavaScript(`wlShow(${i})`);
    await wait(500);
    fs.writeFileSync(path.join(dir, `welcome-${i + 1}.png`), (await ww.webContents.capturePage()).toPNG());
  }
  app.quit();
}

// ---------- Dev aid: `electron . --record-dir=DIR` ----------
// Plays a short story with sample agents and saves the notch frame by frame,
// for the animation in the README (scripts/make-apng.js joins the frames).
async function recordDemo(dir: string): Promise<void> {
  if (!overlay) return;
  const win = overlay;
  fs.mkdirSync(dir, { recursive: true });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  saveAppSettings({ agentColours: { scout: "#f3f3f1", atlas: "#f0353f", juno: "#2f7cf6", pixel: "#19b8a6" }, glass: true, onboarded: true, sounds: false });
  pushSettings();
  // A wallpaper behind the notch, so the picture reads on a light or dark page.
  // It only changes left to right: identical rows keep the file small.
  await win.webContents.insertCSS("html { height: 100%; background: linear-gradient(90deg, #14304d 0%, #1c5d8f 35%, #2aa3d6 68%, #16294a 100%) no-repeat !important; }");
  setState("idle");
  await wait(600);

  const frames: { t: number; png: Buffer }[] = [];
  let recording = true;
  const start = Date.now();
  const loop = (async () => {
    while (recording) {
      const t0 = Date.now();
      frames.push({ t: t0 - start, png: (await win.webContents.capturePage({ x: 0, y: 0, width: OVERLAY_WIDTH, height: 300 })).toPNG() });
      const left = 70 - (Date.now() - t0);
      if (left > 0) await wait(left);
    }
  })();

  const story: [number, () => void][] = [
    [900, () => setState("greeting")],
    [2000, () => setState("working", "Reading the brief", "Scout", undefined, "Draft the summary")],
    [2000, () => setState("working", "Drafting the summary", "Scout", undefined, "Email it to Sam")],
    [1700, () => setState("working", "Running the tests", "Claude Code")],
    [1900, () => setState("needsYou", "Send the summary to Sam?", "Scout", ["Send", "Don't send"])],
    [2600, () => setState("working", "You chose \"Send\"", "Scout")],
    [1300, () => setState("finished", "Summary sent to Sam", "Scout")],
    [2300, () => setState("needsYou", "Allow this command? (deletes files)", "Claude Code", ["Approve", "Deny"])],
    [2600, () => setState("working", "You chose \"Deny\"", "Claude Code")],
    [1500, () => setState("working", "Creating objects 6-12 of 30", "Atlas")],
    [1900, () => setState("needsYou", "Row 516 went to the wrong company. How should I handle it?", "Atlas", ["Clone it into the right company and delete the copy", "Clone it and keep the copy", "I'll fix it myself; carry on with the rest"], undefined, { list: true, other: true })],
    [3800, () => setState("working", "You chose \"Clone it and keep the copy\"", "Atlas")],
    [1500, () => setState("error", "Couldn't reach the server", "Juno")],
    [2400, () => setState("finished", "All 42 tests pass", "Claude Code")],
    [2600, () => {}],
  ];
  for (const [before, act] of story) {
    await wait(before);
    act();
  }
  recording = false;
  await loop;
  frames.forEach((f, i) => fs.writeFileSync(path.join(dir, `frame-${String(i).padStart(4, "0")}.png`), f.png));
  fs.writeFileSync(path.join(dir, "times.json"), JSON.stringify(frames.map((f) => f.t)));
  app.quit();
}

// ---------- App ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    // A notification button opens an agentbuddy:// link, which arrives here.
    const link = argv.find((a) => a.startsWith(`${PROTOCOL}://`));
    if (link) { handleProtocolUrl(link); return; }
    if (!overlay || overlay.isDestroyed()) {
      overlay = createOverlay();
    } else {
      overlay.showInactive();
    }
    if (tray) {
      try { tray.displayBalloon({ title: "Agent Buddy", content: "Already running — showing the buddy." }); } catch { /* unsupported */ }
    }
  });

  app.whenReady().then(() => {
    overlay = createOverlay();
    tray = createTray();
    refreshTrayMenu();
    setInteractive(false);
    startCursorPolling();
    screen.on("display-metrics-changed", () => resetOverlayPosition());

    if (loadStartWithWindows()) {
      setStartWithWindows(true);
    }

    ipcMain.on("buddy:pill-rect", (_e, r: Rect) => { pillRect = r; });
    ipcMain.on("buddy:interactive", (_e, on: boolean) => setInteractive(on === true));
    ipcMain.on("buddy:needs-you", (_e, on: boolean) => {
      tray?.setImage(makeTrayIcon(on === true));
    });
    ipcMain.on("buddy:decision", (_e, choice: unknown) => {
      stopDemo();
      if (currentAsk?.freeText) return; // a typed answer is expected
      if (currentAsk) { answerCurrent(typeof choice === "number" ? choice : 0); return; }
      // No real question waiting: this was the tray demo.
      setState(choice === 0 ? "working" : "idle", choice === 0 ? "Approved, continuing…" : "Denied. Agent stopped.");
    });

    registerSettingsIpc();
    registerWelcomeIpc();
    ipcMain.on("buddy:decision-always", () => { stopDemo(); answerCurrent(0, undefined, true); });
    ipcMain.on("buddy:text-answer", (_e, text: unknown) => { if (typeof text === "string") answerWithText(text); });
    ipcMain.handle("panel:get", () => historySnapshot());
    ipcMain.handle("panel:colours", () => loadAppSettings().agentColours ?? {});

    const recDir = process.argv.find((a) => a.startsWith("--record-dir="));
    if (recDir) {
      overlay.webContents.once("did-finish-load", () =>
        setTimeout(() => recordDemo(recDir.slice("--record-dir=".length)), 1600)
      );
      return;
    }
    const snapDir = process.argv.find((a) => a.startsWith("--snapshot-dir="));
    if (snapDir) {
      overlay.webContents.once("did-finish-load", () =>
        setTimeout(() => snapshotAll(snapDir.slice("--snapshot-dir=".length)), 800)
      );
      return;
    }

    activityLogPath = path.join(app.getPath("userData"), "activity.log");
    seedHistoryFromLog(activityLogPath);
    registerGrokIpc();

    try {
      getConnectorToken();
    } catch (err) {
      if (Notification.isSupported()) {
        new Notification({
          title: "Agent Buddy token problem",
          body: err instanceof Error ? err.message : String(err),
        }).show();
      }
    }

    startBuddyServer(backend, {
      getToken: () => getConnectorToken(),
      getTunnelUrl: () => tunnel.status.url,
      getDiagnostics: () => ({
        version: app.getVersion(),
        packaged: app.isPackaged,
        dataFolder: app.getPath("userData"),
        tokenOk: safeGetToken() !== null,
        tunnel: tunnel.status.state,
      }),
      logFile: activityLogPath,
      getHistory: () => historySnapshot(),
      dev: process.env.AGENT_BUDDY_DEV === "1"
        ? {
            click: (c) => void overlay?.webContents.executeJavaScript(`document.getElementById(${JSON.stringify(c === 2 ? "always" : c === 0 ? "approve" : "deny")}).click()`),
            clickOption: (i) => void overlay?.webContents.executeJavaScript(`document.getElementById(${JSON.stringify(i < 0 ? "opt-other" : `opt-${i}`)}).click()`),
            typeAnswer: (text) => void overlay?.webContents.executeJavaScript(`(() => { document.getElementById("reply-text").value = ${JSON.stringify(text)}; document.getElementById("reply").requestSubmit(); })()`),
            snapshot: async () => (await overlay!.webContents.capturePage()).toPNG(),
            currentAsk: () => (currentAsk ? { agent: currentAsk.agent, nonce: currentAsk.nonce, queued: askQueue.length } : null),
          }
        : undefined,
    });
    if (loadTunnelEnabled()) tunnel.start();
    app.on("before-quit", () => tunnel.stop());

    // Let Windows hand agentbuddy:// links to this app (for notification buttons).
    if (app.isPackaged) app.setAsDefaultProtocolClient(PROTOCOL);
    else app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(__dirname, "..", "..")]);
    syncToggleShortcut();
    app.on("will-quit", () => globalShortcut.unregisterAll());

    // First launch: show the quick start once.
    if (loadAppSettings().onboarded !== true) setTimeout(() => openWelcome(), 1400);
  });

  app.on("window-all-closed", () => { /* tray keeps the app alive */ });
}
