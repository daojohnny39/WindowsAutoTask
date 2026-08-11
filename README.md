# Windows Autobot

Windows Autobot is a work-in-progress desktop assistant that scopes each chat to one running Windows application. It inspects and acts through Chrome DevTools Protocol (CDP) for Electron/Chromium targets and Microsoft UI Automation (UIA) for standard Win32 applications.

> This is experimental developer software. Review actions before relying on it with sensitive accounts or irreversible workflows.

## Repository status

`main` is the canonical branch. `UI_Overhaul` is an experimental, unmerged branch and should not be treated as the current release line.

There is no published release yet. Runtime state is generated locally and excluded from Git.

## How it works

1. The app discovers running Electron and Win32 applications.
2. The user opens a chat scoped to one selected executable.
3. Before each turn, the app builds a live snapshot of that target only.
4. The model may use a curated CDP or UIA tool set to inspect and act on the selected target.
5. The tool loop allows up to 40 rounds before requiring a final response.

The current tool surface includes:

- CDP window listing and selection
- DOM snapshot, focused search, text reads, clicks, typing, paste, key presses, and scrolling
- structured Discord message, search, pin, reaction, reply, and image actions
- UIA tree inspection, invoke, and value setting
- replayable per-app automations
- clarifying questions during a tool run
- local text-file attachments in chat

Local attachments are read as text and inserted into the request. Individual files are limited to 256 KiB and the per-message total is limited to 512 KiB. Binary files are rejected.

## Architecture

```text
Renderer (chat and automation UI)
        │ IPC
        ▼
Electron main process
        ├── CDP bridge ── selected Electron/Chromium target
        ├── UIA bridge ── selected Win32 target
        ├── model tool loop (maximum 40 rounds)
        └── local runtime state
```

The model does not receive an arbitrary shell or JavaScript-evaluation tool. The project still depends on remote-debugging access and app-specific DOM behavior, so the scope guard should be treated as a design constraint rather than a hardened security boundary.

## Requirements

- Windows 10 or 11
- Node.js 18+
- PowerShell 5.1+
- either `OPENAI_API_KEY` or a logged-in Codex CLI session, depending on the selected authentication path

## Setup

```powershell
cd electron-detector
npm install
npm test
npm start
```

Packaged distribution is unsupported and unverified. Run the application from source; the repository does not provide a packaging command or release artifact.

## Enabling CDP

CDP must be enabled when the target starts. The helper can list, enable, or disable supported Electron applications:

```powershell
.\Start-ElectronDebug.ps1 -List
.\Start-ElectronDebug.ps1 -Enable -Name <application-name>
.\Start-ElectronDebug.ps1 -Disable -Name <application-name>
```

Enabling CDP restarts the target, so unsaved work may be lost. Some signed applications ignore remote-debugging flags and fall back to UIA.

## Local runtime files

The application creates these paths as needed:

| Path | Purpose |
|---|---|
| `cdp-state.json` | machine-specific executable and CDP port state |
| `cdp-watch-launch.vbs` | generated hidden watcher launcher |
| `app-agents/` | per-app instructions and latest snapshots |
| `automations/` | saved local automation recipes |
| `loop/` | local headless-loop inputs and results |
| `logs/` | optional chat transcript logs |
| `debug/` and related output | local diagnostics |

These paths are intentionally ignored and must not be committed. A fresh clone does not include another user's runtime state.

## Configuration and transcript logging

Copy the example only when local configuration is needed:

```powershell
Copy-Item config.example.json config.json
```

Transcript logging is **off by default**. It is enabled only when the local `config.json` contains:

```json
{
  "logging": {
    "enabled": true,
    "dir": "logs"
  }
}
```

Logs may contain prompts, model reasoning, tool inputs, tool results, application metadata, and replies. Keep them local and review them before sharing.

Low-level CDP debug logging is also off by default. Set `WINDOWS_AUTOBOT_DEBUG_LOG=1` before starting the application to write `cdp-debug.log`; review that file before sharing it.

## Repository layout

```text
README.md
SPEC.md
config.example.json
Start-ElectronDebug.ps1
electron-detector/
  main.js
  preload.js
  renderer.js
  index.html
  styles.css
  chat-logger.js
  package.json
```

## Testing

`npm test` runs the portable chat-logger and spawn-retry tests. It does not launch Electron, connect to a live Windows application, use Discord, or perform network automation.

Additional diagnostic and live verification scripts are development aids and may require Windows, Electron dependencies, a local CDP target, or an existing app session. Do not run live probes against an account without reviewing the script and target first.

## Development notes

- Element refs are snapshot-scoped and must be refreshed after UI changes.
- CDP target state, agent files, snapshots, recipes, logs, and debug output are local artifacts.
- Saved recipes resolve dynamic message/search targets at replay time rather than storing live message identifiers.
- Keep examples generic and never commit account identifiers, private task context, captured UI text, or machine-specific paths.
