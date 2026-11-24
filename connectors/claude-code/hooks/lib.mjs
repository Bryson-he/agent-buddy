/** Shared helpers for Agent Buddy Claude Code hooks. Fail-open when Buddy is down. */
export const BASE = process.env.AGENT_BUDDY_URL ?? "http://127.0.0.1:47821";

export async function post(route, body) {
  try {
    const res = await fetch(`${BASE}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(125_000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function setStatus(state, message) {
  await post("/api/status", { state, message: String(message).slice(0, 60), agent: "Claude Code" });
}

export async function askUser(question, options = ["Approve", "Deny"]) {
  return post("/api/ask", {
    question: String(question).slice(0, 300),
    options,
    agent: "Claude Code",
    timeout_sec: 120,
  });
}

export function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { data += c; });
    process.stdin.on("end", () => {
      // Some Windows shells put a byte-order mark (char code 0xFEFF) in front of piped text.
      const text = (data.charCodeAt(0) === 0xfeff ? data.slice(1) : data).trim();
      try { resolve(JSON.parse(text || "{}")); } catch { resolve({}); }
    });
  });
}

export function reply(obj) {
  process.stdout.write(JSON.stringify(obj));
}
