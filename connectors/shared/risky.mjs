// Decides whether a shell command should be confirmed on the notch first.
// Shared by the Cursor and Claude Code hooks. Deliberately errs towards asking:
// it is a speed bump for destructive or hard-to-undo commands, not a sandbox.

// Start of a command: line start, or after a separator, pipe, bracket or quote.
const AT = String.raw`(?:^|[\s;&|({"'\`])`;
// End of the command word: whitespace or end of line (so flags like -rf still count).
const END = String.raw`(?=\s|$)`;

const RULES = [
  // Deleting files and folders (Unix, cmd and PowerShell, with common aliases)
  [new RegExp(`${AT}(?:rm|rmdir|rd|del|erase|unlink|shred|Remove-Item|ri|Clear-Content|Clear-RecycleBin)${END}`, "i"), "deletes files"],
  // Disks, volumes and power
  [new RegExp(`${AT}(?:diskpart|mkfs(?:\\.\\w+)?|dd|Format-Volume|Clear-Disk|Remove-Partition|shutdown|Restart-Computer|Stop-Computer)${END}`, "i"), "changes disks or power"],
  // "format c:" only as a command with a drive letter, so "npm run format" stays routine
  [/(?:^|[;&|]\s*)format\s+[a-z]:/i, "formats a drive"],
  // Git: rewriting or discarding work
  [/\bgit\s+push\b[^\n]*(?:--force\b|--force-with-lease\b|\s-f\b|\s\+\S)/i, "force-pushes"],
  [/\bgit\s+reset\b[^\n]*--hard\b/i, "discards local changes"],
  [/\bgit\s+clean\b[^\n]*\s-[a-z]*[fdx]/i, "deletes untracked files"],
  [/\bgit\s+(?:checkout|restore)\b[^\n]*(?:\s--\s|\s\.(?:\s|$))/i, "discards local changes"],
  [/\bgit\s+branch\b[^\n]*\s-D\b/, "deletes a branch"],
  // Publishing
  [/\b(?:npm|pnpm|yarn)\s+publish\b/i, "publishes a package"],
  // Databases
  [/\b(?:drop\s+(?:table|database|schema)|truncate\s+table)\b/i, "drops database data"],
  [/\bdelete\s+from\s+\w+\s*(?:;|$)/i, "deletes all rows"],
  // Downloading and running code in one go
  [/\b(?:curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n|]*\|\s*(?:sh|bash|zsh|iex|Invoke-Expression|powershell|pwsh|python\d?|node)\b/i, "runs downloaded code"],
  // Registry and services
  [new RegExp(`${AT}reg\\s+delete${END}`, "i"), "deletes registry keys"],
  [new RegExp(`${AT}(?:Remove-ItemProperty|Stop-Service|sc\\s+delete|taskkill|Stop-Process)${END}`, "i"), "stops or removes system items"],
];

/** Returns a short reason if the command should be confirmed, or null if it looks routine. */
export function riskReason(command) {
  const cmd = String(command ?? "");
  for (const [re, why] of RULES) if (re.test(cmd)) return why;
  return null;
}

export function isRisky(command) {
  return riskReason(command) !== null;
}
