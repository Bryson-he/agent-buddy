// Tests the Route B (xAI API) chat loop against a fake xAI server: model
// picking, local tool execution, and error messages. No API key needed.
//   node scripts/test-grok-loop.mjs
import { pickModel, runGrokChat } from "../dist/main/grok.js";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Fake xAI: first asks for set_status, then ask_user, then replies using the answer.
function fakeXai() {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.endsWith("/models")) {
      return json({ data: [
        { id: "grok-2-image", created: 300 },
        { id: "grok-3", created: 100 },
        { id: "grok-4.5", created: 200 },
      ] });
    }
    const body = JSON.parse(init.body);
    requests.push(body);
    const step = requests.length;
    if (step === 1) return json({ choices: [{ message: { content: "", tool_calls: [
      { id: "c1", type: "function", function: { name: "set_status", arguments: JSON.stringify({ state: "working", message: "Checking files" }) } },
    ] } }] });
    if (step === 2) return json({ choices: [{ message: { content: null, tool_calls: [
      { id: "c2", type: "function", function: { name: "ask_user", arguments: JSON.stringify({ question: "Delete temp files?" }) } },
    ] } }] });
    const last = body.messages.at(-1);
    return json({ choices: [{ message: { content: `Done. Tool said: ${last.content}` } }] });
  };
  return { fetchImpl, requests };
}

const calls = [];
const backend = {
  setStatus: async (a) => { calls.push(["setStatus", a]); },
  askUser: async (a) => { calls.push(["askUser", a]); return { answer: "Approve" }; },
};

const { fetchImpl, requests } = fakeXai();
check("picks newest Grok chat model (skips image models)", (await pickModel("k", "https://fake", fetchImpl)) === "grok-4.5");

const out = await runGrokChat({ apiKey: "k", model: "grok-4.5", baseUrl: "https://fake", fetchImpl, backend,
  messages: [{ role: "user", content: "Clean up my temp files" }] });
check("runs set_status locally", calls[0]?.[0] === "setStatus" && calls[0][1].agent === "Grok", JSON.stringify(calls[0]));
check("runs ask_user locally", calls[1]?.[0] === "askUser" && calls[1][1].question === "Delete temp files?");
check("feeds the user's answer back to Grok", out.reply.includes("The user chose: Approve"), out.reply);
check("reports which tools were used", out.toolCalls.join(",") === "set_status,ask_user", out.toolCalls.join(","));
check("sends tool definitions to xAI", requests[0].tools.map((t) => t.function.name).join(",") === "set_status,ask_user");
check("tool schema has no $schema key", !("$schema" in requests[0].tools[0].function.parameters));
check("sends system prompt first", requests[0].messages[0].role === "system");

const badKey = async () => json({ error: "bad key" }, 401);
let msg = "";
try { await pickModel("nope", "https://fake", badKey); } catch (e) { msg = e.message; }
check("bad key gives a clear message", msg.includes("rejected the API key"), msg);

console.log(failures ? `\n${failures} FAILED` : "\nAll Grok loop tests passed");
process.exit(failures ? 1 : 0);
