#!/usr/bin/env node
// Claude Code PostToolUse: refresh the notch after edits / shell.
import { readStdin, setStatus } from "./lib.mjs";

const input = await readStdin();
const tool = String(input.tool_name ?? input.toolName ?? "");
const toolInput = input.tool_input ?? input.toolInput ?? {};

if (tool === "Edit" || tool === "Write") {
  const file = String(toolInput.file_path ?? toolInput.path ?? "").split(/[/\\]/).pop() || "a file";
  await setStatus("working", `Edited ${file}`);
} else if (tool === "Bash" || tool === "PowerShell") {
  const cmd = String(toolInput.command ?? "").trim();
  await setStatus("working", cmd ? `Ran: ${cmd.slice(0, 50)}` : "Ran a shell command");
}

process.exit(0);
