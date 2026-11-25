#!/usr/bin/env node
// Stdio MCP server for agents that launch connectors as a command
// (Grok Bot "STDIO" connectors, Cursor, Claude Code). It forwards every tool
// call to the running Agent Buddy app on 127.0.0.1.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBuddyMcpServer, type AskUserArgs, type AskUserResult, type BuddyBackend, type RemindArgs, type SetStatusArgs } from "./tools.js";

const BASE = process.env.AGENT_BUDDY_URL ?? "http://127.0.0.1:47821";

async function post<T>(route: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Agent Buddy is not running. Start the Agent Buddy app and try again.");
  }
  if (!res.ok) throw new Error(`Agent Buddy returned ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

const backend: BuddyBackend = {
  setStatus: async (a: SetStatusArgs) => {
    const r = await post<{ notes?: string[]; command?: "pause" | "stop" | null; away?: boolean }>("/api/status", a);
    return { notes: r?.notes ?? [], command: r?.command ?? undefined, away: r?.away === true };
  },
  remindUser: async (a: RemindArgs) => {
    const r = await post<{ at?: string | null }>("/api/remind", a);
    return r?.at ? { at: Date.parse(r.at) } : null;
  },
  askUser: (a: AskUserArgs) => post<AskUserResult>("/api/ask", a),
};

createBuddyMcpServer(backend)
  .connect(new StdioServerTransport())
  .catch((err) => {
    process.stderr.write(`agent-buddy-mcp failed: ${String(err)}\n`);
    process.exit(1);
  });
