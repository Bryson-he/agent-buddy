#!/usr/bin/env node
// Claude Code helper: POST a status update to Agent Buddy (fail-open).
const BASE = process.env.AGENT_BUDDY_URL ?? "http://127.0.0.1:47821";
const state = process.argv[2] ?? "working";
const message = process.argv.slice(3).join(" ") || "Claude Code is working";

try {
  await fetch(`${BASE}/api/status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ state, message: message.slice(0, 60), agent: "Claude Code" }),
    signal: AbortSignal.timeout(5000),
  });
} catch {
  // fail-open
}
process.exit(0);
