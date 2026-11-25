# Agent Buddy: notes for whoever works on the code

Written for an AI assistant or a person picking the project up cold. `README.md` is the user-facing page; this is the map of the code, the decisions behind it, and the traps.

## What it is

A Windows desktop companion: a black "notch" pinned to the top centre of a screen, holding a small animated character that shows what the owner's AI agents are doing and asks for an answer when one needs it. Electron 39 + TypeScript, no UI framework.

The idea of a companion outside the app comes from Novra's concept case study (https://www.novra.design/case-studies/grokbot). The character, animation and all the integration are this project's own. **Do not copy xAI's mascot artwork or Novra's animation files.**

## Run and build

```powershell
npm install
npm start          # build and run
npm run dev        # with DevTools
npm run dist       # installer in release\
```

To restart during development, stop the running copy first: the app holds a single-instance lock. The installed app and a source checkout share one data folder (`%APPDATA%\agent-buddy`), so only one of them runs at a time.

### Traps

- **Renderer scripts are plain scripts, not modules.** They compile with `tsconfig.renderer.json` (`moduleDetection: legacy`), must not use `import`/`export`, and share one global scope at compile time, so top-level names must be unique across all files in `src/renderer/` (hence the `wl` and `panel` prefixes). Don't name a global `status` or `history`; they clash with DOM globals.
- **Electron's `Notification` `action` event is macOS-only.** Toast buttons use `toastXml` and an `agentbuddy://` link instead (see Questions).
- **Windows PowerShell 5.1 corrupts UTF-8** when a file is read with `Get-Content -Raw` and written back. Use `[IO.File]` with `UTF8Encoding($false)`, or an editor.
- **A project folder inside OneDrive** can leave `node_modules\electron` half-unpacked. Keep the checkout elsewhere, or see `scripts/move-off-onedrive.ps1`.
- **Hook scripts must live outside `app.asar`** (`asarUnpack: connectors/**/*`), because Cursor and Claude Code run them with plain `node`. Use `resourcePath()` in `main.ts` for any path handed to another program.
- **Scripted input is not real input.** A test that fills a text box by script once missed a key-handler bug that a real key press caught.

## Code map

| Path | What it does |
|---|---|
| `src/main/main.ts` | Electron main: overlay window, tray, cursor polling, the question queue, settings, shortcuts, the Settings / Activity / Quick start / Ask Grok windows, snapshot mode |
| `src/main/server.ts` | HTTP server on `127.0.0.1:47821`: `/mcp`, `/api/status`, `/api/ask`, `/api/history`, `/api/diagnostics`, `/health`, dev endpoints |
| `src/main/tunnel.ts` | Settings file, connector token (DPAPI), Cloudflare tunnel (quick or named) |
| `src/main/history.ts`, `activity.ts` | What each agent has done (Activity panel) and the on-disk activity log |
| `src/main/grok.ts`, `keystore.ts` | "Ask Grok" chat loop against the xAI API, and its key storage |
| `src/mcp/tools.ts` | The two MCP tools and their schemas (shared by HTTP, stdio and Ask Grok) |
| `src/mcp/stdio-bridge.ts` | stdio MCP server that forwards to the running app |
| `src/preload/*.ts` | The only bridges between pages and main, one per window |
| `src/renderer/shared.ts` | Agent names and colours, loaded by every page that draws agents |
| `src/renderer/renderer.ts` | The notch: agent tracking and ranking, the character, glass mode, sounds |
| `src/renderer/settings.ts`, `panel.ts`, `welcome.ts`, `chat.ts` | The other windows |
| `renderer/*.html`, `*.css` | Markup and styles |
| `connectors/` | Hook scripts for Claude Code and Cursor, and the shared risky-command rules |
| `docs/` | Connection guide, AI setup prompts, the skill text for cloud bots, README pictures |
| `scripts/` | Tests and the README picture builder |

## The connector

Two MCP tools (`src/mcp/tools.ts`):

- `set_status { state, message?, next?, agent? }`. States: `working`, `finished`, `error`, `upload`, `idle`, `greeting`.
- `ask_user { question, options?[2..4], allow_other?, free_text?, agent?, timeout_sec? }`. Waits for the answer. Returns the chosen label or typed text, or says it timed out, the queue was full, or the question is still pending.

`agent` is the display name; `keyOf()` normalises it ("Claude Code" → `claudecode`).

Ways in: local HTTP MCP (`/mcp`, stateless streamable HTTP), the stdio bridge, the same `/mcp` through the tunnel, and plain JSON on `/api/status` and `/api/ask` (used by the hooks).

### Security rules in `server.ts` (keep these)

- Binds to `127.0.0.1` only. Any request with an `Origin` header is refused.
- A request is "remote" if its Host is not local or it carries `cf-ray`, `cf-connecting-ip` or `x-forwarded-for`. Remote requests reach only `/mcp`, only with `Authorization: Bearer <token>` (constant-time compare), rate-limited.
- A remote request is handed back as `pending` after 85 s (`REMOTE_ASK_MAX_SEC`), because Cloudflare drops a request silent for 100 s. The question stays up; the agent asks again with the same question and re-attaches (see Questions).
- Dev endpoints exist only with `AGENT_BUDDY_DEV=1`, never through the tunnel. `AGENT_BUDDY_TOKEN` is honoured only in dev mode too.
- The activity log never contains the token. The token is copied to the clipboard by main, never sent to a page.

## Questions

`askUserQueued` in `main.ts`: one question on screen, up to 5 waiting; a question's timeout covers its whole wait; a full queue answers `busy`. Ways to answer: the notch buttons, `Ctrl+Alt+Y` / `Ctrl+Alt+N` (registered only while a two-button question shows), the toast buttons (`agentbuddy://answer/<0|1>?n=<nonce>`, received in `second-instance`; the nonce is per question), a typed answer (`free_text`), or a remembered answer ("Always": one agent + one exact question, stored in `rules.json`).

**Lists.** More than two options, any option longer than `BUTTON_LABEL_MAX`, or `allow_other` makes the question a numbered list (`Ask.list`; `renderChoices` in `renderer.ts`, `.choices` in `style.css`). Answered by click, the keys 1 to 4, `Ctrl+Alt+1..4`, or the toast buttons. "Something else" swaps the list for the text box. "Always" is offered only for two-button questions.

**Pending.** `askUserQueued(a, wait)` takes `wait.detachAfterSec`. When it passes, the request resolves with `pending: true` and `Ask.resolve` becomes null, but the question stays on screen or in the queue until its deadline. The same agent asking the same question again re-attaches to it. An answer given while nothing is attached is kept in `parkedAnswers` for 15 minutes and handed over on the next ask. Only tunnelled requests detach; in dev mode `/api/ask?detach_sec=N` does the same for tests.

## The notch

- **Agents:** a map keyed by normalised name. The lead is ranked: pinned, needs you, changed in the last 5 s, error, working / upload / greeting, finished, idle. Others show as small faces (compact) or pills (expanded).
- **Sizes:** expanded for a few seconds after a change, while an agent needs you, during a reaction, or while the cursor is on the face. Otherwise compact.
- **Glass mode:** cursor on the notch but not the face makes it see-through and click-through; touching the face wakes it. Stays solid while asking. The `glass` setting turns this off (then the notch is solid whenever the cursor is on it). The renderer decides and tells main through `buddy:interactive`.
- **Character:** one shaded body per agent; colour is the main difference (`COLOURS` in `shared.ts`, overridable per agent through the `agentColours` setting). Body styles: `ball`, `block` (Claude Code, with limbs), `hex` (Cursor). All motion is spring-driven in `frame()` (`Spring` class, `EYE` shapes, `eyeOnBall`, `enterState`), and the loop sleeps when everything has settled. Idle personality (glances, dozing) is timer-driven in `idleTick`.
- **Small faces** (the other agents) are animated with CSS only (`mini-*` keyframes at the end of `style.css`), keyed on each chip's `data-state`. They use the `scale` property for blinking because the eyes already carry an SVG `transform`.
- **Motion can only be judged by eye.** Snapshots show poses, not feel. Tune spring stiffness and damping from feedback.

## Settings and data

Everything is in `%APPDATA%\agent-buddy\`:

| File | Contents |
|---|---|
| `settings.json` | `tunnel`, `tunnelMode`, `namedTunnelName`, `namedHostname`, `startWithWindows`, `sounds`, `volume`, `notifications`, `shortcuts`, `display`, `lingerFinishedMin`, `glass`, `agentColours`, `onboarded` |
| `connector-token.bin`, `xai-key.bin` | Secrets, DPAPI-encrypted |
| `rules.json` | Remembered answers |
| `activity.log` | One JSON line per connector call (ring buffer) |
| `tunnel.json`, `cloudflared.log` | The running tunnel |

`applySettings` in `main.ts` accepts only known keys with sane values and applies them at once. To add a setting: the `AppSettings` type in `tunnel.ts`, `applySettings`, `pushSettings` if the notch needs it, then the control in `settings.html` / `settings.ts` (and `welcome.*` if it belongs in the quick start).

The Quick start window opens once, when `onboarded` is not true, and from the tray.

## Tests and checking work

```powershell
npm test                          # Ask Grok tool loop against a fake xAI server
node scripts/test-risky.mjs       # risky-command rules
node scripts/test-hooks.mjs       # real hook scripts against a fake Agent Buddy
```

Against the live app, started with `$env:AGENT_BUDDY_DEV="1"`: `scripts/test-asks.mjs` (queue, shortcuts, toast links, Always, typed answers) and `scripts/test-connector.mjs`. `scripts/test-tunnel.mjs` also needs a throwaway `AGENT_BUDDY_TOKEN`.

**Pictures:** `npx electron . --snapshot-dir=shots` saves a PNG of every state and window and exits. It uses a throwaway data folder and sample agents, so nothing personal appears. `npx electron scripts/readme-images.js shots` rebuilds `docs/images/`.

**Animation:** `npx electron . --record-dir=rec` plays a short story with sample agents (`recordDemo` in `main.ts`) and saves it frame by frame; `node scripts/make-apng.js rec docs/images/demo.png` joins the frames into an animated PNG, storing only what changed per frame. Edit the `story` list to change what it shows.

A desktop-control tool that hides windows of apps it has no access to will hide the overlay; grant it access to the app first.

## Not built

- Auto-update (needs public releases wired to `electron-updater`, and ideally code signing).
- Code signing.
- macOS and Linux.
- Dropping a file on the notch; dragging the character onto a window.

## House rules

- Plain language in anything the user reads. The notch has room for about 60 characters.
- Never type or log secrets. The owner pastes tokens themselves.
- Keep the two tools small. An agent should be able to use them from the one-line descriptions.

## Rive character (trial)

Settings > "New character (trial)" (`riveCharacter`, default off) swaps the lead character's drawn body for a Rive one. The bubble, sparkles and z's are still the SVG ones, and the small faces are unchanged.

- **Source:** `rive/buddy/scene.rml`, a Rive CLI project. A "Buddy" view model (`color`, `lookX`, `lookY`, `state` 0 to 10) drives a state machine with two layers: Face (where the eyes sit, each pill's tilt and size, blinking, the colour wash) and Symbol (which part of each eye shows: the pill, a spinning ring while working, an X on error, a fade for the rising eyes on upload). The body never moves, by the owner's choice: all the animation is in the eyes and the colour. Every animation in a layer keys the same properties, so a state change blends all of them.
- **In the app:** `renderer/rive/buddy.riv` (the export), `renderer/vendor/rive/` (Rive's web runtime and its wasm engine, MIT, copied from `node_modules/@rive-app/webgl2`), and `src/renderer/rive-face.ts`, which sends the colour, eye direction and state once a frame. The canvas sits in a `foreignObject` inside the face SVG, sized so its ball matches the drawn one. If loading fails, the drawn character stays.
- **To change the character:** edit `scene.rml`, check with `rive . --verify`, `rive inspect . --summary` and frames from `rive . --commands` (`data state=3`, `advance 700ms`, `screenshot x.png`), then `rive . --publish` and copy `build/buddy.riv` to `renderer/rive/`. Read `rive/buddy/AGENTS.md` first; look types up with `rive schema`, never from memory.
- **`--publish` needs `rive login`**, even with no scripts. On a free workspace the export carries Rive's splash screen, which shows for a moment when the file loads; a paid plan removes it.
- The file has no scripts on purpose: scripts must be signed to load in the web runtime.
- In this mode every agent is a ball. Claude Code's block and Cursor's hexagon have no Rive version yet.
- `npx electron . --snapshot-dir=shots --rive` takes the pictures with the Rive character on.

## Start with Windows: only the installed app registers

A copy run from source never adds itself to Windows start-up (`setStartWithWindows` in `main.ts`); it only removes its own entry. It used to register itself whenever it ran, and after a restart Windows started it ahead of the installed app, which the single-instance lock then kept out. If the wrong copy is running, `GET /api/diagnostics` shows `"packaged": false`.

## Two-way (v0.7.0)

- **From the user back to an agent.** Nothing can be pushed into an agent, so a note, Pause or Stop waits in `outbox` (`main.ts`) and is returned in the result of that agent's next `set_status` (`takeOutbox`, `statusReplyText` in `tools.ts`). The notch shows "sent" until it is picked up (`buddy:outbox`). The Note, Pause and Stop buttons show for the lead agent while the cursor is on the notch; the note reuses the typed-answer box (`body[data-ask="note"]`).
- **`set_status` extras:** `progress {done, total}` (a bar), `urgency` (`quiet` stays silent and small, `urgent` adds a sound and a notification), `link` + `link_label` (a button; the address is kept in main and opened by agent name, never sent to the page; http and https only).
- **`ask_user` extras:** `multi_select` (rows tick on and off, then Send; the result has `answers`), `detail` (background behind a "Details" fold).
- **Away.** `userAway()` reads `powerMonitor.getSystemIdleTime()` against the `awayAfterMin` setting (default 5, 0 = never). Only requests marked `tellIfAway` (the tunnel) are answered at once with `away`; local hooks still wait.
- **`remind_user`:** stored in `reminders.json`, re-armed at start, shown as a question with "Got it" and "Snooze 10 min".
- **A test copy beside the installed app:** with `AGENT_BUDDY_DEV=1`, `AGENT_BUDDY_DATA=<folder>` and `AGENT_BUDDY_PORT=<port>` a source copy uses its own data, lock and port and leaves the notification links alone. `scripts/test-asks.mjs` reads the same two variables; `POST /api/dev/quit` closes the copy.
- **Shell heredocs can mangle backslashes** in patch scripts on this setup. Write such a script to a file with an editor, or build the character with `String.fromCharCode`.

## Body shapes (v0.8.0)

Thirteen body shapes: ball, cloud, square, sparkle, clover, drop, burst, egg, pill, triangle, house, star, hex (`SHAPE_NAMES` in `shared.ts`; the order is the number the Rive file expects). They are this project's own shapes, built from plain geometry. Do not trace another product's avatars.

- **Per agent:** the `agentShapes` setting (keyed like `agentColours`), picked in Settings next to a palette of eleven colours (`PALETTE`). `bodyStyle(key)` in `renderer.ts` returns the picked shape, else the default (block for Claude Code, hex for Cursor, ball otherwise).
- **Drawn character and small faces:** `shapeRadius(kind, angle)` gives each outline as a distance from the centre; `outline()` turns it into the 96-point path every body shares, so shapes still morph.
- **Rive character:** the body is a `Solo` holding one parametric shape per body (ellipse, rectangle, polygon, star), switched by the view model's `shape` number through the Shape layer. The wash, shading and highlight are clipped to the Solo, so they follow whichever body shows. Rive ids cannot end in `:0`.
- The colour key is the agent's name in lower case with only letters and digits (`colourKey` in `main.ts`, `keyOf` in the pages). Settings lists one row per key.

## Layout v2 (v0.9.0)

- **Size:** `.inner` is as wide and tall as its content needs (`max-content`, between `--minw` and `--maxw`); a ResizeObserver in `renderer.ts` copies that size to `.clip` (`--cw`, `--ch`), which animates to it. The overlay window is 480 x 660 so the notch has room to grow. Wrapping text (a question, a note) gets a fixed width to wrap against.
- **One left edge:** everything under the status line (buttons, choices, text box, details, tools) starts at `--indent` (face width plus the row gap). While asking, the face is smaller and `--indent` follows.
- **A calm lead:** `rank()` keeps the lead on a busy bot. Only a bot you clicked (pinned for 45 s), one that needs you, or a fresh error takes it. There is no "whoever spoke last" rule any more.
- **Other bots are rows** when expanded (face, name, status, state dot, thin progress bar), and small faces plus a count in words when compact (`#summary`). Clicking either opens that bot as the lead.
- **⋯** shows while the cursor is on the notch; Note, Pause and Stop open from it (`toolsOpen`), so hovering does not change the notch's height.
- **Touches:** a line in the lead bot's colour along the bottom (`--lead`), a progress ring round the face when compact (`.ring`, `--ringp`), a fade-in when the lead changes (`.row.swap`), and bots greying out for their last 8 seconds (`isLeaving`).
- The stylesheet is layered: later sections override earlier ones (questions, row growth, layout v2). Read to the end of `style.css` before changing a size.
