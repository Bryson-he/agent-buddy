# Connecting agents

Agent Buddy runs a small server on `http://127.0.0.1:47821`. Agents reach it in one of four ways. The tray menu (**Connect an agent**) and the **Quick start** window copy each config with the paths filled in for your PC.

- [Claude Code](#claude-code)
- [Cursor](#cursor)
- [Cloud bots (Grok Bot and similar)](#cloud-bots-grok-bot-and-similar)
- [Anything with MCP](#anything-with-mcp)
- [Plain HTTP](#plain-http)

## Claude Code

Needs Node.js. Hooks report each tool call and ask before a risky shell command.

1. Tray → Connect an agent → **Copy Claude Code hooks (settings.json)**.
2. Merge the copied `hooks` block into `%USERPROFILE%\.claude\settings.json`.
3. Start a new session. `/hooks` lists them.

A **Deny** on the notch blocks the command, and so does not answering within 120 seconds. If Agent Buddy is not running, the hooks do nothing and Claude Code uses its own permission prompt as usual. The rules for "risky" are in `connectors/shared/risky.mjs`.

## Cursor

Needs Node.js.

1. Tray → Connect an agent → **Copy Cursor hooks.json**.
2. Save it as `%USERPROFILE%\.cursor\hooks.json` (merge if you already have one).
3. Restart Cursor.

## Cloud bots (Grok Bot and similar)

Some agents run their connectors on their own servers, not on your PC, so `127.0.0.1` means nothing to them. For those, Agent Buddy opens a Cloudflare tunnel: a public HTTPS address that leads only to the MCP endpoint and only with a secret token.

1. Install cloudflared: `winget install Cloudflare.cloudflared`.
2. Tray → Connect an agent → tick **Public tunnel**. After a few seconds the menu shows the address.
3. In the bot's app, add a custom connector:
   - Name: `agent-buddy`
   - Type: Remote HTTPS
   - Server URL: tray → **Copy server URL** (ends in `/mcp`)
   - HTTP header: name `Authorization`, value from tray → **Copy header value (secret token)**
4. Give each bot the skill that tells it to report: tray → **Copy skill for bot…**, or the text in [skill-agent-buddy.md](skill-agent-buddy.md) with `BOTNAME` replaced. In Grok Bot that goes under the bot's settings → Knowledge → Skills.

Things to know:

- **Treat the header value like a password.** Anyone with it and the address can show statuses and ask you questions. Tray → **Rotate connector token** makes a new one; update the connector afterwards.
- **A quick tunnel's address is random** and changes after a reboot or when the tunnel is switched off. Then the connector has to be removed and added again with the new address.
- **A slow answer is fine.** Cloudflare drops a request that has been silent for 100 seconds, so after 85 the bot is told the question is still waiting and asks again. The question stays on your screen the whole time (5 minutes unless the bot sets `timeout_sec`, 10 at most) and is never shown twice.
- In Grok Bot, a connector's URL cannot be edited: uninstall it and add it again. After re-adding one mid-conversation, a bot's next tool call can fail once with a "server changed" message; it clears on the next message.
- If bots go quiet, look in `%APPDATA%\agent-buddy\activity.log` for `"result":401`: that means the token saved in the connector is wrong.

### A fixed address

With a Cloudflare account and a domain you can keep one address for good.

1. `cloudflared tunnel login`
2. `cloudflared tunnel create agent-buddy`
3. `cloudflared tunnel route dns agent-buddy buddy.example.com`
4. In `%USERPROFILE%\.cloudflared\config.yml`, point the tunnel at `http://127.0.0.1:47821`.
5. In `%APPDATA%\agent-buddy\settings.json` set:

```json
{
  "tunnel": true,
  "tunnelMode": "named",
  "namedTunnelName": "agent-buddy",
  "namedHostname": "buddy.example.com"
}
```

6. Switch the tunnel off and on from the tray.

## Anything with MCP

Tray → Connect an agent → **Copy connector config (URL / HTTP)**:

```json
{ "mcpServers": { "agent-buddy": { "url": "http://127.0.0.1:47821/mcp" } } }
```

For agents that can only launch a command, use **Copy connector config (command / stdio)** instead. Then tell the agent, in its rules or system prompt, to call `set_status` as it works and `ask_user` before anything you would want to approve. [skill-agent-buddy.md](skill-agent-buddy.md) is wording that has held up well.

| Tool | Arguments |
|---|---|
| `set_status` | `state` (`working`, `finished`, `error`, `upload`, `idle`, `greeting`), `message?`, `next?`, `agent?` |
| `ask_user` | `question`, `options?` (two to four answers), `allow_other?` (adds "Something else" with a text box), `free_text?` (typed answer only), `agent?`, `timeout_sec?` |

Two short options show as buttons. Three or four, any option longer than 24 characters, or `allow_other` turns the question into a numbered list.

`agent` is the name shown on the notch. It picks the colour and keeps each agent's line separate.

## Plain HTTP

For scripts and quick tests, from this PC only:

```powershell
Invoke-RestMethod http://127.0.0.1:47821/api/status -Method Post -ContentType 'application/json' -Body '{"state":"working","message":"Backing up","agent":"Nightly job"}'
Invoke-RestMethod http://127.0.0.1:47821/api/ask -Method Post -ContentType 'application/json' -Body '{"question":"Delete the old backups?","options":["Delete","Keep"],"agent":"Nightly job"}'
```

`/api/ask` answers with `{ "answer", "timedOut", "busy", "pending" }`.
