# Let an AI set it up

Two prompts. Use the first if Agent Buddy is already installed, the second to have an agent do everything from nothing.

## 1. Agent Buddy is installed: connect my agent

The easiest way is inside the app: tray icon → **Quick start** → **Let an AI do it** → **Copy the prompt**. That copy has the paths already filled in for your PC.

If you would rather copy it from here, paste this into Claude Code or Cursor:

```text
Please connect yourself to Agent Buddy, a small desktop companion already running on this Windows PC. It shows what you are doing in a notch at the top of my screen and asks me before risky commands.

Rules
- Only edit the two config files named below. Back each one up first (same name plus .bak) if it exists.
- Merge into what is already there. Never remove or overwrite my other hooks or settings.
- If something does not match what you expect, stop and tell me instead of guessing.

Steps
1. Check Agent Buddy is running: GET http://127.0.0.1:47821/health should return {"ok":true,"name":"agent-buddy"}. If it does not, ask me to start Agent Buddy and stop.
2. Check Node.js is installed (node -v). The hooks are small Node scripts. If it is missing, tell me to install Node.js LTS and stop.
3. Find the hook scripts. Installed copy: %LOCALAPPDATA%\Programs\Agent Buddy\resources\app.asar.unpacked\connectors. Source checkout: the connectors folder of the repo. Call that folder CONNECTORS and use forward slashes in the commands below.
4. If the folder %USERPROFILE%\.claude exists (Claude Code), merge these hooks into %USERPROFILE%\.claude\settings.json:
   - PreToolUse, matcher "Bash|PowerShell|Edit|Write": command  node "CONNECTORS/claude-code/hooks/pre-tool.mjs"  with "timeout": 130
   - PostToolUse, same matcher: command  node "CONNECTORS/claude-code/hooks/post-tool.mjs"
   - Stop: command  node "CONNECTORS/claude-code/hooks/stop.mjs"
   Each entry has the shape { "matcher": "...", "hooks": [ { "type": "command", "command": "..." } ] } (Stop has no matcher).
5. If the folder %USERPROFILE%\.cursor exists (Cursor), merge these into %USERPROFILE%\.cursor\hooks.json (top level: "version": 1 and "hooks"):
   - beforeShellExecution: { "command": "node \"CONNECTORS/cursor/hooks/before-shell.mjs\"", "failClosed": false }
   - afterFileEdit: { "command": "node \"CONNECTORS/cursor/hooks/after-edit.mjs\"" }
   - stop: { "command": "node \"CONNECTORS/cursor/hooks/stop.mjs\"" }
6. Test it: POST http://127.0.0.1:47821/api/status with JSON {"state":"working","message":"Setup test","agent":"<your name, e.g. Claude Code or Cursor>"} and ask me whether the notch showed it. Then POST {"state":"finished","message":"Setup done","agent":"<same name>"}.
7. Tell me which files you changed, where the backups are, and that the hooks start working in a new session (Claude Code: /hooks lists them; Cursor: restart Cursor).
```

## 2. From nothing: install it, then connect

Paste this into Claude Code or Cursor on the Windows PC you want it on:

```text
Please install Agent Buddy from https://github.com/Bryson-he/agent-buddy and connect yourself to it. It is a small Windows desktop companion that shows what AI agents are doing and asks me before risky commands.

Rules
- Tell me what you are about to do before each step that installs or changes something, and wait if I say stop.
- Do not change anything outside the steps below. Back up any config file before editing it, and merge instead of overwriting.
- Never type or paste secrets for me. If a step needs one, tell me where to click.

Steps
1. Check the basics: Windows 10 or 11, git, and Node.js 20 or newer (node -v). If Node.js is missing, tell me to install the LTS version and stop.
2. Clone the repo into a folder I agree to (suggest %USERPROFILE%\agent-buddy, and avoid OneDrive folders). Run npm install, then npm run build.
3. Start it: npm start, in the background. Confirm GET http://127.0.0.1:47821/health returns {"ok":true,"name":"agent-buddy"}. A Quick start window opens for me; tell me I can use it to choose the look while you carry on.
4. Read docs/SETUP-WITH-AI.md in the repo and follow prompt 1 ("connect my agent"), using the repo's connectors folder as CONNECTORS.
5. Ask whether I want it installed properly so it starts with Windows. If yes: npm run dist, then tell me to run the installer in the release folder myself, and afterwards repoint the hook commands at %LOCALAPPDATA%\Programs\Agent Buddy\resources\app.asar.unpacked\connectors.
6. Finish with a short summary: what you installed, which files you changed and where the backups are, and how to open Quick start again (tray icon → Quick start).
```

## Cloud bots (Grok Bot and similar)

A bot that runs in someone else's cloud cannot be set up by a prompt on your PC: you add a connector in the bot's own app and paste a secret token yourself. The steps are in [CONNECTING.md](CONNECTING.md#cloud-bots-grok-bot-and-similar). What the bot needs to be told is in [skill-agent-buddy.md](skill-agent-buddy.md); the tray menu copies it with the bot's name filled in.
