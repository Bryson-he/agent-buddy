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
  options?: string[];
  /** The user types an answer instead of choosing one of two buttons. */
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
}
export interface BuddyBackend {
  setStatus(a: SetStatusArgs): Promise<void>;
  /** Resolves with the label the user clicked, or null if nobody answered / busy. */
  askUser(a: AskUserArgs): Promise<AskUserResult>;
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
  "Set free_text to true when you need a short typed answer (a name, a number, a choice among many) instead: " +
  "the user gets a text box and you get back what they typed.";

export const statusShape = {
  state: z.enum(STATUS_STATES).describe("What the agent is doing"),
  message: z.string().max(200).optional().describe("One short line shown under the bot"),
  next: z.string().max(200).optional().describe("Optional next-step line shown under the current message"),
  agent: z.string().max(40).optional().describe("Name of the agent, e.g. 'Grok Bot'"),
};
export const askShape = {
  question: z.string().min(1).max(300).describe("The question to show the user"),
  options: z.array(z.string().min(1).max(24)).length(2).optional()
    .describe("Exactly two button labels; default ['Approve', 'Deny']"),
  free_text: z.boolean().optional().describe("Show a text box instead of buttons and return what the user types"),
  agent: z.string().max(40).optional().describe("Name of the agent asking"),
  timeout_sec: z.number().int().min(10).max(600).optional().describe("How long to wait; default 120"),
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
      if (result.busy) {
        text = "Too many questions are already waiting on Agent Buddy. Do not proceed with this risky action yet; try ask_user again shortly, or ask in chat.";
      } else if (result.answer === null) {
        text = "The user did not answer in time. Do not proceed with the risky action; ask again later or stop.";
      } else {
        text = args.free_text ? `The user answered: ${result.answer}` : `The user chose: ${result.answer}`;
      }
      return {
        content: [{ type: "text", text }],
        structuredContent: {
          answer: result.answer,
          timedOut: result.timedOut === true,
          busy: result.busy === true,
        },
      };
    }
  );

  return server;
}
