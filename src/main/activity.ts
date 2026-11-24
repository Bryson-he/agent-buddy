// Ring-buffer activity log: who called what, for "why didn't the bot show up?".
// Never records the connector token.
import * as fs from "fs";

const MAX_LINES = 2000;

export function appendActivity(logFile: string, entry: Record<string, unknown>): void {
  try {
    const line = JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n";
    fs.appendFileSync(logFile, line);
    trimActivityLog(logFile);
  } catch { /* logging must never break a request */ }
}

export function trimActivityLog(logFile: string): void {
  try {
    if (!fs.existsSync(logFile)) return;
    const raw = fs.readFileSync(logFile, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    if (lines.length <= MAX_LINES) return;
    fs.writeFileSync(logFile, lines.slice(-MAX_LINES).join("\n") + "\n");
  } catch { /* ignore */ }
}

export type ActivityPeek = { lastCalls: { t?: string; tool?: string; agent?: string; message?: string; question?: string; state?: string }[] };

/** Last N status/ask lines, newest first, for the tray peek. */
export function peekActivity(logFile: string, n = 12): ActivityPeek {
  try {
    if (!fs.existsSync(logFile)) return { lastCalls: [] };
    const lines = fs.readFileSync(logFile, "utf8").split("\n").filter((l) => l.length > 0);
    const out: ActivityPeek["lastCalls"] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
      try {
        const j = JSON.parse(lines[i]) as Record<string, unknown>;
        if (j.tool === "set_status" || j.tool === "ask_user" || j.tool === "ask_user:answer") {
          out.push({
            t: typeof j.t === "string" ? j.t : undefined,
            tool: typeof j.tool === "string" ? j.tool : undefined,
            agent: typeof j.agent === "string" ? j.agent : undefined,
            message: typeof j.message === "string" ? j.message : undefined,
            question: typeof j.question === "string" ? j.question : undefined,
            state: typeof j.state === "string" ? j.state : undefined,
          });
        }
      } catch { /* skip bad line */ }
    }
    return { lastCalls: out };
  } catch {
    return { lastCalls: [] };
  }
}

export function formatActivityPeek(logFile: string): string {
  const { lastCalls } = peekActivity(logFile, 12);
  if (lastCalls.length === 0) return "No connector calls recorded yet.";
  return lastCalls.map((c) => {
    const when = c.t ? c.t.slice(11, 19) : "??:??:??";
    const who = c.agent ?? "?";
    if (c.tool === "ask_user") return `${when}  ${who} asked: ${c.question ?? ""}`;
    if (c.tool === "ask_user:answer") return `${when}  ${who} answer logged`;
    return `${when}  ${who} ${c.state ?? ""}${c.message ? `: ${c.message}` : ""}`;
  }).join("\n");
}
