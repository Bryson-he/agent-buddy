// Shared by the notch page, the Activity panel and Settings: each page loads
// this file before its own script. One place for agent names and colours.

// Every agent is the same character; colour is the main difference. These are
// the built-in colours. The owner can set a colour per agent in Settings, which
// arrives through setCustomColours().
const COLOURS: Record<string, string> = {
  agentbuddy: "#ececec",
  grok: "#f3f3f1",
  grokbot: "#f3f3f1",
  cursor: "#d9dce3", // light graphite, so it is not mistaken for Claude Code's coral
  claude: "#d97757",
  claudecode: "#d97757",
  codex: "#7dd3c0",
  copilot: "#8b9cf7",
  gemini: "#6aa5ff",
};
const FALLBACK_COLOURS = ["#a78bfa", "#4ade80", "#fbbf24", "#f472b6", "#38bdf8", "#fb923c", "#f0353f", "#19b8a6"];
const DEFAULT_NAME = "Agent Buddy";
const DEFAULT_KEY = "agentbuddy";

/** "Service Portal" and "service-portal" are the same agent. */
const keyOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "") || DEFAULT_KEY;

let customColours: Record<string, string> = {};
function setCustomColours(map: unknown): void {
  customColours = {};
  if (!map || typeof map !== "object") return;
  for (const [k, v] of Object.entries(map as Record<string, unknown>)) {
    if (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v)) customColours[k] = v;
  }
}

/** The colour an agent gets when the owner has not picked one. */
function defaultColourFor(key: string): string {
  if (COLOURS[key]) return COLOURS[key];
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return FALLBACK_COLOURS[h % FALLBACK_COLOURS.length];
}
function colourFor(key: string): string {
  return customColours[key] ?? defaultColourFor(key);
}
