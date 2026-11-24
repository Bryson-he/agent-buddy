// Quick start window: shown once on first launch, and from the tray menu.
// Top-level names start with "wl" because renderer scripts share one global scope.

interface WelcomeView {
  settings: {
    sounds?: boolean;
    notifications?: boolean;
    startWithWindows?: boolean;
    display?: number;
    glass?: boolean;
  };
  displays: { index: number; label: string }[];
  version: string;
  tunnel: { state: string; url: string | null };
  aiPrompt: string;
}
interface WelcomeApi {
  get(): Promise<WelcomeView>;
  set(patch: Record<string, unknown>): Promise<unknown>;
  copy(what: string, arg?: string): Promise<boolean>;
  setTunnel(on: boolean): Promise<WelcomeView>;
  demo(): void;
  testSound(name: string): void;
  open(what: string): void;
  done(): void;
}
interface Window {
  welcomeApi: WelcomeApi;
}

const wlGet = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const wlPages = Array.from(document.querySelectorAll<HTMLElement>(".page"));
const wlStepButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("#wl-steps button"));
const wlBack = wlGet<HTMLButtonElement>("wl-back");
const wlNext = wlGet<HTMLButtonElement>("wl-next");
const wlToast = wlGet<HTMLElement>("wl-toast");
const wlDisplay = wlGet<HTMLSelectElement>("wl-display");
const wlGlass = wlGet<HTMLInputElement>("wl-glass");
const wlSounds = wlGet<HTMLInputElement>("wl-sounds");
const wlNotifications = wlGet<HTMLInputElement>("wl-notifications");
const wlStart = wlGet<HTMLInputElement>("wl-start");
const wlTunnel = wlGet<HTMLInputElement>("wl-tunnel");
const wlTunnelState = wlGet<HTMLElement>("wl-tunnel-state");
let wlStep = 0;
let wlToastTimer: number | undefined;

function wlSay(text: string, bad = false): void {
  wlToast.textContent = text;
  wlToast.style.color = bad ? "#fbbf24" : "";
  window.clearTimeout(wlToastTimer);
  wlToastTimer = window.setTimeout(() => { wlToast.textContent = ""; }, 2600);
}

function wlShow(step: number): void {
  wlStep = Math.min(wlPages.length - 1, Math.max(0, step));
  wlPages.forEach((p, i) => { p.hidden = i !== wlStep; });
  wlStepButtons.forEach((b, i) => {
    b.classList.toggle("current", i === wlStep);
    b.classList.toggle("done", i < wlStep);
    if (i === wlStep) b.setAttribute("aria-current", "step");
    else b.removeAttribute("aria-current");
  });
  wlBack.disabled = wlStep === 0;
  wlNext.textContent = wlStep === wlPages.length - 1 ? "Finish" : "Next";
  wlGet<HTMLElement>("wl-pages").scrollTop = 0;
}

function wlFill(view: WelcomeView): void {
  const s = view.settings;
  wlDisplay.replaceChildren();
  for (const d of view.displays) {
    const o = document.createElement("option");
    o.value = String(d.index);
    o.textContent = d.label;
    wlDisplay.appendChild(o);
  }
  wlDisplay.value = String(Math.min(view.displays.length - 1, Math.max(0, s.display ?? 0)));
  wlDisplay.disabled = view.displays.length < 2;
  wlGlass.checked = s.glass !== false;
  wlSounds.checked = s.sounds !== false;
  wlNotifications.checked = s.notifications !== false;
  wlStart.checked = s.startWithWindows === true;
  wlGet<HTMLTextAreaElement>("wl-prompt").value = view.aiPrompt;
  wlFillTunnel(view);
}

function wlFillTunnel(view: WelcomeView): void {
  const t = view.tunnel;
  wlTunnel.checked = t.state === "on" || t.state === "starting";
  wlTunnelState.textContent = t.state === "on" ? "On" : t.state === "starting" ? "Starting…" : t.state === "error" ? "Could not start (is cloudflared installed?)" : "Off";
}

async function wlSave(patch: Record<string, unknown>): Promise<void> {
  await window.welcomeApi.set(patch);
  wlSay("Saved");
}

wlDisplay.addEventListener("change", () => wlSave({ display: Number(wlDisplay.value) }));
wlGlass.addEventListener("change", () => wlSave({ glass: wlGlass.checked }));
wlSounds.addEventListener("change", () => wlSave({ sounds: wlSounds.checked }));
wlNotifications.addEventListener("change", () => wlSave({ notifications: wlNotifications.checked }));
wlStart.addEventListener("change", () => wlSave({ startWithWindows: wlStart.checked }));
wlGet<HTMLButtonElement>("wl-try-sound").addEventListener("click", (ev) => { ev.preventDefault(); window.welcomeApi.testSound("finished"); });
wlGet<HTMLButtonElement>("wl-demo").addEventListener("click", () => { window.welcomeApi.demo(); wlSay("Playing: look at the top of your screen"); });

wlTunnel.addEventListener("change", async () => {
  wlTunnelState.textContent = wlTunnel.checked ? "Starting…" : "Stopping…";
  wlFillTunnel(await window.welcomeApi.setTunnel(wlTunnel.checked));
  // The address takes a few seconds to arrive.
  if (wlTunnel.checked) window.setTimeout(async () => wlFillTunnel(await window.welcomeApi.get()), 6000);
});

for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>("[data-copy]"))) {
  btn.addEventListener("click", async () => {
    const what = btn.dataset.copy ?? "";
    const ok = await window.welcomeApi.copy(what, what === "skill" ? wlGet<HTMLInputElement>("wl-bot-name").value : undefined);
    if (ok) wlSay("Copied");
    else wlSay(what === "serverUrl" ? "Switch the tunnel on first" : "Nothing to copy yet", true);
  });
}
for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>("[data-open]"))) {
  btn.addEventListener("click", () => window.welcomeApi.open(btn.dataset.open ?? ""));
}
wlStepButtons.forEach((b, i) => b.addEventListener("click", () => wlShow(i)));
wlBack.addEventListener("click", () => wlShow(wlStep - 1));
wlNext.addEventListener("click", () => {
  if (wlStep === wlPages.length - 1) window.welcomeApi.done();
  else wlShow(wlStep + 1);
});

wlShow(0);
window.welcomeApi.get().then(wlFill);
