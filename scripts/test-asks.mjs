// Tests the question queue and the notification-button links against the running app.
// Start the app in dev mode first:
//   $env:AGENT_BUDDY_DEV="1"; npx electron .
// then: node scripts/test-asks.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const BASE = "http://127.0.0.1:47821";
let failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); if (!ok) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ask = (body) => fetch(`${BASE}/api/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const askDetached = (body, sec) => fetch(`${BASE}/api/ask?detach_sec=${sec}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const option = (index) => fetch(`${BASE}/api/dev/option`, { method: "POST", body: JSON.stringify({ index }) });
const click = (choice) => fetch(`${BASE}/api/dev/click`, { method: "POST", body: JSON.stringify({ choice }) });
const current = () => fetch(`${BASE}/api/dev/ask`).then((r) => r.json()).then((j) => j.ask);
const openLink = (url) => spawn("cmd", ["/c", "start", "", url], { windowsHide: true, stdio: "ignore" });

let up = false;
for (let i = 0; i < 40 && !up; i++) { up = await fetch(`${BASE}/health`).then((r) => r.ok, () => false); if (!up) await sleep(500); }
check("app is running", up);
if (!up) process.exit(1);
const dev = await fetch(`${BASE}/api/dev/ask`).then((r) => r.ok, () => false);
check("app is in dev mode", dev, "start it with AGENT_BUDDY_DEV=1");
if (!dev) process.exit(1);

// 1. Two agents ask at once: the second waits its turn, each gets its own answer.
const a = ask({ question: "First question?", options: ["Yes A", "No A"], agent: "Test A", timeout_sec: 30 });
await sleep(400);
const b = ask({ question: "Second question?", options: ["Yes B", "No B"], agent: "Test B", timeout_sec: 30 });
await sleep(800);
let cur = await current();
check("first asker is on screen, second is queued", cur?.agent === "Test A" && cur?.queued === 1, JSON.stringify(cur));
await click(0);
const ra = await a;
check("first asker gets its own first option", ra.answer === "Yes A" && !ra.busy, JSON.stringify(ra));
await sleep(800);
cur = await current();
check("second question is shown next", cur?.agent === "Test B" && cur?.queued === 0, JSON.stringify(cur));
await click(1);
const rb = await b;
check("second asker gets its own second option", rb.answer === "No B", JSON.stringify(rb));

// 2. A queued question gives up when its own time runs out, without disturbing the one on screen.
const c = ask({ question: "On screen", agent: "Test C", timeout_sec: 30 });
await sleep(400);
const t0 = Date.now();
const d = await ask({ question: "Queued, short wait", agent: "Test D", timeout_sec: 10 });
const waited = (Date.now() - t0) / 1000;
check("queued question times out on its own clock", d.timedOut === true && d.answer === null && waited > 8 && waited < 14, `${waited.toFixed(1)} s`);
cur = await current();
check("question on screen is still there", cur?.agent === "Test C", JSON.stringify(cur));

// 3. Notification button links: the right one-time code answers, a wrong one does not.
openLink(`agentbuddy://answer/0?n=${"0".repeat(24)}`);
await sleep(2500);
cur = await current();
check("link with a wrong code is ignored", cur?.agent === "Test C");
openLink(`agentbuddy://answer/1?n=${cur.nonce}`);
const rc = await Promise.race([c, sleep(8000).then(() => null)]);
check("link with the right code answers (second option)", rc?.answer === "Deny", JSON.stringify(rc));

// 4. The queue has a limit: beyond it, callers are told "busy" at once.
const hold = ask({ question: "Holding", agent: "Test H", timeout_sec: 20 });
await sleep(300);
const waiting = [];
for (let i = 0; i < 5; i++) waiting.push(ask({ question: `Queued ${i}`, agent: `Test Q${i}`, timeout_sec: 20 }));
await sleep(600);
const over = await ask({ question: "One too many", agent: "Test X", timeout_sec: 20 });
check("a full queue answers busy at once", over.busy === true, JSON.stringify(over));
for (let i = 0; i < 6; i++) { await click(0); await sleep(500); }
const all = await Promise.all([hold, ...waiting]);
check("every queued question was answered in turn", all.every((r) => r.answer === "Approve"), all.map((r) => r.answer).join(","));

// 5. "Always": the remembered answer is given at once next time, for that exact question only.
const rulesPath = path.join(process.env.APPDATA ?? "", "agent-buddy", "rules.json");
const dropTestRules = () => {
  try {
    const rules = JSON.parse(fs.readFileSync(rulesPath, "utf8"));
    fs.writeFileSync(rulesPath, JSON.stringify(rules.filter((r) => !String(r.agent).startsWith("test ")), null, 2));
  } catch { /* no rules file yet */ }
};
dropTestRules();
const first = ask({ question: "Send the daily report?", options: ["Send", "Hold"], agent: "Test R", timeout_sec: 20 });
await sleep(800);
await click(2); // the "Always" button
check("Always answers with the first option", (await first).answer === "Send");
const t1 = Date.now();
const again = await ask({ question: "  send the DAILY report? ", options: ["Send", "Hold"], agent: "Test R", timeout_sec: 20 });
check("the same question is then answered at once, without asking", again.answer === "Send" && Date.now() - t1 < 1500 && (await current()) === null, `${Date.now() - t1} ms`);
const other = ask({ question: "Send the weekly report?", options: ["Send", "Hold"], agent: "Test R", timeout_sec: 20 });
await sleep(800);
check("a different question is still asked", (await current())?.agent === "Test R");
await click(1);
check("and gets its own answer", (await other).answer === "Hold");
const otherBot = ask({ question: "Send the daily report?", options: ["Send", "Hold"], agent: "Test S", timeout_sec: 20 });
await sleep(800);
check("another bot asking the same thing is still asked", (await current())?.agent === "Test S");
await click(1);
await otherBot;
dropTestRules();

// 6. Typed answers.
const typed = ask({ question: "Which row should I update?", free_text: true, agent: "Test T", timeout_sec: 20 });
await sleep(800);
await click(0); // buttons are hidden for a typed answer; a stray click must not answer it
await sleep(500);
check("a button click does not answer a typed question", (await current())?.agent === "Test T");
await fetch(`${BASE}/api/dev/text`, { method: "POST", body: JSON.stringify({ text: "  Row 12,   please  " }) });
const rt = await Promise.race([typed, sleep(5000).then(() => null)]);
check("the typed text comes back, tidied", rt?.answer === "Row 12, please", JSON.stringify(rt));

// 7. A list of answers: three choices plus "Something else".
const LIST = ["Change company and delete the Restricted copy, then continue", "Change company and keep the copy, then continue", "I'll fix it myself; keep going on the others"];
const list1 = ask({ question: "How should I handle object 123 (row 516)?", options: LIST, allow_other: true, agent: "Test L", timeout_sec: 20 });
await sleep(900);
await option(1);
const rl1 = await Promise.race([list1, sleep(5000).then(() => null)]);
check("a list question returns the row that was clicked", rl1?.answer === LIST[1], JSON.stringify(rl1));
const list2 = ask({ question: "How should I handle object 124?", options: LIST, allow_other: true, agent: "Test L", timeout_sec: 20 });
await sleep(900);
await option(-1); // "Something else" opens the text box
await sleep(400);
await fetch(`${BASE}/api/dev/text`, { method: "POST", body: JSON.stringify({ text: "Skip it for now" }) });
const rl2 = await Promise.race([list2, sleep(5000).then(() => null)]);
check("\"Something else\" returns what was typed", rl2?.answer === "Skip it for now", JSON.stringify(rl2));
const list3 = ask({ question: "Pick one of four", options: ["One", "Two", "Three", "Four"], agent: "Test L", timeout_sec: 20 });
await sleep(900);
await fetch(`${BASE}/api/dev/text`, { method: "POST", body: JSON.stringify({ text: "typed" }) }).catch(() => {});
await sleep(400);
check("a list without \"Something else\" does not take typed text", (await current())?.agent === "Test L");
openLink(`agentbuddy://answer/3?n=${(await current()).nonce}`);
const rl3 = await Promise.race([list3, sleep(6000).then(() => null)]);
check("a notification link can pick the fourth answer", rl3?.answer === "Four", JSON.stringify(rl3));
const bad = await fetch(`${BASE}/api/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "Too many", options: ["1", "2", "3", "4", "5"], agent: "Test L" }) });
check("more than four answers is refused", bad.status === 400);

// 8. A slow answer: the request is handed back as "pending", the question stays up, asking again picks it up.
const SLOW = { question: "Slow one: which way?", options: ["Left", "Right", "Straight on"], agent: "Test P", timeout_sec: 60 };
const p1 = await askDetached(SLOW, 3);
check("a request is handed back as pending, not timed out", p1.pending === true && p1.answer === null && p1.timedOut === false, JSON.stringify(p1));
check("the question is still on screen", (await current())?.agent === "Test P");
const p2wait = askDetached(SLOW, 30);
await sleep(700);
check("asking again does not show it twice", (await current())?.queued === 0, JSON.stringify(await current()));
await option(2);
const p2 = await Promise.race([p2wait, sleep(5000).then(() => null)]);
check("asking again gets the answer", p2?.answer === "Straight on" && p2?.pending === false, JSON.stringify(p2));
// Answered while nobody was waiting: the next ask gets it at once.
const p3 = await askDetached({ ...SLOW, question: "Slow two: which way?" }, 3);
check("second slow question goes pending", p3.pending === true);
await option(0);
await sleep(500);
const t3 = Date.now();
const p4 = await askDetached({ ...SLOW, question: "Slow two: which way?" }, 30);
check("an answer given in between is handed over at once", p4.answer === "Left" && Date.now() - t3 < 1500 && (await current()) === null, JSON.stringify(p4));

// 9. The Activity panel's history saw all of it.
const hist = (await fetch(`${BASE}/api/history`).then((r) => r.json())).bots;
const botT = hist.find((b) => b.name === "Test T");
check("history records the question and the answer", botT?.events.some((e) => e.kind === "needsYou") && botT?.events.some((e) => e.kind === "answered" && /Row 12/.test(e.text)), JSON.stringify(botT?.events?.map((e) => e.kind)));
check("history counts today's questions", botT?.today.questions === 1);

await fetch(`${BASE}/api/status`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: "idle", agent: "Test A" }) });
// Leave no test bots behind in the activity log (the Activity panel is rebuilt from it at start).
try {
  const logPath = path.join(process.env.APPDATA ?? "", "agent-buddy", "activity.log");
  const kept = fs.readFileSync(logPath, "utf8").split("\n").filter((l) => !/"agent":"(Test [A-Z]\d?|Key Test)"/.test(l));
  fs.writeFileSync(logPath, kept.join("\n"));
} catch { /* nothing to tidy */ }

console.log(failures ? `\n${failures} FAILED` : "\nAll question tests passed");
process.exit(failures ? 1 : 0);
