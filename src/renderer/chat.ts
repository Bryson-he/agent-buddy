// "Ask Grok" window: key setup + a simple chat. All API calls happen in main.

type ChatMessage = { role: "user" | "assistant"; content: string };
interface GrokApi {
  hasKey(): Promise<boolean>;
  saveKey(key: string): Promise<{ ok: true; model: string } | { error: string }>;
  clearKey(): Promise<void>;
  chat(messages: ChatMessage[]): Promise<{ reply: string; toolCalls: string[] } | { error: string }>;
  cancel(): Promise<{ ok: true }>;
}
interface Window {
  grok: GrokApi;
}

const setupEl = document.getElementById("setup")!;
const chatEl = document.getElementById("chat")!;
const keyInput = document.getElementById("key") as HTMLInputElement;
const keyError = document.getElementById("key-error")!;
const saveBtn = document.getElementById("save-key") as HTMLButtonElement;
const log = document.getElementById("log")!;
const form = document.getElementById("composer") as HTMLFormElement;
const input = document.getElementById("input") as HTMLTextAreaElement;
const sendBtn = document.getElementById("send") as HTMLButtonElement;
const cancelBtn = document.getElementById("cancel") as HTMLButtonElement;
const clearBtn = document.getElementById("clear-chat") as HTMLButtonElement;
const changeKey = document.getElementById("change-key")!;
const modelEl = document.getElementById("model")!;

const conversation: ChatMessage[] = [];
let inFlight = false;

function show(view: "setup" | "chat"): void {
  setupEl.hidden = view !== "setup";
  chatEl.hidden = view !== "chat";
  (view === "setup" ? keyInput : input).focus();
}

function addBubble(kind: "user" | "assistant" | "note" | "error", text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = `bubble ${kind}`;
  el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

function setBusy(on: boolean): void {
  inFlight = on;
  sendBtn.disabled = on;
  cancelBtn.hidden = !on;
  input.disabled = on;
}

saveBtn.addEventListener("click", async () => {
  const key = keyInput.value.trim();
  if (!key) return;
  saveBtn.disabled = true;
  keyError.textContent = "Checking the key with xAI…";
  const res = await window.grok.saveKey(key);
  saveBtn.disabled = false;
  if ("error" in res) {
    keyError.textContent = res.error;
    return;
  }
  keyInput.value = "";
  keyError.textContent = "";
  modelEl.textContent = res.model;
  show("chat");
  addBubble("note", `Connected. Using model ${res.model}.`);
});

changeKey.addEventListener("click", async () => {
  await window.grok.clearKey();
  modelEl.textContent = "";
  show("setup");
});

clearBtn.addEventListener("click", () => {
  conversation.length = 0;
  log.replaceChildren();
  addBubble("note", "New chat.");
});

cancelBtn.addEventListener("click", async () => {
  await window.grok.cancel();
  setBusy(false);
  addBubble("note", "Cancelled.");
});

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const text = input.value.trim();
  if (!text || inFlight) return;
  input.value = "";
  conversation.push({ role: "user", content: text });
  addBubble("user", text);
  const pending = addBubble("note", "Grok is thinking…");
  setBusy(true);

  const res = await window.grok.chat(conversation);
  pending.remove();
  setBusy(false);
  if ("error" in res) {
    if (res.error !== "Cancelled.") conversation.pop();
    addBubble("error", res.error);
    return;
  }
  if (res.toolCalls.length) addBubble("note", `Used on your buddy: ${res.toolCalls.join(", ")}`);
  conversation.push({ role: "assistant", content: res.reply });
  addBubble("assistant", res.reply);
  input.focus();
});

input.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault();
    form.requestSubmit();
  }
});

window.grok.hasKey().then((has) => show(has ? "chat" : "setup"));
