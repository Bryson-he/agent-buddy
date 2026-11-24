// Activity panel: every bot, what it is doing now, what it has done today, and
// its recent steps. Loads shared.js first for the agent colours.

type PanelKind = "idle" | "greeting" | "working" | "needsYou" | "error" | "finished" | "upload" | "answered" | "timedOut";
interface PanelEvent { t: number; kind: PanelKind; text: string }
interface PanelBot {
  name: string;
  kind: PanelKind;
  text: string;
  updatedAt: number;
  today: { finished: number; errors: number; questions: number };
  events: PanelEvent[];
}
interface PanelApi {
  get(): Promise<PanelBot[]>;
  colours(): Promise<Record<string, string>>;
  onUpdate(cb: (bots: PanelBot[]) => void): void;
}
interface Window {
  panelApi: PanelApi;
}

const KIND_LABEL: Record<PanelKind, string> = {
  idle: "Idle",
  greeting: "Idle",
  working: "Working",
  upload: "Uploading",
  needsYou: "Needs you",
  error: "Error",
  finished: "Finished",
  answered: "Answered",
  timedOut: "No answer",
};
const STEPS_SHOWN = 5;

const panelList = document.getElementById("bots")!;
const panelEmpty = document.getElementById("empty")!;
const expandedBots = new Set<string>();
let panelBots: PanelBot[] = [];

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function ago(t: number): string {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString([], { day: "numeric", month: "short" });
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderPanel(): void {
  panelEmpty.hidden = panelBots.length > 0;
  panelList.replaceChildren();
  for (const b of panelBots) {
    const key = keyOf(b.name);
    const card = el("article", "bot");
    card.dataset.kind = b.kind;
    card.style.setProperty("--bot", colourFor(key));

    const head = el("div", "head");
    head.appendChild(el("span", "face"));
    const title = el("div", "title");
    title.appendChild(el("div", "name", b.name));
    title.appendChild(el("div", "when", ago(b.updatedAt)));
    head.appendChild(title);
    head.appendChild(el("span", "chip", KIND_LABEL[b.kind]));
    card.appendChild(head);

    if (b.text) card.appendChild(el("div", "now", b.text));

    const t = b.today;
    const counts = [
      t.finished ? `${t.finished} finished` : "",
      t.errors ? `${t.errors} error${t.errors === 1 ? "" : "s"}` : "",
      t.questions ? `${t.questions} question${t.questions === 1 ? "" : "s"}` : "",
    ].filter(Boolean);
    card.appendChild(el("div", "today", counts.length ? `Today: ${counts.join(" · ")}` : "Nothing finished today yet"));

    const all = [...b.events].reverse(); // newest first
    const open = expandedBots.has(key);
    const steps = el("ol", "steps");
    for (const ev of open ? all : all.slice(0, STEPS_SHOWN)) {
      const li = el("li");
      li.dataset.kind = ev.kind;
      li.appendChild(el("time", undefined, clock(ev.t)));
      li.appendChild(el("span", "what", ev.text || KIND_LABEL[ev.kind]));
      steps.appendChild(li);
    }
    card.appendChild(steps);

    if (all.length > STEPS_SHOWN) {
      const more = el("button", "more", open ? "Show fewer" : `Show all ${all.length} steps`);
      more.type = "button";
      more.addEventListener("click", () => {
        if (open) expandedBots.delete(key); else expandedBots.add(key);
        renderPanel();
      });
      card.appendChild(more);
    }
    panelList.appendChild(card);
  }
}

function setPanelBots(bots: PanelBot[]): void {
  panelBots = bots;
  renderPanel();
}

window.panelApi.colours().then((c) => { setCustomColours(c); return window.panelApi.get(); }).then(setPanelBots);
window.panelApi.onUpdate(setPanelBots);
window.setInterval(renderPanel, 30_000); // keep "5 min ago" fresh
