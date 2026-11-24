// Optional smoke test for Ask Grok with a real xAI key.
// Usage:
//   $env:XAI_API_KEY="xai-…"; node scripts/smoke-ask-grok.mjs
// Skips (exit 0) when no key is set so CI / local runs stay green.
const key = process.env.XAI_API_KEY;
if (!key) {
  console.log("SKIP  no XAI_API_KEY — set it to run a real Ask Grok smoke test");
  process.exit(0);
}

const base = process.env.XAI_BASE_URL ?? "https://api.x.ai/v1";
const models = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${key}` } });
if (!models.ok) {
  console.error("FAIL  models:", models.status, await models.text());
  process.exit(1);
}
const list = (await models.json()).data ?? [];
const chat = list.filter((m) => /^grok/i.test(m.id) && !/image|imagine|vision|video|tts|voice|embed/i.test(m.id));
chat.sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
if (!chat.length) {
  console.error("FAIL  no chat models");
  process.exit(1);
}
const model = chat[0].id;
console.log("PASS  model", model);

const res = await fetch(`${base}/chat/completions`, {
  method: "POST",
  headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
  body: JSON.stringify({
    model,
    messages: [
      { role: "system", content: "Reply with exactly: pong" },
      { role: "user", content: "ping" },
    ],
  }),
});
if (!res.ok) {
  console.error("FAIL  chat:", res.status, await res.text());
  process.exit(1);
}
const data = await res.json();
const reply = data.choices?.[0]?.message?.content ?? "";
console.log("PASS  chat reply:", reply.slice(0, 80));
console.log("\nAsk Grok API smoke OK (run the app tray → Ask Grok to exercise tools on the notch).");
process.exit(0);
