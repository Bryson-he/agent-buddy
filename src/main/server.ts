// Local-only HTTP server: the MCP endpoint (/mcp) plus a tiny JSON API used by
// the stdio bridge. Binds to 127.0.0.1 and refuses browser-originated requests,
// so web pages cannot drive the buddy.
import * as crypto from "crypto";
import * as http from "http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createBuddyMcpServer, askShape, statusShape, type BuddyBackend } from "../mcp/tools.js";
import { appendActivity, peekActivity } from "./activity.js";
import { z } from "zod";

export const BUDDY_PORT = Number(process.env.AGENT_BUDDY_PORT ?? 47821);
const MAX_BODY = 64 * 1024;
const REMOTE_WINDOW_MS = 60_000;
const REMOTE_MAX_PER_WINDOW = 120;
const REMOTE_ASK_MAX_SEC = 85;

const statusSchema = z.object(statusShape);
const askSchema = z.object(askShape);

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
    setStatus: async (a) => { log({ tool: "set_status", ...a }); await realBackend.setStatus(a); },
    askUser: async (a) => {
      log({ tool: "ask_user", agent: a.agent, question: a.question });
      const r = await realBackend.askUser(a);
      log({ tool: "ask_user:answer", agent: a.agent, answer: r.answer, timedOut: r.timedOut, busy: r.busy });
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
        // Cloudflare drops a tunnelled request that has sent nothing for 100 s, so a
        // question asked through the tunnel must be answered or time out before then.
        const forThisRequest: BuddyBackend = isRemote(req)
          ? { setStatus: backend.setStatus, askUser: (a) => backend.askUser({ ...a, timeout_sec: Math.min(a.timeout_sec ?? REMOTE_ASK_MAX_SEC, REMOTE_ASK_MAX_SEC) }) }
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
        await backend.setStatus(parsed.data);
        return send(res, 200, { ok: true });
      }

      if (req.method === "POST" && url.pathname === "/api/ask") {
        const parsed = askSchema.safeParse(await readBody(req));
        if (!parsed.success) return send(res, 400, { error: parsed.error.message });
        const result = await backend.askUser(parsed.data);
        // Machine-readable for Cursor / Claude Code hooks.
        return send(res, 200, {
          answer: result.answer,
          timedOut: result.timedOut === true,
          busy: result.busy === true,
          chosen: result.answer,
        });
      }

      // Dev-only: lets automated tests press the real Approve/Deny buttons.
      if (dev && req.method === "POST" && url.pathname === "/api/dev/click") {
        const body = (await readBody(req)) as { choice?: number } | undefined;
        dev.click(body?.choice === 2 ? 2 : body?.choice === 1 ? 1 : 0);
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
