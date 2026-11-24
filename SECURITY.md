# Security

Agent Buddy shows messages from AI agents and passes your answers back to them. Here is what protects that, and what it does not try to do.

## What it does

- **Local only by default.** The server listens on `127.0.0.1:47821`. Other devices on your network cannot reach it.
- **Web pages are refused.** Any request with an `Origin` header gets a 403, so a site open in your browser cannot drive the notch.
- **The tunnel is opt-in and narrow.** When you switch it on, requests from outside can reach only `/mcp`, only with `Authorization: Bearer <token>` (compared in constant time), and are rate-limited. Everything else returns 404 or 401.
- **Secrets are encrypted at rest.** The connector token and any saved xAI key are stored with Windows DPAPI, readable only by your Windows account. The token is never written to the activity log.
- **Notification buttons carry a one-time code** per question, so an `agentbuddy://` link planted on a web page cannot answer for you.
- **Windows are sandboxed.** Every page runs with context isolation, no Node integration, and a strict content security policy.

## What it does not do

- **It is not a sandbox for your agents.** The risky-command check in the Claude Code and Cursor hooks is a convenience that errs towards asking. An agent that wants to do harm has other ways.
- **Anyone holding the tunnel address and token can show statuses and ask you questions.** They cannot read your files or run commands through Agent Buddy, but they could try to trick you with a misleading question. Rotate the token (tray → Connect an agent) if it may have leaked.
- **Status text is whatever the agent sends.** Treat it as the agent's claim, not proof.
- **The installer is not code-signed.**

## Reporting a problem

Please open a private security advisory on GitHub (Security → Report a vulnerability) rather than a public issue.
