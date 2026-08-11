# Windows Autobot

> **Experimental:** `UI_Overhaul` is a work-in-progress branch. It is not the
> default branch or a released build, and the behaviors below may change.

Per-app scoped AI chat for Windows. Pick a running Electron or Win32 app, open a chat panel scoped to *only that app*, and the model can read its UI and act on it through a curated tool surface (CDP for Electron, UIA for Win32).

App-scoped chat starts with only the selected app. Experimental `/app` references,
file attachments, and region screenshots can add context only when the user
explicitly chooses them. The model cannot run arbitrary JavaScript or shell
commands; UI actions go through the curated CDP/UIA tools.

## Why

Most desktop-AI integrations either screen-scrape the whole OS (broad, leaky) or wrap a single SaaS (locked in). This project goes the other way: one app per chat, with a fresh UI snapshot fed into the system prompt every turn, and a small set of tools the model can use to act on what it sees.

The result is an assistant that can drive Discord, ChatGPT, VS Code, or any Electron app with `--remote-debugging-port` enabled — and Win32 apps via UIA — without needing per-app integrations.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Electron app (electron-detector/)                          │
│                                                             │
│  Renderer (chat UI)  ──IPC──>  Main process                 │
│                                  │                          │
│                                  ├── CDP bridge ──> target  │
│                                  │   (port from              │
│                                  │    cdp-state.json)        │
│                                  │                          │
│                                  ├── UIA bridge ──> target  │
│                                  │   (PowerShell + UIAuto)  │
│                                  │                          │
│                                  └── Responses API          │
│                                      (planner + executor)   │
└─────────────────────────────────────────────────────────────┘
```

Each chat turn:

1. Rebuild a live UI snapshot of the scoped app (≤500 elements, stable `ref` per row).
2. Assemble a system prompt: scope guard → agent file (`app-agents/<key>.md`) → snapshot → tool descriptions.
3. Stream the model's response. Tool calls round-trip through the main process, run against the live app, results feed back in.
4. Repeat within the mode budget: 40 rounds for one app, 64 with explicit
   multi-app references, 8 for direct chat, or 48 for direct chat with app
   references. The model then writes the final reply.

See `SPEC.md` for the full design — system prompt assembly, tool semantics, planner/executor split, incident log.

## Tools

### Electron (CDP)

| Tool | Purpose |
|---|---|
| `cdp_click` | Click an element by ref. Uses CDP `Input.dispatchMouseEvent` so React sees `isTrusted=true`. |
| `cdp_type` | Set value on an input / textarea / contenteditable via native value setter. |
| `cdp_get_text` | Read `textContent` (or `value`) of an element. |
| `cdp_get_tree` | Refresh the full element snapshot. |
| `cdp_get_messages` | Discord-specific: structured `{id, author, time, text, images, reactions}` for last N messages. ~25 messages = 2-5 KB vs 80 KB for a full tree. |
| `cdp_scroll_to_message` | Discord-specific: `scrollIntoView` on a message id, with a brief blurple outline so the user can see what was hit. |

### Win32 (UIA)

| Tool | Purpose |
|---|---|
| `uia_invoke` | `InvokePattern.Invoke()` on an AutomationId, fallback to `LegacyIAccessiblePattern.DoDefaultAction`. |
| `uia_set_value` | `ValuePattern.SetValue`, fallback to focus + SendKeys. |
| `uia_get_tree` | Refresh the UIA snapshot. |

Arbitrary `cdp_eval` and shell execution remain out of scope. `UI_Overhaul`
experimentally adds user-selected files, region screenshots, and explicit
multi-app references; these are not released features.

## Repository layout

```
electron-detector/          Electron app — main, preload, renderer, styles
  main.js                   Main process: tool execution, CDP/UIA bridges, planner/executor loop
  renderer.js               Chat UI, thinking pill state machine, tool pills
  preload.js                IPC bridge
  index.html                Apps grid + chat panel shell
  styles.css
Start-ElectronDebug.ps1     Toggles --remote-debugging-port=N per Electron app; persists in cdp-state.json
config.example.json         Safe starting configuration; copy to config.json
cdp-state.json              Generated per-exe CDP port assignments (git-ignored)
app-agents/                 Generated per-app agent files (git-ignored)
  <key>.md                  User-editable agent file (regenerated above ## User notes; preserved below)
  <key>.snapshot.md         Last live snapshot (debug aid)
SPEC.md                     Experimental design spec and incident log
```

## Setup

Requirements:

- Windows 10/11
- Node.js 18+
- PowerShell 5.1+ (built in)
- An OpenAI API key in `OPENAI_API_KEY` **or** a logged-in Codex CLI (`codex.cmd login`), whichever the chat panel is configured to use.

```powershell
cd electron-detector
npm install
Copy-Item ..\config.example.json ..\config.json
npm start                    # dev run
npm test                     # portable unit tests
```

Packaging is currently unsupported and unverified. This branch does not ship a
packaging script, installer, or release artifact.

Transcript logging, direct-chat history persistence, and `cdp-debug.log` are
off by default. Enable the first two explicitly in `config.json`; enable the
debug log only for a diagnostic run with `WINDOWS_AUTOBOT_DEBUG_LOG=1`.

## Enabling CDP on a target app

CDP can only be enabled at launch via `--remote-debugging-port=N`. The helper script restarts the target with the flag set and remembers the port:

```powershell
# List all running Electron apps and show which already have CDP
.\Start-ElectronDebug.ps1 -List

# Restart one app with CDP enabled, persistently (survives reboot via Task Scheduler)
.\Start-ElectronDebug.ps1 -Enable -Name Discord

# Disable
.\Start-ElectronDebug.ps1 -Disable -Name Discord
```

State persists locally in the git-ignored `cdp-state.json` at the repo root. A logon scheduled task re-applies CDP to tracked apps after reboot.

Caveats:

- The app is killed and relaunched — unsaved state is lost.
- Some signed builds (Slack, Teams, official Microsoft Electron apps) strip `--remote-debugging-port` and will silently ignore it. Those fall back to UIA.

Win32 apps don't need CDP setup — the UIA bridge works on any standard Windows window.

## Using the chat panel

1. Launch the Electron app (`npm start`).
2. The **Apps** grid shows every running Electron/Win32 app on the machine.
3. Click an app card → a chat panel opens scoped to that app.
4. First open writes `app-agents/<key>.md` from a template. Edit the block below `## User notes` to add app-specific rules, workflows, and gotchas — it persists across chat resets. Everything above that heading regenerates each open so capability/scope text stays current with the actual tool surface.
5. Send a message. The model gets a fresh snapshot every turn and can act on the app through the tool calls listed above.

The experimental overlay provides a direct GPT chat row. The desktop ChatGPT
app card is filtered from the app-scoped picker on this branch.

## Per-app agent files

`app-agents/<key>.md` format:

```markdown
---
exe: C:\Users\ExampleUser\AppData\Local\Programs\Microsoft VS Code\Code.exe
name: Code
type: electron        # electron | uia
created: 2026-05-25T...
---

# Code

## Scope
You operate ONLY on the running instance of "Code" (VS Code).
Refuse any request that targets a different application, the OS shell,
or arbitrary web tasks unrelated to this app.

## Capabilities
You can read UI elements and perform clicks / text input via tool calls.
You cannot execute arbitrary JavaScript or shell commands.

## User notes
<!-- Edit below. Persists across chat resets. -->
- ...
```

`<key>` = sanitized lowercase basename of the exe path. Collisions resolved by appending a short hash.

For apps with documented playbooks (Discord today), the auto-generated block above `## User notes` also includes a DOM map, navigation recipe, and anti-patterns derived from the incident log in `SPEC.md`.

## Conventions (for contributors)

- Click tools must use CDP `Input.dispatchMouseEvent` (not JS-dispatched `MouseEvent`) — React event delegation treats untrusted events as non-user input. See `SPEC.md` → "JS MouseEvent doesn't navigate Discord".
- Selector builder must verify `querySelectorAll(sel).length === 1`. Prefer `data-list-item-id` / `data-testid` / unique `aria-label` / `href` over positional `:nth-child` paths. Walk up to 30 levels with a uniqueness check at each step.
- Sanitize control chars (`\x00-\x1F\x7F-\x9F`) at both source (inside `CDP_JS_EXPR`) and sink (`inspectCdpElements`). Discord message content breaks `JSON.parse` otherwise.
- For Discord content reads, prefer `cdp_get_messages` over `cdp_get_tree`.
- Round budgets in `main.js` are 40/64 for app chat and 8/48 for direct chat
  (single-context/multi-app).

Before changing the CDP path, scan `SPEC.md` "Lessons learned" — it's the source of truth for past failures and their fixes.

## Status

`UI_Overhaul` is an experimental, unreleased development branch. It contains
CDP/UIA interaction, generated per-app agent files, snapshots, direct chat, and
automation UI. No retained live validation, CI result, installer, or release
artifact is claimed here; Windows/Discord behavior requires manual verification
on a configured machine.

## License

Personal project. No license declared — ask before reusing.
