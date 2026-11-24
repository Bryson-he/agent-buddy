// Agent Buddy character, drawn as a notch.
//
// Several agents can report at once. The one that most needs attention is the
// "lead": it gets the big face, its name and its status. The others collapse to
// a face and the line they are working on.
//
// The character is one shaded ball with two eyes. Nothing ever snaps: the eye
// shape, where the eyes sit on the ball, and the body's position, squash and
// roll are all springs that chase a target. A new state only changes the
// targets, so one state flows into the next, and a reaction (slap, annoyed,
// dizzy) can interrupt and hand back without a jump.

type AgentState = "idle" | "greeting" | "working" | "needsYou" | "error" | "finished" | "upload";
type Reaction = "none" | "annoyed" | "slap" | "dizzy";
type Mood = AgentState | Exclude<Reaction, "none">;

interface BuddyApi {
  onState(cb: (s: { state: AgentState; text?: string; agent?: string; options?: [string, string]; next?: string; input?: boolean; canRemember?: boolean }) => void): void;
  onReact(cb: (r: { reaction: Exclude<Reaction, "none">; ms?: number }) => void): void;
  onCursor(cb: (p: { x: number; y: number }) => void): void;
  reportPillRect(r: { x: number; y: number; width: number; height: number }): void;
  setInteractive(on: boolean): void;
  setNeedsYou(on: boolean): void;
  onSettings(cb: (s: { sounds?: boolean; volume?: number; lingerFinishedMin?: number; glass?: boolean; colours?: Record<string, string>; quiet?: boolean }) => void): void;
  onPlaySound(cb: (name: string) => void): void;
  decide(choice: 0 | 1): void;
  decideAlways(): void;
  answerText(text: string): void;
}
interface Window {
  buddy: BuddyApi;
}

// ---------- Timing / motion knobs (tune here) ----------
const TIMING = {
  keepIdle: 20_000,
  keepGreeting: 20_000,
  keepWorking: 20 * 60_000,
  keepUpload: 20 * 60_000,
  keepNeedsYou: 15 * 60_000,
  keepError: 10 * 60_000,
  keepFinished: 5 * 60_000,
  rankRecentMs: 5_000,
  bumpDefault: 5_000,
  bumpError: 8_000,
  bumpAfterLeave: 1_200,
  bumpAfterReact: 1_500,
  greetingToIdle: 2_600,
  pinLeadMs: 8_000,
  slapWindow: 4_000,
  jiggleWindow: 1_000,
  blinkHold: 130,
  sizePoll: 250,
  prunePoll: 1_000,
  settleEps: 0.08,
  settleV: 0.4,
};

const MOTION = {
  eyeK: 320, eyeD: 22, eyeCornerD: 26,
  lookK: 70, lookD: 13,
  bodyXK: 260, bodyXD: 14,
  bodyYK: 210, bodyYD: 13,
  squashK: 300, squashD: 12,
  rotK: 60, rotD: 11,
};

// Agent names and colours (COLOURS, colourFor, keyOf, DEFAULT_NAME, DEFAULT_KEY)
// live in shared.ts, which index.html loads before this file.

/**
 * Body style of the animated character. Every style runs on the same shading,
 * eyes and springs, so each gets every state and reaction.
 *  - "ball": the default.
 *  - "block": Claude Code's. A rounded block with small arms and legs and squarer eyes.
 *  - "hex": Cursor's. A rounded hexagon.
 */
type BodyStyle = "ball" | "block" | "hex";
function bodyStyle(key: string): BodyStyle {
  if (key === "claude" || key === "claudecode") return "block";
  if (key === "cursor") return "hex";
  return "ball";
}
/** How much of the eye's corner rounding each body keeps, and how far its eyes are lifted. */
const EYE_ROUNDING: Record<BodyStyle, number> = { ball: 1, block: 0.32, hex: 0.62 };
const EYE_LIFT: Record<BodyStyle, number> = { ball: 0, block: -2.5, hex: 0 };

// All outlines use the same number of points so the body can morph between them.
function outline(kind: "ball" | "tray" | "block" | "hex"): string {
  const N = 96;
  const pts: string[] = [];
  const superellipse = (c: number, s: number, a: number, b: number, n: number) =>
    1 / Math.pow(Math.pow(Math.abs(c) / a, n) + Math.pow(Math.abs(s) / b, n), 1 / n);
  // A hexagon with a point at the top, softened towards a circle so the corners are round.
  const hexagon = (t: number) => {
    const sector = Math.PI / 3;
    const a = (((t + Math.PI / 2) % sector) + sector) % sector;
    const flat = (30 * Math.cos(Math.PI / 6)) / Math.cos(a - Math.PI / 6);
    return flat * 0.74 + 27.5 * 0.26;
  };
  for (let i = 0; i < N; i++) {
    const t = (i / N) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const r = kind === "ball" ? 28 : kind === "tray" ? superellipse(c, s, 29, 26, 7) : kind === "hex" ? hexagon(t) : superellipse(c, s, 25, 19.5, 6);
    const cy = kind === "block" ? 29 : 32;
    pts.push(`${(32 + r * c).toFixed(2)} ${(cy + r * s).toFixed(2)}`);
  }
  return `path("M${pts.join(" L")} Z")`;
}
const OUTLINE = { ball: outline("ball"), tray: outline("tray"), block: outline("block"), hex: outline("hex") };

// The block character's arms and legs: [x, y, width, height]. Drawn behind the body.
const BLOCK_LIMBS: [number, number, number, number][] = [
  [1, 24.5, 9, 8.5], [54, 24.5, 9, 8.5],                                 // arms
  [12.5, 44, 6.5, 13], [22.5, 44, 6.5, 13], [35, 44, 6.5, 13], [45, 44, 6.5, 13], // legs
];
function appendLimbs(parent: Element, before: Element | null): void {
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("class", "limbs");
  for (const [x, y, w, h] of BLOCK_LIMBS) {
    const r = document.createElementNS(SVG_NS, "rect");
    for (const [k, v] of Object.entries({ x, y, width: w, height: h, rx: 2.4 })) r.setAttribute(k, String(v));
    g.appendChild(r);
  }
  parent.insertBefore(g, before);
}

interface EyeShape { w: number; h: number; rt: number; rb: number }

const EYE: Record<Mood, EyeShape> = {
  idle: { w: 7, h: 14.4, rt: 3.5, rb: 3.5 },
  greeting: { w: 11.6, h: 7.8, rt: 5.8, rb: 1.2 },
  working: { w: 7, h: 13, rt: 3.5, rb: 3.5 },
  upload: { w: 7.6, h: 11, rt: 3.8, rb: 3.8 },
  needsYou: { w: 11.4, h: 11.4, rt: 5.7, rb: 5.7 },
  error: { w: 10.5, h: 3.2, rt: 1.6, rb: 1.6 },
  finished: { w: 11.6, h: 7.8, rt: 5.8, rb: 1.2 },
  annoyed: { w: 11.4, h: 6, rt: 1, rb: 5.6 },
  slap: { w: 7.6, h: 4.6, rt: 1.6, rb: 1.6 },
  dizzy: { w: 5.6, h: 8.5, rt: 2.8, rb: 2.8 },
};

function eyePath(e: EyeShape): string {
  const hw = Math.max(0.4, e.w / 2);
  const hh = Math.max(0.4, e.h / 2);
  let rt = Math.max(0.05, Math.min(e.rt, hw));
  let rb = Math.max(0.05, Math.min(e.rb, hw));
  if (rt + rb > hh * 2) { const k = (hh * 2) / (rt + rb); rt *= k; rb *= k; }
  const f = (n: number) => n.toFixed(2);
  return `M${f(-hw)} ${f(-hh + rt)}A${f(rt)} ${f(rt)} 0 0 1 ${f(-hw + rt)} ${f(-hh)}H${f(hw - rt)}A${f(rt)} ${f(rt)} 0 0 1 ${f(hw)} ${f(-hh + rt)}` +
    `V${f(hh - rb)}A${f(rb)} ${f(rb)} 0 0 1 ${f(hw - rb)} ${f(hh)}H${f(-hw + rb)}A${f(rb)} ${f(rb)} 0 0 1 ${f(-hw)} ${f(hh - rb)}Z`;
}

const EYE_ANGLE = 0.34;
const EYE_RADIUS = 22;
function eyeOnBall(side: -1 | 1, yaw: number, pitch: number): { x: number; y: number; sx: number } {
  const a = side * EYE_ANGLE + yaw * 0.62;
  return {
    x: 32 + EYE_RADIUS * Math.sin(a),
    y: 30.5 + pitch * 6.5,
    sx: Math.max(0.25, Math.cos(a) / Math.cos(EYE_ANGLE)),
  };
}

class Spring {
  v = 0;
  target: number;
  constructor(public x: number, private k: number, private d: number) { this.target = x; }
  step(dt: number): number {
    this.v += (-this.k * (this.x - this.target) - this.d * this.v) * dt;
    this.x += this.v * dt;
    return this.x;
  }
  snap(x: number): void { this.x = x; this.target = x; this.v = 0; }
  settled(): boolean {
    return Math.abs(this.x - this.target) < TIMING.settleEps && Math.abs(this.v) < TIMING.settleV;
  }
}

const DEFAULT_TEXT: Record<AgentState, string> = {
  idle: "Waiting for an agent…",
  greeting: "Hi! I'm here.",
  working: "Working…",
  needsYou: "Needs your OK to continue",
  error: "Something went wrong",
  finished: "All done!",
  upload: "Uploading…",
};

const QUIPS: Record<Exclude<Reaction, "none">, string> = {
  annoyed: "Quit it…",
  slap: "Ow!",
  dizzy: "Whoa… stars…",
};

const KEEP_MS: Record<AgentState, number> = {
  idle: TIMING.keepIdle,
  greeting: TIMING.keepGreeting,
  working: TIMING.keepWorking,
  upload: TIMING.keepUpload,
  needsYou: TIMING.keepNeedsYou,
  error: TIMING.keepError,
  finished: TIMING.keepFinished,
};
const MAX_OTHERS = 4;
const SVG_NS = "http://www.w3.org/2000/svg";

const root = document.documentElement;
const body = document.body;
const pill = document.getElementById("pill")!;
const face = document.getElementById("face")!;
const bodyGroup = document.getElementById("body")!;
const avatarBall = document.getElementById("avatarBall")!;
appendLimbs(avatarBall, avatarBall.firstElementChild); // shown only for the block body (CSS)
const eyeL = document.getElementById("eyeL")!;
const eyeR = document.getElementById("eyeR")!;
const nameEl = document.getElementById("name")!;
const statusEl = document.getElementById("status")!;
const prevEl = document.getElementById("prev")!;
const nextEl = document.getElementById("next")!;
const othersEl = document.getElementById("others")!;
const listEl = document.getElementById("list")!;
const approveBtn = document.getElementById("approve") as HTMLButtonElement;
const denyBtn = document.getElementById("deny") as HTMLButtonElement;
const alwaysBtn = document.getElementById("always") as HTMLButtonElement;
const replyForm = document.getElementById("reply") as HTMLFormElement;
const replyInput = document.getElementById("reply-text") as HTMLInputElement;
const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function setOutline(svg: Element, tray: boolean, style: BodyStyle = "ball"): void {
  const d = tray ? OUTLINE.tray : OUTLINE[style];
  svg.querySelectorAll<SVGPathElement>(".shape").forEach((p) => p.style.setProperty("d", d));
  svg.setAttribute("data-body", tray ? "ball" : style); // limbs tuck away while it is a tray
}

/** Eye outline for a body style: the block's and the hexagon's eyes are squarer. */
function eyeFor(style: BodyStyle, e: EyeShape): string {
  const k = EYE_ROUNDING[style];
  return k === 1 ? eyePath(e) : eyePath({ ...e, rt: e.rt * k, rb: e.rb * k });
}

function miniFace(b: { key: string; state: AgentState }): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 64 64");
  svg.setAttribute("class", "face mini");
  svg.setAttribute("aria-hidden", "true");
  svg.style.setProperty("--bot", colourFor(b.key));
  const style = bodyStyle(b.key);
  const defs = document.createElementNS(SVG_NS, "defs");
  const shade = document.createElementNS(SVG_NS, "radialGradient");
  const sid = `m-shade-${b.key}`;
  shade.setAttribute("id", sid);
  shade.setAttribute("gradientUnits", "userSpaceOnUse");
  shade.setAttribute("cx", "21"); shade.setAttribute("cy", "15"); shade.setAttribute("r", "58");
  for (const [o, c, op] of [["0", "#fff", "0.6"], ["0.42", "#fff", "0"], ["1", "#000", "0.32"]] as const) {
    const s = document.createElementNS(SVG_NS, "stop");
    s.setAttribute("offset", o); s.setAttribute("stop-color", c); s.setAttribute("stop-opacity", op);
    shade.appendChild(s);
  }
  defs.appendChild(shade);
  svg.appendChild(defs);
  if (style === "block") appendLimbs(svg, null);
  for (const cls of ["shape base", "shape wash", "shape shade"]) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("class", cls);
    if (cls.includes("shade")) p.setAttribute("fill", `url(#${sid})`);
    svg.appendChild(p);
  }
  const slot = document.createElementNS(SVG_NS, "rect");
  slot.setAttribute("class", "slot");
  for (const [k, v] of Object.entries({ x: 13, y: 12.5, width: 38, height: 7.5, rx: 3.75 })) slot.setAttribute(k, String(v));
  svg.appendChild(slot);
  const pitch = b.state === "upload" ? 0.9 : 0;
  for (const side of [-1, 1] as const) {
    const pos = eyeOnBall(side, 0, pitch);
    const e = document.createElementNS(SVG_NS, "path");
    e.setAttribute("class", "eyep");
    e.setAttribute("d", eyeFor(style, EYE[b.state]));
    e.setAttribute("transform", `translate(${pos.x.toFixed(2)} ${(pos.y + EYE_LIFT[style]).toFixed(2)})`);
    svg.appendChild(e);
  }
  setOutline(svg, b.state === "upload", style);
  return svg;
}

// ---------- Step icons ----------
// A small icon in front of the current step, guessed from its wording, so the
// kind of work reads at a glance. Anything unrecognised keeps the plain dot.
const STEP_ICONS: [icon: string, words: RegExp][] = [
  ["wait", /^(wait(ing)?|paus\w*|hold(ing)?)\b/i], // "Waiting for a reply" is waiting, not sending
  ["terminal", /^(shell:|ran:)|\b(run(ning)?|build(ing)?|test(ing)?|install(ing)?|compil\w*|deploy\w*|command)\b/i],
  ["send", /\b(send(ing)?|sent|email(ing)?|messag\w*|reply(ing)?|forward\w*|post(ing)?|notify\w*|draft\w*)\b/i],
  ["sync", /\b(sync\w*|upload\w*|download\w*|push(ing)?|fetch\w*|copy(ing)?|mov(e|ing)|sav(e|ing)|import\w*|export\w*)\b/i],
  ["edit", /\b(edit\w*|writ(e|ing)|updat\w*|fix(ing)?|chang\w*|add(ing)?|refactor\w*|creat\w*|shad(e|ing)|fill(ing)?|mark(ing)?|renam\w*|delet\w*|remov\w*)\b/i],
  ["search", /\b(check(ing)?|search\w*|look(ing)?|find(ing)?|read(ing)?|review\w*|verify\w*|scan\w*|compar\w*|open(ing)?|pull(ing)?|inspect\w*)\b/i],
  ["wait", /\b(wait(ing)?|paus\w*|schedul\w*|hold(ing)?)\b/i],
];
function stepIcon(state: AgentState, text: string): string {
  if (state !== "working" && state !== "upload") return "";
  if (state === "upload") return "sync";
  for (const [icon, words] of STEP_ICONS) if (words.test(text)) return icon;
  return "";
}

// ---------- Soft sounds ----------
// A small matched set, all from one soft voice (a sine with a quieter octave
// above it, a quick attack and a gentle decay) in one key, so they sound like
// one family: rising = good or "look here", falling = something went wrong.
// Switched off, and the volume set, in Settings.
let soundsOn = true;
let volume = 0.6;
let audioCtx: AudioContext | null = null;

function note(freq: number, at: number, dur: number, level = 1): void {
  const ctx = audioCtx!;
  const t0 = ctx.currentTime + at;
  const out = ctx.createGain();
  const peak = 0.11 * volume * level;
  out.gain.setValueAtTime(0.0001, t0);
  out.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + 0.012);
  out.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  out.connect(ctx.destination);
  for (const [mult, gain] of [[1, 1], [2, 0.22]] as const) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq * mult;
    g.gain.value = gain;
    osc.connect(g); g.connect(out);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
  }
}

type SoundName = "needsYou" | "finished" | "error" | "greeting" | "slap";
const SOUNDS: Record<SoundName, [freq: number, at: number, dur: number, level?: number][]> = {
  greeting: [[659.3, 0, 0.22, 0.7], [987.8, 0.09, 0.3, 0.7]],          // E5, B5
  needsYou: [[784, 0, 0.16], [784, 0.17, 0.16], [1046.5, 0.34, 0.42]], // G5 G5 C6: "over here"
  finished: [[523.3, 0, 0.16], [659.3, 0.1, 0.16], [784, 0.2, 0.4]],   // C5 E5 G5, rising
  error: [[392, 0, 0.2], [311.1, 0.16, 0.45]],                         // G4 down to E-flat 4
  slap: [[196, 0, 0.09, 1.2], [130.8, 0.03, 0.12, 0.9]],               // a low thud
};

function playSound(name: SoundName): void {
  if (!soundsOn || volume <= 0) return;
  try {
    audioCtx ??= new AudioContext();
    if (audioCtx.state === "suspended") void audioCtx.resume();
    for (const [freq, at, dur, level] of SOUNDS[name]) note(freq, at, dur, level ?? 1);
  } catch { /* no audio device */ }
}
function playStateSound(state: AgentState): void {
  if (state === "needsYou" || state === "finished" || state === "error" || state === "greeting") playSound(state);
}

// ---------- The bots ----------
interface Bot {
  key: string;
  name: string;
  state: AgentState;
  text: string;
  prevText: string;
  nextText: string;
  options?: [string, string];
  changedAt: number;
  updatedAt: number;
  startedAt: number; // when the current task began, for the elapsed time
  input?: boolean;       // the question wants a typed answer
  canRemember?: boolean; // the question can offer "Always"
}

const STALE_AFTER_MIN = 5; // a working bot that has said nothing for this long is flagged
let quiet = false;          // do not disturb: no auto-expanding (questions still expand)

const bots = new Map<string, Bot>();
let lead: Bot = { key: DEFAULT_KEY, name: DEFAULT_NAME, state: "idle", text: DEFAULT_TEXT.idle, prevText: "", nextText: "", changedAt: 0, updatedAt: 0, startedAt: 0 };
let reaction: Reaction = "none";
let reactionTimer: number | undefined;
let pinnedKey: string | null = null;
let pinnedUntil = 0;
let animating = true;
let lastNeedsYou = false;

function rank(b: Bot, now: number): number {
  if (pinnedKey === b.key && now < pinnedUntil) return 7;
  if (b.state === "needsYou") return 6;
  if (b.state !== "idle" && now - b.changedAt < TIMING.rankRecentMs) return 5;
  if (b.state === "error") return 4;
  if (b.state === "working" || b.state === "upload" || b.state === "greeting") return 3;
  if (b.state === "finished") return 2;
  return 0;
}

function ordered(now: number): Bot[] {
  return [...bots.values()].sort((a, b) => rank(b, now) - rank(a, now) || b.updatedAt - a.updatedAt);
}

function prune(now: number): void {
  for (const [key, b] of bots) {
    if (key === DEFAULT_KEY && bots.size === 1) continue;
    if (now - b.updatedAt > KEEP_MS[b.state]) bots.delete(key);
  }
  if (bots.size === 0) {
    bots.set(DEFAULT_KEY, { key: DEFAULT_KEY, name: DEFAULT_NAME, state: "idle", text: DEFAULT_TEXT.idle, prevText: "", nextText: "", changedAt: now, updatedAt: now, startedAt: now });
  }
}

function setAgentState(
  state: AgentState, text?: string, agent?: string, options?: [string, string], next?: string,
  ask?: { input?: boolean; canRemember?: boolean },
): void {
  stir();
  const name = agent ?? DEFAULT_NAME;
  const key = keyOf(name);
  const now = performance.now();
  const prev = bots.get(key);
  const changed = !prev || prev.state !== state;
  const newText = text ?? DEFAULT_TEXT[state];
  const midTask = prev !== undefined && (prev.state === "working" || prev.state === "upload" || prev.state === "needsYou");
  const prevText = !midTask || state === "finished" ? "" : prev.text !== newText ? prev.text : prev.prevText;
  let nextText = prev?.nextText ?? "";
  if (next !== undefined) nextText = next;
  else if (!midTask || state === "finished" || state === "idle" || state === "error") nextText = "";
  bots.set(key, {
    key, name, state, options, prevText, nextText,
    input: state === "needsYou" && ask?.input === true,
    canRemember: state === "needsYou" && ask?.canRemember === true,
    text: newText,
    changedAt: changed ? now : prev!.changedAt,
    updatedAt: now,
    startedAt: midTask ? prev!.startedAt : now,
  });
  if (key !== DEFAULT_KEY) {
    const d = bots.get(DEFAULT_KEY);
    if (d && (d.state === "idle" || d.state === "greeting")) bots.delete(DEFAULT_KEY);
  }
  if (state === "greeting") {
    window.setTimeout(() => {
      if (bots.get(key)?.state === "greeting") setAgentState("idle", undefined, name);
    }, TIMING.greetingToIdle);
  }
  if (changed) {
    if (!quiet || state === "needsYou") bump(state === "error" ? TIMING.bumpError : TIMING.bumpDefault);
    playStateSound(state);
  }
  wakeAnimation();
  refresh();
}

function pinLead(key: string): void {
  pinnedKey = key;
  pinnedUntil = performance.now() + TIMING.pinLeadMs;
  bump(TIMING.pinLeadMs);
  wakeAnimation();
  refresh();
}

let shownLead = "";
let shownText = "";
let othersSig = "";

function renderLead(): void {
  body.dataset.state = lead.state;
  body.dataset.reaction = reaction;
  (face as unknown as SVGElement).style.setProperty("--bot", colourFor(lead.key));
  setOutline(face, lead.state === "upload" && reaction === "none", bodyStyle(lead.key));
  nameEl.textContent = reaction === "none" ? lead.name : QUIPS[reaction];
  prevEl.textContent = lead.prevText;
  statusEl.textContent = lead.text;
  statusEl.title = lead.text;
  statusEl.dataset.icon = stepIcon(lead.state, lead.text);
  // Elapsed time beside the name once a task passes a minute, and a flag when a
  // working bot has gone quiet (it may be stuck, or just not reporting).
  const nowMs = performance.now();
  const busy = (lead.state === "working" || lead.state === "upload") && reaction === "none";
  const elapsedMin = Math.floor((nowMs - lead.startedAt) / 60_000);
  const quietMin = Math.floor((nowMs - lead.updatedAt) / 60_000);
  const stale = busy && quietMin >= STALE_AFTER_MIN;
  nameEl.dataset.elapsed = busy && elapsedMin >= 1 ? (elapsedMin >= 60 ? `${Math.floor(elapsedMin / 60)}h ${elapsedMin % 60}m` : `${elapsedMin}m`) : "";
  statusEl.dataset.stale = stale ? "1" : "";
  nextEl.textContent = stale ? `No update for ${quietMin} min` : lead.nextText ? `Next: ${lead.nextText}` : "";
  nextEl.title = lead.nextText;
  face.setAttribute("aria-label", `${lead.name}: ${lead.text}`);
  const textSig = `${lead.key}|${lead.text}|${lead.nextText}`;
  if (textSig !== shownText) {
    shownText = textSig;
    for (const el of [statusEl, prevEl, nextEl]) {
      el.classList.remove("tick");
      void el.offsetWidth;
      el.classList.add("tick");
    }
  }
  const needs = lead.state === "needsYou" || [...bots.values()].some((b) => b.state === "needsYou");
  if (needs !== lastNeedsYou) {
    lastNeedsYou = needs;
    window.buddy.setNeedsYou(needs);
  }
}

function bindPromote(el: HTMLElement, key: string): void {
  el.style.cursor = "pointer";
  el.addEventListener("click", (ev) => {
    ev.stopPropagation();
    pinLead(key);
  });
}

function renderOthers(others: Bot[]): void {
  const shown = others.slice(0, MAX_OTHERS);
  const extra = others.length - shown.length;
  const sig = shown.map((b) => `${b.key}|${b.state}|${b.text}|${b.nextText}`).join("\n") + `\n+${extra}|${pinnedKey}`;
  root.style.setProperty("--extra", `${shown.length * 24 + (extra > 0 ? 22 : 0)}px`);
  body.dataset.others = String(others.length);
  if (sig === othersSig) return;
  othersSig = sig;

  othersEl.replaceChildren();
  listEl.replaceChildren();
  for (const b of shown) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.dataset.state = b.state;
    chip.title = `${b.name}: ${b.text} (click to show)`;
    chip.appendChild(miniFace(b));
    bindPromote(chip, b.key);
    othersEl.appendChild(chip);

    const item = document.createElement("div");
    item.className = "item";
    item.dataset.state = b.state;
    item.title = `${b.name}: ${b.text} (click to show)`;
    item.style.setProperty("--bot", colourFor(b.key));
    item.appendChild(miniFace(b));
    const line = document.createElement("span");
    line.className = "line";
    line.textContent = b.text;
    item.appendChild(line);
    bindPromote(item, b.key);
    listEl.appendChild(item);
  }
  if (extra > 0) {
    const more = document.createElement("span");
    more.className = "more";
    more.textContent = `+${extra}`;
    othersEl.appendChild(more);
    const moreItem = document.createElement("div");
    moreItem.className = "item more";
    moreItem.textContent = `and ${extra} more`;
    listEl.appendChild(moreItem);
  }
}

function refresh(): void {
  const now = performance.now();
  prune(now);
  if (pinnedKey && now >= pinnedUntil) pinnedKey = null;
  const list = ordered(now);
  lead = list[0];

  approveBtn.textContent = lead.options?.[0] ?? "Approve";
  denyBtn.textContent = lead.options?.[1] ?? "Deny";
  // Which answer controls show: two buttons, two buttons plus "Always", or a text box.
  const askMode = lead.state !== "needsYou" ? "" : lead.input ? "text" : lead.canRemember ? "choice-remember" : "choice";
  if (body.dataset.ask !== askMode) {
    body.dataset.ask = askMode;
    replyInput.value = "";
  }
  alwaysBtn.textContent = `Always “${lead.options?.[0] ?? "Approve"}” for this question`;

  const sig = `${lead.key}|${lead.state}`;
  if (sig !== shownLead) {
    shownLead = sig;
    body.dataset.state = "";
    void body.offsetWidth;
    enterState(lead.state);
  }
  renderLead();
  renderOthers(list.slice(1));
  updateSize();
}

let expandedUntil = 0;
let hovering = false;

function updateSize(): void {
  const mustExpand = lead.state === "needsYou" || lead.state === "greeting" || reaction !== "none" || hovering;
  const size = mustExpand || performance.now() < expandedUntil ? "expanded" : "compact";
  if (body.dataset.size !== size) body.dataset.size = size;
}
function bump(ms = TIMING.bumpDefault): void {
  expandedUntil = Math.max(expandedUntil, performance.now() + ms);
  updateSize();
}
window.setInterval(updateSize, TIMING.sizePoll);
window.setInterval(refresh, TIMING.prunePoll);

const eW = new Spring(EYE.idle.w, MOTION.eyeK, MOTION.eyeD);
const eH = new Spring(EYE.idle.h, MOTION.eyeK, MOTION.eyeD);
const eRt = new Spring(EYE.idle.rt, MOTION.eyeK, MOTION.eyeCornerD);
const eRb = new Spring(EYE.idle.rb, MOTION.eyeK, MOTION.eyeCornerD);
const yaw = new Spring(0, MOTION.lookK, MOTION.lookD);
const pitch = new Spring(0, MOTION.lookK, MOTION.lookD);
const bx = new Spring(0, MOTION.bodyXK, MOTION.bodyXD);
const by = new Spring(0, MOTION.bodyYK, MOTION.bodyYD);
const bsx = new Spring(1, MOTION.squashK, MOTION.squashD);
const bsy = new Spring(1, MOTION.squashK, MOTION.squashD);
const brot = new Spring(0, MOTION.rotK, MOTION.rotD);
const allSprings = [eW, eH, eRt, eRb, yaw, pitch, bx, by, bsx, bsy, brot];

const look = { x: 0, y: 0 };
let blinkUntil = 0;
let stateSince = 0;
let lookDirty = true;

function enterState(state: AgentState): void {
  stateSince = performance.now();
  wakeAnimation();
  if (calm) return;
  switch (state) {
    case "greeting": bsx.x = 0.3; bsy.x = 0.3; by.v = -160; break;
    case "working": bsx.v = 3; bsy.v = -3.6; break;
    case "upload": bsy.v = -4; bsx.v = 3; break;
    case "needsYou": by.v = -190; break;
    case "error": bx.v = 380; break;
    case "finished":
      by.v = -260;
      bsy.v = 2.5;
      // Avoid stacking full turns if finished re-enters mid-roll.
      if (Math.abs(brot.target) < 1 && Math.abs(brot.x) < 1) brot.target = 360;
      else brot.target = brot.x + 360;
      break;
    default: break;
  }
}

function react(r: Exclude<Reaction, "none">, ms: number, then?: () => void): void {
  window.clearTimeout(reactionTimer);
  stir();
  reaction = r;
  if (r === "slap") playSound("slap");
  wakeAnimation();
  if (!calm && r === "slap") { bsx.x = 1.32; bsy.x = 0.68; bx.v = (Math.random() < 0.5 ? -1 : 1) * 240; }
  body.dataset.reaction = "none";
  void body.offsetWidth;
  renderLead();
  updateSize();
  reactionTimer = window.setTimeout(() => {
    reaction = "none";
    renderLead();
    bump(TIMING.bumpAfterReact);
    then?.();
  }, ms);
}

function wakeAnimation(): void {
  if (animating) return;
  animating = true;
  lastFrame = performance.now();
  requestAnimationFrame(frame);
}

function springsSettled(): boolean {
  return allSprings.every((s) => s.settled());
}

let lastFrame = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.033, (now - lastFrame) / 1000);
  lastFrame = now;
  const t = now / 1000;
  const mood: Mood = reaction === "none" ? lead.state : reaction;
  const asleep = dozing && mood === "idle";
  const glancing = !asleep && mood === "idle" && now < glanceUntil;
  const startled = now < startledUntil && mood === "idle";
  const activeMood = mood !== "idle" || reaction !== "none" || now < blinkUntil || glancing || startled;

  const shape = asleep ? SLEEP_EYE : startled ? EYE.needsYou : EYE[mood];
  const blinking = !asleep && now < blinkUntil && (mood === "idle" || mood === "working" || mood === "upload");
  eW.target = shape.w;
  eH.target = blinking ? 1.6 : shape.h;
  eRt.target = shape.rt;
  eRb.target = shape.rb;

  let ty = 0;
  let tp = 0;
  if (mood === "dizzy") { ty = Math.sin(t * 7.5) * 1.15; tp = Math.cos(t * 7.5) * 0.95; }
  else if (mood === "working") { ty = Math.sin(t * 2.3) * 0.8; tp = 0.22; }
  else if (mood === "upload") { tp = 0.95; }
  else if (mood === "error") { tp = 0.4; }
  else if (mood === "slap") { ty = 0; tp = 0.1; }
  else if (mood === "finished" && now - stateSince < 900) { ty = 0; tp = 0; }
  else if (asleep) { ty = 0; tp = 0.7; }                         // head drooped
  else if (glancing) { ty = glance.x; tp = glance.y; }           // looking around on its own
  else { ty = look.x; tp = look.y; }
  yaw.target = calm && mood !== "idle" ? 0 : ty;
  pitch.target = calm && mood !== "idle" ? 0 : tp;

  let tx = 0, tyy = 0, tsx = 1, tsy = 1;
  if (!calm) {
    // Idle has no continuous JS breath so the frame loop can sleep when settled.
    if (asleep) { tyy = 2; tsx = 1.04; tsy = 0.95; } // slumped; a fixed pose, so the loop can still rest
    else if (mood === "greeting") { const b = Math.sin(t * 1.6) * 0.028; tsx = 1 + b; tsy = 1 - b; }
    else if (mood === "working") { tyy = -1.2 - Math.sin(t * 4.2) * 1.3; }
    else if (mood === "upload") { const b = Math.max(0, Math.sin(t * 5.2)); tsy = 1 - b * 0.06; tsx = 1 + b * 0.04; tyy = b * 1.5; }
    else if (mood === "needsYou") { tyy = -Math.abs(Math.sin(t * 4.6)) * 5; }
    else if (mood === "error") { tyy = 3; tsx = 0.95; tsy = 0.9; }
    else if (mood === "annoyed") { tx = Math.sin(t * 58) * 0.9; tsy = 0.96; }
    else if (mood === "dizzy") { tx = Math.sin(t * 5) * 2.2; }
  }
  bx.target = tx; by.target = tyy; bsx.target = tsx; bsy.target = tsy;
  if (Math.abs(brot.x - brot.target) < 0.4 && Math.abs(brot.v) < 2 && brot.target !== 0) brot.snap(0);
  const sway = mood === "dizzy" && !calm ? Math.sin(t * 5) * 9 : 0;

  for (const s of allSprings) s.step(dt);

  const style = bodyStyle(lead.key);
  const lift = EYE_LIFT[style];
  const d = eyeFor(style, { w: eW.x, h: eH.x, rt: eRt.x, rb: eRb.x });
  for (const [el, side] of [[eyeL, -1], [eyeR, 1]] as const) {
    const p = eyeOnBall(side, yaw.x, pitch.x);
    el.setAttribute("d", d);
    el.setAttribute("transform", `translate(${p.x.toFixed(2)} ${(p.y + lift).toFixed(2)}) scale(${p.sx.toFixed(3)} 1)`);
  }
  bodyGroup.setAttribute(
    "transform",
    `translate(${bx.x.toFixed(2)} ${by.x.toFixed(2)}) rotate(${(brot.x + sway).toFixed(2)} 32 32) ` +
      `translate(32 60) scale(${bsx.x.toFixed(3)} ${bsy.x.toFixed(3)}) translate(-32 -60)`
  );

  lookDirty = false;
  const canSleep = !activeMood && !lookDirty && springsSettled() && reaction === "none";
  if (canSleep) {
    animating = false;
    return;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------- Idle personality ----------
// With nothing to report, the buddy still has a little life: it glances around
// now and then, and after a couple of quiet minutes it nods off. Any activity,
// or the cursor coming near, wakes it with a small start. These are one-off
// events on timers, so the animation loop can still rest in between.
const SLEEP_EYE: EyeShape = { w: 10.5, h: 2.4, rt: 1.2, rb: 1.2 };
const DOZE_AFTER_MS = 120_000;
let lastStirAt = performance.now(); // last time anything happened (a status, a reaction, the cursor nearby)
let dozing = false;
let glanceUntil = 0;
let startledUntil = 0;
const glance = { x: 0, y: 0 };

/** Something happened: stay awake, and wake up if it had nodded off. */
function stir(): void {
  lastStirAt = performance.now();
  if (!dozing) return;
  dozing = false;
  body.dataset.doze = "0";
  if (!calm) { by.v = -150; bsy.v = 2; startledUntil = performance.now() + 600; } // a little start
  wakeAnimation();
}

function idleTick(): void {
  const now = performance.now();
  const idleNow = lead.state === "idle" && reaction === "none";
  if (!idleNow) { lastStirAt = now; return; }
  if (!dozing && now - lastStirAt > DOZE_AFTER_MS) {
    dozing = true;
    body.dataset.doze = "1";
    wakeAnimation(); // let it settle into the sleeping pose
    return;
  }
  // Awake and bored: glance somewhere for a moment, about one tick in three.
  if (!dozing && !calm && now - lastStirAt > 6000 && Math.random() < 0.34) {
    glance.x = (Math.random() * 2 - 1) * 0.9;
    glance.y = (Math.random() * 2 - 1) * 0.5;
    glanceUntil = now + 1100 + Math.random() * 700;
    wakeAnimation();
  }
}
window.setInterval(idleTick, 3500);

function blink(): void {
  blinkUntil = performance.now() + TIMING.blinkHold;
  wakeAnimation();
  window.setTimeout(blink, 2400 + Math.random() * 3600);
}
window.setTimeout(blink, 1500);

let slaps: number[] = [];
face.addEventListener("click", () => {
  const now = performance.now();
  slaps = slaps.filter((t) => now - t < TIMING.slapWindow);
  slaps.push(now);
  if (slaps.length >= 3) {
    slaps = [];
    react("dizzy", 3200);
  } else {
    react("slap", 450, () => react("annoyed", 1400));
  }
});

let lastX: number | null = null;
let lastDir = 0;
let flips: number[] = [];

function detectJiggle(p: { x: number; y: number }, r: DOMRect): void {
  const inside = p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
  if (!inside) {
    lastX = null;
    lastDir = 0;
    return;
  }
  if (lastX !== null) {
    const d = Math.sign(p.x - lastX);
    if (d !== 0 && lastDir !== 0 && d !== lastDir) flips.push(performance.now());
    if (d !== 0) lastDir = d;
  }
  lastX = p.x;
  const now = performance.now();
  flips = flips.filter((t) => now - t < TIMING.jiggleWindow);
  if (flips.length >= 5 && reaction === "none") {
    flips = [];
    react("annoyed", 1800);
  }
}

window.buddy.onCursor((p) => {
  lookDirty = true;
  stir(); // main only sends the cursor when it is near the notch
  wakeAnimation();
  const r = face.getBoundingClientRect();
  const dx = p.x - (r.left + r.width / 2);
  const dy = p.y - (r.top + r.height / 2);
  const dist = Math.hypot(dx, dy) || 1;
  const reach = Math.min(1, dist / 110);
  look.x = (dx / dist) * reach;
  look.y = (dy / dist) * reach;
  detectJiggle(p, r);
  updateEngagement(p, r);
});

let engaged = false;
let glassOn = true;         // setting: go see-through when the cursor is on the notch
let ghost = false;
let interactive = false;

function updateEngagement(p: { x: number; y: number }, faceRect: DOMRect): void {
  const pr = pill.getBoundingClientRect();
  const inPill = p.x >= pr.left && p.x <= pr.right && p.y >= pr.top && p.y <= pr.bottom;
  const pad = 3;
  const onFace = p.x >= faceRect.left - pad && p.x <= faceRect.right + pad && p.y >= faceRect.top - pad && p.y <= faceRect.bottom + pad;
  const asking = lead.state === "needsYou";

  if (!inPill) engaged = false;
  else if (onFace || asking || !glassOn) engaged = true;

  const nowGhost = inPill && !engaged;
  if (nowGhost !== ghost) {
    ghost = nowGhost;
    body.dataset.ghost = ghost ? "1" : "0";
  }
  if (engaged !== interactive) {
    interactive = engaged;
    window.buddy.setInteractive(interactive);
  }
  if (engaged !== hovering) {
    hovering = engaged;
    if (!hovering) bump(TIMING.bumpAfterLeave);
    updateSize();
  }
}

approveBtn.addEventListener("click", () => window.buddy.decide(0));
denyBtn.addEventListener("click", () => window.buddy.decide(1));
alwaysBtn.addEventListener("click", () => window.buddy.decideAlways());
// Enter sends the answer, handled here so it does not depend on the form's default behaviour.
replyInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.isComposing) {
    ev.preventDefault();
    replyForm.requestSubmit();
  }
});
replyForm.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const text = replyInput.value.trim();
  if (text) window.buddy.answerText(text);
});

// With the notch focused, Enter / Y approve and Escape / N deny a two-button
// question. Never for a typed answer: there those keys are just text. (This
// handler once swallowed "y", "n" and Enter in the text box.)
window.addEventListener("keydown", (ev) => {
  if (lead.state !== "needsYou" || lead.input) return;
  if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement) return;
  if (ev.key === "Enter" || ev.key === "y" || ev.key === "Y") {
    ev.preventDefault();
    window.buddy.decide(0);
  } else if (ev.key === "Escape" || ev.key === "n" || ev.key === "N") {
    ev.preventDefault();
    window.buddy.decide(1);
  }
});

function reportRect(): void {
  const r = pill.getBoundingClientRect();
  window.buddy.reportPillRect({ x: r.left, y: r.top, width: r.width, height: r.height });
}
new ResizeObserver(reportRect).observe(pill);

window.buddy.onState(({ state, text, agent, options, next, input, canRemember }) => setAgentState(state, text, agent, options, next, { input, canRemember }));
window.buddy.onReact(({ reaction: r, ms }) => react(r, ms ?? 1500));
window.buddy.onSettings((s) => {
  quiet = s.quiet === true;
  glassOn = s.glass !== false;
  setCustomColours(s.colours);
  refresh();
  soundsOn = s.sounds !== false && !quiet;
  volume = typeof s.volume === "number" ? Math.min(1, Math.max(0, s.volume)) : 0.6;
  if (typeof s.lingerFinishedMin === "number" && s.lingerFinishedMin > 0) KEEP_MS.finished = s.lingerFinishedMin * 60_000;
});
window.buddy.onPlaySound((name) => { if (name in SOUNDS) playSound(name as SoundName); });

// Opening moment: the notch drops out of the top edge, then the buddy says hello.
body.classList.add("opening");
window.setTimeout(() => body.classList.remove("opening"), 1200);

setAgentState("greeting");
reportRect();
