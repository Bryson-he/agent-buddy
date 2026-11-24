# Claude Code → Agent Buddy

Hooks that call Agent Buddy's local API at `http://127.0.0.1:47821` (no tunnel). They need Node.js, and they fail open: if Agent Buddy is not running, Claude Code carries on as normal.

Install: tray → Connect an agent → **Copy Claude Code hooks (settings.json)**, then merge the copied block into `%USERPROFILE%\.claude\settings.json`. Or let Claude Code do it: see [docs/SETUP-WITH-AI.md](../../docs/SETUP-WITH-AI.md).

| Event | Script | Does |
|---|---|---|
| PreToolUse (`Bash\|PowerShell\|Edit\|Write`) | `hooks/pre-tool.mjs` | Shows the step; asks on the notch before a risky shell command |
| PostToolUse (same matcher) | `hooks/post-tool.mjs` | Shows the result of an edit or command |
| Stop | `hooks/stop.mjs` | Marks the turn finished |

Give PreToolUse `"timeout": 130`, longer than the 120 seconds a question waits. In Claude Code, `/hooks` confirms they loaded.

What counts as risky is decided in [`../shared/risky.mjs`](../shared/risky.mjs), shared with the Cursor hooks.
