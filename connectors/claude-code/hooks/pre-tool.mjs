#!/usr/bin/env node
// Claude Code PreToolUse: show status; ask on the notch before risky shell
// commands. Fail-open: if Agent Buddy is not running, Claude Code carries on
// with its own permission flow.
import { askUser, readStdin, reply, setStatus } from "./lib.mjs";
import { riskReason } from "../../shared/risky.mjs";

// Claude Code only reads a PreToolUse decision from inside hookSpecificOutput.
function decide(permissionDecision, permissionDecisionReason) {
  reply({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason } });
  process.exit(0);
}

const input = await readStdin();
const tool = String(input.tool_name ?? input.toolName ?? "");
const toolInput = input.tool_input ?? input.toolInput ?? {};
const cmd = String(toolInput.command ?? "").trim();

if (tool === "Bash" || tool === "PowerShell") {
  await setStatus("working", cmd ? `Shell: ${cmd.slice(0, 50)}` : "About to run a shell command");
  const why = riskReason(cmd);
  if (!why) process.exit(0); // routine: leave it to Claude Code's normal permissions

  const result = await askUser(`Allow this command? (${why})\n${cmd.slice(0, 180)}`, ["Approve", "Deny"]);
  if (!result) process.exit(0); // Agent Buddy is down: do not block
  if (result.busy) decide("ask", "Another Agent Buddy question is waiting, so this one was not shown.");
  if (result.timedOut || result.answer == null) decide("deny", "No answer on Agent Buddy in time.");
  const ok = /^(approve|allow|yes|run)$/i.test(String(result.answer).trim());
  decide(ok ? "allow" : "deny", ok ? `User chose "${result.answer}" on Agent Buddy.` : `User denied on Agent Buddy (${result.answer}).`);
}

if (tool === "Edit" || tool === "Write") {
  const file = String(toolInput.file_path ?? toolInput.path ?? "").split(/[/\\]/).pop() || "a file";
  await setStatus("working", `Editing ${file}`);
}

process.exit(0);
