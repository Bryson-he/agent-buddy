// What each bot has been doing, for the Activity panel. Kept in memory and
// seeded from the activity log at start, so it survives an app restart.
import * as fs from "fs";

export type HistoryKind = "idle" | "greeting" | "working" | "needsYou" | "error" | "finished" | "upload" | "answered" | "timedOut";
export interface HistoryEvent { t: number; kind: HistoryKind; text: string }
export interface BotHistory {
  name: string;
  kind: HistoryKind;
  text: string;
  updatedAt: number;
  today: { finished: number; errors: number; questions: number };
  events: HistoryEvent[]; // newest last
}

const MAX_EVENTS = 40;
const bots = new Map<string, BotHistory>();
const keyOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
const dayOf = (t: number) => new Date(t).toDateString();

export function recordHistory(name: string, kind: HistoryKind, text: string, at = Date.now()): void {
  const key = keyOf(name);
  if (!key) return;
  let b = bots.get(key);
  if (!b) {
    b = { name, kind, text, updatedAt: at, today: { finished: 0, errors: 0, questions: 0 }, events: [] };
    bots.set(key, b);
  }
  // Counts are per calendar day.
  if (dayOf(b.updatedAt) !== dayOf(at)) b.today = { finished: 0, errors: 0, questions: 0 };
  if (kind === "finished") b.today.finished += 1;
  else if (kind === "error") b.today.errors += 1;
  else if (kind === "needsYou") b.today.questions += 1;

  b.name = name;
  b.kind = kind === "answered" ? "working" : kind === "timedOut" ? "idle" : kind;
  b.text = text;
  b.updatedAt = at;
  // A repeat of the same line (bots often re-send it) is not a new step.
  const last = b.events[b.events.length - 1];
  if (!last || last.kind !== kind || last.text !== text) {
    b.events.push({ t: at, kind, text });
    if (b.events.length > MAX_EVENTS) b.events.splice(0, b.events.length - MAX_EVENTS);
  }
}

/** Most recently active first. Counts from an earlier day read as zero. */
export function historySnapshot(): BotHistory[] {
  const today = dayOf(Date.now());
  return [...bots.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((b) => ({ ...b, today: dayOf(b.updatedAt) === today ? b.today : { finished: 0, errors: 0, questions: 0 }, events: [...b.events] }));
}

/** Replays the activity log (written by server.ts) so the panel is not empty after a restart. */
export function seedHistoryFromLog(logFile: string): void {
  let lines: string[];
  try { lines = fs.readFileSync(logFile, "utf8").split("\n"); } catch { return; }
  for (const line of lines.slice(-800)) {
    if (!line) continue;
    try {
      const j = JSON.parse(line) as { t?: string; tool?: string; agent?: string; state?: string; message?: string; question?: string; answer?: string | null; timedOut?: boolean };
      const at = j.t ? Date.parse(j.t) : NaN;
      if (!j.agent || !Number.isFinite(at)) continue;
      if (j.tool === "set_status" && j.state) recordHistory(j.agent, j.state as HistoryKind, j.message ?? "", at);
      else if (j.tool === "ask_user") recordHistory(j.agent, "needsYou", j.question ?? "", at);
      else if (j.tool === "ask_user:answer") {
        if (j.answer) recordHistory(j.agent, "answered", `You chose "${j.answer}"`, at);
        else if (j.timedOut) recordHistory(j.agent, "timedOut", "No answer in time", at);
      }
    } catch { /* skip a bad line */ }
  }
}
