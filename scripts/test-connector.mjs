// End-to-end test of the Agent Buddy connector against the running app.
// Start the app first with AGENT_BUDDY_DEV=1 (enables the test-only click/snapshot endpoints):
//   $env:AGENT_BUDDY_DEV="1"; npx electron .
// then: node scripts/test-connector.mjs [snapshotDir]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "http://127.0.0.1:47821";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const snapDir = process.argv[2];
let failures = 0;

function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}
const text = (r) => r.content.map((c) => c.text).join(" ");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const click = (choice) => fetch(`${BASE}/api/dev/click`, { method: "POST", body: JSON.stringify({ choice }) });
async function snap(name) {
  if (!snapDir) return;
  const res = await fetch(`${BASE}/api/dev/snapshot`);
  writeFileSync(path.join(snapDir, `${name}.png`), Buffer.from(await res.arrayBuffer()));
}

// 1. Health + browser protection (waits up to 20 s for the app to start)
let healthy = false;
for (let i = 0; i < 40 && !healthy; i++) {
  healthy = await fetch(`${BASE}/health`).then((r) => r.ok, () => false);
  if (!healthy) await sleep(500);
}
check("health endpoint", healthy);
if (!healthy) process.exit(1);
const blocked = await fetch(`${BASE}/health`, { headers: { origin: "https://evil.example" } });
check("requests from web pages are refused", blocked.status === 403, `status ${blocked.status}`);

// 2. HTTP MCP route
const http = new Client({ name: "test-http", version: "1.0.0" });
await http.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
const tools = (await http.listTools()).tools.map((t) => t.name).sort();
check("HTTP: lists set_status + ask_user", tools.join(",") === "ask_user,set_status", tools.join(","));
const s1 = await http.callTool({ name: "set_status", arguments: { state: "working", message: "Editing app.ts", agent: "Grok Bot" } });
check("HTTP: set_status works", text(s1).includes("working"), text(s1));
await sleep(700);
await snap("http-working");

const askHttp = http.callTool({ name: "ask_user", arguments: { question: "Delete the build folder?", agent: "Grok Bot", timeout_sec: 30 } });
await sleep(1200);
await snap("http-ask");
await click(0);
const a1 = await askHttp;
check("HTTP: ask_user returns Approve after click", text(a1).includes("Approve"), text(a1));
await http.close();

// 3. stdio bridge route (what Grok Bot / Cursor launch). Uses Electron as Node, like the copied config.
const electronExe = path.join(root, "node_modules", "electron", "dist", "electron.exe");
const stdio = new Client({ name: "test-stdio", version: "1.0.0" });
await stdio.connect(new StdioClientTransport({
  command: electronExe,
  args: [path.join(root, "dist", "mcp", "stdio-bridge.js")],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
}));
const s2 = await stdio.callTool({ name: "set_status", arguments: { state: "upload", message: "Uploading build.zip", agent: "Cursor" } });
check("stdio: set_status works", text(s2).includes("upload"), text(s2));

const askStdio = stdio.callTool({ name: "ask_user", arguments: { question: "Which branch?", options: ["main", "dev"], agent: "Cursor", timeout_sec: 30 } });
await sleep(1200);
await snap("stdio-ask-custom");
await click(1);
const a2 = await askStdio;
check("stdio: custom options, user picks 'dev'", text(a2).includes("dev"), text(a2));

const a3 = await stdio.callTool({ name: "ask_user", arguments: { question: "Nobody answers this", timeout_sec: 10 } });
check("stdio: unanswered question times out safely", text(a3).includes("did not answer"), text(a3));

const bad = await stdio.callTool({ name: "set_status", arguments: { state: "dancing" } });
check("invalid arguments are rejected", bad.isError === true);
await stdio.close();

await fetch(`${BASE}/api/status`, { method: "POST", body: JSON.stringify({ state: "finished", message: "Connector test done" }) });
console.log(failures ? `\n${failures} FAILED` : "\nAll connector tests passed");
process.exit(failures ? 1 : 0);
