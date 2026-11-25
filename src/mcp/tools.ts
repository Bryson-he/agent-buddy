// The Agent Buddy connector: the tools any agent can call.
// Shared by the in-app HTTP MCP endpoint and the stdio bridge, and mirrored
// as function tools for the built-in "Ask Grok" chat.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export const STATUS_STATES = ["working", "finished", "error", "upload", "idle", "greeting"] as const;
export type StatusState = (typeof STATUS_STATES)[number];
export const URGENCIES = ["quiet", "normal", "urgent"] as const;
export type Urgency = (typeof URGENCIES)[number];

export interface SetStatusArgs {
  state: StatusState;
  message?: string;
  /** Optional "what comes next" line shown under the current step. */
  next?: string;
  agent?: string;
  /** How far through a countable job: drawn as a bar. */
  progress?: { done: number; total: number };
  /** quiet: no sound, the notch stays small. urgent: a sound and a notification. */
  urgency?: Urgency;
  /** A web address the user can open from the notch with one click. */
  link?: string;
  /** What the link's button says. */
  link_label?: string;
}
/** What comes back from a status update: anything the user left for this agent. */
export interface StatusReply {
  /** Notes the user typed for this agent on the notch since its last update. */
  notes: string[];
  /** A button the user pressed for this agent. */
  command?: "pause" | "stop";
  /** True when the user has not touched the PC for a while. */
  away: boolean;
}
export interface AskUserArgs {
  question: string;
  /** Two to four answers. Two short ones show as buttons; more, or longer ones, as a list. */
  options?: string[];
  /** Adds a "Something else" choice that lets the user type their own answer. */
  allow_other?: boolean;
  /** The user types an answer instead of choosing. */
  free_text?: boolean;
  /** The user may tick more than one option. */
  multi_select?: boolean;
  /** Longer background the user can open before answering (a draft, the rows affected). */
  detail?: string;
  agent?: string;
  timeout_sec?: number;
}
export interface AskUserResult {
  answer: string | null;
  /** With multi_select: each option the user ticked. */
  answers?: string[];
  /** True when the user did not click before the timeout. */
  timedOut?: boolean;
  /** True when another question was already waiting; this ask was not shown. */
  busy?: boolean;
  /** True when the question is still on screen, unanswered: ask again with the same question to keep waiting. */
  pending?: boolean;
  /** True when the user was away from the PC, so the question was not shown at all. */
  away?: boolean;
}
export interface RemindArgs {
  text: string;
  in_minutes?: number;
  /** A local time today or tomorrow as "HH:MM" (24 hour), or a full ISO date and time. */
  at?: string;
  agent?: string;
}
/** How one request waits, as opposed to how long the question stays on screen. */
export interface AskWait {
  /** Give this request back as "pending" after this many seconds, leaving the question up. */
  detachAfterSec?: number;
  /** Answer at once with "away" when the user is not at the PC, without showing the question. */
  tellIfAway?: boolean;
}
export interface BuddyBackend {
  setStatus(a: SetStatusArgs): Promise<StatusReply | void>;
  /** Resolves with the label the user clicked, or null if nobody answered / busy. */
  askUser(a: AskUserArgs, wait?: AskWait): Promise<AskUserResult>;
  /** Schedules a reminder; resolves with when it will show (ms since 1970), or null if the time made no sense. */
  remindUser?(a: RemindArgs): Promise<{ at: number } | null>;
}

export const SET_STATUS_DESCRIPTION =
  "Show what you are doing on the user's Agent Buddy desktop companion. " +
  "Call it when you start a task, at each major step (with a short message such as 'Editing app.ts'), " +
  "and when you finish ('finished') or fail ('error'). Keep messages under 60 characters. " +
  "Optionally set next to a short planned next step (under 60 characters). " +
  "For a countable job pass progress {done, total} and it draws a bar. " +
  "urgency 'quiet' keeps a routine update silent and small; 'urgent' adds a sound and a notification. " +
  "link (an https address) with link_label adds a button the user can click, e.g. to open the file you updated. " +
  "ALWAYS read the result: it carries anything the user left for you on the notch (a note, or a Pause or Stop request), and you must follow it.";

export const ASK_USER_DESCRIPTION =
  "Ask the user a question on their Agent Buddy desktop companion and wait for their answer. " +
  "Use it before anything risky or hard to undo (deleting files, running commands that change things, " +
  "sending or publishing something) or when you need the user to choose. " +
  "Shows two buttons (default 'Approve' and 'Deny') and returns the label the user clicked. " +
  "For a choice between up to four courses of action, pass two to four options (each a short phrase, up to 80 characters): " +
  "they show as a lettered list. Set allow_other to true to add a 'Something else' choice where the user types their own answer. " +
  "Set multi_select to true when the user may pick more than one option. " +
  "Put longer background (the draft you want to send, the rows affected) in detail: the user can open it before answering. " +
  "Set free_text to true when you only need a short typed answer (a name, a number): " +
  "the user gets a text box and you get back what they typed. " +
  "If the result says the question is still waiting, call ask_user again with exactly the same question, options and agent " +
  "to keep waiting; it is not shown twice. If it says the user is away, ask in chat instead.";

export const REMIND_USER_DESCRIPTION =
  "Set a reminder that will appear on the user's Agent Buddy desktop companion at a later time, with a sound. " +
  "Give the text and either in_minutes or at ('HH:MM' in 24 hour local time, or a full ISO date and time). " +
  "Use it when the user asks to be reminded, or to bring something back to them later (a follow-up that is due, a check that needs their eyes).";

export const statusShape = {
  state: z.enum(STATUS_STATES).describe("What the agent is doing"),
  message: z.string().max(200).optional().describe("One short line shown under the bot"),
  next: z.string().max(200).optional().describe("Optional next-step line shown under the current message"),
  agent: z.string().max(40).optional().describe("Name of the agent, e.g. 'Grok Bot'"),
  progress: z.object({
    done: z.number().int().min(0).max(1_000_000),
    total: z.number().int().min(1).max(1_000_000),
  }).optional().describe("How far through a countable job, e.g. {done: 12, total: 30}"),
  urgency: z.enum(URGENCIES).optional().describe("quiet: silent and small. urgent: sound and notification. Default normal"),
  link: z.string().max(800).regex(/^https?:\/\/\S+$/i).optional().describe("An http(s) address the user can open from the notch"),
  link_label: z.string().min(1).max(30).optional().describe("The link button's text, e.g. 'Open tracker'"),
};
export const askShape = {
  question: z.string().min(1).max(400).describe("The question to show the user"),
  options: z.array(z.string().min(1).max(80)).min(2).max(4).optional()
    .describe("Two to four answers; default ['Approve', 'Deny']. Keep two-button labels under 24 characters"),
  allow_other: z.boolean().optional().describe("Add a 'Something else' choice where the user types their own answer"),
  free_text: z.boolean().optional().describe("Show a text box instead of buttons and return what the user types"),
  multi_select: z.boolean().optional().describe("Let the user tick more than one option; the result lists each one ticked"),
  detail: z.string().max(2000).optional().describe("Longer background the user can open before answering"),
  agent: z.string().max(40).optional().describe("Name of the agent asking"),
  timeout_sec: z.number().int().min(10).max(600).optional().describe("How long the question stays up; default 120 (300 through the tunnel)"),
};
export const remindShape = {
  text: z.string().min(1).max(200).describe("What to remind the user of"),
  in_minutes: z.number().int().min(1).max(10_080).optional().describe("How many minutes from now (up to a week)"),
  at: z.string().max(40).optional().describe("'HH:MM' in 24 hour local time (today, or tomorrow if that has passed), or an ISO date and time"),
  agent: z.string().max(40).optional().describe("Name of the agent setting it"),
};

/** The words a status update's result carries when the user left something for the agent. */
export function statusReplyText(reply: StatusReply | void): string {
  if (!reply) return "";
  const parts: string[] = [];
  if (reply.command === "stop") {
    parts.push("THE USER PRESSED STOP on Agent Buddy: stop now. Do not start any further steps or tool calls for this task. Set your status to finished with what was done so far, and tell them in chat.");
  } else if (reply.command === "pause") {
    parts.push("THE USER PRESSED PAUSE on Agent Buddy: finish the step you are on, then stop. Tell them in chat where you paused and wait for them to say continue.");
  }
  for (const note of reply.notes) parts.push(`MESSAGE FROM THE USER, left on Agent Buddy for you (follow it): "${note}"`);
  if (reply.away) parts.push("(The user is away from their PC right now.)");
  return parts.length ? ` ${parts.join(" ")}` : "";
}

export function createBuddyMcpServer(backend: BuddyBackend): McpServer {
  const server = new McpServer({ name: "agent-buddy", version: "0.2.0" });

  server.registerTool(
    "set_status",
    { title: "Show status on Agent Buddy", description: SET_STATUS_DESCRIPTION, inputSchema: statusShape },
    async (args) => {
      const reply = await backend.setStatus(args);
      return {
        content: [{ type: "text", text: `Agent Buddy now shows: ${args.state}${args.message ? ` (${args.message})` : ""}.${statusReplyText(reply)}` }],
        structuredContent: { notes: reply ? reply.notes : [], command: reply?.command ?? null, userAway: reply ? reply.away : false },
      };
    }
  );

  server.registerTool(
    "ask_user",
    { title: "Ask the user via Agent Buddy", description: ASK_USER_DESCRIPTION, inputSchema: askShape },
    async (args) => {
      const result = await backend.askUser(args);
      let text: string;
      if (result.away) {
        text = "The user is away from their PC, so the question was not shown on Agent Buddy. Ask in chat instead (your question card is fine), and do not proceed with anything risky until they answer.";
      } else if (result.pending) {
        text = "No answer yet. The question is still on the user's screen. Call ask_user again with exactly the same question, options and agent to keep waiting (it will not be shown twice). Do not proceed until you have an answer.";
      } else if (result.busy) {
        text = "Too many questions are already waiting on Agent Buddy. Do not proceed with this risky action yet; try ask_user again shortly, or ask in chat.";
      } else if (result.answer === null) {
        text = "The user did not answer in time. Do not proceed with the risky action; ask again later or stop.";
      } else if (result.answers) {
        text = `The user picked ${result.answers.length}: ${result.answers.map((a) => `"${a}"`).join(", ")}`;
      } else {
        const typed = args.free_text === true || !(args.options ?? ["Approve", "Deny"]).includes(result.answer);
        text = typed ? `The user answered: ${result.answer}` : `The user chose: ${result.answer}`;
      }
      return {
        content: [{ type: "text", text }],
        structuredContent: {
          answer: result.answer,
          answers: result.answers ?? null,
          timedOut: result.timedOut === true,
          busy: result.busy === true,
          pending: result.pending === true,
          away: result.away === true,
        },
      };
    }
  );

  if (backend.remindUser) {
    const remind = backend.remindUser.bind(backend);
    server.registerTool(
      "remind_user",
      { title: "Set a reminder on Agent Buddy", description: REMIND_USER_DESCRIPTION, inputSchema: remindShape },
      async (args) => {
        const set = await remind(args);
        const text = set
          ? `Reminder set for ${new Date(set.at).toLocaleString()}: "${args.text}". It will show on Agent Buddy if the PC is on then.`
          : "That reminder was not set: give in_minutes, or at as 'HH:MM' (24 hour) or an ISO date and time in the future.";
        return { content: [{ type: "text", text }], structuredContent: { at: set ? new Date(set.at).toISOString() : null } };
      }
    );
  }

  return server;
}
