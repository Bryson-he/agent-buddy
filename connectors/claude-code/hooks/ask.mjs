#!/usr/bin/env node
// Claude Code helper: ask on the notch. Prints chosen|deny|busy|timeout|down for shell scripts.
const BASE = process.env.AGENT_BUDDY_URL ?? "http://127.0.0.1:47821";
const question = process.argv.slice(2).join(" ") || "Allow this action?";

try {
  const res = await fetch(`${BASE}/api/ask`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      question: question.slice(0, 300),
      options: ["Approve", "Deny"],
      agent: "Claude Code",
      timeout_sec: 120,
    }),
    signal: AbortSignal.timeout(125_000),
  });
  if (!res.ok) {
    process.stdout.write("down\n");
    process.exit(0);
  }
  const j = await res.json();
  if (j.busy) process.stdout.write("busy\n");
  else if (j.timedOut || j.answer == null) process.stdout.write("timeout\n");
  else process.stdout.write(`${j.answer}\n`);
} catch {
  process.stdout.write("down\n");
}
process.exit(0);
