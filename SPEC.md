# Windows Autobot — Current Technical Specification

This document describes the current implementation on the canonical `main` branch. `UI_Overhaul` is experimental and unmerged.

## Product boundary

Windows Autobot opens a chat scoped to one running Windows application. The main process builds a current UI snapshot and exposes only the tool set for that target's backend:

- **CDP:** Electron and Chromium applications launched with a remote-debugging port.
- **UIA:** standard Win32 applications inspected through Microsoft UI Automation.
- **No backend:** explanation-only chat with no automation tools.

The application is a work in progress, not a hardened sandbox. It deliberately omits arbitrary shell and arbitrary JavaScript-evaluation tools from the model-facing surface, but CDP access and UI automation remain powerful capabilities.

## Branch policy

- `main` is canonical.
- `UI_Overhaul` is an experimental branch and is not part of the current release line.
- Runtime files and generated state are local-only and ignored by Git.

## Runtime layout

```text
config.json             local configuration; created when absent
cdp-state.json          local executable/CDP-port state
cdp-watch-launch.vbs    generated watcher launcher
app-agents/             generated per-app guidance and snapshots
automations/            local replayable recipes
loop/                   local headless-loop jobs and results
logs/                   optional transcript logs
debug/                  local diagnostics
```

None of these paths belongs in a public commit. `config.example.json` is the shareable template.

## Main-process responsibilities

`electron-detector/main.js` owns:

1. Electron and Win32 application discovery.
2. CDP enable/disable and persisted local state.
3. CDP and UIA snapshot construction.
4. scoped tool execution and per-snapshot ref maps.
5. model authentication and streaming requests.
6. local text-file attachment validation and injection.
7. transcript logging orchestration.
8. automation generation, validation, storage, editing, and replay.
9. the optional local headless-loop watcher.

The preload bridge exposes narrow IPC methods to `renderer.js`; context isolation is enabled and Node integration is disabled in the renderer.

## Chat turn lifecycle

1. Validate target metadata (`exe`, `name`, backend fields).
2. Load local logging configuration.
3. Build a fresh target snapshot and replace the ref map.
4. Assemble instructions from the scope guard, generated per-app guidance, tool guide, attachment guide, clarification guide, and live snapshot.
5. Inject selected local text attachments into the final user message.
6. Call the model and execute requested tools.
7. Continue for at most `MAX_ROUNDS = 40` rounds.
8. Stream the final reply and optional local transcript entry.

Refs such as `e12`, `f3`, or `u7` are snapshot-scoped. Any action that changes the UI can make prior refs stale.

## CDP tools

The current CDP surface includes:

- window enumeration and selection
- element snapshot and focused find
- click, type, paste, key press, and text read
- generic and message-list scrolling
- structured Discord messages, search results, pins, reactions, replies, and image actions

CDP interactions resolve the selected page target for the application's configured local port. Multi-window operations use an explicit list/select pair rather than silently assuming the first page forever.

Discord-specific tools exist because virtualized or hover-only UI cannot always be represented safely by the generic snapshot. They operate on data discovered during the current run. Public documentation and stored recipes use placeholders or dynamic captures, never account-specific identifiers.

## UIA tools

The UIA surface includes:

- `uia_get_tree`
- `uia_invoke`
- `uia_set_value`

UIA snapshots are capped and converted to scoped refs. Value setting can fall back to focused keyboard input when `ValuePattern` is unavailable.

## Snapshot and scope rules

- Every send starts with a fresh snapshot.
- The default snapshot cap is 500 elements.
- A ref map is kept in main-process memory for the selected executable.
- Mutating actions should be followed by a new snapshot or focused find.
- Tool execution stays bound to the selected app metadata and configured backend.
- Failures or unverifiable actions must not be reported as completed work.

## Local text attachments

The file picker accepts a whitelist of text-oriented extensions plus common extensionless text files.

- per-file limit: 256 KiB
- per-message total: 512 KiB
- files are resolved to canonical local paths before reading
- binary content containing NUL bytes is rejected
- attached content is labeled as untrusted user-provided data
- content is inserted inline for the current request; it is not copied into the repository

## Transcript logging

Transcript logging is opt-in.

- `config.example.json` and the missing/malformed-config default set `logging.enabled` to `false`.
- `config.json` is read on each send, so a local toggle applies without a restart.
- when enabled, each conversation receives a separate file under `logging.dir`
- logs can include prompts, reasoning, actions, results, errors, target metadata, and replies
- logging failures do not abort a chat turn
- `config.json` and `logs/` are ignored by Git

Low-level CDP debug logging is separately opt-in through `WINDOWS_AUTOBOT_DEBUG_LOG=1`. When enabled, write failures are nonfatal and output remains a local artifact.

Because transcripts can contain sensitive application context, they must remain local unless deliberately redacted.

## Per-app guidance

Opening a chat creates `app-agents/<app-key>.md` locally. Generated capability text may be refreshed while the content below `## User notes` is preserved. A latest-snapshot file may also be written for local debugging.

Both the guidance and snapshots can contain machine or application context and are ignored in their entirety.

## Replayable automations

A successful tool trail can be distilled into a recipe stored under `automations/<app-key>/index.json`.

Recipe constraints include:

- only allowlisted tools for the target backend
- no raw snapshot refs in saved actions
- element refs must resolve through captured finds/snapshots
- changing message or search targets must resolve from live captured data
- hard-coded long-lived message identifiers are rejected
- progress and cancellation are surfaced through IPC
- replay stops on a non-recoverable step error

Automations are local runtime data. They can include typed text and workflow context and must not be committed.

## CDP watcher

`Start-ElectronDebug.ps1` manages local CDP state and may generate `cdp-watch-launch.vbs` for a hidden watcher. The helper can restart applications, so enabling or disabling a target may discard unsaved application state.

The launcher and `cdp-state.json` are machine-specific generated files and are ignored.

## Configuration

Shareable template:

```json
{
  "logging": {
    "enabled": false,
    "dir": "logs"
  }
}
```

Local opt-in:

```json
{
  "logging": {
    "enabled": true,
    "dir": "logs"
  }
}
```

## Verification policy

Portable validation must not require Windows, a signed-in account, a live CDP port, or Discord.

The supported portable command is:

```sh
cd electron-detector
npm test
```

It covers:

- missing, malformed, enabled, and disabled logging configuration
- safe log-path and transcript-writing behavior
- transient spawn-retry behavior through a controlled stub

Before committing, also run `node --check` for tracked JavaScript files and parse tracked JSON files. Live probes are separate manual diagnostics and are not part of the portable test command.

## Privacy and repository hygiene

Never commit:

- account, user, server, channel, message, or other live service identifiers
- machine-specific executable paths or usernames
- captured UI snapshots or per-app instructions
- transcript, loop, recipe, debug, or automation output
- secrets, auth files, cookies, or local environment files
- private task text embedded in probes or fixtures

Use generic placeholders in code and documentation. If a local artifact is accidentally committed, removing it from the current tree is not sufficient; review and sanitize reachable Git history before treating the repository as clean.

## Known limitations

- Windows is the supported runtime platform.
- CDP requires a compatible target launched with remote debugging.
- application updates can invalidate DOM selectors and app-specific tools.
- UIA behavior depends on the controls exposed by the target.
- packaged distribution is unsupported and unverified; the repository provides no packaging command or release artifact.
- portable tests do not prove live Windows or third-party application behavior.
