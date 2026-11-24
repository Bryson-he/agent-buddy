// The Agent Buddy connector: two tools any agent can call.
// Shared by the in-app HTTP MCP endpoint and the stdio bridge, and mirrored
// as function tools for the built-in "Ask Grok" chat.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export const STATUS_STATES = ["working", "finished", "error", "upload", "idle", "greeting"] as const;
export type StatusState = (typeof STATUS_STATES)[number];

export interface SetStatusArgs {
  state: StatusState;
  message?: string;
  /** Optional "what comes next" line shown under the current step. */
  next?: string;
  agent?: string;
}
export interface AskUserArgs {
  question: string;
  /** Two to four answers. Two short ones show as buttons; more, or longer ones, as a list. */
  options?: string[];
  /** Adds a "Something else" choice that lets the user type their own answer. */
  allow_other?: boolean;
  /** The user types an answer instead of choosing. */
  free_text?: boolean;
  agent?: string;
  timeout_sec?: number;
}
export interface AskUserResult {
  answer: string | null;
  /** True when the user did not click before the timeout. */
  timedOut?: boolean;
  /** True when another question was already waiting; this ask was not shown. */
  busy?: boolean;
  /** True when the question is still on screen, unanswered: ask again with the same question to keep waiting. */
  pending?: boolean;
}
/** How one request waits, as opposed to how long the question stays on screen. */
export interface AskWait {
  /** Give this request back as "pending" after this many seconds, leaving the question up. */
  detachAfterSec?: number;
}
export interface BuddyBackend {
  setStatus(a: SetStatusArgs): Promise<void>;
  /** Resolves with the label the user clicked, or null if nobody answered / busy. */
  askUser(a: AskUserArgs, wait?: AskWait): Promise<AskUserResult>;
}

export const SET_STATUS_DESCRIPTION =
  "Show what you are doing on the user's Agent Buddy desktop companion. " +
  "Call it when you start a task, at each major step (with a short message such as 'Editing app.ts'), " +
  "and when you finish ('finished') or fail ('error'). Keep messages under 60 characters. " +
  "Optionally set next to a short planned next step (under 60 characters).";

export const ASK_USER_DESCRIPTION =
  "Ask the user a question on their Agent Buddy desktop companion and wait for their answer. " +
  "Use it before anything risky or hard to undo (deleting files, running commands that change things, " +
  "sending or publishing something) or when you need the user to choose. " +
  "Shows two buttons (default 'Approve' and 'Deny') and returns the label the user clicked. " +
  "For a choice between up to four courses of action, pass two to four options (each a short phrase, up to 80 characters): " +
  "they show as a lettered list. Set allow_other to true to add a 'Something else' choice where the user types their own answer. " +
  "Set free_text to true when you only need a short typed answer (a name, a number): " +
  "the user gets a text box and you get back what they typed. " +
  "If the result says the question is still waiting, call ask_user again with exactly the same question, options and agent " +
  "to keep waiting; it is not shown twice.";

export const statusShape = {
  state: z.enum(STATUS_STATES).describe("What the agent is doing"),
  message: z.string().max(200).optional().describe("One short line shown under the bot"),
  next: z.string().max(200).optional().describe("Optional next-step line shown under the current message"),
  agent: z.string().max(40).optional().describe("Name of the agent, e.g. 'Grok Bot'"),
};
export const askShape = {
  question: z.string().min(1).max(400).describe("The question to show the user"),
  options: z.array(z.string().min(1).max(80)).min(2).max(4).optional()
    .describe("Two to four answers; default ['Approve', 'Deny']. Keep two-button labels under 24 characters"),
  allow_other: z.boolean().optional().describe("Add a 'Something else' choice where the user types their own answer"),
  free_text: z.boolean().optional().describe("Show a text box instead of buttons and return what the user types"),
  agent: z.string().max(40).optional().describe("Name of the agent asking"),
  timeout_sec: z.number().int().min(10).max(600).optional().describe("How long the question stays up; default 120 (300 through the tunnel)"),
};

export function createBuddyMcpServer(backend: BuddyBackend): McpServer {
  const server = new McpServer({ name: "agent-buddy", version: "0.1.0" });

  server.registerTool(
    "set_status",
    { title: "Show status on Agent Buddy", description: SET_STATUS_DESCRIPTION, inputSchema: statusShape },
    async (args) => {
      await backend.setStatus(args);
      return { content: [{ type: "text", text: `Agent Buddy now shows: ${args.state}${args.message ? ` (${args.message})` : ""}` }] };
    }
  );

  server.registerTool(
    "ask_user",
    { title: "Ask the user via Agent Buddy", description: ASK_USER_DESCRIPTION, inputSchema: askShape },
    async (args) => {
      const result = await backend.askUser(args);
      let text: string;
      if (result.pending) {
        text = "No answer yet. The question is still on the user's screen. Call ask_user again with exactly the same question, options and agent to keep waiting (it will not be shown twice). Do not proceed until you have an answer.";
      } else if (result.busy) {
        text = "Too many questions are already waiting on Agent Buddy. Do not proceed with this risky action yet; try ask_user again shortly, or ask in chat.";
      } else if (result.answer === null) {
        text = "The user did not answer in time. Do not proceed with the risky action; ask again later or stop.";
      } else {
        const typed = args.free_text === true || !(args.options ?? ["Approve", "Deny"]).includes(result.answer);
        text = typed ? `The user answered: ${result.answer}` : `The user chose: ${result.answer}`;
      }
      return {
        content: [{ type: "text", text }],
        structuredContent: {
          answer: result.answer,
          timedOut: result.timedOut === true,
          busy: result.busy === true,
          pending: result.pending === true,
        },
      };
    }
  );

  return server;
}
