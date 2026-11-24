#!/usr/bin/env node
// Cursor beforeShellExecution: ask on the notch before risky shell commands.
// Fail-open: if Agent Buddy is not running, the command is allowed.
import { askUser, readStdin, reply, setStatus } from "./lib.mjs";
import { riskReason } from "../../shared/risky.mjs";

const input = await readStdin();
const command = String(input.command ?? input.command_line ?? "").trim();

await setStatus("working", command ? `Shell: ${command.slice(0, 50)}` : "About to run a shell command");

const why = riskReason(command);
if (!why) {
  reply({ permission: "allow" });
  process.exit(0);
}

const result = await askUser(`Allow this command? (${why})\n${command.slice(0, 180)}`, ["Approve", "Deny"]);
if (!result) {
  // Agent Buddy is not running: do not block Cursor.
  reply({ permission: "allow", agent_message: "Agent Buddy was not reachable; allowed without asking." });
  process.exit(0);
}
if (result.busy) {
  reply({ permission: "ask", user_message: "Another Agent Buddy question is waiting.", agent_message: "Ask the user in chat instead." });
  process.exit(0);
}
if (result.timedOut || result.answer === null) {
  reply({ permission: "deny", user_message: "No answer on Agent Buddy in time.", agent_message: "Shell denied: user did not answer." });
  process.exit(0);
}
const ok = /^(approve|allow|yes|run)$/i.test(String(result.answer).trim());
reply({
  permission: ok ? "allow" : "deny",
  user_message: ok ? undefined : `You chose "${result.answer}" on Agent Buddy.`,
  agent_message: ok ? `User chose "${result.answer}".` : `User denied (${result.answer}).`,
});
