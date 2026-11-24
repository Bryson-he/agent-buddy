// Tests the public tunnel: the right token gets in, everything else is refused,
// and ask_user works through the tunnel (with a timed click via the local API).
// Start the app with the tunnel on and a throwaway token:
//   $env:AGENT_BUDDY_TOKEN="test-token-123"; $env:AGENT_BUDDY_DEV="1"; npx electron .
//   (tunnel enabled in the tray)
// then: $env:AGENT_BUDDY_TOKEN="test-token-123"; node scripts/test-tunnel.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const LOCAL = "http://127.0.0.1:47821";
const token = process.env.AGENT_BUDDY_TOKEN;
let failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); if (!ok) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let url = null;
for (let i = 0; i < 60 && !url; i++) {
  url = await fetch(`${LOCAL}/api/tunnel`).then((r) => r.json()).then((j) => j.url, () => null);
  if (!url) await sleep(1000);
}
check("tunnel has a public address", !!url, url ?? "none after 60 s");
if (!url || !token) process.exit(1);

let reachable = false;
for (let i = 0; i < 30 && !reachable; i++) {
  reachable = await fetch(`${url}/mcp`, { method: "POST" }).then((r) => r.status === 401, () => false);
  if (!reachable) await sleep(2000);
}
check("no token → 401", reachable);

const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } };
const post = (path, headers = {}) => fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(init) });

check("wrong token → 401", (await post("/mcp", { authorization: "Bearer wrong" })).status === 401);
check("status API is not exposed", (await post("/api/status", { authorization: `Bearer ${token}` })).status === 404);
check("health is not exposed", (await fetch(`${url}/health`)).status === 404);
check("dev endpoints are not exposed", (await post("/api/dev/click", { authorization: `Bearer ${token}` })).status === 404);
check("spoofed local Host is still treated as remote", (await post("/api/status", { "x-forwarded-host": "127.0.0.1:47821" })).status === 404);

const client = new Client({ name: "test-tunnel", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
const tools = (await client.listTools()).tools.map((t) => t.name).sort().join(",");
check("right token: lists tools through the tunnel", tools === "ask_user,set_status", tools);
const r = await client.callTool({ name: "set_status", arguments: { state: "working", message: "Hello through the tunnel", agent: "Tunnel test", next: "Then finish" } });
check("right token: set_status works through the tunnel", r.content[0].text.includes("working"));

// ask_user through the tunnel: start the call, then click Approve via local DEV API.
const askPromise = client.callTool({
  name: "ask_user",
  arguments: { question: "Tunnel ask OK?", options: ["Approve", "Deny"], agent: "Tunnel test", timeout_sec: 30 },
});
await sleep(800);
const clicked = await fetch(`${LOCAL}/api/dev/click`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ choice: 0 }),
}).then((res) => res.ok, () => false);
check("dev click available for ask_user test (AGENT_BUDDY_DEV=1)", clicked, clicked ? "" : "start app with AGENT_BUDDY_DEV=1");
const askResult = await askPromise;
const askText = askResult.content?.[0]?.text ?? "";
check("ask_user works through the tunnel", /chose:\s*Approve/i.test(askText), askText.slice(0, 80));

// Concurrent ask should be rejected as busy (not hang).
const busy = await client.callTool({
  name: "ask_user",
  arguments: { question: "Should be busy if somehow still asking", agent: "Tunnel test", timeout_sec: 10 },
});
// After previous answered, this should succeed or be a normal timeout path — fire a second while one is open:
const hold = client.callTool({
  name: "ask_user",
  arguments: { question: "Hold the notch", options: ["Yes", "No"], agent: "Tunnel A", timeout_sec: 15 },
});
await sleep(500);
const busy2 = await client.callTool({
  name: "ask_user",
  arguments: { question: "Concurrent?", agent: "Tunnel B", timeout_sec: 10 },
});
const busyText = busy2.content?.[0]?.text ?? "";
check("concurrent ask_user is rejected as busy", /already waiting/i.test(busyText), busyText.slice(0, 100));
await fetch(`${LOCAL}/api/dev/click`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ choice: 1 }),
}).catch(() => undefined);
await hold.catch(() => undefined);
void busy;

await client.close();

console.log(failures ? `\n${failures} FAILED` : "\nAll tunnel tests passed");
process.exit(failures ? 1 : 0);
