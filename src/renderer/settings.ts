// Settings window. Every control saves as soon as it changes.

interface SettingsView {
  settings: {
    sounds?: boolean;
    volume?: number;
    notifications?: boolean;
    shortcuts?: boolean;
    startWithWindows?: boolean;
    display?: number;
    lingerFinishedMin?: number;
    glass?: boolean;
    agentColours?: Record<string, string>;
    agentShapes?: Record<string, string>;
    riveCharacter?: boolean;
    awayAfterMin?: number;
  };
  agents: { key: string; name: string }[];
  displays: { index: number; label: string }[];
  shortcutKeys: { first: string; second: string; toggle: string; panel: string };
  rules: { agent: string; question: string; answer: string; at: number }[];
}
interface SettingsApi {
  get(): Promise<SettingsView>;
  set(patch: Record<string, unknown>): Promise<SettingsView>;
  forgetRule(agent: string, question: string): Promise<SettingsView>;
  testSound(name: string): void;
}
interface Window {
  settingsApi: SettingsApi;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const sounds = $<HTMLInputElement>("sounds");
const volumeEl = $<HTMLInputElement>("volume");
const volumeOut = $<HTMLOutputElement>("volume-out");
const notifications = $<HTMLInputElement>("notifications");
const shortcuts = $<HTMLInputElement>("shortcuts");
const startWithWindows = $<HTMLInputElement>("startWithWindows");
const display = $<HTMLSelectElement>("display");
const linger = $<HTMLSelectElement>("linger");
const glassEl = $<HTMLInputElement>("glass");
const riveEl = $<HTMLInputElement>("riveCharacter");
const awayEl = $<HTMLSelectElement>("awayAfterMin");
const keysHint = $<HTMLElement>("keys-hint");
const saved = $<HTMLElement>("saved");
const rulesEl = $<HTMLElement>("rules");
const rulesEmpty = $<HTMLElement>("rules-empty");
const agentsEl = $<HTMLElement>("agents");
const agentsEmpty = $<HTMLElement>("agents-empty");

let savedTimer: number | undefined;
function flashSaved(): void {
  saved.textContent = "Saved";
  window.clearTimeout(savedTimer);
  savedTimer = window.setTimeout(() => { saved.textContent = ""; }, 1400);
}

function showSettings(view: SettingsView): void {
  const s = view.settings;
  sounds.checked = s.sounds !== false;
  const vol = Math.round((typeof s.volume === "number" ? s.volume : 0.6) * 100);
  volumeEl.value = String(vol);
  volumeOut.textContent = `${vol}%`;
  volumeEl.disabled = !sounds.checked;
  notifications.checked = s.notifications !== false;
  shortcuts.checked = s.shortcuts !== false;
  startWithWindows.checked = s.startWithWindows === true;

  display.replaceChildren();
  for (const d of view.displays) {
    const o = document.createElement("option");
    o.value = String(d.index);
    o.textContent = d.label;
    display.appendChild(o);
  }
  display.value = String(Math.min(view.displays.length - 1, Math.max(0, s.display ?? 0)));
  display.disabled = view.displays.length < 2;

  linger.value = String(s.lingerFinishedMin ?? 5);
  glassEl.checked = s.glass !== false;
  riveEl.checked = s.riveCharacter === true;
  awayEl.value = String(s.awayAfterMin ?? 5);
  const k = view.shortcutKeys;
  keysHint.textContent = `${k.first} and ${k.second} answer a question. ${k.toggle} shows or hides the notch. ${k.panel} opens Activity.`;

  // A shape and a colour per agent. "Reset" goes back to the built-in look.
  const custom = s.agentColours ?? {};
  const shapes = s.agentShapes ?? {};
  agentsEl.replaceChildren();
  agentsEmpty.hidden = view.agents.length > 0;
  for (const a of view.agents) {
    const row = document.createElement("div");
    row.className = "row agent";
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = a.name;
    const controls = document.createElement("span");
    controls.className = "colour";
    // Shape
    const shapeSel = document.createElement("select");
    shapeSel.className = "shape";
    shapeSel.setAttribute("aria-label", `Shape for ${a.name}`);
    for (const name of ["", ...SHAPE_NAMES]) {
      const o = document.createElement("option");
      o.value = name;
      o.textContent = name === "" ? "Default shape" : name[0].toUpperCase() + name.slice(1);
      shapeSel.appendChild(o);
    }
    shapeSel.value = shapes[a.key] ?? "";
    shapeSel.addEventListener("change", () => save({ agentShapes: { [a.key]: shapeSel.value === "" ? null : shapeSel.value } }));
    controls.appendChild(shapeSel);
    // Ready-made colours, then the picker for anything else
    const swatches = document.createElement("span");
    swatches.className = "swatches";
    const current = (custom[a.key] ?? defaultColourFor(a.key)).toLowerCase();
    for (const c of PALETTE) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "swatch";
      b.style.background = c;
      b.title = c;
      b.setAttribute("aria-label", `${a.name}: ${c}`);
      if (c === current) b.setAttribute("aria-pressed", "true");
      b.addEventListener("click", () => save({ agentColours: { [a.key]: c } }));
      swatches.appendChild(b);
    }
    controls.appendChild(swatches);
    const picker = document.createElement("input");
    picker.type = "color";
    picker.value = custom[a.key] ?? defaultColourFor(a.key);
    picker.setAttribute("aria-label", `Colour for ${a.name}`);
    picker.addEventListener("change", () => save({ agentColours: { [a.key]: picker.value } }));
    controls.appendChild(picker);
    if (custom[a.key] || shapes[a.key]) {
      const reset = document.createElement("button");
      reset.type = "button";
      reset.textContent = "Reset";
      reset.addEventListener("click", () => save({ agentColours: { [a.key]: null }, agentShapes: { [a.key]: null } }));
      controls.appendChild(reset);
    }
    row.append(label, controls);
    agentsEl.appendChild(row);
  }

  // Answers remembered with "Always", each with a way to forget it.
  rulesEl.replaceChildren();
  rulesEmpty.hidden = view.rules.length > 0;
  for (const r of view.rules) {
    const row = document.createElement("div");
    row.className = "row rule";
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = `Always “${r.answer}”`;
    const small = document.createElement("small");
    small.textContent = `${r.agent}: ${r.question}`;
    small.title = r.question;
    label.appendChild(small);
    const forget = document.createElement("button");
    forget.type = "button";
    forget.textContent = "Forget";
    forget.addEventListener("click", async () => {
      showSettings(await window.settingsApi.forgetRule(r.agent, r.question));
      flashSaved();
    });
    row.append(label, forget);
    rulesEl.appendChild(row);
  }
}

async function save(patch: Record<string, unknown>): Promise<void> {
  showSettings(await window.settingsApi.set(patch));
  flashSaved();
}

sounds.addEventListener("change", () => save({ sounds: sounds.checked }));
volumeEl.addEventListener("input", () => { volumeOut.textContent = `${volumeEl.value}%`; });
volumeEl.addEventListener("change", async () => {
  await save({ volume: Number(volumeEl.value) / 100 });
  window.settingsApi.testSound("finished");
});
notifications.addEventListener("change", () => save({ notifications: notifications.checked }));
shortcuts.addEventListener("change", () => save({ shortcuts: shortcuts.checked }));
startWithWindows.addEventListener("change", () => save({ startWithWindows: startWithWindows.checked }));
display.addEventListener("change", () => save({ display: Number(display.value) }));
linger.addEventListener("change", () => save({ lingerFinishedMin: Number(linger.value) }));
glassEl.addEventListener("change", () => save({ glass: glassEl.checked }));
riveEl.addEventListener("change", () => save({ riveCharacter: riveEl.checked }));
awayEl.addEventListener("change", () => save({ awayAfterMin: Number(awayEl.value) }));

for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>("[data-sound]"))) {
  btn.addEventListener("click", () => window.settingsApi.testSound(btn.dataset.sound ?? "finished"));
}

window.settingsApi.get().then(showSettings);
