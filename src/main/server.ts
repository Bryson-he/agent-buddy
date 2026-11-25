// Local-only HTTP server: the MCP endpoint (/mcp) plus a tiny JSON API used by
// the stdio bridge. Binds to 127.0.0.1 and refuses browser-originated requests,
// so web pages cannot drive the buddy.
import * as crypto from "crypto";
import * as http from "http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createBuddyMcpServer, askShape, remindShape, statusShape, type BuddyBackend } from "../mcp/tools.js";
import { appendActivity, peekActivity } from "./activity.js";
import { z } from "zod";

export const BUDDY_PORT = Number(process.env.AGENT_BUDDY_PORT ?? 47821);
const MAX_BODY = 64 * 1024;
const REMOTE_WINDOW_MS = 60_000;
const REMOTE_MAX_PER_WINDOW = 120;
const REMOTE_ASK_MAX_SEC = 85;
/** How long a tunnelled question stays on screen when the agent does not say (it re-asks to keep waiting). */
const REMOTE_ASK_DEFAULT_SEC = 300;

const statusSchema = z.object(statusShape);
const askSchema = z.object(askShape);
const remindSchema = z.object(remindShape);

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve(undefined);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new Error("invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// A request is "remote" if it came through the tunnel: the Host is not this PC,
// or it carries a proxy header that the tunnel always adds and a caller cannot remove.
function isRemote(req: http.IncomingMessage): boolean {
  const host = (req.headers.host ?? "").toLowerCase();
  const localHost = host === `127.0.0.1:${BUDDY_PORT}` || host === `localhost:${BUDDY_PORT}`;
  const h = req.headers;
  return !localHost || h["cf-ray"] !== undefined || h["cf-connecting-ip"] !== undefined || h["x-forwarded-for"] !== undefined;
}

function hasValidToken(req: http.IncomingMessage, token: string): boolean {
  const given = Buffer.from(String(req.headers.authorization ?? ""));
  const expected = Buffer.from(`Bearer ${token}`);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/** Simple per-token sliding window to soften spam if a token leaks. */
class RateLimiter {
  private hits: number[] = [];
  allow(): boolean {
    const now = Date.now();
    this.hits = this.hits.filter((t) => now - t < REMOTE_WINDOW_MS);
    if (this.hits.length >= REMOTE_MAX_PER_WINDOW) return false;
    this.hits.push(now);
    return true;
  }
}

export interface DevHooks {
  /** 0 = first answer, 1 = second answer, 2 = "Always" (first answer, remembered). */
  click(choice: 0 | 1 | 2): void;
  /** Clicks a row of a list question: 0 to 3, -1 for "Something else", -2 for a pick-several question's Send. */
  clickOption(index: number): void;
  /** What the notch's Note box, Pause and Stop buttons do, for an agent by name. */
  leave(agent: string, what: { note?: string; command?: "pause" | "stop" }): void;
  /** Pretends the user has been idle this many seconds (-1 = use the real figure). */
  setIdle(seconds: number): void;
  /** Closes the app (a test copy tidying up after itself). */
  quit(): void;
  /** Handles an agentbuddy:// link as if Windows had passed it in. */
  openLink(url: string): void;
  typeAnswer(text: string): void;
  snapshot(): Promise<Buffer>;
  /** The question on screen, with its one-time code, so tests can use a notification link. */
  currentAsk(): { agent: string; nonce: string; queued: number } | null;
}
export interface ServerOptions {
  /** Secret that tunnelled requests must send as "Authorization: Bearer <token>". */
  getToken(): string;
  getTunnelUrl(): string | null;
  logFile?: string;
  /** What each bot has been doing (the Activity panel's data). Local callers only. */
  getHistory?(): unknown;
  /** Which copy is running and whether the token can be read (no secrets). Local callers only. */
  getDiagnostics?(): unknown;
  dev?: DevHooks;
}

export function startBuddyServer(realBackend: BuddyBackend, opts: ServerOptions): http.Server {
  const dev = opts.dev;
  const remoteLimit = new RateLimiter();

  const log = (entry: Record<string, unknown>): void => {
    if (!opts.logFile) return;
    appendActivity(opts.logFile, entry);
  };
  const backend: BuddyBackend = {
    setStatus: async (a) => {
      // The link's address stays out of the log: it can carry a private file's path.
      log({ tool: "set_status", ...a, link: a.link ? "(link)" : undefined });
      const reply = await realBackend.setStatus(a);
      if (reply && (reply.notes.length > 0 || reply.command)) log({ tool: "set_status:reply", agent: a.agent, notes: reply.notes.length, command: reply.command });
      return reply;
    },
    remindUser: realBackend.remindUser
      ? async (a) => {
          const set = await realBackend.remindUser!(a);
          log({ tool: "remind_user", agent: a.agent, text: a.text, at: set ? new Date(set.at).toISOString() : null });
          return set;
        }
      : undefined,
    askUser: async (a, wait) => {
      log({ tool: "ask_user", agent: a.agent, question: a.question, options: a.options?.length });
      const r = await realBackend.askUser(a, wait);
      log({ tool: "ask_user:answer", agent: a.agent, answer: r.answer, timedOut: r.timedOut, busy: r.busy, pending: r.pending, away: r.away });
      return r;
    },
  };
  const server = http.createServer(async (req, res) => {
    try {
      // Browsers always send Origin on cross-site requests; MCP clients and the bridge do not.
      if (req.headers.origin !== undefined) return send(res, 403, { error: "forbidden" });
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${BUDDY_PORT}`);

      // Tunnelled requests: only the MCP endpoint, and only with the secret token.
      if (isRemote(req)) {
        if (url.pathname !== "/mcp") return send(res, 404, { error: "not found" });
        if (!hasValidToken(req, opts.getToken())) {
          log({ http: "mcp", via: "tunnel", result: 401 });
          return send(res, 401, { error: "unauthorized" });
        }
        if (!remoteLimit.allow()) {
          log({ http: "mcp", via: "tunnel", result: 429 });
          return send(res, 429, { error: "too many requests" });
        }
      } else if (req.method === "GET" && url.pathname === "/api/tunnel") {
        return send(res, 200, { url: opts.getTunnelUrl() });
      } else if (req.method === "GET" && url.pathname === "/api/diagnostics") {
        return send(res, 200, opts.getDiagnostics?.() ?? {});
      } else if (req.method === "GET" && url.pathname === "/api/history") {
        return send(res, 200, { bots: opts.getHistory?.() ?? [] });
      } else if (req.method === "GET" && url.pathname === "/api/activity") {
        return send(res, 200, opts.logFile ? peekActivity(opts.logFile) : { lastCalls: [] });
      }

      if (url.pathname === "/health") return send(res, 200, { ok: true, name: "agent-buddy" });

      if (url.pathname === "/mcp") {
        const body = req.method === "POST" ? await readBody(req) : undefined;
        const rpc = body as { method?: string; params?: { name?: string } } | undefined;
        log({ http: "mcp", via: isRemote(req) ? "tunnel" : "local", method: req.method, rpc: rpc?.method, name: rpc?.params?.name });
        // Cloudflare drops a tunnelled request that has sent nothing for 100 s. So a
        // request through the tunnel is handed back as "pending" before then, while the
        // question stays on screen; the agent asks again to keep waiting.
        const forThisRequest: BuddyBackend = isRemote(req)
          ? {
              setStatus: backend.setStatus,
              remindUser: backend.remindUser,
              // An agent in the cloud has a chat to fall back on, so it is told at once when the user is away.
              askUser: (a) => backend.askUser({ ...a, timeout_sec: a.timeout_sec ?? REMOTE_ASK_DEFAULT_SEC }, { detachAfterSec: REMOTE_ASK_MAX_SEC, tellIfAway: true }),
            }
          : backend;
        // Stateless: a fresh MCP server per request keeps concurrent agents independent.
        const mcp = createBuddyMcpServer(forThisRequest);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on("close", () => { void transport.close(); void mcp.close(); });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/status") {
        const parsed = statusSchema.safeParse(await readBody(req));
        if (!parsed.success) return send(res, 400, { error: parsed.error.message });
        const reply = await backend.setStatus(parsed.data);
        return send(res, 200, { ok: true, notes: reply ? reply.notes : [], command: reply?.command ?? null, away: reply ? reply.away : false });
      }

      if (req.method === "POST" && url.pathname === "/api/remind") {
        const parsed = remindSchema.safeParse(await readBody(req));
        if (!parsed.success) return send(res, 400, { error: parsed.error.message });
        const set = backend.remindUser ? await backend.remindUser(parsed.data) : null;
        return send(res, 200, { ok: set !== null, at: set ? new Date(set.at).toISOString() : null });
      }

      if (req.method === "POST" && url.pathname === "/api/ask") {
        const parsed = askSchema.safeParse(await readBody(req));
        if (!parsed.success) return send(res, 400, { error: parsed.error.message });
        // Dev mode only: "detach_sec" hands the request back early as "pending", the way the tunnel does.
        const detach = dev ? Number(url.searchParams.get("detach_sec")) : 0;
        const tellIfAway = dev !== undefined && url.searchParams.get("away") === "1";
        const result = await backend.askUser(parsed.data, detach > 0 || tellIfAway ? { detachAfterSec: detach > 0 ? detach : undefined, tellIfAway } : undefined);
        // Machine-readable for Cursor / Claude Code hooks.
        return send(res, 200, {
          answer: result.answer,
          timedOut: result.timedOut === true,
          busy: result.busy === true,
          pending: result.pending === true,
          away: result.away === true,
          answers: result.answers ?? null,
          chosen: result.answer,
        });
      }

      // Dev-only: lets automated tests press the real Approve/Deny buttons.
      if (dev && req.method === "POST" && url.pathname === "/api/dev/click") {
        const body = (await readBody(req)) as { choice?: number } | undefined;
        dev.click(body?.choice === 2 ? 2 : body?.choice === 1 ? 1 : 0);
        return send(res, 200, { ok: true });
      }
      if (dev && req.method === "POST" && url.pathname === "/api/dev/option") {
        const body = (await readBody(req)) as { index?: number } | undefined;
        dev.clickOption(Number.isInteger(body?.index) ? (body!.index as number) : 0);
        return send(res, 200, { ok: true });
      }
      if (dev && req.method === "POST" && url.pathname === "/api/dev/leave") {
        const body = (await readBody(req)) as { agent?: unknown; note?: unknown; command?: unknown } | undefined;
        dev.leave(String(body?.agent ?? ""), {
          note: typeof body?.note === "string" ? body.note : undefined,
          command: body?.command === "pause" || body?.command === "stop" ? body.command : undefined,
        });
        return send(res, 200, { ok: true });
      }
      if (dev && req.method === "POST" && url.pathname === "/api/dev/link") {
        const body = (await readBody(req)) as { url?: unknown } | undefined;
        dev.openLink(String(body?.url ?? ""));
        return send(res, 200, { ok: true });
      }
      if (dev && req.method === "POST" && url.pathname === "/api/dev/quit") {
        send(res, 200, { ok: true });
        setTimeout(() => dev.quit(), 100);
        return;
      }
      if (dev && req.method === "POST" && url.pathname === "/api/dev/idle") {
        const body = (await readBody(req)) as { seconds?: number } | undefined;
        dev.setIdle(Number.isFinite(body?.seconds) ? (body!.seconds as number) : -1);
        return send(res, 200, { ok: true });
      }
      if (dev && req.method === "POST" && url.pathname === "/api/dev/text") {
        const body = (await readBody(req)) as { text?: unknown } | undefined;
        dev.typeAnswer(String(body?.text ?? ""));
        return send(res, 200, { ok: true });
      }
      if (dev && req.method === "GET" && url.pathname === "/api/dev/ask") {
        return send(res, 200, { ask: dev.currentAsk() });
      }
      if (dev && req.method === "GET" && url.pathname === "/api/dev/snapshot") {
        const png = await dev.snapshot();
        res.writeHead(200, { "content-type": "image/png" });
        res.end(png);
        return;
      }

      send(res, 404, { error: "not found" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "internal error";
      if (!res.headersSent) send(res, 500, { error: message.slice(0, 200) });
    }
  });

  server.on("error", (err) => console.error(`[agent-buddy] server error on port ${BUDDY_PORT}:`, err));
  server.listen(BUDDY_PORT, "127.0.0.1", () => console.log(`[agent-buddy] listening on http://127.0.0.1:${BUDDY_PORT}`));
  return server;
}
