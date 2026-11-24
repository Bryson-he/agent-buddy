// Runs the real Cursor and Claude Code hook scripts against a fake Agent Buddy
// and checks what they tell the IDE for every outcome. No app needed.
//   node scripts/test-hooks.mjs
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hook = (...p) => path.join(root, "connectors", ...p);
let failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); if (!ok) failures++; };

// Fake Agent Buddy: records calls, answers /api/ask with whatever the test sets.
let askAnswer = { answer: "Approve", timedOut: false, busy: false };
let calls = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    calls.push({ url: req.url, body: JSON.parse(body || "{}") });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url === "/api/ask" ? askAnswer : { ok: true }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const live = `http://127.0.0.1:${server.address().port}`;
const dead = "http://127.0.0.1:9"; // nothing listens here

function run(script, input, base = live) {
  calls = [];
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [script], { env: { ...process.env, AGENT_BUDDY_URL: base } });
    let out = "";
    p.stdout.on("data", (c) => { out += c; });
    p.on("close", (code) => {
      let json = null;
      try { json = out.trim() ? JSON.parse(out) : null; } catch { json = "INVALID JSON: " + out; }
      resolve({ code, json, calls: [...calls] });
    });
    p.stdin.end(JSON.stringify(input));
  });
}

// ---------- Claude Code ----------
const pre = hook("claude-code", "hooks", "pre-tool.mjs");
const shell = (command, tool = "PowerShell") => ({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { command } });
const decision = (r) => r.json?.hookSpecificOutput?.permissionDecision;

let r = await run(pre, shell("git status"));
check("Claude: routine command says nothing and exits 0", r.code === 0 && r.json === null);
check("Claude: routine command still shows a status", r.calls.some((c) => c.url === "/api/status" && c.body.agent === "Claude Code" && c.body.state === "working"));
check("Claude: routine command does not ask", !r.calls.some((c) => c.url === "/api/ask"));

askAnswer = { answer: "Approve", timedOut: false, busy: false };
r = await run(pre, shell("rm -rf build", "Bash"));
check("Claude: risky command asks on the notch", r.calls.some((c) => c.url === "/api/ask" && /rm -rf build/.test(c.body.question)));
check("Claude: Approve becomes allow, in the shape Claude Code reads", decision(r) === "allow" && r.json.hookSpecificOutput.hookEventName === "PreToolUse", JSON.stringify(r.json));

askAnswer = { answer: "Deny", timedOut: false, busy: false };
check("Claude: Deny becomes deny", decision(await run(pre, shell("Remove-Item -Recurse dist"))) === "deny");
askAnswer = { answer: null, timedOut: true, busy: false };
check("Claude: no answer becomes deny", decision(await run(pre, shell("git reset --hard"))) === "deny");
askAnswer = { answer: null, timedOut: false, busy: true };
check("Claude: busy falls back to Claude Code's own prompt", decision(await run(pre, shell("git clean -fdx"))) === "ask");

r = await run(pre, shell("rm -rf build"), dead);
check("Claude: Agent Buddy not running does not block", r.code === 0 && r.json === null);

r = await run(pre, { tool_name: "Edit", tool_input: { file_path: "C:\\proj\\src\\app.ts" } });
check("Claude: an edit shows the file name", r.calls.some((c) => c.body.message === "Editing app.ts"), JSON.stringify(r.calls.map((c) => c.body.message)));

r = await run(hook("claude-code", "hooks", "post-tool.mjs"), { tool_name: "Write", tool_input: { file_path: "/p/readme.md" } });
check("Claude: after an edit shows 'Edited'", r.calls.some((c) => c.body.message === "Edited readme.md"));
r = await run(hook("claude-code", "hooks", "stop.mjs"), {});
check("Claude: end of turn shows finished", r.calls.some((c) => c.body.state === "finished"));

// ---------- Cursor ----------
const before = hook("cursor", "hooks", "before-shell.mjs");
r = await run(before, { command: "npm run build" });
check("Cursor: routine command is allowed without asking", r.json?.permission === "allow" && !r.calls.some((c) => c.url === "/api/ask"));
askAnswer = { answer: "Approve", timedOut: false, busy: false };
check("Cursor: Approve becomes allow", (await run(before, { command: "rm -rf build" })).json?.permission === "allow");
askAnswer = { answer: "Deny", timedOut: false, busy: false };
check("Cursor: Deny becomes deny", (await run(before, { command: "del /q *.log" })).json?.permission === "deny");
askAnswer = { answer: null, timedOut: true, busy: false };
check("Cursor: no answer becomes deny", (await run(before, { command: "git push --force" })).json?.permission === "deny");
askAnswer = { answer: null, timedOut: false, busy: true };
check("Cursor: busy falls back to Cursor's own prompt", (await run(before, { command: "rmdir /s /q x" })).json?.permission === "ask");
check("Cursor: Agent Buddy not running allows", (await run(before, { command: "rm -rf build" }, dead)).json?.permission === "allow");
r = await run(hook("cursor", "hooks", "after-edit.mjs"), { file_path: "C:\\proj\\main.ts" });
check("Cursor: an edit shows the file name", r.calls.some((c) => c.body.message === "Edited main.ts" && c.body.agent === "Cursor"));
r = await run(hook("cursor", "hooks", "stop.mjs"), {});
check("Cursor: end of turn shows finished", r.calls.some((c) => c.body.state === "finished"));

server.close();
console.log(failures ? `\n${failures} FAILED` : "\nAll hook tests passed");
process.exit(failures ? 1 : 0);
