// Route B: chat with Grok through the xAI API (OpenAI-compatible chat completions).
// Grok gets the same two tools as the MCP connector, but they run here on the
// user's PC, so no public tunnel is needed.
import { z } from "zod";
import {
  ASK_USER_DESCRIPTION, SET_STATUS_DESCRIPTION, askShape, statusShape, type BuddyBackend,
} from "../mcp/tools.js";

export const XAI_BASE_URL = process.env.XAI_BASE_URL ?? "https://api.x.ai/v1";
export type ChatMessage = { role: "user" | "assistant"; content: string };
type FetchFn = typeof fetch;

const statusSchema = z.object(statusShape);
const askSchema = z.object(askShape);

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

const TOOLS = [
  { type: "function", function: { name: "set_status", description: SET_STATUS_DESCRIPTION, parameters: jsonSchema(statusSchema) } },
  { type: "function", function: { name: "ask_user", description: ASK_USER_DESCRIPTION, parameters: jsonSchema(askSchema) } },
];

const SYSTEM_PROMPT =
  "You are Grok, chatting with the user through Agent Buddy, a small companion character on their Windows desktop. " +
  "Use set_status to show progress on the buddy during multi-step work (agent name 'Grok'). " +
  "Optionally set next on set_status for a short planned next step. " +
  "Before anything risky or irreversible, or when the user must choose, call ask_user and respect the answer. " +
  "Keep replies concise.";

async function describeError(res: Response): Promise<string> {
  const text = (await res.text()).slice(0, 300);
  if (res.status === 401 || res.status === 403) return "xAI rejected the API key. Check it in Ask Grok → Change key.";
  if (res.status === 429) return "xAI rate limit or credit limit reached. Try again later or check your xAI console.";
  return `xAI API error ${res.status}: ${text}`;
}

/** Picks the newest Grok chat model this key can use. */
export async function pickModel(apiKey: string, baseUrl = XAI_BASE_URL, fetchImpl: FetchFn = fetch): Promise<string> {
  const res = await fetchImpl(`${baseUrl}/models`, { headers: { authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(await describeError(res));
  const data = (await res.json()) as { data?: { id: string; created?: number }[] };
  const chat = (data.data ?? []).filter(
    (m) => /^grok/i.test(m.id) && !/image|imagine|vision|video|tts|voice|embed/i.test(m.id)
  );
  chat.sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  if (chat.length === 0) throw new Error("No Grok chat models are available for this API key.");
  return chat[0].id;
}

async function runTool(name: string, rawArgs: string, backend: BuddyBackend): Promise<string> {
  let args: unknown;
  try { args = JSON.parse(rawArgs || "{}"); } catch { return "Error: arguments were not valid JSON."; }
  if (name === "set_status") {
    const p = statusSchema.safeParse(args);
    if (!p.success) return `Error: ${p.error.message}`;
    await backend.setStatus({ agent: "Grok", ...p.data });
    return `Agent Buddy now shows: ${p.data.state}`;
  }
  if (name === "ask_user") {
    const p = askSchema.safeParse(args);
    if (!p.success) return `Error: ${p.error.message}`;
    const result = await backend.askUser({ agent: "Grok", ...p.data });
    if (result.busy) return "Another question is already waiting. Do not proceed yet.";
    return result.answer === null ? "The user did not answer in time. Do not proceed." : `The user chose: ${result.answer}`;
  }
  return `Error: unknown tool ${name}`;
}

export interface GrokChatOptions {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  backend: BuddyBackend;
  baseUrl?: string;
  fetchImpl?: FetchFn;
  maxSteps?: number;
  signal?: AbortSignal;
}

/** Runs one user turn: calls Grok, executes any tool calls locally, repeats until Grok replies. */
export async function runGrokChat(o: GrokChatOptions): Promise<{ reply: string; toolCalls: string[] }> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const baseUrl = o.baseUrl ?? XAI_BASE_URL;
  const toolCalls: string[] = [];
  const msgs: Record<string, unknown>[] = [{ role: "system", content: SYSTEM_PROMPT }, ...o.messages];

  for (let step = 0; step < (o.maxSteps ?? 8); step++) {
    if (o.signal?.aborted) throw new Error("Cancelled.");
    const res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${o.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: o.model, messages: msgs, tools: TOOLS }),
      signal: o.signal,
    });
    if (!res.ok) throw new Error(await describeError(res));
    const data = (await res.json()) as {
      choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
    };
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error("Grok returned no message.");
    const calls = msg.tool_calls ?? [];
    if (calls.length === 0) return { reply: msg.content ?? "", toolCalls };

    msgs.push({ role: "assistant", content: msg.content ?? "", tool_calls: calls });
    for (const call of calls) {
      if (o.signal?.aborted) throw new Error("Cancelled.");
      toolCalls.push(call.function.name);
      msgs.push({ role: "tool", tool_call_id: call.id, content: await runTool(call.function.name, call.function.arguments, o.backend) });
    }
  }
  throw new Error("Grok used too many tool steps without replying.");
}
