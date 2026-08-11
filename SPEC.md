# Per-App Scoped Chat — Spec

> **Branch status:** This document describes the experimental, unreleased
> `UI_Overhaul` branch. Incident notes are historical design records, not
> retained live validation, a supported release, or current test results.
> Packaging is unsupported and unverified; no installer or release artifact is
> provided.

When the user navigates **Apps → click app card**, the chat panel opens and the assistant behind it is scoped to *only that app*. Each app gets its own agent file describing identity, capabilities, and operating rules, and the model is given live access to the app's UI through CDP (Electron) or UIA (Win32).

## Goals

1. **Scope enforcement** — assistant refuses requests that aren't about the open app, and refuses to act on other windows.
2. **Live awareness** — every send pulls a fresh element snapshot so the model sees the app's current UI, not a stale dump.
3. **Action capability** — model can click, type, read text via tool calls. Backend chosen automatically (CDP if Electron + CDP enabled, UIA otherwise).
4. **User-editable agent files** — `app-agents/<key>.md` is plain markdown the user can tune (workflows, gotchas, naming conventions).

## Non-goals (v1)

- Arbitrary JS evaluation (footgun; defer).
- Implicit cross-app workflows without explicit `/app` references.
- Persistent state across app restarts beyond the agent file and opt-in direct-chat history.

## Direct GPT-5.5 chat (appless)

When the user opens the overlay without selecting an app, hitting Enter on the
**Just chat with GPT-5.5** row (or typing a message + Enter with no app match)
opens a chat that goes straight to the OpenAI Responses API. There is no
default app snapshot or scope guard. Without explicit `/app` references it is
an Autobot-side assistant; referenced apps add the scoped multi-app tool
surface described below. User-supplied file and image attachments are included
in the request.

- **IPC:** `chat:send-direct` (mirrors `chat:send` and accepts
  `{ messages, attachments, apps }`). `chat:load-direct` returns persisted history
  only when the user opted in; `chat:reset-direct` wipes any stored history.
- **Tools:** the hosted Responses `web_search` (always on, runs server-side at
  OpenAI; surfaces source URLs as inline `url_citation` annotations) and
  `ask_user` (same clarify card as app-scoped chat). Explicit `/app` references
  add `select_app` plus the scoped CDP/UIA tool union. Attachments are request
  inputs, not arbitrary local-filesystem access.
- **Reasoning effort:** `medium` (vs `high` for app-scoped chat) — direct chat
  is conversational, not multi-tool planning.
- **History:** in-memory for the live renderer session by default. Setting
  `directChat.persistHistory: true` in the local `config.json` opts into a
  single thread at `logs/direct-gpt.json` via `direct-chat-store.js`. Atomic
  writes store only plain conversation text; corrupt JSON falls back to empty.
  Schema: `{ messages: [{role, content, ts}], updated }`.
- **ChatGPT app card removed.** The desktop ChatGPT Electron app is filtered
  out of the Apps grid, the drawer, and the launcher candidate list
  (`isChatGptApp` in `renderer.js`). Direct chat supersedes app-scoping
  ChatGPT itself; CDP-driving the desktop app is no longer offered.
- **Sentinel exe:** `DIRECT_CHAT_ID = '__direct__'` — used as the `meta.exe`
  for every per-key Map (`chatAbortFlags`, `chatPendingAsks`, `activeChats`,
  renderer's `chatStore` / `chatMetaStore`) and as the `data.exe` on chat:*
  events. Real exe paths are absolute Windows paths so the sentinel never
  collides.
- **Sources UI:** the streaming layer parses `response.output_text.annotation.added`
  with `type=url_citation` and emits `chat:citation` per URL; the renderer
  dedupes by URL and renders a "Sources" footer of clickable chips under the
  assistant bubble. Links route through `shell:open-external` so they open in
  the OS browser, never the renderer window.

## Multi-app references (`/app`)

A single chat turn can act on more than one running app. The user references
extra apps inline with the **`/app`** slash command (same dropdown + detected
app list the overlay launcher uses), e.g. *"find the last thing X said in
Discord #general and note it in `[app:notion_…]`"*.

- **Model:** the overlay-selected app stays the **primary** (eager snapshot in
  the system prompt, as before). `/app` pills register **secondary** apps. In
  appless **direct chat** there is no primary — every app comes from `/app` and
  the model must `select_app` before any cdp_*/uia_* tool.
- **Renderer — two composer surfaces:** `/app` works in BOTH the inline chat
  composer (`#chat-input`) and the **overlay launcher task input**
  (`#launcher-input`), because the overlay's first message is typed in the plain
  launcher input (a separate element from `#chat-input`, which is only
  reparented in once inline chat starts).
  - *Inline chat composer:* `/app` opens `#chat-app-menu` (mirrors `/tab`);
    picking inserts a `.chat-app-pill`; on send it serialises to
    `[app:<key> "<name>"]` and the live meta is collected from the pills into
    `payload.apps[]`. `#chat-app-menu` is reparented alongside `#chat-tab-menu`
    in `enterInlineChat`/`exitInlineChat` so it anchors to the moved composer.
  - *Launcher task input:* typing `/app` (after an app is already selected as
    primary) reuses `#launcher-dropdown` — the same list + autocomplete as the
    initial app selection. Picking inserts an `[app:<key> "<name>"]` text token
    (the launcher input is a plain `<input>`, no pills) and records the resolved
    meta in `launcherAppRefs`. `submitChat` parses the token via
    `collectLauncherApps()` and passes `apps[]` to `sendChatMessage(text, apps)`.
  - `appKeyFor()` in renderer mirrors `appKey()` in main so keys match the
    backend on both paths. `payload.apps[]` = `{ key, exe, name, type, pid, port }`.
- **Backend:** `createAppRegistry(primaryMeta, apps)` builds a `key → meta` map
  (primary first, deduped by key). A turn is *multi-app* when the registry has
  >1 entry (app-scoped) or ≥1 entry (direct). When multi-app, the tool surface
  becomes the **union** `CDP_TOOLS + UIA_TOOLS + ASK_USER + select_app`, a
  `## Referenced apps` table is injected, and `MAX_ROUNDS` is raised (64 app /
  48 direct).
- **`select_app(app)`:** switches the ACTIVE app (resolve by key, then name).
  Builds a **fresh** snapshot for that app (lazy — only on first/each switch),
  swaps in its own ref holder, and returns `{ ok, app, name, backend, refs,
  snapshot, playbook? }` (per-app `app-agents/<key>.md` playbook injected once).
- **Routing:** every other tool runs against `routerActiveMeta(router)` with
  that app's ref holder, so `meta.port` / `meta.pid` and the ref table always
  target the active app. A tool whose backend (`cdp_*`/`uia_*`) doesn't match
  the active app's backend returns a `wrong_backend` error instead of acting on
  the wrong app. Per-app ref holders mean switching back and forth never
  clobbers another app's snapshot.
- **Scope:** running apps only (no auto-launch). ChatGPT is excluded (same
  `isChatGptApp` filter). `apps[]` is per-turn — the model is expected to finish
  the cross-app task within one turn's tool loop.

## Inline chat (static composer)

The overlay launcher and the chat share a single composer — `.launcher-row` —
that never disappears or restyles between modes. On chat enter (`enterInlineChat`
in `renderer.js`) the renderer reparents four nodes out of `#page-chat`:
`#chat-input` slots into `.launcher-input-stack` (replacing the hidden
`#launcher-input` for the duration of the chat); `#chat-tab-menu` follows so its
absolute positioning still anchors to the input slot; `#chat-scroll` and
`#chat-window-picker` move directly under `.launcher-card` above the
`.launcher-row`. `#page-chat` itself is hidden in overlay mode
(`body[data-mode="overlay"] #page-chat { display:none }`); the chat-header /
chat-composer that legacy layouts surfaced never render.

The result: the composer is pixel-identical to image-12/13's launcher row
across the whole chat lifetime — bolt logo, optional app pill, contenteditable
input, CHAT mode chip. New message bubbles animate in via `@keyframes bubbleEnter`
(translateY 28px + scaleY 0.6 → 1 over 220ms, `transform-origin: bottom`) so
they read as extruded from the composer's top edge. Reset chat and "Pick a
different app" live in a small popover anchored to the gear button
(`#launcher-gear-menu`); the gear opens Settings directly in launcher view and
the popover in chat view. The app pill's `×` close button is hidden while a
chat is open so the user can't orphan the in-flight thread by switching scope.

## File layout

```
config.json          # repo-root config (logging toggle); auto-created if absent
logs/                 # per-session chat transcripts (git-ignored), one file per session
app-agents/
  <key>.md           # user-editable agent file, one per app
  <key>.snapshot.md  # last live snapshot (debug aid, regenerated each turn)
```

`<key>` = sanitized basename of `Exe` path (lowercase, non-alphanum → `_`). Example: `C:\...\Code.exe` → `code`. Collisions resolved by appending short hash of full exe path.

## Overlay UI (hotkey quick-entry)

The app's primary surface is a frameless, transparent, always-on-top **overlay** summoned by a global hotkey (default `Control+Alt+Space`, rebindable in Settings). It is modeled on the Claude desktop quick-entry overlay.

- **Two windows, one codebase.** Both `index.html`/`renderer.js` instances run with a `?mode=` query: `mode=overlay` (the launcher) and `mode=settings` (the decorated management window — app browsing/CDP toggles, ChatGPT auth, hotkey rebind, logs, Inspector, automations). `document.body.dataset.mode` gates layout via CSS. Stream events route per-window automatically because every `chat:*`/`automation:*` event uses `event.sender.send` (the window that invoked the handler receives its own stream).
- **Tray + lifecycle.** Lives in the system tray (`Tray`, runtime-generated icon). Single-instance lock; a second launch summons the overlay. Closing/hiding windows does **not** quit — only the tray Quit (sets `isQuitting`) does. `globalShortcut` register checks the return bool and rolls back to the last working hotkey on failure.
- **Double-tap = Automation Mode.** A single hotkey press shows the overlay in Chat mode immediately (no latency). A second press within `DOUBLE_TAP_MS` (420ms) while the just-opened overlay is visible morphs it into Automation Mode; a press outside that window hides. Sub-`HOTKEY_DEBOUNCE_MS` (70ms) repeats are ignored (globalShortcut gives no key-up).
- **Launcher flow.** Bottom-pinned input; dropdown + chat grow **upward** (`overlay:resize` with `anchor:'bottom'`). Stage 1: app-name autocomplete over **running detected apps only** (`currentApps` + `cachedUiaApps`) — inline ghost prediction, dropdown with ↑↓ nav, Tab-to-complete. Selecting an app → pill. Stage 2 (Chat): type a task → `openChat()` + `sendChatMessage()`, overlay grows into the chat card. Stage 2 (Automation): autocomplete automation **names** (`automation:list`, matched on `name`/`slug`) → `runAutomation()`. Script generation ("Save as automation") remains available from the chat trail exactly as in the full window.
- **Resize is JS-tweened in main** (`animateOverlayTo`) — Electron's `setBounds(rect, true)` animate flag is macOS-only, so Windows growth is tweened over ~12 frames and clamped inside the work area ("skooch").
- **Config:** `config.json` keys `hotkey`, `overlay:{width,collapsedHeight,dropdownMaxHeight,chatHeight,runHeight,persistPosition}`, `startMinimized` (see `app-config.js`). Overlay position persisted to `.overlay-pos.json`.

## Agent file format (`app-agents/<key>.md`)

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

The block above the `## User notes` heading is auto-generated and **regenerated on every chat open** (so capability/scope text stays current with what tools actually exist). Everything from `## User notes` onward is preserved verbatim.

## System prompt assembly (per send)

Order, top to bottom:

1. **Scope guard** (fixed, can't be edited):
   > You are an assistant scoped to a single running application: **{name}** (pid {pid}, exe {exe}). You may only reason about this app and may only use tools that act on this app. If the user asks about anything else, briefly explain the scope and refuse.
2. **Agent file contents** (everything from `app-agents/<key>.md` minus the YAML frontmatter).
3. **Live element snapshot** — re-inspected on every send:
   - Electron path: `inspectCdpElements(port)` → tag/text/id/role/aria for ≤500 elements.
   - UIA path: `inspectAppElements(pid)` → name/automationId/className/controlType for ≤500 elements.
   - Rendered as a compact table. Each row gets a stable `ref` (e.g. `e12`, `u47`) the model uses in tool calls.
4. **Tool descriptions** — see next section.

Snapshot latency budget: ~1–2 s. Acceptable per user decision. If `>3s` consistently, add a "snapshot is stale, call `refresh()`" path later.

## Tool surface (v1)

Exposed via the `tools` field on the Responses API request.

### Electron (CDP) — only when CDP enabled + alive

| name | args | behavior |
|---|---|---|
| `cdp_list_windows` | (none) | Enumerate EVERY open window/tab the app exposes over CDP. `GET http://127.0.0.1:<port>/json`, filter `type:"page"` with a `webSocketDebuggerUrl`, return `{count, active, windows:[{index, id, title, url, active}]}`. A normal snapshot (`cdp_get_tree`/`cdp_find`) only ever sees the single *active* page target, so the model would otherwise report "one window" even when several are open. For a Chromium browser launched on one `--user-data-dir`, this lists windows across **all open profiles** in that one browser process (each profile window is its own page target on the shared debug port). Pairs with `cdp_select_window`. |
| `cdp_select_window` | `index?`, `id?` | Bind every subsequent page tool (snapshot/click/type/scroll) to a chosen window from `cdp_list_windows`. Sets a per-port `CDP_ACTIVE_TARGET[port] = targetId` and invalidates the cached page-WS URL so the next `fetchCdpPageWsUrl` re-resolves to the selected target's `webSocketDebuggerUrl`. Until set, the page tools bind to the first `type:"page"` target (legacy behavior). If the selected window later closes/navigates away, the stale active id is cleared and tools fall back to the first page. Returns `{ok, active:{index, id, title, url}}`. Recipe to survey everything: `cdp_list_windows` → for each row `cdp_select_window(index)` then read. |
| `cdp_click` | `ref` | Resolve `ref` to selector → `Runtime.evaluate` walks up from svg/path/aria-hidden child to first clickable ancestor (tag in `button/a/input/label` OR role in `button/link/menuitem/tab/treeitem/option/checkbox/radio/switch`), scrolls into view, returns `getBoundingClientRect` center as `{x,y}`. Then dispatches CDP `Input.dispatchMouseEvent` `mouseMoved` + `mousePressed` + `mouseReleased` at those coords. **Must be CDP-level Input events, not JS-dispatched `MouseEvent`** — Discord (and other React apps with event delegation) ignore JS-dispatched events because `event.isTrusted === false`. CDP `Input.dispatchMouseEvent` produces `isTrusted=true` events that pass React's filters and trigger navigation. |
| `cdp_type` | `ref`, `text` | `Runtime.evaluate` with native value setter trick (`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set`) for `<input>`/`<textarea>`, or `textContent` + `InputEvent` for `contenteditable`. JS-level is acceptable here because React forms re-read value on `input` event. |
| `cdp_get_text` | `ref` | `Runtime.evaluate` returns `el.textContent` (or `el.value`), truncated 2 KB. |
| `cdp_get_messages` | `limit?` | **Discord-specific.** `Runtime.evaluate` walks `li[id^="chat-messages-"]` (last `limit` items, default 25, capped 1–100) and returns structured `{id, author, time, text, images[], reactions[], reactionTotal}` per message. Image URLs come from `img[src*="cdn.discordapp.com"]` and `a[href*="cdn.discordapp.com/attachments"]`, filtered to skip emoji/avatar URLs. Reactions parse the `[class*="reaction_"]` button's count text + emoji `img alt`. Use this instead of `cdp_get_tree` for content-reading tasks — 25 messages ≈ 2-5 KB vs 80 KB+ for a full tree. |
| `cdp_scroll_to_message` | `message_id` | **Discord-specific.** `Runtime.evaluate` resolves `document.getElementById(message_id)` (or `li[id$="-<numeric-suffix>"]` fallback), calls `scrollIntoView({block:'center', inline:'nearest', behavior:'auto'})` on the `<li>`, and briefly outlines the target in Discord blurple (`#5865F2`, ~1.8 s). Returns `{ok, id, top, height, visible, innerHeight}`. **Required** whenever the user says "scroll to / show me / jump to / take me to / find" a specific message — `cdp_get_messages` only reads the DOM, the viewport stays put. Pass the full `id` from `cdp_get_messages` (`"chat-messages-<channel>-<message>"`). |
| `cdp_scroll` | `direction`, `pages?`, `container?` | **Generic.** Auto-detects the page's main scrollable container (or accepts an explicit CSS selector via `container`) and scrolls `"up"` / `"down"` / `"top"` / `"bottom"`. Returns `{ok, direction, scrollTopBefore, scrollTopAfter, scrollHeightBefore, scrollHeightAfter, atTop, atBottom, heightChanged, topChanged, containerTag, containerClass}`. **Required for any "first / earliest / oldest" or "latest / newest" query on a virtualized conversation** (ChatGPT, Slack, web chats): the DOM only contains messages near the current viewport, so `cdp_find` / `cdp_get_tree` see a partial slice. Loop `cdp_scroll("top")` until `{atTop:true, heightChanged:false}` before enumerating to find the first match; do the inverse for "latest". For Discord, prefer `cdp_scroll_messages` (it knows Discord's specific list selector). Detector preference order: `ol[data-list-item-id="chat-messages"]` → `main[class*="chatContent"] ol` → `[role="log"]` → `[data-testid*="conversation"]` → `main [class*="conversation"]` → `main [class*="thread"]` → `main` → largest scrollable element on the page. |
| `cdp_paste` | `ref`, `text`, `clear?` | Focus the element by ref with a real CDP click (`Input.dispatchMouseEvent` mouseMoved + mousePressed + mouseReleased on the bounding-rect center), optionally Ctrl+A + Delete to clear existing content, then dispatch `Input.insertText` with the payload. Works on every text surface — including rich-text editors (DraftJS, Slate, Lexical, Quill) where `cdp_type`'s JS path (`textContent = …` + InputEvent dispatch) is silently ignored because the editor owns its state model. Discord's channel-header search bar is DraftJS: `cdp_type` reports `{ok:true}` but the field stays empty; `cdp_paste` produces real text. Returns `{ok, tag, ce, chars, cleared}`. |
| `cdp_press_key` | `key`, `modifiers?` | Dispatch `Input.dispatchKeyEvent` keyDown + keyUp at CDP layer (`isTrusted=true`). `key` is `"Enter"` / `"Escape"` / `"Tab"` / `"Backspace"` / `"Delete"` / `"ArrowUp\|Down\|Left\|Right"` / `"Home"` / `"End"` / `"PageUp\|Down"` / `"Space"`, or any single character. `modifiers` is an optional array (`["ctrl"]`, `["ctrl","shift"]`, etc.). Required to submit forms (`Enter` after `cdp_paste`-ing a search query), dismiss popouts (`Escape`), navigate autocomplete (`ArrowUp/Down`), or compose keyboard shortcuts. Returns `{ok, key, modifiers}`. |
| `cdp_get_search_results` | `limit?` | **Discord-specific.** Scrapes `section[aria-label="Search Results"]` (with `[class*="searchResultsWrap_"]` fallback) and returns `{ sortMode, totalCount, pages: [{label, current}], count, results: [{id, messageId, author, authorId, time, text, images[], guildId, channelId, channelHref}] }`. Required because `cdp_get_tree` against the search panel drops `<li role="listitem">` rows (the snapshot filter suppresses `role=listitem` to keep chat-log noise out of normal snapshots), so the model has no other way to read `search-results-<messageId>` ids. The `sortMode` field tells the model whether to flip to `Old` for first-uploaded queries; the `pages` array surfaces numeric pagination when the result set spans multiple pages. |
| `cdp_jump_to_search_result` | `message_id` | **Discord-specific.** Atomic hover-and-click for the channel-header search panel's per-row Jump button. Accepts either the bare snowflake (`"<id>"`) or the full row id (`"search-results-<id>"`). Implementation: (1) `Runtime.evaluate` resolves the row by id and returns its center coords, (2) CDP `Input.dispatchMouseEvent type=mouseMoved` at those coords (real native hover — triggers Discord's CSS `:hover` rule that reveals the Jump button), (3) `Start-Sleep 350ms` to let the hover-revealed button paint, (4) `Runtime.evaluate` locates the Jump button inside the now-hovered row (priority: `button[aria-label*="Jump"]` → `[class*="jumpButton" i]` → `button` whose text is `"Jump"` → trailing `a[href*="/channels/"]` as last-resort fallback), (5) CDP `Input.dispatchMouseEvent` mouseMoved + mousePressed + mouseReleased at the Jump button's center. Returns `{ok, messageId, x, y, tag, aria, text}`. **Required** because the Jump button is hidden via CSS until `:hover`, which means it never appears in `cdp_get_tree` / `cdp_find` snapshots — without this tool, the model has no ref for it and falls back to clicking message-preview inner divs, which opens the image lightbox or does nothing. |

### UIA — when not Electron or CDP off

| name | args | behavior |
|---|---|---|
| `uia_invoke` | `ref` | Find element by AutomationId, call `InvokePattern.Invoke()`. Fallback: `LegacyIAccessiblePattern.DoDefaultAction`. |
| `uia_set_value` | `ref`, `text` | `ValuePattern.SetValue(text)`. Fallback: focus + SendKeys. |
| `uia_get_tree` | (none) | Re-inspect and return the snapshot table (lets model refresh mid-turn). |

### Backend-agnostic — always exposed

| name | args | behavior |
|---|---|---|
| `ask_user` | `question`, `options?` | **Human-in-the-loop clarification.** Pauses the tool loop and surfaces a question card in the renderer with up to 4 clickable option chips plus a free-text box. The loop `await`s the user's choice/typed answer (no socket open during the wait, so `streamOneRound` timeouts do not apply); the answer is returned to the model as the tool's `function_call_output` (`{answer}`), so the **same turn continues seamlessly** rather than ending and restarting. Used for ambiguous, underspecified, or destructive/irreversible requests instead of guessing or asking in plain prose (a plain-text question would end the turn). Options are sanitized (control chars stripped, capped at 4, length-clamped). Multiple sequential `ask_user` calls in one turn are supported. |

**Clarification wiring.** Main keeps a `chatPendingAsks` map (`exe → {resolve}`). When the model calls `ask_user`, the loop sends a `chat:ask` IPC (`{exe, callId, question, options}`) and `await`s `waitForUserAnswer(exe)`. The renderer renders the card; clicking a chip or submitting custom text calls `window.chat.answer({exe, answer})` → the `chat:answer` IPC handler calls `resolvePendingAsk(exe, {answer})`, unblocking the loop. `chat:stop` and `chat:reset` also call `resolvePendingAsk(exe, {aborted:true})` so a suspended loop unblocks cleanly (the abort flag then ends the turn → `chat:done` with `"Stopped by user"`). A 10-minute `Promise.race` timeout guards against a zombie wait if the renderer never answers. The answered card freezes in place (chosen chip highlighted, controls disabled) and persists post-turn via the trail (`ask_user` renders as `❓ <question> → "<answer>"`).

Tool execution lives in the main process. Renderer receives `tool_call` deltas via the existing `chat:chunk` channel, forwards to a new `chat:tool` IPC; main process runs the action, returns `tool_result`, model continues. The Responses streaming format already supports this — only new wiring is the round-trip.

### Out of v1

- `cdp_eval`, `cdp_screenshot`, `uia_screenshot`, multi-step composite actions, file I/O. Add as separate iterations.

## Refs and snapshot stability

A `ref` is only valid for the snapshot it came from. After any tool that mutates the DOM/UI, the snapshot is implicitly stale. v1 keeps it simple:

- Each turn rebuilds the snapshot before calling the model.
- During a single model turn, `ref`s stay tied to that turn's snapshot.
- If the model uses an outdated `ref` (e.g. element gone), the tool returns `{ "error": "ref_not_found", "hint": "call uia_get_tree / cdp refresh" }` and the model can recover.

For Electron, `ref` → selector mapping is kept in main-process memory keyed by `(exe, turnId)`. Selector format: a stable CSS path computed at snapshot time (`button[data-testid="x"]` preferred, else nth-of-type chain). For UIA, `ref` → AutomationId (or `ClassName + index` if no AutomationId).

## Scope enforcement

Soft (prompt-level) + hard (code-level):

- **Soft:** scope guard at top of system prompt; agent file repeats it.
- **Hard:** every tool call checks the target app is the same `exe` the chat was opened against. The PowerShell scripts already filter by exe/pid. The CDP path only talks to the port stored for *this* exe in `cdp-state.json`. No cross-app tool can leak through.

## Streaming + tool-call handling

Current code path streams `response.output_text.delta` only (`main.js:633`). Need to also handle:

- `response.output_item.added` where `item.type === "function_call"`
- `response.function_call_arguments.delta` — accumulate args
- `response.output_item.done` for function_call — emit `chat:tool` to main, run, append `function_call_output` to `input`, send a follow-up request with the tool result, resume streaming.

This is the meaningful new code in `main.js`. Renderer mostly unchanged — it still sees text deltas; tool calls happen invisibly except for an optional "🔧 calling `cdp_click(e12)`…" status line.

## Debug transcript logging

Opt-in, config-toggled logging of full chat sessions for debugging. Lives in `electron-detector/chat-logger.js`; wired into the `chat:send` handler in `main.js`.

- **Toggle:** `config.json` at repo root — `{ "logging": { "enabled": true|false, "dir": "logs" } }`. Read fresh on every `chat:send` via `chatLogger.loadConfig()`, so flipping `enabled` takes effect on the next message with **no restart**. Missing/malformed config is rewritten with the safe default (`enabled: false`, `dir: logs`).
- **Location:** separate folder `logs/` (override with `logging.dir`; relative resolves from repo root, absolute used as-is). Git-ignored.
- **One file per session:** `logs/<appkey>_<ISO-timestamp>_<id>.log`. A *session* = one conversation. The main process tracks sessions in a `Map<exe, session>`: a fresh conversation (≤1 prior user/assistant message, i.e. the renderer's first send or post–"New chat") opens a new file; continued turns append. `chat:reset` (the renderer "New chat" button) drops the session so the next message opens a new file.
- **Per turn it records:** the user message, ChatGPT's reasoning (accumulated from reasoning deltas via `reasoningSink` in `streamOneRound`), the tool actions (each tool name + args + result, results truncated at 2000 chars), the final reply, and any error/stop reason.
- **Safety:** all fs work is wrapped; a logging failure is emitted to the opt-in `cdp-debug.log` when `WINDOWS_AUTOBOT_DEBUG_LOG=1` and never breaks a chat turn. Disabled → no files written, session map cleared.
- **Tests:** `electron-detector/test-chat-logger.js` (`node test-chat-logger.js`).

## Migration / compatibility

- `cdp-state.json` schema unchanged. New file `app-agents/<key>.md` opt-in (created on first chat open for that exe).
- `config.json` is local and git-ignored; absent or malformed config is recreated with logging off. `logs/` is also git-ignored.
- `chat:send` IPC signature gains an optional third arg `agentFile` (default: load from disk). Existing renderer call site at `renderer.js:1057` stays back-compat.
- `chatStore` keying unchanged (already per-exe).

## Lessons learned (incident log)

Track real failures + the fix that resolved them. Future iterations should keep these in mind.

### 2026-06-05 — Automation title leaks a stale channel into the search `in:` filter

**Symptom:** A dynamic automation titled *"Go to the Example Community server, go to #screenshots, and show the latest upload"* was run with a dynamic channel group; the user answered **drafts**. The channel-open group correctly navigated to `#drafts` (composer read `Message #drafts`). But the later image-search group built the Discord query `has:image in:screenshots` and the final jump-to-result landed the user in **#screenshots** — the channel named in the *title*, not the one actually open.

**Root cause:** The synthetic group prompt injected the automation title verbatim as `[Automation: <title>]`. Discord search is server-wide, so `in:<channel>` is what scopes results. The search recipe said to use `in:<channel>` but never said where `<channel>` comes from, so the model scraped `#screenshots` out of the stale title string instead of the live channel. The dynamic override (`drafts`) was ignored at filter-build time.

**Fix (grounding + instruction, all in `main.js` prompt assembly):**
1. **`probeActiveChannel(record)`** — fail-closed CDP probe (mirrors `probeActiveAppIdentity`) reading the composer aria-label `Message #<channel>`. Returns `{ok:true,channel}` only when exactly one visible composer matches `^Message #(.+)$` (no `#` in the name); search panel / DM / thread / no-composer all return `{ok:false}` so a wrong guess never replaces an honest "unknown". **Not cached** — re-probed every group, since the active channel changes on navigation.
2. **`## Active channel`** section added to both `buildDynamicSyntheticMessage` and `buildSyntheticContextBlock`: the live channel as data when known, or an *instruction* ("read the live composer") when unknown — never a stale value.
3. **`## Ground truth` block (always present)** + a `RESUME_RULES_BLOCK` bullet: the `[Automation title: …]` / `[Group: …]` labels and prior-step summaries are human descriptions, never the source for navigation or `in:`/`from:` filters. Header relabeled `[Automation: …]` → `[Automation title: …]` to signal its status.
4. **Search recipe** now states explicitly where `<channel>` comes from (live composer / Active channel line) and that the title/label/prior-steps must never be copied into the filter; if active channel disagrees with the task text, trust the active channel.

**Generalization:** Any value that scopes an action (channel, server, user, board) must come from a live probe or an explicit user input — never parsed out of a free-text title/label that the harness happens to inject for human readability. When you can't probe it confidently, emit an instruction to read it live, not a best-guess value.

### 2026-05-25 — JS `MouseEvent` doesn't navigate Discord

**Symptom:** `cdp_click(e58)` on the `div[role="treeitem"][aria-label="…Example Community…"]` reported `{ok:true}` but Discord did not switch servers. Multiple retries with the same ref + `cdp_get_tree` refreshes returned the same 338-ref tree — no DOM change. Snapshot did contain Example Community correctly.

**Root cause:** The click path was `Runtime.evaluate` dispatching synthetic `PointerEvent`/`MouseEvent` instances at the element. Those events have `isTrusted === false`. Discord's React event handlers (and many other React apps using delegated event listeners on `document`) treat untrusted events as non-user input and skip navigation.

**Fix:** `cdp_click` now uses CDP's `Input.dispatchMouseEvent` (`mouseMoved` → `mousePressed` → `mouseReleased`) at coordinates returned from a prior `Runtime.evaluate` that walks up to the clickable ancestor and reads `getBoundingClientRect`. CDP-level input produces `isTrusted=true` events.

**Implementation note:** This requires a multi-command PowerShell script that opens the CDP WebSocket once, sends 4 commands with sequential IDs (`Runtime.evaluate`, then 3× `Input.dispatchMouseEvent`), and uses `Recv-Id` to filter responses by `id` (the WS also emits page events that must be ignored).

**Generalization:** Any *interaction* tool that triggers React or framework code should prefer CDP `Input.*` over JS-dispatched events. Read-only operations (`cdp_get_text`) and form value mutations (`cdp_type` via native setter — value setters bypass the `isTrusted` check because React explicitly polls value on `input`) can stay JS-level.

### 2026-05-25 — Snapshot returns 0 refs after navigating to Discord channel

**Symptom:** After `cdp_click(e58)` successfully navigated to Example Community, the next `cdp_get_tree` returned `0 refs`. Snapshot file showed `_No DOM elements found._`. Model reported "Discord's UI snapshot is returning no interactable elements" and refused to act.

**Root cause:** `inspectCdpElements` JSON parse failed with `Bad control character in string literal in JSON at position 93429`. Discord's chat channel includes message-log content whose `textContent` (chat messages, embed text, code-block sources, etc.) contains raw control characters (U+0000–U+001F or U+007F–U+009F). Even though V8's `JSON.stringify` correctly escapes those, *something* in the CDP-WebSocket → PowerShell `ConvertFrom-Json` → `Write-Output` → Node `execFile` stdout pipeline re-introduces raw control bytes mid-string, breaking Node's `JSON.parse` (which rejects raw 0x00–0x1F inside string literals per the JSON spec). On the result, `inspectCdpElements` swallowed the error and returned `[]` → empty snapshot → no refs → model gives up.

**Fix (two layers):**
1. **Source-side sanitize** — `CDP_JS_EXPR` now runs all string fields (`Text`, `Id`, `Class`, `Role`, `AriaLabel`) through `clean(s) = s.replace(/[\x00-\x1F\x7F-\x9F]+/g, ' ')` *before* `JSON.stringify`. No control char ever enters the serialized payload.
2. **Sink-side sanitize** — `inspectCdpElements` strips the same range from raw stdout before `JSON.parse`. Belt and suspenders; protects against future tools/paths that don't sanitize at source.
3. **Filter chat noise** — `CDP_JS_EXPR` now also drops nodes with `role` in `{log, listitem, article}`. Discord's message-log explodes the snapshot with non-interactable rows. Reduces token cost + parse fragility.

**Generalization:** Any CDP `Runtime.evaluate` path that returns string data scraped from a live DOM should sanitize control chars at source. Trusting `JSON.stringify` end-to-end is not safe when the data crosses a `Runtime.evaluate` → text pipeline (PowerShell, shells, etc.). Same rule for UIA — `Name`/`HelpText` from chat-like surfaces can carry control chars.

### 2026-05-25 — `cdp_click` clicks wrong server (non-unique selector)

**Symptom:** After "Navigate to Example Community server and go to #screenshots", "Example Community C" briefly opened first, then Example Community opened, then the `#screenshots` channel never opened despite three `cdp_click → cdp_get_tree` rounds. Each `cdp_click` reported `ok` but the wrong server / no channel actually selected.

**Root cause:** The `sel()` selector builder in `CDP_JS_EXPR` produced **non-unique** selectors for Discord's sidebar treeitems. Discord renders every server icon with the same SVG/foreignObject DOM scaffold (`foreignobject > div > svg > foreignobject > div > div`). The old `sel()`:
- Only added `:nth-of-type(N)` when siblings shared the same tag (`sibs.length > 1`). In Discord's per-server scaffold each tag appears alone among its siblings → no index added.
- Walked up only 6 levels, so the selector started mid-tree rather than from a stable anchor.

Result: the CSS selector `foreignobject > div > svg > foreignobject > div > div` matched **every** server's inner div. `document.querySelector(sel)` picked the *first* one in DOM order — Example Community C — so every "Example Community" click actually hit Example Community C (or whichever server was first). Channel clicks failed for the same reason: channel-list rows share scaffold across all channels.

**Fix:**
1. **Prefer `aria-label` selector** when unique — added after id/data-testid checks in `sel()`. Discord treeitems all carry unique aria-labels (`"Unread messages, Example Community"`, `"screenshots (text channel)"`). Selector becomes `div[aria-label="…Example Community…"]` → exactly one match.
2. **`:nth-child(N)` instead of `:nth-of-type(N)`, applied unconditionally** — even when siblings have distinct tags, positional index disambiguates against other matches elsewhere in the DOM. Removed the `sibs.length > 1` gate.
3. **Walk 10 levels (was 6)** — gives the selector enough scaffold to anchor against a distant unique ancestor when aria-label fallback also fails.
4. **Settle delay** — `cdpClickReal` now sleeps 400 ms after `mouseReleased` before closing the WebSocket. Discord's React router re-renders the sidebar/main area asynchronously after the click event; without the delay, the very next `cdp_get_tree` snapshot would capture the old view and the model would click stale refs.

**Generalization:** Any auto-generated CSS path needs uniqueness verification *and* a richer disambiguator than nth-of-type. For chat / sidebar UIs with repeated scaffolds, prefer attribute-based selectors (`aria-label`, `data-list-item-id`, etc.) before falling back to positional paths. Post-action settle delay is part of any click tool's contract on a SPA — the click contract is "click + DOM observable" not just "click event dispatched".

### 2026-05-25 — Model navigates server but stalls on channel

**Symptom:** With selectors fixed and the click producing real `isTrusted` events, the Example Community server *visually* opened in Discord. The model still failed to reach `#screenshots`: it called `cdp_click` on whichever ref looked vaguely channel-shaped (often an SVG, not the `<a>`), and never went further than two click rounds.

**Root cause:** Tooling correct, *prompting* wrong. Without an app-specific recipe, the model treated Discord's three-refs-per-row layout (`svg`, `svg`, `div[role="treeitem"]`) as undifferentiated and clicked the first one it saw. It also did not internalize that multi-step navigation requires `*_get_tree` between every click.

**Fix:** `buildAutoBlock()` now emits an **app-specific playbook** when `meta.exe` basename matches a known app. For Discord the playbook describes the DOM map (server rail vs channel sidebar vs composer), gives an explicit click recipe ("find treeitem by aria-label substring → click → re-inspect → find `<a>` channel → click → re-inspect → type in composer"), and lists anti-patterns (don't click `svg`, don't reuse refs across snapshots, strip "Unread messages, " / "N mentions, " prefixes when matching server names). The generic "Working style" section was also extended with the multi-step verification rule and a substring-on-label matching guideline that applies to any SPA.

**Generalization:** A tool surface is necessary but not sufficient. For each non-trivial app, the agent file should encode (a) the DOM map of the main surfaces, (b) explicit navigation recipes for common goals, (c) anti-patterns observed in real failures. When the user deletes the agent file between runs, this content regenerates fresh from `appSpecificPlaybook(meta)`, so corrections to the playbook are durable without manual edits to per-app files.

### 2026-05-25 — Server treeitems have empty aria-label; selectors still non-unique

**Symptom:** After all earlier fixes were in place ("isTrusted clicks", control-char sanitize, `:nth-child` selectors, walk depth 10, settle delay, Discord playbook), the chat would still navigate to **the wrong server** ("It just went to the wrong community server" — not even Example Community) and never reach `#screenshots`. Repeated retries with deleted-and-regenerated agent file behaved the same.

**Direct CDP investigation:** Probed `document.querySelectorAll('[role="treeitem"]')` on a live Discord with the chat-panel API up. 40 server treeitems exist. **All but two (`"Add a Server"` and `"Discover"`) have an empty `aria-label` attribute.** The server *name* lives only in the treeitem's `textContent`. Channels (which earlier docs lumped together with servers) *do* carry `aria-label`, but the format is `"<channel> (text channel)"` / `"unread, <channel> (text channel)"` — not `"(channel, category: ...)"` as the old playbook claimed.

Separately, the `sel()` selector builder still produced **non-unique** selectors for the server treeitems: walk depth 10 from a server treeitem (which sits 15+ levels deep inside `nav > ul > div > div > div > svg > foreignObject > div > svg > foreignObject > div > div`) never reached the per-server distinguishing ancestor. Every server treeitem's selector resolved to the same 10-level `:nth-child` chain, so `document.querySelector(sel)` always returned the first one — typically `example-server-c` or `Example Community C` — regardless of which ref the model picked.

**Fix (three layers, all in `main.js` `CDP_JS_EXPR`):**

1. **Prefer `data-list-item-id` selectors** — Discord tags every server treeitem with `data-list-item-id="guildsnav___<guild-id>"` and every channel with `data-list-item-id="channels___<channel-id>"`. Always globally unique. `sel()` now checks this between `data-testid` and `aria-label`. Direct test: every server treeitem now serialises as `[data-list-item-id="guildsnav___<id>"]` (Example Community), `[data-list-item-id="guildsnav___<id>"]` (Example Community B), etc.
2. **Prefer `a[href=...]` for anchors** — secondary unique-attribute path; useful for non-Discord apps that don't expose `data-list-item-id` but do use stable hrefs.
3. **Walk-with-uniqueness-check fallback** — when no unique attribute is found, the walk now goes up to **30 levels** (was 10) *and* checks `querySelectorAll(parts.join(' > ')).length === 1` at each step, returning as soon as the partial path is unique. No selector should ever be shared across distinct elements again.

**Playbook rewrite:** `appSpecificPlaybook(meta)` Discord section was rewritten to:
- Tell the model **explicitly** that `aria-label` is empty on server treeitems, and that it must match servers by the snapshot's `text` column (with prefix/suffix stripping spelled out).
- Update the channel matching format to `"<channel> (text channel)"` / `"unread, <channel> (text channel)"`.
- Move all matching rules to operate on the snapshot columns the model actually receives (`text`, `aria-label`, `tag`, `role`), not on hypothetical attribute names.

**Historical local verification:** an end-to-end live probe drove the same pipeline (`CDP_JS_EXPR` → snapshot → match → `cdp_click` via `Input.dispatchMouseEvent`) without ChatGPT in the loop. It navigated between generic test server/channel fixtures successfully. The live probe is intentionally not retained in the public tree.

**Generalization:** When an automatic selector builder claims uniqueness, **verify**. Walking a fixed number of levels and trusting nth-child indices to disambiguate is brittle on deeply nested SVG / foreignObject scaffolds (Discord, Figma, many Electron sidebar layouts). Always: (a) check `querySelectorAll(sel).length === 1` after building; (b) prefer stable per-item attributes (`data-list-item-id`, `data-testid`, `href`, unique `aria-label`) over positional paths; (c) keep walking *and re-checking* if the path is still ambiguous, up to a reasonable depth. The selector builder is part of the system's correctness contract — its output is the difference between "click Example Community" and "click whatever server happens to be first in DOM order."

**Documentation drift hazard:** The previous Discord playbook claimed servers had `aria-label = "Unread messages, Example Community…"` — based on outdated UIA snapshots from before this debugging round. Always re-probe the DOM after the framework updates; the previous incident's "fix" was directionally right (prefer attribute selectors) but landed on the wrong attribute (`aria-label` vs `data-list-item-id`) because no one had verified the live attribute set on a current Discord build.

### 2026-05-25 — `MAX_ROUNDS = 6` too tight for content tasks on Discord

**Symptom:** User asked "Navigate to Example Community → #screenshots → show the last image I uploaded." Chat panel rendered `"ChatGPT stopped responding: ChatGPT stopped responding after 6 tool rounds without sending a reply. The task may be too complex — try simplifying or breaking it up."` Tool pills indicated the model was on the right track (server click, tree refresh, channel click) — it simply ran out of rounds before it could reply.

**Root cause:** `chat:send` in `electron-detector/main.js` caps the tool loop at `MAX_ROUNDS = 6`. The minimum Discord recipe is `cdp_get_tree → cdp_click(server) → cdp_get_tree → cdp_click(channel) → cdp_get_tree → cdp_get_messages → reply`. That's exactly 6 tool rounds before the model gets a chance to *write* the final answer — and the reply round itself counts against the cap because the model emits text only on the round where it stops calling tools. Any disambiguation, settle-retry, or extra `cdp_get_tree` (which the playbook explicitly tells the model to do "if the snapshot raced the post-click settle") immediately overruns the budget. The cap also gave the playbook's "do not give up after one `cdp_get_tree` returns no channels" rule no slack to actually use.

**Fix:** Bumped `MAX_ROUNDS` from `6` to `16` in `electron-detector/main.js`. The error string (line ~1423) already interpolates `${MAX_ROUNDS}`, so its message stays accurate. The `dispatch_executor` tool schema in the planner/executor design (below) was updated to match: default `16`, max `24`.

**Why 16 (not 8 or 32):** 16 covers the Discord navigation recipe (~6 rounds) plus realistic retries and a *second* navigation in the same turn (e.g. "after reading messages, jump to another channel and reply") without enabling runaway loops. A cap is still load-bearing — without one, a model that gets confused by a stale ref can spin tool calls until the SSE connection dies. 16 is the largest value that still surfaces "the model is genuinely stuck" within ~2-3 minutes of wall-clock.

**Generalization:** Multi-round tool budgets need to be sized against the *longest documented recipe + 1 round for the reply + N rounds of recovery headroom*, not against a guess. Whenever a playbook is extended with a new tool that adds a round to the recipe (e.g. `cdp_get_messages` was a new round on top of the navigation recipe), the budget cap is part of the change set. The proper long-term fix is the planner/executor split described below: planner runs at high effort and decides what to dispatch, executor runs at low effort with its own (configurable) round budget, and the two layers absorb retry cost without inflating top-level latency.

### 2026-05-26 — "first image I uploaded" jumped to the *newest* image (search sort not flipped)

**Symptom:** User: "Navigate to Example Community → #screenshots → find the first image I've ever uploaded and take me there." The model reported success ("found your earliest image upload … and took you to it") but jumped to a *recent* image, not the first one.

**Root cause:** Discord's search-results sort UI changed. The playbook told the model to flip to oldest-first by clicking a text toggle labelled `"Old"` (`cdp_find("Old")`). That toggle no longer exists — current Discord (build `app-1.0.9238`, verified by live CDP probe) renders sort as a **dropdown** `button[aria-label="Sort"]` that opens a portal menu `#search-result-sort-menu` with three `role="menuitemradio"` options (`…-option-newest` (default, checked), `…-option-oldest`, `…-option-most_relevant`). So `cdp_find("Old")` matched nothing, the model silently stayed on the **Newest-first default**, and `cdp_get_search_results.results[0]` was the *most recent* match. The old `sortMode` scraper (looked for `[role="tab"]` with text new/old/relevant) also matched nothing and returned `''`, giving the model no signal that sort hadn't changed. Verified server-wide `has:image` baseline: `results[0]` = `2026-05-26` (newest); after flipping to Oldest, `results[0]` = `2019-02-26` (the actual first image).

**Fix (all in `electron-detector/main.js`, so it survives the per-run agent-file wipe):**
- New tool **`cdp_set_search_sort(order)`** (`"oldest"` / `"newest"` / `"relevant"`). `cdpSetSearchSortReal` opens the dropdown and clicks the radio at the CDP mouse layer (real `isTrusted` clicks so React commits), then **verifies from the result-row timestamps** (authoritative — the radio ids leave the DOM once the menu closes).
- `buildSearchResultsExpr` (`cdp_get_search_results`) now returns `order` (`"ascending"`=oldest-first / `"descending"`=newest-first), `firstTime`, `lastTime`, and a timestamp-derived `sortMode` label — instead of the dead `[role="tab"]` scrape.
- Discord playbook + planner doc: replaced the "click the `Old` toggle" step with "call `cdp_set_search_sort("oldest")` and proceed only when the follow-up `cdp_get_search_results` reports `order:"ascending"`." Added anti-patterns: never trust `results[0]` as first/oldest without confirming `order`; never `cdp_find("Old")`.

**Historical local verification:** a live Discord probe exercised the shipped functions — baseline descending → `cdp_set_search_sort("oldest")` → ascending → `results[0]` is the oldest, idempotent re-call, and reset-to-newest all passed. The live probe is intentionally not retained in the public tree.

**Generalization:** Any "first / earliest / oldest" (or "latest / newest") task over a sortable, paginated list is only correct if the tool **confirms the actual sort order from the data** (here, comparing first vs last visible timestamps) rather than assuming a UI click changed it. A click that silently no-ops (because the control's DOM changed) is invisible unless you read back ground truth. This is the same class of bug as the `isTrusted` incident: don't trust that an action took effect — verify the post-state. Re-probe vendor UIs after app updates; toggles become dropdowns.

### 2026-05-25 — "Scroll me to my last upload" reported done, but viewport never moved

**Symptom:** User opened the ChatGPT panel scoped to Discord and asked "Navigate to Example Community server and go to #screenshots. Find the latest picture I uploaded and scroll me to there." The tool-pill trail showed the correct navigation recipe (`cdp_click` server → `cdp_get_tree` → `cdp_click` channel → `cdp_get_tree` → `cdp_get_messages → 70 messages`), then the assistant replied: *"Done — you're in Example Community → #screenshots, positioned at your latest uploaded picture post: Example User — example post, with the latest image in that set being example-image.png."* The Discord window did not scroll. The user's "latest upload" was many screens above the current viewport; the chat still showed the bottom of the channel exactly as it had when the channel first loaded.

**Root cause:** No scroll tool existed. `cdp_get_messages` is a read-only DOM scrape — it walks `li[id^="chat-messages-"]`, serializes 70 messages of metadata, and returns. It does not touch `scrollTop` or call `scrollIntoView` on anything. The model conflated "I located the target message in the returned JSON" with "the user can now see the target message" and emitted a completion reply. The playbook for `cdp_get_messages` explicitly described it as a content-reading tool but did not warn that *finding* a message is not the same as *showing* it; without a scroll verb in the tool surface, the model also had no obvious recovery path even if it noticed the gap.

**Fix (three layers):**

1. **New tool `cdp_scroll_to_message(message_id)` in `electron-detector/main.js`.** Builds a `Runtime.evaluate` expression that resolves `document.getElementById(raw)` first (matches the full `chat-messages-<channel>-<message>` id returned by `cdp_get_messages`), falls back to `li[id$="-<numeric-suffix>"]` if the caller passed just the trailing message id, then calls `scrollIntoView({block:'center', inline:'nearest', behavior:'auto'})`. `behavior:'auto'` (synchronous, no animation) means the scroll completes before the Runtime.evaluate response returns, so the next snapshot or screenshot reflects the new scroll position with no settle gap. As a UX nicety the tool also paints a 2 px `#5865F2` outline on the target for ~1.8 s and clears it via `setTimeout`, so the user visually confirms which message the assistant landed on. Returns `{ok, id, top, height, visible, innerHeight}` so the model can detect a missed scroll.
2. **Tool-guide string + agent-file tool list updated.** The single-paragraph `toolGuide` (CDP branch) and the bulleted `toolList` emitted into every agent file now mention `cdp_scroll_to_message` and spell out the trigger phrases ("scroll to", "show me", "jump to", "take me to", "find") that require it. The guide explicitly says: *"saying 'done' without scrolling is a failure"* — encoding the user-visible failure mode at the same place the tool is introduced.
3. **Discord playbook — new "Scrolling the viewport to a specific message" section.** Spells out the contract: (a) call `cdp_get_messages` to locate, (b) call `cdp_scroll_to_message(id)` with the full id, (c) only report completion after `{ok:true, visible:true}`. Anti-patterns list gains: *"Do not declare a scroll/show/jump-to task done after only `cdp_get_messages`. That tool reads, it does not scroll."* Also covers the off-screen case: if the target is not in the loaded window, ask the user to scroll up first or click into the channel header — `cdp_get_messages` cannot fetch what is not in the DOM.

**Generalization:** Whenever a read tool and a user-visible state-change verb share vocabulary (read messages vs. scroll to a message; read DOM vs. focus an element; read text vs. select text), the tool surface must include **both** primitives, and the playbook must explicitly name the failure mode where the model substitutes the read tool for the action. Without the second tool, the model has no choice but to lie by omission ("I found the post" sounds like task completion to the user). Without the playbook anti-pattern, the model will still lie even with the tool available, because the JSON returned by the read tool feels like proof. *Tool-result satisfaction* and *user-observable satisfaction* are different surfaces; the agent file must teach the model which one the user actually cares about for each verb.

**Verification (manual):** After restarting the Electron app, re-running the same prompt should show a fifth tool pill `cdp_scroll_to_message → ok` after the `cdp_get_messages → 70 messages` pill, and the Discord window should visibly scroll to the target message with a brief blurple outline before the assistant's reply.

### 2026-05-25 — ChatGPT "first image I uploaded" returns first *rendered* image, not first *historical* image

**Symptom:** User opened the ChatGPT panel scoped to the running ChatGPT Electron app and asked to be taken to **the first image they had ever uploaded** in the current chat. The model called `cdp_find("img")` (or `cdp_get_tree()`), picked the first `<img>` in the returned snapshot, clicked it, and reported success. The viewer opened the wrong image — specifically, the first image visible in the **currently rendered slice** of the conversation, not the chronologically first upload. The actual first-ever upload was many screens above the current scroll position and had never been mounted into the DOM during the task.

**Root cause (two compounding factors):**

1. **No ChatGPT-specific playbook.** `appSpecificPlaybook(meta)` only branched on Discord. For every other Electron app the model fell back to the generic "Working style" section, which does not mention lazy-loading, virtualization, or the read-vs-load distinction. With no warning, the model treated "first image in the DOM I can see" as identical to "first image in history."
2. **No generic scroll tool.** The existing scroll tools (`cdp_scroll_messages`, `cdp_scroll_to_message`) are Discord-specific — they target `ol[data-list-id="chat-messages"]` and `li[id^="chat-messages-"]`, neither of which exists in ChatGPT's DOM. The model had no way to force-load history even if it knew it should. Asking the user to scroll manually is the failure mode the previous fix tried to eliminate; without an automatable scroll, the model defaulted to the next-worst option: pretend the current DOM is the full history.

**Fix (three layers):**

1. **New tool `cdp_scroll(direction, pages?, container?)` in `electron-detector/main.js`.** Detector preference order: `ol[data-list-id="chat-messages"]` (Discord) → `main[class*="chatContent"] ol` → `[role="log"]` → `[data-testid*="conversation"]` → `main [class*="conversation"]` → `main [class*="thread"]` → `main` → the largest visible element with `overflow-y: auto|scroll` whose `scrollHeight > clientHeight + 10`. Returns the same shape as `cdp_scroll_messages` plus `heightChanged` (so the model can detect lazy-load completion) and `containerTag` / `containerClass` (so the model can verify it grabbed the right scroller). Wired into `executeTool` and added to `AUTOMATION_TOOLS_CDP` so recipes can use it too.
2. **`appSpecificPlaybook(meta)` ChatGPT branch.** Spelled-out DOM map (the conversation scroller is the largest `overflow-y:auto` descendant of `main`; turns are `article[data-message-author-role="user|assistant"]`; uploads are `<img>` inside user-role turns), the lazy-load rule (any "first/earliest/oldest" or "latest/newest" query forces a `cdp_scroll("top")` / `cdp_scroll("bottom")` loop until `{atTop|atBottom:true, heightChanged:false}` *before* enumerating), an explicit 15-iteration cap so the model surfaces "chat too long for budget" instead of guessing, and the anti-pattern list (don't read first-from-current-viewport, don't use Discord-specific tools, don't ask the user to scroll, don't reuse refs across scrolls).
3. **`buildAutoBlock` tool list and `chat:send` tool guide updated** to mention `cdp_scroll` everywhere `cdp_scroll_messages` is mentioned, and to state the lazy-load rule in app-agnostic language. The guide now says explicitly: *"For ANY app whose conversation is lazy-loaded (ChatGPT, Slack, web chats): any 'first / earliest / oldest / original' or 'latest / newest' query MUST start with `cdp_scroll("top")` or `cdp_scroll("bottom")` looped until `{atTop:true, heightChanged:false}` before searching with `cdp_find` / `cdp_get_tree`."*

**Generalization:** *Lazy-loaded / virtualized lists* (ChatGPT, Slack, modern Discord, Linear, Notion, anything React-windowed) violate the implicit "the DOM is the source of truth" assumption every selector-based tool relies on. The fix has two halves and both are mandatory: (a) provide a *force-load* primitive (a scroll tool that grows the DOM), and (b) tell the model *when* to use it via an explicit rule in the per-app playbook tied to natural-language triggers ("first", "earliest", "oldest", "original", "latest", "newest", "most recent"). Without the primitive, the model has no recovery path. Without the rule, the model will keep substituting "first rendered" for "first historical" because the JSON returned by a snapshot feels like ground truth. The same pattern will recur for any app added next — bake the lazy-load rule into every new app playbook unless its conversation is provably eager-loaded.

**Verification:** End-to-end requires re-running the same prompt against a live ChatGPT instance with CDP enabled. Expected trail: `cdp_scroll("top") → {atTop:?, heightChanged:true}` → repeat until `{atTop:true, heightChanged:false}` → `cdp_find("img")` (or `cdp_get_tree("[data-message-author-role='user']")`) → `cdp_click(<first img ref>)`. The viewer should land on the user's first-ever upload, not the first in the previously-rendered slice.

## Discord navigation playbook (canonical)

This is the same content emitted into `app-agents/discord_<hash>.md` by `appSpecificPlaybook(meta)`. Kept here so the spec doubles as the source of truth. **Verified against a live Discord client via direct CDP probing — the rules below match observed DOM, not a hypothesis.**

**DOM map**

- **Server rail** (left column): each server is `div[role="treeitem"]` with `data-list-item-id="guildsnav___<guild-id>"`. `aria-label` is **empty**. The server name lives in the treeitem's `textContent`, in one of these shapes:
  - `"<Server Name>"` — plain
  - `"Unread messages, <Server Name>"` — has unread activity
  - `"<n> mentions, <Server Name>"` — has mentions
  - `"<Server Name>, Voice call active"` / `"<Server Name>, Screenshare active"` — extra suffixes
  Two non-interactive `svg` decorations precede each treeitem and share the same `textContent`. **Always click the `div[role="treeitem"]`, not the `svg`.** With the current `sel()` builder, server rows serialize as `[data-list-item-id="guildsnav___<id>"]` — globally unique.
- **Channel sidebar** (right of rail, only after a server opens): channels are `<a>` tags with `data-list-item-id="channels___<channel-id>"` and `aria-label` of the form `"<channel-name> (text channel)"` or `"unread, <channel-name> (text channel)"`. Text content is `Text<channel-name>` (or `Text (Active Threads)<channel-name>`). Channels serialize as `[data-list-item-id="channels___<id>"]`. Category headers are `div[role="button"]` — they collapse/expand, **do not navigate**.
- **Main area**: message composer is `div[role="textbox"]` with `aria-label` starting `"Message "` and containing the current channel name.

**Navigation recipe (server → channel → send)**

1. `cdp_get_tree()` to see current state.
2. **Find server.** Filter rows: `tag == div`, `role == treeitem`, `text` (case-insensitive) contains the server name **after** stripping `"Unread messages, "` / `"N mentions, "` prefix and `", Voice call active"` / `", Screenshare active"` suffix. Pick the `div` ref. **Do not match on `label` / `aria-label` for servers — it is empty.** `cdp_click` that ref.
3. `cdp_get_tree()` — server has switched and channel sidebar is now populated. Refs from step 1 are stale.
4. **Find channel.** Filter rows: `tag == a`, `aria-label` (case-insensitive) contains the user's channel name (strip leading `#`, accept an `"unread, "` prefix and ` (text channel)` suffix in the aria-label). `cdp_click` that ref.
5. `cdp_get_tree()` to confirm a `role == textbox` composer whose `aria-label` references the channel.
6. To send: `cdp_type(composer, "<text>")`, then click the `aria-label == "Send Message"` button (or a future `cdp_key('Enter')` tool).

**Scrolling to a specific message** (e.g. "show me my last upload"):

1. `cdp_get_messages(limit)` to locate the target in the loaded window.
2. `cdp_scroll_to_message(id)` with the full `id` from step 1 — this is the only way to move the viewport. `cdp_get_messages` is read-only.
3. Confirm `{ok:true, visible:true}` before telling the user "you're at <message>". A brief blurple outline on the target gives the user visual confirmation.

If the target is not in the `cdp_get_messages` output, **use the channel-header search bar** (next section) rather than asking the user to scroll. `cdp_get_messages` only sees what's mounted; search hits Discord's index and reaches every message in the server.

**Using the channel-header search bar** (for "first / earliest / oldest <X>" or any query that predates the loaded scrollback):

- Search bar is `div[class*="searchBar_"]` in the channel header. `textContent` = `"Search <Server Name>"`. Find via `cdp_find("Search ")`.
- After click, focus lands on a DraftJS combobox (`div[role="combobox"][aria-label="Search"][contenteditable="true"]`). **`cdp_type` does NOT work on this — DraftJS swallows JS-dispatched InputEvents. Use `cdp_paste`.**
- Recipe: `cdp_find("Search ")` → `cdp_click(<ref>)` → `cdp_paste(<ref>, "<query>")` → `cdp_press_key("Enter")` → enumerate `li[id^="search-results-"]` in `section[aria-label="Search Results"]` → click target row's "Jump" button → optional `cdp_press_key("Escape")` to close panel.
- Query syntax: `from:<username>` (your own uploads → use `currentUser` from `cdp_get_messages`), `has:image | has:link | has:embed | has:file | has:video | has:sound`, `in:<channel>`, `mentions:<user>`, `before:YYYY-MM-DD` / `during:YYYY-MM-DD` / `after:YYYY-MM-DD`, plus free-text words. Combine freely: `from:<current-user> has:image during:2025-08-12`.
- Use search instead of scrolling whenever the target is older than the recent window. One search call beats dozens of `cdp_scroll_messages("up")` rounds.

**Anti-patterns**

- Matching servers by `aria-label` / `label`. It is empty on server treeitems. Use `text`.
- Clicking `svg` refs for navigation. Always click `div[role="treeitem"]` (servers) or `a` (channels).
- Reusing refs from a pre-click snapshot. Navigation re-renders the main area; refs reshuffle.
- Picking by ref position ("the first treeitem"). Unread + folder state changes order.
- Giving up after one `cdp_get_tree()` returns a small tree — the snapshot may have raced the post-click settle. Call `cdp_get_tree()` again before concluding the channel sidebar is empty.
- Declaring a "scroll to / show me / jump to" task done after only `cdp_get_messages`. That tool reads the DOM, it does not move the viewport. Always follow with `cdp_scroll_to_message(id)` and verify `{ok:true}`.
- Using `cdp_type` on the channel-header search bar. The search input is DraftJS and ignores JS-dispatched InputEvents — `cdp_type` returns `{ok:true}` while the field stays empty. Use `cdp_paste`.
- Scrolling history when search would work. "First image I uploaded in this server" → `from:<currentUser> has:image` in the search bar, not hundreds of `cdp_scroll_messages("up")` rounds.
- Reporting partial completion ("I had to stop before…") as success. The user is looking at the app and will see the mismatch. Either complete the task via an alternate path, or explicitly say what you tried, what blocked you, and what you'd try next.

### 2026-05-25 — Chat panel appears frozen during 2-3 min reasoning gaps after large `cdp_get_tree`

**Symptom:** User issued a content task ("Navigate to Example Community → #screenshots → show the last image with 21+ reactions"). The model executed the navigation correctly via the post-fix selectors, then went silent for **2 minutes 47 seconds** between `cdp_get_tree → 500 refs` and the next tool call. From the UI, the chat looked frozen — no pill, no text streaming, no progress indicator. The model eventually resumed.

**Root cause (two compounding factors):**
1. **Snapshot token bloat.** `cdp_get_tree` was being used for tasks that needed *message content*, not interaction targets. A 500-ref snapshot is ~80 KB of JSON; round-tripping it through the model's context + reasoning over it (especially with `reasoning.effort = high`) takes minutes. No tool calls fire during that internal reasoning, so the renderer's existing "thinking dots" — which only show before the first tool call — were already gone.
2. **No mid-turn thinking indicator.** The renderer's `showThinking()` was called once on `sendChatMessage` and removed on the first tool call or text chunk. Subsequent reasoning rounds (between `chat:tool-result` and the next `chat:tool`) had no UI signal at all — fully silent.

**Fix (two parts):**

1. **New tool `cdp_get_messages(limit?)`.** Discord-specific scraper that returns structured `{id, author, time, text, images, reactions, reactionTotal}` for the last N visible messages. Bypasses the full DOM snapshot for content-reading tasks. ~25 messages = 2-5 KB vs 80 KB+. Encoded directly into the Discord playbook with explicit guidance: "use `cdp_get_messages` to read content; use `cdp_get_tree` only when you need to click or type". Implemented as `buildMessagesExpr(limit)` returning a `Runtime.evaluate` expression, dispatched through the existing `cdpEvalRaw` PowerShell-WebSocket path. Reaction count parsing is per-emoji (each `[class*="reaction_"]` button = one emoji + its count); `reactionTotal` is the sum across emoji on that message. Unique-reactor count is *not* available without opening each tooltip, so callers should treat `reactionTotal` as an upper bound for "popular post" filtering.

2. **Dynamic thinking pill.** A persistent "Thinking…" row at the bottom of the chat that updates its subtext in place rather than getting replaced by tool pills. State machine:
   - `chat:send` → show pill with subtext `"reading your request…"`.
   - SSE event `response.reasoning_summary_text.delta` (and aliases `response.reasoning_text.delta`, `response.reasoning.delta`) → main forwards `chat:thinking { delta }`; renderer appends to a buffer and replaces the subtext with the **tail** of the buffer (last ~240 chars). Updates in place — no chat-history fill.
   - `chat:tool` → hide pill, render the tool pill; remember `"running <name>…"` as the next fallback subtext.
   - `chat:tool-result` → re-show pill with subtext describing the result (`"after cdp_get_tree → 500 refs"`, `"after cdp_get_messages → 25 messages"`, etc.). Buffer reset; if no reasoning deltas fire next, at least the fallback subtext gives the user state context.
   - `chat:chunk` → hide pill (assistant is now writing the final answer).
   - `chat:done` → hide pill, clear fallback.

   Wired in `main.js streamOneRound` (new SSE branches), `preload.js` (new `onThinking` listener + removeListeners), `renderer.js` (`showThinking(subtext)`, `setThinkingSub`, `thinkingBuffer`, `thinkingFallbackText`, hooks on tool/tool-result/chunk/done), `styles.css` (new flex-column layout with `.chat-thinking-head`, `.chat-thinking-spinner`, `.chat-thinking-sub` for line-clamped tail).

**Generalization:**
- For any agent UI that has multi-round tool calling, the renderer should track *agent state* (`thinking | running tool | streaming answer`) rather than just rendering the events it sees. Long reasoning gaps with no SSE traffic *look* like a freeze and erode user trust; a sticky status pill with last-known fallback subtext makes the gap legible.
- For any large-context tool result, design a *narrower* alternative tool for the common task (here: messages instead of full DOM). The model will pick the cheaper tool *if the playbook tells it to* — left to its own devices it defaults to `cdp_get_tree` because that's the one mentioned first in every example.

### 2026-05-25 — ChatGPT bugs out the Discord search bar, reports partial completion as failure

**Symptom:** User asked the chat (scoped to Discord) to find their first uploaded image in `#screenshots`. ChatGPT navigated correctly to Example Community → `#screenshots` (right server, right channel, tool-pill trail correct), then attempted to use Discord's channel-header search bar. Instead of completing, the model emitted: *"I navigated to Example Community → screenshots but I had to stop before successfully finding and pasting your first uploaded image link here."* The Discord window was left on the channel with no search results visible.

**Root cause (three compounding factors):**

1. **`cdp_type` doesn't work on DraftJS / Slate / Lexical editors.** The Discord channel-header search bar (`div[class*="searchBar_"]`) opens a `div[role="combobox"][aria-label="Search"][contenteditable="true"]` that is a DraftJS editor. `cdp_type`'s contenteditable path mutates `el.textContent` and dispatches a synthetic `InputEvent({inputType:"insertText", data:text})`. DraftJS's controlled-input model reads from its own `EditorState` and overwrites whatever you wrote to `textContent` on the next render tick. The model called `cdp_type` against the search bar, saw `{ok:true, mode:"contenteditable"}`, then `cdp_get_tree` showed the field still empty — and had no path forward.
2. **No keyboard primitive for form submission.** Even if the model had managed to insert text, there was no tool to press Enter. Discord's search input submits on `keydown` of the Enter key, which only fires when an `isTrusted=true` `Input.dispatchKeyEvent` (or a real human keypress) hits the focused element. The synthetic `KeyboardEvent` you could dispatch via `cdp_get_tree` then `cdp_click` is `isTrusted=false` and React's onKeyDown filter ignores it. So the model had nothing to call that would submit the (still-empty) query.
3. **No "use search" entry in the Discord playbook + no self-recovery rule.** The playbook described `cdp_get_messages` + `cdp_scroll_messages` for content tasks, but had nothing about the channel-header search bar — which is the *right* primitive for "first / oldest / earliest <X>" queries that predate the loaded scrollback. With no search recipe and a broken type path, the model fell back to scrolling, hit `MAX_ROUNDS`, and reported partial completion. There was also no general rule telling it not to give up silently — so its final reply leaked "I had to stop" instead of explaining what blocked it.

**Direct CDP probe (verified against live Discord build, channel-header search):**

- Search bar wrapper: `div[class*="searchBar_"]` in the channel header. `textContent` reads `"Search <Server Name>"` (e.g. `"Search Example Community"`). Width ~244 px on a standard layout.
- Click focuses: `div.public-DraftEditor-content[role="combobox"][aria-label="Search"][contenteditable="true"]`.
- `Input.insertText` works — typed value appears, Discord's filter popout opens with hints (`from:<current-user>`, `in:channel`, `has:link,embed,or file`, `mentions:user`, `before/during/after:YYYY-MM-DD`).
- `Input.dispatchKeyEvent` `Enter` submits — results panel renders as `section[class*="searchResultsWrap_"][aria-label="Search Results"]` containing `li[id^="search-results-"]` rows (~25-50 visible). Each row has a "Jump" button that navigates the main chat to the source message.

**Fix (four layers, all in `electron-detector/main.js`):**

1. **New tool `cdp_paste(ref, text, clear?)`** — focuses element via real CDP click (mouseMoved + mousePressed + mouseReleased dispatched through `Input.dispatchMouseEvent`, same `isTrusted=true` path as `cdp_click`), optionally Ctrl+A + Delete to clear, then `Input.insertText`. Works on every text editor we've encountered, including DraftJS. Verified end-to-end against the Example Community → `#screenshots` search bar — typed `from:me has:image`, got back `{ok:true, chars:17, cleared:true}` and the popout opened.
2. **New tool `cdp_press_key(key, modifiers?)`** — `Input.dispatchKeyEvent` keyDown + keyUp at CDP layer. Recognises `Enter`, `Escape`, `Tab`, `Backspace`, `Delete`, `ArrowUp/Down/Left/Right`, `Home`, `End`, `PageUp/Down`, `Space`, plus any single character. Modifiers via array (`["ctrl"]`, `["ctrl","shift"]`, etc.). Required to submit forms / searches and to dismiss popouts. Verified: `cdp_press_key("Enter")` after the paste submitted the search, results panel rendered with 25 rows; `cdp_press_key("Escape")` closed it.
3. **Discord playbook — new "Using Discord's search bar" section** in `appSpecificPlaybook("discord")`. Spells out the DOM map (search bar selector, DraftJS combobox, results panel + Jump rows), the exact recipe (`cdp_find("Search ")` → `cdp_click` to focus → `cdp_paste` the query → `cdp_press_key("Enter")` → enumerate `li[id^="search-results-"]` → click target's "Jump" → optional `cdp_press_key("Escape")` to close), the Discord query syntax (`from:`, `has:image|link|embed|file|video|sound`, `in:`, `mentions:`, `before/during/after:YYYY-MM-DD`, free-text), and a *when to use search vs scroll* rule: search for anything older than the recent window, scroll only for "latest / most recent" within the loaded view.
4. **Generic "Working style" self-recovery rule** in `buildAutoBlock()`. Lists the standard substitutions (`cdp_type` → `cdp_paste`, manual scrolling → app search bar, big `cdp_get_tree` → `cdp_find` / scoped tree, stale ref → re-`cdp_find`, missing element → re-snapshot once for post-click settle) and mandates an explicit "what I tried / what blocked me / what I'd try next" reply if recovery genuinely fails. *"I had to stop" is not an acceptable terminal reply.*

The Discord playbook also gained three new anti-patterns: (a) do not `cdp_type` into the channel-header search bar (DraftJS swallows it; use `cdp_paste`); (b) do not scroll history when search would work (one search call beats dozens of scroll rounds); (c) do not declare partial completion as success.

**Generalization:**

- **Tool primitives must cover the breadth of input the framework family demands.** A click tool that produces `isTrusted=true` events is necessary but not sufficient — text editors and form submission also need `isTrusted=true` paths at CDP layer (`Input.insertText`, `Input.dispatchKeyEvent`). The JS-dispatched fallback is fine for plain `<input>`/`<textarea>` but is a footgun on any rich-text editor that owns its state. When you see "looks like it worked but the field didn't change", that's a missing CDP-layer primitive, not a model failure.
- **For every "I'm going to scroll forever" task on a search-indexed app, the search bar is a faster primitive — bake it into the playbook.** Discord, Slack, Linear, Notion, GitHub Issues all have global search; using it is always cheaper than scrolling history. The playbook must explicitly route "first / earliest / oldest <X>" queries to search rather than scroll, and must encode the app's query syntax so the model writes valid filters.
- **Silent partial completion is the worst failure mode for a chat-driven UI agent.** The user is watching the app and will see the mismatch immediately; lying by omission ("I had to stop before…") is strictly worse than an honest "I tried X, it failed because Y, try Z." Encode this rule in the working-style section, not just per-app playbooks — it generalises to every app the agent will ever drive.

**Verification (manual, against live Discord):** Probed the search bar DOM via direct CDP (selectors above all match). Drove `cdp_paste("from:me has:image", clear:true)` + `cdp_press_key("Enter")` from CLI: search bar received the text, popout opened, Enter submitted, `section[aria-label="Search Results"]` rendered with 25 `li[id^="search-results-"]` rows. `cdp_press_key("Escape")` closed the panel. End-to-end works without ChatGPT in the loop, so remaining failures will be model-prompting issues, not tooling.

### 2026-05-25 — Click pre-scroll shifts Discord viewport, server rail off-screen

**Symptom:** User asked ChatGPT to navigate Discord. Navigation worked, but after the task the Discord layout was scrolled horizontally — the server rail's left-edge white unread indicators were clipped off the left of the viewport. The user had to scroll the window back manually to recover.

**Root cause:** Both click paths in `main.js` (`buildCdpClickScript` line ~503 and `buildCdpActionExpr('click')` line ~636) called `target.scrollIntoView({block:'center', inline:'center'})` *before* dispatching the click. Per the CSSOM-View spec, `scrollIntoView` walks every ancestor scroll container and aligns the element per the supplied `block`/`inline` arguments. `inline:'center'` forces every ancestor with horizontal overflow — including the outermost app layout when the Discord window is too narrow to fit `sidebar + main` at their natural widths — to recentre on the clicked target. Over multiple clicks during a navigation recipe (server click, channel click) the cumulative effect shifts the entire layout left, pushing the server rail (and its `::before` unread pills) outside the viewport.

**Fix:** Both click paths now use `scrollIntoView({block:'nearest', inline:'nearest'})`. `'nearest'` only scrolls a container when the target is not already visible along that axis; when it is, no scroll happens. Server treeitems and channel anchors are always visible inline within their respective rails when the model picks them out of a snapshot (the snapshot only includes rendered elements), so `inline:'nearest'` is a no-op for navigation and only kicks in when the click target is genuinely off-screen vertically. `cdp_scroll_to_message` (line ~423) already used `inline:'nearest'` — unchanged.

**Generalization:** Any `scrollIntoView` baked into a click path is a *side effect on the user's viewport*. Default to `{block:'nearest', inline:'nearest'}` — only escalate to `'center'` for explicit user-facing scroll verbs (the message scroll tool). For app layouts with multiple nested scroll containers (Electron shells, Discord/Slack/Figma-style sidebars), `inline:'center'` is almost always wrong because the user can see the un-scrolled state and any layout shift looks like a regression. Same logic applies to programmatic `focus()` with `preventScroll:false` (the default) — pass `{preventScroll:true}` on synthetic focus calls inside click tools.

### 2026-05-25 — Recipe generator emits generic queries and wrong `.fN` indices

**Symptom:** User completed a successful task in the chat panel ("Navigate Example Community → #screenshots → find first uploaded image"), clicked **⚡ Make automation**, and Codex returned a valid-looking JSON recipe. When inspected (and re-run), the recipe navigated to the **wrong server / channel**. Example saved recipe:

```json
[
  {"tool":"cdp_find","args":{"query":"Example Community"},"capture":"server"},
  {"tool":"cdp_click","args":{"ref":"$server.f1"}},
  {"tool":"cdp_find","args":{"query":"screenshots","limit":20},"capture":"channel"},
  {"tool":"cdp_click","args":{"ref":"$channel.f2"}},
  …
  {"tool":"cdp_type","args":{"ref":"$search.f1","text":"from:example-user has:image in:screenshots\n","clear":true}},
  …
]
```

**Root cause (three compounding factors):**

1. **Trail summary discarded semantic info.** `summariseResult` reduced `cdp_get_tree` / `cdp_find` results to `{ refs, region, count }`, dropping the rendered table with per-ref labels. Codex only saw "the user called `cdp_click(e58)`" with no idea what `e58` actually pointed to. To write a `cdp_find` query, the model had to fall back to the user's natural-language wording ("Example Community") — which matches many elements in Discord (server icon, channel name, message text, mentions, etc.).
2. **`refMap` entries only held `{ selector, tag, text }`.** Even if we had wanted to enrich the trail with what each ref pointed to, the `aria`, `role`, and `id` fields were thrown away at snapshot-render time despite being available on the source element. Discord server treeitems have **empty** text (the name is in `textContent` after stripping prefixes) — so a `text`-only enrichment would have produced a blank query for the most important case.
3. **`.fN` indices guessed blindly.** Codex emitted `.f1` for the server click and `.f2` for the channel click. Without seeing what `result_summary.matches` actually contained, both indices were guesses — `.f1` happened to be the channel-name-mention in the message list rather than the server icon, and `.f2` was a category header rather than the channel anchor. Even when the query is too generic, the right `.fN` could rescue the step *if the model could see the per-row labels*.

Two adjacent symptoms that the same trail surfaced:
- `cdp_type` was used against Discord's search bar with `\n` appended to the query string. The recipe runtime doesn't translate `\n` into an `Enter` keypress — the literal `\n` ends up in the search field, which Discord parses as part of the query. Submission never fires.
- The original successful turn used `cdp_paste` + `cdp_press_key("Enter")` for the search bar (correct for DraftJS), but the distilled recipe replaced it with a single `cdp_type` step. The model collapsed the two-step pattern back into one because nothing in the prompt warned that some tools can't be substituted for each other.

**Fix (four layers, all in `electron-detector/main.js`):**

1. **Enrich `refMap` entries** in `renderCdpSnapshot` and `renderFocusedSnapshot` to keep `aria`, `role`, `id` alongside the existing `selector`, `tag`, `text`. UIA's `refMap` already kept `automationId`, `name`, `controlType`, `className` — no change there.
2. **Capture `refInfo` per trail entry** in `chat:send`'s tool loop. Before `executeTool` runs, look up `parsedArgs.ref` in `refMapHolder.current` (which is about to be overwritten by `cdp_get_tree` / `cdp_find`) and store `{ ref, tag, text, aria, role, id, name, automationId, controlType }` onto the trail entry. This is the only opportunity — after the call, the refMap is gone.
3. **`summariseResult` preserves the snapshot table excerpt** for any result with a `snapshot` field. The first 1500 chars of the rendered markdown table are kept under `matches`, so Codex sees `| f1 | div | Example Community | … |` for every match and can pick the right `.fN` rather than defaulting to `.f1`.
4. **`buildCodexPrompt` instructions updated** to:
   - Include each step's `targetElement` (the captured refInfo) in the trail JSON given to Codex.
   - Tell Codex to use the **most uniquely identifying attribute** of `targetElement` as the `cdp_find` query, in priority order: exact `aria` → exact `text` → role+name combo → tag+keyword fallback. **Never** use the user's natural-language wording when a more specific attribute exists on `targetElement`.
   - Tell Codex to pick the `.fN` whose row in `result_summary.matches` matches `targetElement`, not always `.f1`.
   - Tell Codex never to embed `\n` / `\r` in `cdp_type` / `cdp_paste` text to submit a form — use a separate `cdp_press_key({"key":"Enter"})` step.
   - Tell Codex to use `cdp_paste` (not `cdp_type`) for rich-text editors (DraftJS / Slate / Lexical / contenteditable comboboxes), and to preserve the full `cdp_find → cdp_click → cdp_paste → cdp_press_key("Enter")` sequence rather than collapsing it.
   - The on-prompt example was updated to show `targetElement.aria` flowing into the `cdp_find` query (full strings, not user wording).

**Generalization (this applies to every app, not just Discord):**

- **A recipe distilled from a tool trail is only as good as the semantic information in that trail.** If the trail is summarised down to `{ count, refs }`, the recipe generator has no choice but to recover semantic content from the user's prompt — and user prompts are colloquial ("Example Community") whereas the real DOM target carries the unambiguous identifier ("Example Community"). Trail entries given to the recipe generator **must** include the per-step element context (`targetElement`) and the per-result label table (`result_summary.matches`). This is a permanent design requirement of the automation pipeline, not a Discord-specific hack.
- **Snapshot-render layers throw away information by default.** When a renderer collapses an element to a markdown row, it usually retains only what's *displayed* (tag/label). Anything else available on the source element (aria, role, id, automationId, controlType, className) should be kept in the parallel `refMap` even if not shown in the table — it costs nothing at snapshot time and the recipe generator (and any future planner/executor split) depends on it. Treat the refMap entry as the *full* element descriptor, the table row as the *displayed* projection.
- **Index-based references in recipes (`.f1`, `.f2`) are brittle without context.** Either eliminate them (single-result queries via more specific filters) or carry enough context for the recipe generator to choose the right index deliberately. The `summariseResult.matches` excerpt is the minimum context needed — without it, `.fN` selection is a coin flip and gets worse on apps with sparse / repeated labels (Slack channel list, Notion sidebar, anywhere lazy lists repeat the same display string).
- **Recipe generators can collapse multi-step interactions into a single step that doesn't work.** When a successful trail used a paired sequence (`paste` + `press_key("Enter")` for rich-text submission; `scroll → scroll → scroll` for lazy-load force; `click → wait → click` for animated reveal), the recipe generator will try to optimize and may emit a single step instead. The prompt must explicitly call out the patterns that **cannot** be collapsed and why (DraftJS swallows synthetic InputEvents, no `\n`-to-Enter translation, no implicit wait). This belongs in the generator prompt, not in per-app playbooks — the generator is one place, the apps are many.
- **Per-tool argument constraints belong on the recipe side too, not just the runtime side.** The runtime rejects malformed args at execution time, but by then the recipe is saved and the user thinks the failure is the runtime's fault. The generator prompt is the right place to encode "this string field cannot contain newlines", "this tool cannot be substituted for that one on this kind of element", etc. — at recipe-creation time, with the trail right there to show the contrast.

**Verification path:** Re-run "Navigate Example Community → #screenshots → find first image" end-to-end. The new trail JSON passed to Codex should include `targetElement.aria = "screenshots (text channel)"` on the channel click and `targetElement.text = "Example Community"` (or similar; servers have empty aria, so text is the right surface) on the server click. The emitted recipe should use those full strings as `cdp_find` queries and should preserve the `cdp_paste` + `cdp_press_key("Enter")` pair around the search-bar interaction. The `\n` should be gone from any `cdp_type`/`cdp_paste` text args.

### 2026-05-26 — Recipe generator fabricates pagination steps + builds from failed turns

**Symptom:** User completed a Discord task ("Navigate to Example Community → #screenshots, find the first image I ever uploaded") in chat. The assistant's final reply was *"I navigated to Example Community #screenshots, found your oldest search result with an image from Jan 24, 2026 at 1:33 PM, but the Jump button wasn't clickable before the tool session ended."* — i.e. **explicit failure**. The **⚡ Save as automation** button appeared anyway, the user clicked it, Codex returned a recipe, the user saved it, the user ran it. Run aborted at step 10 with `"ref f1 not in capture 'page4' (have: )"`. Step 9 was a `cdp_find("Page 4")` against a Discord search panel; step 10 deref'd that empty capture. (Note: this entry originally claimed the search panel "has no pagination UI" — that was wrong. Discord search results DO have numbered `div[aria-label="Page N"]` controls; the true blocker was the **hover-only Jump button**, documented in the [next lesson](#2026-05-26--discord-search-jump-button-is-css-hover-only-not-in-snapshots).) Step 11 carried a control-char-garbled query `Example User[TAG],Server Tag: TAGTAG - 1/24/2026 1:33 PMSaturday...`. The Discord window never moved to the target message.

**Root cause (four compounding factors):**

1. **`FAILURE_REGEX` in `renderer.js canAutomate()` missed the actual failure phrases the model used.** The regex covered `couldn't|can't|cannot|unable to|stopped without|aborted|didn't|...`, but the reply used **`wasn't clickable`** and **`before the tool session ended`** — neither of which matched. The "Save as automation" button stayed visible on a clearly-failed turn, and the user understandably trusted the affordance.
2. **No server-side check at `automation:create` IPC.** The renderer was the only gate. Once a renderer regression or direct IPC call gets past it, Codex spends tokens generating a recipe from a failed trail and the result lands in the user's Automations tab.
3. **Codex prompt did not forbid invented steps.** The recipe-generator instructions told Codex to "drop redundant steps" and "build minimum steps to accomplish the user's goal" — but never said *every emitted step must correspond to a tool call that actually fired in the trail*. With a failed trail that ended on a stuck-on-search-results state, Codex tried to "complete" the task by inventing a pagination click (`cdp_find("Page 4")`) and a final result click — neither of which was in the trail. *(Original wording here claimed `Page 4` "doesn't exist in Discord's search UI at all (it's a virtualized list with no pagination)." That was wrong — Discord search results do have numbered `div[aria-label="Page N"]` controls; see the [hover-Jump lesson below](#2026-05-26--discord-search-jump-button-is-css-hover-only-not-in-snapshots) for the corrected diagnosis. The true reason Codex shouldn't have emitted that step is the "trail is gospel" rule — not because the UI doesn't exist.)*
4. **Control chars leaked into the Codex prompt through `summariseResult` and `targetElement`.** `inspectCdpElements` sanitizes at source + sink for the chat path, but `summariseResult` re-slices the rendered snapshot string without re-sanitizing, and `refInfo.text` is taken from `refMapHolder.current[ref]` whose entries can carry raw U+0000–U+001F bytes from any DOM scrape path that wasn't updated. Codex emits whatever it sees, so the garbage propagates into a saved `cdp_find` `query` field — which then can never match the live DOM on replay.

Additional contributing factor: **the runtime's empty-capture error was uninformative.** `"ref f1 not in capture 'page4' (have: )"` told the user *that* the capture was empty but not *why* — no mention of the originating `cdp_find` query, no hint that the recipe targets nonexistent UI. The user had to inspect the saved JSON to understand the failure.

**Fix (five layers):**

1. **`FAILURE_REGEX` rewrite in `renderer.js` (~line 1323).** Now covers `was/were/is/are/has/have/had + n't` with `'`/`’` apostrophe variants, optional follow-on verbs (`clickable`, `working`, `loaded`, etc.), `before/until/when … (the/tool) session (ended|expired|...)`, `had to stop`, `ran out of`, `out of rounds/time/budget`, `partial(ly) (complete|done|successful)`, `never (loaded|opened|clicked|reached)`. Both apostrophe forms matter — gpt-5.5 emits curly `’` after punctuation passes. Tested against the failing reply: matches `wasn't clickable` AND `before the tool session ended`.
2. **Server-side guard in `electron-detector/main.js automation:create`.** Mirror regex `SERVER_FAILURE_REGEX` kept in sync with renderer; `automation:create` throws a clear error before any Codex call if the reply admits failure, AND if the last trail step has `result.error`. Defense in depth — also covers direct-IPC and future renderer regressions.
3. **Codex prompt: new "DO NOT INVENT STEPS" section in `buildCodexPrompt` instructions.** Every emitted step must correspond to a tool call that fired in the trail. If a trail `cdp_find` returned `result_summary.count: 0`, drop it AND any downstream step that captured from it. If the reply admits failure, output `[]` — an empty recipe surfaces "not replayable" cleanly; a fabricated recipe corrupts the user's library. New "DISCORD SEARCH RESULTS" section spells out the right tools (`cdp_get_search_results` to read rows, `cdp_jump_to_search_result` to navigate; both pagination and the `Old` sort toggle are valid recipe steps). *Correction:* the original version of this fix told Codex "Discord search has no pagination" — that was wrong (see the [hover-Jump entry below](#2026-05-26--discord-search-jump-button-is-css-hover-only-not-in-snapshots)). The prompt has since been updated to reflect that both sort toggles AND numeric pagination exist.
4. **Control-char sanitize in trail → Codex pipeline.** New `cleanCtrl` / `cleanDeep` helpers in `main.js`. `buildCodexPrompt` runs the trail JSON through `cleanDeep` before serialization; sanitizes `userMsg` and `finalReply` slices. `summariseResult` strips C0/C1 control bytes from `r.snapshot` before slicing the `matches` excerpt.
5. **Runtime error improvement in `resolveStepArgs`.** When a `$cap.fN` deref hits an empty capture, the error now names the originating `cdp_find` query (captured into `cap.query` by `executeAutomationStep`) and tells the user the recipe likely targets UI that doesn't exist in the live app state — re-record from a fresh successful turn.

**Generalization:**

- **A "save as automation" affordance is a contract with the user that the turn succeeded.** Any heuristic gating that affordance must be paranoid in both directions — false-positive rejections cost nothing (user re-asks the model), false-positive *acceptances* corrupt the user's automation library and waste Codex tokens. Failure-phrase detection must cover both apostrophe forms and follow-on verbs ("wasn't *clickable*", "didn't *load*"), and must be defended in depth (renderer + IPC handler).
- **Recipe generators must be told the trail is ground truth, not a starting point.** Without an explicit "do not invent steps" rule, the model interprets the goal in the user prompt and tries to complete it — even when the trail stopped short. The right output for a failed trail is `[]`, not a creative reconstruction. This rule generalises to every replayable-script generator: trail is gospel, prompt is context.
- **Sanitize control chars at every boundary that re-derives strings from DOM scrapes.** Source + sink sanitize for the JSON-parse path was insufficient — `summariseResult` re-slicing the rendered table is a third boundary, and `refMap[ref].text` is a fourth. The right invariant is *no string field that crosses an IPC, model, or filesystem boundary may contain C0/C1 control bytes*; bake the sanitize into every helper that touches such fields, not just the parse path.
- **Runtime errors on dead recipes should name the recipe's actual brokenness, not the generic symptom.** "Capture empty" → "the `cdp_find` query you saved doesn't match anything in this DOM" is the diff between "user understands and re-records" and "user files a bug they can't describe."

**Verification path:** Re-run the same "first image in #screenshots" task. (a) If the assistant's reply still admits failure, the **Save as automation** button must not appear, and any direct `automation:create` IPC call must reject with the failure-language error. (b) If the assistant completes the task cleanly, the saved recipe must not contain any `cdp_find("Page N")` step, must not carry any byte in `0x00-0x1F` / `0x7F-0x9F` inside `args.query`, and must end on the actual Jump-button click that moved the viewport. (c) If a re-recorded recipe references a stale capture at replay time, the runtime error must name the originating `cdp_find` query.

### 2026-05-27 — Recipe omits navigation the live UI state made unnecessary (not portable)

**Symptom:** User ran "Go to the Example Community B server and go to #test. React example-emoji-typo to the last 10 pictures." in chat. It completed cleanly, the user clicked **Save as automation**, and the recipe looked right — but it was missing the step that opens the **#test channel**. Saved recipe: `cdp_find("example-server-d")` → `cdp_click`(server) → `cdp_scroll_messages(bottom)` → `cdp_react`×10. On replay from any other channel, it reacts in whatever channel happens to be open, not #test.

**Root cause:** During the live run, #test was *already the open channel* inside Example Community B, so the assistant only had to click the server icon — clicking the channel landed it directly in #test. The trail therefore contained a `cdp_find("test")` (which located the #test channel link and the "Message #test" composer) but **no `cdp_click` on the channel**, because none was needed. The recipe generator faithfully reproduced the trail: two prompt rules — "Drop redundant tool calls / skip exploratory snapshots" and "DO NOT INVENT STEPS (every step must correspond to a tool call that fired)" — together forced it to (a) drop the unfollowed `cdp_find("test")` as exploratory and (b) refuse to add a channel-open click that never appeared in the trail. There was no rule telling the generator that **a recipe must be portable — replayable from a cold start, not only from the exact UI state the live run began in.** Replay (`automation:run` → `buildLiveSnapshot`) starts from wherever the app currently is, with no neutral reset, so the omission is fatal.

This is the inverse failure of the [fabricates-pagination lesson](#2026-05-26--recipe-generator-fabricates-pagination-steps--builds-from-failed-turns): there the generator added steps with no trail evidence (bad); here it *omitted* a navigation step whose target the trail DID locate (also bad). Both are failures of the same axis — "what counts as trail evidence for a step" — and the fix must distinguish them precisely or one rule re-breaks the other.

**Fix (all in `buildCodexPrompt`, `electron-detector/main.js`):**
1. **New "PORTABILITY — replay from a COLD START" section.** States that replay begins from whatever server/channel/view is open at run time, not the live run's starting state, so the recipe must include navigation to every destination the user's request names — *even when the trail performed no click to reach it because it was already open*. Gives the detection rule (request names the destination AND the trail has a `cdp_find`/`cdp_get_tree` that located it — a matching channel `<a>`, "Message #<channel>" composer, or server treeitem — but no click followed) and the action (emit the missing `cdp_find` → `cdp_click`, query/`.fN` built from that lookup's `result_summary.matches`/`targetElement`, placed in cold-start order). Includes the Example Community B/#test case as a worked example.
2. **Amended "Drop redundant tool calls" bullet** so a lookup that *located a destination the task must reach* is explicitly NOT a droppable exploratory snapshot.
3. **Amended the "DO NOT INVENT STEPS" first bullet** with one narrow, explicit exception: materializing navigation to a request-named destination the trail located-but-didn't-click is supported by trail evidence (the lookup), so it's materializing, not inventing. The forbidden case stays "a step targeting a control the trail NEVER located."

Also fixed the one already-saved broken recipe (`automations/discord_<app-key>/index.json`) by inserting the `cdp_find("test (text channel)") → cdp_click` channel-open step between the server open and the scroll.

**Generalization:**
- **A replayable recipe must be portable, not a literal transcript of one run.** The live run executes against a *specific* incidental starting state (a server/channel/view already open, a search already focused, a sort already flipped). A recipe replays against an *arbitrary* starting state. Any navigation the live run skipped because the destination was already there is exactly the navigation the recipe most needs — and it is invisible in the trail as an *action*, present only as a *lookup*. The generator must reconstruct intent from "request names destination X + trail located X" even when "trail clicked X" is absent.
- **"Trail is gospel" and "recipe must be portable" pull in opposite directions; resolve them on evidence type, not on whether a click fired.** A step is legitimate if the trail contains *evidence of its target's identity* (a lookup that located it), regardless of whether a click on that target fired. A step is invented if the trail contains *no evidence of the target at all*. Drawing the line at "did a click fire" (the naive reading of DO NOT INVENT STEPS) wrongly forbids required navigation; drawing it at "did the trail locate the target" admits required navigation while still excluding fabricated pagination/Jump/load-more controls the trail never saw.
- **This compounds with task complexity.** Simple tasks tolerate a missing nav step (user notices the wrong channel). Multi-destination tasks (open server A → channel B → search → open thread C) accumulate skipped navigations wherever the live run started partway through, and a recipe that assumes the live starting state fails in proportion to how much navigation the live run got "for free." Portability is a generator-side invariant, enforced once, not a per-app patch.

**Verification path:** Re-run "Go to the Example Community B server and go to #test, react to the last 10 pictures" with a DIFFERENT channel open at save time. The saved recipe must contain a `cdp_find`(#test channel) → `cdp_click` step between the server-open click and the scroll. Then switch the live app to another server/channel/friends view and run the saved automation — it must navigate Example Community B → #test before scrolling and reacting, landing the reactions in #test regardless of the pre-run state.

### 2026-05-26 — Discord search task drifts into Voice & Video settings panel

**Symptom:** User asked ChatGPT (scoped to Discord) to find their first uploaded image in `#screenshots`. The tool-pill trail showed correct navigation (Example Community server → `#screenshots` channel → channel-header search bar focused → text typed). Then the Discord window unexpectedly opened the **User Settings → Voice & Video** panel and the assistant emitted a partial-completion reply (`"results were not clearly identifying your own uploads… stop / pivoting"`). The search results panel never produced a usable result and the user's settings page was now open on top of the channel.

**Root cause (three compounding factors):**

1. **`currentUser` extraction in `buildMessagesExpr` fails during an active voice call.** The function relied on three DOM paths to read the logged-in user's name out of the bottom-left user panel: `[class*="panels_"] [class*="username_"]`, `button[aria-label^="Open user profile"]`, and `button[aria-label*="Set status"]`. When the user is in a voice call, Discord collapses the username container into a "Voice Connected" widget — none of those selectors match anymore. `cdp_get_messages` returned `{ currentUser: "", messages: [...] }`. The agent had no way to construct a `from:<user>` filter and no way to know it was the *voice-call layout* that broke the read, not the messages.
2. **Agent recovery path was exploratory clicking instead of dropping the filter.** With an empty `currentUser`, the model emitted `from: has:image in:screenshots` (literal blank), then `from:me has:image …` (invalid keyword — Discord search has no `me` shortcut), then `from:jchnny has:image …` (a guess derived from the `Manage profile and status` button label). All three returned empty result panels. Instead of falling back to a `has:image in:<channel>` query and filtering author locally, the model called `cdp_get_tree("body")` to hunt for the user's name in the full DOM dump.
3. **`cdp_get_tree("body")` returns ~500 unrelated refs — including settings/audio control buttons that look superficially relevant.** Among the 500 rows, the model picked `e19` whose label was `User Settings`. Calling `cdp_click(e19)` opened the full settings modal at the last-viewed tab (Voice & Video). One stray click in a wide DOM dump destroyed the user's task context. The same dump also exposes `Mute`, `Deafen`, `Input Options`, `Output Options`, and `Manage profile and status` — any of which would have caused similar drift.

Trace from `cdp-debug.log` (timestamps abbreviated):
- `03:33:38 cdp_paste sel="div[aria-label='Search']" text="from:me has:image in:screenshots"` ← invalid keyword
- `03:33:42 cdp_press_key Enter` → no results
- `03:34:10 cdp_get_tree region=body` ← 500-row dump
- `03:34:21 cdp_click ref=e19 sel='button[aria-label="User Settings"]'` ← misclick from dump
- `03:34:21 cdp_press_key Enter` ← Enter inside Settings panel = further drift

**Fix (four layers, all in `electron-detector/main.js`):**

1. **Robust `currentUser` extraction in `buildMessagesExpr`.** Existing username selectors run first (unchanged). Added an **avatar-src fallback chain**: search the user panel root (`section[aria-label*="User area" i]` or `[class*="panels_"]`) for any `<img src*="/avatars/<userId>/...">`, parse the Discord snowflake out of the URL with `/\/avatars\/(\d+)\//`, then look up the same userId on any visible message's `[data-author-id="<id>"]` element to recover the username text. If the avatar is rendered as a CSS `background-image` instead of an `<img>` tag (Discord's voice-call panel does this), the fallback also reads `getComputedStyle(...).backgroundImage` on any descendant whose class contains `avatar`. Returns `{ currentUser, currentUserId, messages }` — both fields populated independently, so even when the visible text is hidden the snowflake is still usable for client-side filtering of `messages[i].authorId`.
2. **`messages[i].authorId` exposed alongside `author`.** Each message scrape now picks up the `data-author-id` attribute off the message-username span. The agent file's "Reading message content" section was rewritten to prefer `authorId === currentUserId` over the text-based `author === currentUser` comparison — exact IDs always beat fuzzy text matching, and the ID-based path keeps working even when the visible display name is a server-specific nickname rather than the user's global handle.
3. **Hard tool-level guard against `cdp_get_tree("body")` / `"html"` / `"*"` / `"document"`.** `executeTool` returns `{ error: "unsafe_region", hint: ... }` for those region values before evaluating the JS. The hint names the specific footgun (user-panel buttons getting misclicked from a wide dump) and points at `cdp_find("<needle>")` as the recovery. No way to bypass — these regions were never a legitimate scope.
4. **Discord playbook (`appSpecificPlaybook("discord")`) gains two new anti-patterns and a "blank currentUser" recovery block.**
   - **Recovery block (in "Reading message content"):** if both `currentUser` and `currentUserId` are empty, do **not** click around hunting for the username — drop the `from:` filter, search `has:image in:<channel>` instead, and filter locally by `authorId` if any (else surface the failure to the user as "I can't read your Discord username — likely because you're in a voice call. Tell me your username and I'll redo the search").
   - **Anti-pattern: never call `cdp_get_tree("body")` / `cdp_get_tree("html")` etc.** Explanation calls out that the user-panel buttons (`User Settings`, `Mute`, `Deafen`, `Input Options`, `Output Options`, `Manage profile and status`) are common false-positive matches for any "settings"/"profile"/"options" search and that misclicks on them destroy the task context.
   - **Anti-pattern: never click bottom-left user-panel controls** during a search/navigation/read task. The buttons enumerated above are listed by exact `aria-label`, with the rule that they are only valid steps when the user has explicitly asked for settings or audio control.
   - **Anti-pattern: never paste a `from:` filter with a blank or guessed username.** `from:` with no value, `from:me`, `from:<current-user>`, or any name not pulled directly out of `cdp_get_messages.currentUser` is forbidden — pointed at the recovery block as the alternative.
   - The search recipe step that builds the query was updated to reference both `currentUser` and `currentUserId`, with explicit "verify non-empty before substituting" wording.

**Generalization:**

- **Read tools that derive identity from a layout-fragile DOM path need a fallback that's invariant under layout state.** Discord's user panel mutates aggressively during voice/screenshare/streaming/idle — any selector chain rooted in "user panel + class containing 'username'" will eventually find a state where the username text is unreachable. The CDN avatar URL contains a stable user ID and is present even when the visible text is hidden; reading the snowflake is the layout-invariant fallback. Apply the same pattern to any app where the agent needs a stable user identifier (Slack: avatar `src` carries the team-scoped user id; ChatGPT: account menu retains an `aria-label` even when collapsed).
- **Exploratory tree dumps are the worst kind of footgun in an agent loop.** A 500-row snapshot looks like "more information" to the model, but each new row is also a potential misclick target. When the agent has lost its bearings (empty filter result, no obvious next step), the right move is to **narrow** (e.g. `cdp_find("<exact text>")` with 1-5 hits) or **surface the failure to the user**, not to widen. Block the widest-possible scope at the tool layer so the model can't pick it even when its prompt-side guard rails fail.
- **"User panel" controls in chat clients are uniformly dangerous incidental click targets.** Discord's bottom-left has Mute, Deafen, Input/Output device dropdowns, and the Settings gear — all permanently rendered, all containing words like "User"/"Settings"/"Options" that match any naive text search. Slack has DND/Status, Teams has presence/calls, Linear has the workspace switcher. Encode an explicit "never click these unless the user asks for settings" rule in every app playbook — naming each button by its exact `aria-label`, not as a category — because category descriptions are fuzzy and the model will rationalize a click that "felt close enough."
- **Recovery rules in playbooks must be tied to specific tool outputs, not vibes.** "If you can't make a query work, ask the user" is a vibe and the model ignores it because the cost of asking feels higher than the cost of one more click. "If `cdp_get_messages` returns `currentUser: ""` AND `currentUserId: ""`, drop the `from:` filter and run `has:image in:<channel>` instead" is a rule keyed on observable tool output and the model follows it because there is no ambiguity about *when* the rule fires.

**Verification path:** Re-run the same "first image in #screenshots" task while in an active voice call. (a) `cdp_get_messages` should now return a non-empty `currentUserId` even when `currentUser` is blank; if both are blank, the assistant should surface the failure honestly rather than typing into the search bar. (b) Any `cdp_get_tree("body")` call must return `{ error: "unsafe_region" }` and the agent must pivot to `cdp_find(<needle>)`. (c) The Discord window must not show the Settings modal at the end of the turn — if it does, regression. (d) The saved automation pipeline (caveat 2026-05-25 "Recipe generator emits…") should now be able to use `authorId` for the local filter step rather than relying on text-based `from:` substitution.

### 2026-05-26 — Discord search "Jump" button is CSS hover-only, not in snapshots

**Symptom:** User asked the chat (scoped to Discord) to find the first image they had ever uploaded in `#screenshots`. Navigation worked (Example Community server → channel → channel-header search bar → `cdp_paste` "has:image in:screenshots" → `cdp_press_key("Enter")`). The Discord *visually* showed the right oldest image in the results panel. The model then made ~10 more tool calls (clicking `Page 4`, clicking inner divs of search-result row #16, clicking another row's inner div, scrolling the search panel, re-snapshotting, etc.) before hitting `MAX_ROUNDS = 40` and emitting *"I navigated to Example Community's #screenshots and found search results for your earliest uploaded images, but I stopped because Discord's search result 'Jump' control wasn't activating before the tool-call limit ended."* The user observed that the Discord viewport *did* briefly scroll to the right message (one click did navigate) but the model kept clicking afterwards and opened the image lightbox, never reporting success.

**Debug-log trail (abbreviated, real timestamps from `cdp-debug.log`):**

- `04:07:23` `cdp_get_tree { region: "[aria-label='Search Results']" }` — snapshot of the panel after pagination
- `04:07:32` `cdp_click { ref: "e166" }` → selector `div[aria-label="Page 4"]` (pagination IS present, snapshot saw it)
- `04:07:46` `cdp_click { ref: "e100" }` → `li:nth-child(16) > div:nth-child(2) > div:nth-child(1)` (inner div of a search result, NOT the Jump button)
- `04:07:56` `cdp_click { ref: "e95" }` → `div:nth-child(1) > ul:nth-child(1) > li:nth-child(16) > div:nth-child(1)` (another inner div in the same row)
- `04:08:12` `cdp_scroll { container: "[aria-label='Search Results']", direction: "down" }` — scrolled the panel further
- `04:08:31`–`04:09:19` more `cdp_click`s on `li:nth-child > div:nth-child` selectors, more `cdp_get_messages`, more `cdp_get_tree` against the search panel, etc. — none of them ever called the Jump button on a search-result row.

The model literally **never had a ref for a Jump button** in any snapshot.

**Root cause (three compounding factors):**

1. **The "Jump" button is hover-revealed via CSS.** Discord renders each search-result row with the Jump button present in the DOM but visually hidden until the row enters `:hover` state (CSS toggles `visibility`/`opacity` and `pointer-events`). `cdp_get_tree` against the search panel returns the snapshot of currently-rendered visible interactables; even when the Jump button is technically in the DOM, the snapshot filter does not surface it consistently and clicking at the JS-resolved coordinates of a `pointer-events: none` element does nothing. The model has no observable ref it can `cdp_click` to navigate to a search result.
2. **`cdp_get_tree` against `[aria-label="Search Results"]` drops the row ids.** Each result is `<li id="search-results-<msg>" role="listitem">`, and the snapshot filter explicitly excludes `role=listitem` (introduced to keep chat-log noise out of regular snapshots). So the model never sees the row ids it would need to construct any kind of message-id-based recovery — it has to navigate by clicking *something* in the row, and the only visible somethings are the message-preview text and image thumbnails. Clicking the image preview opens Discord's image lightbox; clicking the body div may do nothing or focus a sub-region; neither triggers the navigation behavior Jump performs.
3. **The previous lesson asserted "Discord search has no pagination" — which was wrong.** That assertion (introduced in [Recipe generator fabricates pagination steps + builds from failed turns](#2026-05-26--recipe-generator-fabricates-pagination-steps--builds-from-failed-turns)) was based on a half-symptom diagnosis: the model in *that* incident had emitted a fabricated `cdp_find("Page 4")` step in a *recipe*. The author assumed Discord had no pagination at all. The current debug log proves otherwise — `div[aria-label="Page N"]` controls are real and clickable. The false assertion (a) misled future debugging by sending attention away from the true cause, (b) leaked into the Codex prompt, and (c) gave the model an excuse to treat valid pagination clicks as out-of-distribution.

**Fix (six layers, in `electron-detector/main.js` + `SPEC.md`):**

1. **New tool `cdp_get_search_results(limit?)`.** Discord-specific scrape of `section[aria-label="Search Results"]` (with `[class*="searchResultsWrap_"]` fallback). Returns `{ sortMode, totalCount, pages: [{label, current}], count, results: [{id, messageId, author, authorId, time, text, images[], guildId, channelId, channelHref}] }`. Bypasses the `role=listitem` filter — the model now sees every row's id without `cdp_get_tree`. Reaction parsing is intentionally omitted: search results display reaction counts inconsistently, the channel-scoped `cdp_get_messages` is the canonical source. Implementation builds a single `Runtime.evaluate` expression (`buildSearchResultsExpr`) dispatched through the existing `cdpEvalRaw` pipeline, with source-side control-char sanitize and sink-side fallback parsing.
2. **New tool `cdp_jump_to_search_result(message_id)`.** Atomic Discord-specific hover-and-click: (a) `Runtime.evaluate` resolves `document.getElementById("search-results-" + msgId)` and returns the row's center coords, (b) CDP `Input.dispatchMouseEvent type=mouseMoved` at those coords — this is a **real native-mouse hover** that triggers Discord's CSS `:hover` rule for real (synthetic JS `MouseEvent` does not flip `:hover` in any browser), (c) PowerShell `Start-Sleep -Milliseconds 350` so the hover-revealed Jump button can paint, (d) `Runtime.evaluate` locates the now-visible button inside the row via priority chain (`button[aria-label*="Jump"]` → `[class*="jumpButton" i]` → `button` whose text is "Jump" → trailing `a[href*="/channels/"]` fallback) and returns its coords, (e) CDP `Input.dispatchMouseEvent` mouseMoved + mousePressed + mouseReleased at the Jump-button coords (same isTrusted=true path as `cdp_click`). Returns `{ok, messageId, x, y, tag, aria, text}`. The whole sequence is one PowerShell-WebSocket session so the row stays hovered between the two evaluates.
3. **Discord playbook rewrite (`appSpecificPlaybook("discord")` "Using Discord's search bar" section).** Old steps 5-7 (`cdp_get_tree("[aria-label='Search Results']")` / `cdp_find("Jump")` / `cdp_click` Jump) are replaced with the new mandatory recipe: `cdp_get_search_results(limit?)` → pick by `results[].messageId` → optionally toggle `Old` sort or `Page N` for deeper results → `cdp_jump_to_search_result(messageId)` → optional `cdp_press_key("Escape")` to close the panel. Two new explicit anti-patterns: (a) *"Do not `cdp_click` on search-result row children — the message preview opens the image lightbox, not the message; the Jump button is hover-only and you will never see it in a snapshot"*, (b) *"Do not use `cdp_get_tree` on the search-results panel — `role=listitem` rows are filtered out, you cannot reconstruct row ids"*.
4. **`buildAutoBlock` tool list and `chat:send` tool guide updated** to mention `cdp_get_search_results` and `cdp_jump_to_search_result` everywhere the search flow is described. Tool guide says explicitly: *"after submitting a query in the channel-header search bar, you MUST read results via `cdp_get_search_results` … and you MUST navigate to a chosen result via `cdp_jump_to_search_result(messageId)` — never `cdp_click` on a search-result row child."*
5. **Codex recipe-generator prompt corrected.** Removed the false assertion *"Discord's search-results panel has NO pagination"* and the rule that told Codex to drop `Page N` clicks. Replaced with: *"Discord's search panel HAS both sort toggles (`New`/`Old`/`Relevant`) AND numeric pagination (`div[aria-label="Page N"]`). Prefer flipping sort to `Old` over paginating; both are valid recipe steps."* New rule: *"Navigating to a result: use `cdp_jump_to_search_result({message_id: "<snowflake>"})` — NEVER a `cdp_click` on a search-result row child."* If the trail used the old buggy pattern, distill it into the new tool.
6. **`AUTOMATION_TOOLS_CDP` allowlist + `CDP_TOOLS` schema + `summariseResult` + `synthesiseDoneReply` + `renderer.js` tool-pill mapping** all extended for the two new tools — recipes can use them, the chat panel renders `✓ cdp_get_search_results → 25 results (Old)` style pills, and the thinking-pill fallback subtext stays informative.

**Generalization:**

- **CSS pseudo-class state (`:hover`, `:focus-within`, etc.) is reachable only by real native input events.** `el.matches(':hover')` requires that the user-agent's hit-test treat the element as currently under a real cursor. JS-synthesized `MouseEvent` does not flip `:hover`; the only way to trigger it from CDP is `Input.dispatchMouseEvent type=mouseMoved` (which IS treated as a real native input). Any control that is gated on `:hover` (Discord Jump, Notion drag-handles, GitHub reaction picker, every "hover to reveal" UI built in the last decade) is unreachable through `cdp_click` against a snapshot ref — the snapshot was taken pre-hover, the ref points to nothing visible, the click coords land on something else. The fix is always: hover at CDP layer first, then find the now-visible target, then click. Bake this into a single atomic tool per UI pattern so the model never sees the pre-hover/post-hover transition as two separate decisions.
- **Snapshot filters that suppress noise also suppress signal.** Dropping `role=listitem` from `cdp_get_tree` was correct for the chat log (without it, every Discord channel snapshot is ~80 KB of message rows). But the same filter destroys the search-results panel: its rows ARE `role=listitem` and they ARE the model's only path to row ids. The right answer is not to weaken the filter (that re-introduces the noise) but to provide a *purpose-specific* tool for any panel whose interaction model the snapshot can't represent. `cdp_get_search_results`, `cdp_get_messages`, `cdp_get_text` are all instances of this pattern: when the generic snapshot is structurally wrong for a task, write the specific scraper.
- **A failed-fix lesson is a worse failure mode than the original bug.** The "no pagination" assertion from the prior incident actively misled the *next* debugging round — the author and the model both worked from "Discord search has no pagination" as a fact for two days, and the real symptom (hover-revealed Jump button) was hidden behind the assumption that the model was making it up. When patching a lesson, the patch must (a) explicitly cross-reference the corrected lesson, (b) restate what the original claimed and why it was wrong, and (c) update every other place the false claim was carried into (Codex prompt, playbook, tool guide). Otherwise the next person to hit the bug rediscovers the original symptom and re-files the same wrong fix.
- **Atomic tools eliminate model footguns better than playbook anti-patterns.** Telling the model "do not click search-result row children" is a *negative* rule — it depends on the model recognizing that its next click is a row child. With 40 rounds available, the model will rationalize at least one "this one looks different" exception per session. Replacing the entire decision tree with one tool (`cdp_jump_to_search_result(messageId)` — model has no other verb available for navigating to a search result) removes the footgun structurally. The playbook still encodes the rule for clarity, but the tool surface is the actual enforcement.

**Verification path:** Re-run the same "first image in `#screenshots`" task. (a) Tool-pill trail should show `cdp_get_search_results → N results (New)` → optional `cdp_find("Old") → cdp_click` toggle → `cdp_get_search_results → N results (Old)` → `cdp_jump_to_search_result(<msgId>) → ok` → `cdp_press_key("Escape")` (optional) → final assistant reply. (b) No `cdp_click` against a `li:nth-child(N) > div:nth-child(M)` selector in the search panel. (c) No `cdp_click({ref: "<N>"})` whose result navigates to anything other than a Jump-target message. (d) Total rounds should be under 15 (search bar focus + paste + Enter + get-results + optional Old toggle + jump + escape + reply). (e) The Discord image lightbox should not open at any point during the turn.

### 2026-05-25 — Automation step fails with `spawn EPERM` mid-run (PowerShell child-process flake)

**Symptom:** A saved automation for "Navigate to Example Community → #screenshots → first uploaded image" ran cleanly through 8 steps (find / click / find / click / get_tree / click / paste / press_key), then step 9 — `cdp_find` — aborted with the bare error `spawn EPERM`. Steps 10-15 never executed. The same recipe run a second time often succeeded. The error appeared as a generic `Step 9 (cdp_find): spawn EPERM` row in the automation runner panel with no further detail.

**Root cause:** Every CDP and UIA tool in `electron-detector/main.js` shells out via `execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], …)`. On Windows, the child process spawn itself periodically fails with `EPERM` (also seen in the wild: `EBUSY`, `EAGAIN`, `EMFILE`, `ENFILE`, `ETXTBSY`). Causes are environmental, not logical:

- Microsoft Defender / EDR scanning `powershell.exe` (or the script content delivered via `-Command`) holds an OS-level lock on the binary for a few hundred milliseconds. A `CreateProcess` racing the scanner returns `ERROR_ACCESS_DENIED` (5), which libuv surfaces as `spawn EPERM`.
- Bursts of rapid `execFile` calls (recipes fire 1-2 PowerShells per step with no batching) push the Electron main process past a transient handle-table limit.
- Some endpoint security products (CrowdStrike, SentinelOne, Sophos, corporate Defender ASR rules) insert a kernel-mode filter that briefly denies `powershell.exe` creation under load.

The spawn never starts, so there is no stdout or stderr — only the bare error from `uv_spawn`. The error is **transient**: a single retry hundreds of milliseconds later succeeds, because by then the AV scan / handle pressure has cleared. A one-shot failure aborts the entire recipe and corrupts the user's "this automation works" mental model — the next run will often succeed, so the user can't reliably reproduce the bug for support.

**Fix:** `main.js` now wraps `execFile` with `execFileWithRetry` at module scope:

```js
const { execFile: _rawExecFile, spawn } = require('child_process');

const TRANSIENT_SPAWN_CODES = new Set(['EPERM', 'EBUSY', 'EAGAIN', 'EMFILE', 'ENFILE', 'ETXTBSY']);
const MAX_SPAWN_RETRIES = 4;
function execFile(cmd, args, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = undefined; }
  let attempt = 0;
  const tryOnce = () => _rawExecFile(cmd, args, opts || {}, (err, stdout, stderr) => {
    if (err && err.syscall === 'spawn' && TRANSIENT_SPAWN_CODES.has(err.code) && attempt < MAX_SPAWN_RETRIES) {
      attempt++;
      const delay = 80 * Math.pow(2, attempt - 1); // 80, 160, 320, 640 ms
      try { debugLog(`[execFile retry ${attempt}/${MAX_SPAWN_RETRIES}] ${cmd} ${err.code} delay=${delay}ms`); } catch {}
      setTimeout(tryOnce, delay);
      return;
    }
    if (cb) cb(err, stdout, stderr);
  });
  return tryOnce();
}
```

Key invariants:
- **Only `spawn`-stage errors are retried.** The guard `err.syscall === 'spawn'` ensures real command failures (non-zero exit, timeouts, stderr content from a process that *did* start) are passed through unchanged. A retry on those would mask logic bugs.
- **Up to 4 retries on an exponential backoff** (80, 160, 320, 640 ms — total worst case ~1.2 s before final failure). Long enough to outlast a typical AV scan window; short enough that the user perceives the step as "slow but not stuck."
- **Wraps all 14+ existing `execFile('powershell.exe', …)` call sites with zero changes at each site.** The wrapper preserves the original signature (`file, args, options, callback` with optional `options`) so `cdpEvalRaw`, `cdpPasteReal`, `cdpClickReal`, the detect script, the UIA bridges, etc. all benefit.
- Retries are logged to `cdp-debug.log` via `debugLog` so post-incident debugging can confirm whether a recipe failed due to AV retry exhaustion vs. a genuine spawn problem.

**Generalization (app-agnostic):** *Any* tool that shells out via `child_process.spawn` / `execFile` on Windows needs spawn-level retry. The bug is not specific to CDP, PowerShell, or this app — it's a Windows + AV-scanner property of `CreateProcess` under load. The pattern is:
1. Distinguish **spawn-stage failures** (`err.syscall === 'spawn'`, child never ran, no stdout) from **process-stage failures** (child ran, returned non-zero or timed out). Only retry the former.
2. Limit the transient code list to those known to be safe to retry: `EPERM`, `EBUSY`, `EAGAIN`, `EMFILE`, `ENFILE`, `ETXTBSY`. `ENOENT` (binary missing) and `EACCES` (permanent permissions) are **not** transient; retrying wastes time and hides the real problem.
3. Use exponential backoff (not constant) — the AV scan window is variable, and constant 100 ms retries spend the same number of attempts inside a 600 ms scan as outside it.
4. Log every retry. Silent retries make the "intermittent failure" feel like a Heisenbug; a logged retry is a known-good fallback.

This pattern applies to any future Windows app code: UIA shellouts (`powershell.exe -Command Get-CimInstance …`), Codex / external CLI invocations, screenshot capture (`SnippingTool.exe`, `magick.exe`), file-system polling, etc. Every shell-out is a candidate for `spawn EPERM` and should go through the same wrapper. When adding a new external-process integration, the first question is "is this routed through the retry wrapper?", not "does this work on my machine right now?"

**Alternative considered (and rejected for v1):** Replace PowerShell shellouts entirely with a native Node WebSocket client (e.g. the `ws` package) so CDP calls never spawn a child process. This eliminates the EPERM class of failure structurally rather than papering over it. Rejected because: (a) the PowerShell scripts encode non-trivial command sequencing (multi-message WS conversations for `Input.dispatchMouseEvent`) that would need full reimplementation, (b) detection / UIA flows are *inherently* PowerShell (`Get-CimInstance`, UIAutomationClient COM bridge) and can't be deshelled, so the retry wrapper is needed regardless. The native-WS migration is tracked as a future optimization, not a fix for this incident.

**Verification:** Re-run the Example Community → #screenshots recipe under conditions that previously failed (Defender real-time scan enabled, a few other Electron apps open to apply handle pressure). Each retry should appear in `cdp-debug.log` as `[execFile retry N/4] powershell.exe EPERM delay=…ms`. The recipe should complete end-to-end with no `spawn EPERM` surfaced to the automation runner. If the wrapper exhausts all 4 retries, the final error reaches the caller normally and the runner reports the same `Step N (cdp_find): spawn EPERM` row — at that point the user knows the issue is *persistent* (e.g. Defender quarantined powershell.exe), not transient.

### 2026-05-26 — `spawn EPERM` is sometimes persistent; native CDP WebSocket transport replaces PowerShell shellout

**Symptom:** After landing the `execFile` retry wrapper (previous incident), the Example Community → #screenshots automation still failed deterministically at step 5 (`cdp_find` for the search bar). Logs showed all 4 retries firing back-to-back in ~1.3 s, every retry sync-throwing `spawn EPERM`, and the final error surfacing to the automation runner identical to the original symptom. Independent 50× `powershell.exe` smoke tests from the same Node process succeeded with zero failures, ruling out a generic AV-scan throttle. The EPERM was reproducible across runs but only inside the recipe execution path.

**Root cause:** `_rawExecFile` (Node's `child_process.execFile`) can throw `spawn EPERM` in **two** distinct modes on Windows, and only one was originally retried:

1. **Async callback error** — the documented path, when `CreateProcessW` returns `ERROR_ACCESS_DENIED` after the function returns. The callback fires with `err.syscall='spawn'`, `err.code='EPERM'`. The original wrapper handled this.
2. **Synchronous throw** — libuv's `uv_spawn` returns the EPERM directly, before `_rawExecFile` returns. The error is thrown from the `_rawExecFile` call itself, never reaches the registered callback. The original wrapper's `try { _rawExecFile(...) } catch {}` was missing, so the throw escaped through the Promise executor in `cdpEvalRaw` / `cdpClickReal` / `cdpPasteReal` and bubbled straight to the automation runner.

Beyond the throw-vs-callback bug, the deeper observation is that **PowerShell spawns from inside the recipe execution path hit persistent EPERM** (4-retry budget exhausted) while bare spawns from outside the path succeed indefinitely. The likely cause is a process-level AMSI / EDR rule that flags Electron-main → powershell.exe → CDP WebSocket as a fileless-attack pattern after a few invocations. Retry doesn't recover because the rule is sticky for the process lifetime, not time-based.

**Fix (two layers):**

1. **Wrapper now catches synchronous spawn throws** (`electron-detector/main.js`):

   ```js
   const tryOnce = () => {
     let child;
     try {
       child = _rawExecFile(cmd, args, opts || {}, (err, stdout, stderr) => {
         if (err && handleErr(err)) return;
         if (cb) cb(err, stdout, stderr);
       });
     } catch (err) {
       if (handleErr(err)) return null;
       // Non-retryable synchronous throw — surface via callback to match
       // the async callback shape callers expect.
       try { debugLog(`[execFile sync-throw] ${cmd} code=${err.code} syscall=${err.syscall} msg=${(err.message||'').slice(0,160)}`); } catch {}
       if (cb) setImmediate(() => cb(err, '', ''));
       return null;
     }
     return child;
   };
   ```

   Both paths now route through the same `handleErr` retry helper. Sync throws are no longer leaked.

2. **Native Node WebSocket transport for CDP**, bypassing PowerShell entirely. Electron 35 ships Node 22 which exposes global `WebSocket`. The CDP transport doesn't need a child process at all — it's just a WebSocket conversation with `http://127.0.0.1:<port>/json` for target discovery and `ws://127.0.0.1:<port>/devtools/page/<id>` for command dispatch.

   New helpers in `main.js`:
   - `fetchCdpPageWsUrl(port)` — `http.get('/json')` to find the page target, cached for 30 s.
   - `cdpNativeWsSession(port, commands, opts?)` — open one WS, send N commands with sequential ids, collect responses by id, close. ~50 ms overhead vs ~250 ms for the PowerShell roundtrip.
   - `cdpNativeEvaluate(port, jsExpr)` — single-command convenience wrapper returning the `result.value` string.

   Rewritten functions (each preserves the original signature, falls back to the PowerShell path on native failure or when `WINDOWS_AUTOBOT_FORCE_PS=1` is set):
   - `cdpEvalRaw` — was 1 PS spawn. Now 1 native WS session. Used by `cdp_find`, `cdp_get_tree`, `cdp_get_messages`, `cdp_scroll`, `cdp_get_search_results`, anything that calls `Runtime.evaluate`.
   - `cdpClickReal` — was 1 PS spawn doing 4 WS messages (eval + 3 mouse events). Now 2 WS sessions (one for coord eval, one for the mouse-event sequence) — bundled mouse events in a single session.
   - `cdpPressKeyReal` — was 1 PS spawn. Now 1 WS session with 2 messages (keyDown + keyUp).
   - `cdpPasteReal` — was 1 PS spawn. Now 2 WS sessions (coord eval, then click + optional Ctrl+A/Delete + insertText bundled).
   - `cdpJumpSearchResultReal` — was 1 PS spawn. Now 4-5 WS sessions (eval row coords, hover path, eval Jump button coords, click Jump, optional `location.assign` fallback when Discord's modern search panel doesn't render a hover-only Jump button).

   The PowerShell paths remain as `cdpEvalRawPS` / `cdpClickRealPS` / etc. for environments where the native WebSocket isn't available, or for forced regression testing. They are unchanged from the previous incident.

**Bonus fix included with the native transport rewrite:**

- **Jump button fallback** — modern Discord search panels (`section[aria-label="Search Results"]`) no longer render a dedicated "Jump" button on hover for every search row; the row's outer `[role="button"]` wrapper handles navigation directly via React onClick delegation. `buildJumpButtonCoordsExpr` now falls back to (a) the `[role="button"]` wrapper, then (b) the `<li>` itself, when the canonical Jump button selectors fail. After clicking, `cdpJumpSearchResultReal` verifies the URL changed; if not, it reads the row's `<a href="/channels/g/c/m">` (or constructs the URL from `data-list-item-id`) and force-navigates via `location.assign()`. This eliminates the silent failure mode where the recipe reported `ok` but Discord didn't move.

**Generalization (app-agnostic, for any future app added to this repo):**

- **Don't shell out for protocol traffic when the protocol speaks WebSocket.** Native Node WebSocket avoids spawn-EPERM, AMSI scanning, shell-escape headaches, and ~200 ms per call of PowerShell startup. Reserve PowerShell shellout for things that genuinely need it: UIA COM bridge (`UIAutomationClient`), CIM (`Get-CimInstance`), or external CLIs like `codex.cmd`. Anything that the OS speaks over a socket should go native.
- **`child_process.execFile` can throw before returning a ChildProcess.** Any retry wrapper for `execFile` must catch BOTH async-callback errors AND synchronous throws. Wrap the `_rawExecFile` call in `try/catch`, not just the callback. This applies to any future shellout integration (screenshot tools, AppLocker probes, etc.).
- **AMSI / EDR throttling is sticky, not time-based.** If the parent process pattern is flagged (Electron main → powershell.exe → WebSocket → loop), retry-with-backoff cannot recover within the process lifetime. The only fixes are: (a) eliminate the spawn (native path), (b) change the spawn signature (write the script to a temp `.ps1` file + `-File` invocation, which AMSI scans differently than `-Command` inline), or (c) elevate exclusion rules in Defender. Option (a) is the only one that's portable across user environments.
- **Always verify navigation actually happened, not just that the click dispatched.** Clicking a `role="button"` div via CDP returns `ok` even when no React handler is wired. Any "jump to / open / navigate" tool should re-read state (URL, scroll position, modal presence) and fall back to direct navigation if the action didn't take. This applies to ChatGPT's archived conversations, Slack's permalinks, Linear's issues — anywhere a search-style result row leads to a target view.

**Historical local verification:** a live end-to-end harness exercised the automation runner against a generic Discord fixture and reached the target message without surfacing a spawn error. The live harness is intentionally not retained in the public tree. Portable wrapper coverage remains in `test-spawn-retry.js`; the Windows-only smoke check remains in `test-spawn-real.js`.

### 2026-05-26 — Recipe creation rejects `cdp_react`: allowlist drifted out of sync with tool surface

**Symptom:** User asked ChatGPT (scoped to Discord) to "go to Example Community B → #test, react `example-emoji-typo` to the last 10 pictures." The chat turn completed flawlessly — 20 tool calls, all `ok:true`, ending with 10 successful `cdp_react` calls and a `Done.` reply. The user then clicked **⚡ Make automation**. Codex distilled a valid recipe whose later steps were `cdp_react`. The review modal opened with steps empty (`STEPS (0)`) and a red error banner: `Error invoking remote method 'automation:create': Error: Recipe validation: step 6 disallowed tool: cdp_react`. The task worked live but could not be saved as an automation.

**Root cause:** `cdp_react` was a fully wired chat-surface tool — present in the `CDP_TOOLS` schema, the executor, `summariseResult`, the renderer tool-pill map, and **all three Codex prompt allowed-tool lists** (`buildCodexPrompt`, `buildStepEditPrompt`, and the third generator at line ~3818). So the model was explicitly told `cdp_react` was a legal recipe step and used it. But the **recipe-validation allowlist** `AUTOMATION_TOOLS_CDP` (`electron-detector/main.js` ~line 73) never had `cdp_react` added when the tool was introduced. `validateRecipe` (called from the `automation:create` IPC handler) checks each step's tool against that Set and rejected step 6. The prompt-facing allowlist (what the model is told it may emit) and the enforcement allowlist (what the validator accepts) had silently diverged. The client-side mirror `AUTO_TOOLS_CDP` in `renderer.js` (`validateRecipeClient`, used before applying a hand-edited JSON recipe) had drifted too — it was missing **both** `cdp_react` **and** `cdp_set_search_sort` (the latter present in the main-process Set since the search-tools work, item 6 of the "Jump button" incident above).

This is the second allowlist-drift incident: the search-tools fix (`cdp_get_search_results` / `cdp_set_search_sort` / `cdp_jump_to_search_result`) correctly extended `AUTOMATION_TOOLS_CDP`, but `cdp_react` — added in a separate later change — only touched the chat-surface plumbing and the prompts, not the two validation allowlists.

**Fix (`electron-detector/main.js` + `electron-detector/renderer.js`):**

1. **`AUTOMATION_TOOLS_CDP` (main.js) gains `cdp_react`.** The server-side validator now accepts the same tool the prompts advertise. This is the load-bearing fix — it is the gate that threw the error.
2. **`AUTO_TOOLS_CDP` (renderer.js, client mirror) gains `cdp_react` AND `cdp_set_search_sort`.** Re-syncs the client mirror to the server Set so a hand-edited JSON recipe using either tool is not falsely rejected by `validateRecipeClient` before it ever reaches the main process.
3. **`humanizeStep` (renderer.js) gains a `cdp_react` case** → renders `React with :<emoji>:` (or `React to that message`) instead of the generic `Run cdp_react` fallback, so the plain-English step view a non-coder reads is meaningful.

`cdp_react` step args are `{message_id, emoji}` — both literal strings, no `$capture.fN` ref, so they need no substitution-rule changes; `validateRecipe`'s args-is-object / capture-is-string checks already pass. Note the semantic limit (not a bug, inherent to recording an action): a saved react recipe replays against the **exact message ids** that were reacted to during recording, not whatever the "last 10" are at replay time. Re-reacting the same messages is idempotent on Discord, so replay is safe; it just won't track new messages.

**Generalization:**

- **A tool's "allowed to be emitted" list and its "allowed to be validated" list are two different allowlists, and adding a tool must touch both.** The chat surface (`CDP_TOOLS` schema + executor + prompt lists) governs what the model may *do live*; the automation allowlists (`AUTOMATION_TOOLS_CDP` in main.js, `AUTO_TOOLS_CDP` in renderer.js) govern what may be *saved and replayed*. They are easy to desync because adding a chat tool feels complete once the live path works — the recipe path is exercised only when a user clicks "Make automation" on a turn that happened to use the new tool. The failure is invisible until exactly that combination occurs, often days later.
- **Maintain one canonical list of automatable CDP tools and derive the others from it.** The durable fix for repeat drift is to define the CDP automation tool set once (e.g. export `AUTOMATION_TOOLS_CDP` and build the Codex prompt's tool-list string by joining it, and have the renderer import the same constant) so adding a tool in one place propagates to the validator, the prompt, and the client mirror simultaneously. Until that refactor lands, the checklist for adding any CDP tool is: schema + executor + `summariseResult` + renderer pill map + **`AUTOMATION_TOOLS_CDP`** + **`AUTO_TOOLS_CDP`** + **all three Codex prompt tool lists** + `humanizeStep` case.
- **Test the recipe round-trip, not just the live turn.** The live turn passing tells you nothing about whether the same trail survives `automation:create`. Any new replayable tool needs a test that records a trail using it and runs it through `validateRecipe` / `validateRecipeClient`.

**Verification path:** Re-run "go to Example Community B → #test, react `example-emoji-typo` to the last N pictures" in the Discord chat panel, then click **⚡ Make automation**. (a) The review modal must populate with the real steps (not `STEPS (0)`) and show no red `disallowed tool: cdp_react` banner. (b) The `cdp_react` steps must render in plain English as `React with :example-emoji-typo:`. (c) Open the technical (JSON) view, leave it unchanged, click **Apply JSON changes** — `validateRecipeClient` must accept it. (d) Save, then run the automation: the `cdp_react` steps replay against the recorded message ids. (e) Construct a JSON recipe by hand containing a `cdp_set_search_sort` step and Apply it — must also pass the client mirror.

### 2026-05-27 — Saved react recipe bakes in the user's approximate emoji name instead of the resolved one

**Symptom:** User asked ChatGPT (scoped to Discord) to "go to Example Community B → #test, react `example-emoji-typo` to the last 10 pictures." The real custom emoji is `example-emoji` (tilde, not hyphen). The live turn worked perfectly: each `cdp_react` call sent `emoji: "example-emoji-typo"`, the runtime fuzzy-matched it to the real emoji, and the result came back `{"emoji":"example-emoji-typo","picked":"example-emoji","added":true}`. But the recipe Codex distilled from that turn hard-coded `emoji: "example-emoji-typo"` in every `cdp_react` step — the same approximate name the user typed. The saved script therefore re-runs the exact same fuzzy-match dance every replay (search `example-emoji-typo`, then silently correct to `example-emoji`) instead of just targeting the real emoji directly. Brittle: if Discord's fuzzy matcher ever resolves `example-emoji-typo` to a *different* emoji (e.g. a new `example-emoji-variant` is added), the replay reacts with the wrong one.

**Root cause (two layers):** (1) `summariseResult` (`electron-detector/main.js`) had no `cdp_react` branch — a react result fell through to the generic `if (r.ok !== undefined) return { ok: r.ok }`, dropping the `picked` field. So the recipe-generation prompt's per-step `result_summary` only ever showed `{ ok: true }`; the model never saw that the applied emoji (`example-emoji`) differed from the requested one (`example-emoji-typo`). (2) Even if it had, `buildCodexPrompt` gave no instruction to prefer the applied name — its default behavior is to copy the trail step's `args` verbatim, so it copied the user's typo into the saved recipe.

**Fix (both in `electron-detector/main.js`):**

1. **`summariseResult` gains a `cdp_react` branch** (keyed on `r.picked !== undefined`, before the generic `r.ok` branch) → returns `{ ok, emoji, picked, added }`. Now the recipe prompt's trail shows the model both the requested name and the one Discord actually applied.
2. **`buildCodexPrompt` OTHER RULES gains a `cdp_react` rule:** set the `emoji` arg to `result_summary.picked` (the applied emoji), not the requested `emoji`; when they differ, `picked` is authoritative because the requested name was a typo for it. Mirrored into the prose rules summary in the "Recipe-generation prompt" section above.

This is scoped to the trail-distillation path (saving a completed turn as an automation). The manual step edit/add prompts (`buildStepEditPrompt` / `buildStepAddPrompt`) are *not* changed: they author steps from a user's plain-English instruction with no live lookup, so no `picked` value exists to resolve against — a hand-authored react step still relies on the runtime fuzzy-match, which is correct for that path.

**Generalization:**

- **When a tool's runtime resolves an approximate input to a canonical value, the recipe generator must record the canonical value, not the input.** The trail's `args` are what the model *asked for*; the result's resolved field (`picked` here) is what *actually happened*. A replayable script must encode reality, not intent — otherwise every replay re-derives the resolution and inherits its ambiguity. Any future tool that fuzzy-matches / normalizes / auto-corrects an argument (emoji names, @-mention handles, channel names, fuzzy search) needs (a) the resolved value surfaced in `summariseResult` and (b) a `buildCodexPrompt` rule pinning the recipe to the resolved value.
- **`summariseResult` is load-bearing for recipe quality, not just a log nicety.** It is the *only* view of each tool's result the recipe generator gets. Any result field the generator needs to make a correct step (the chosen `.fN` row, the applied emoji, a resolved id) must be in the summary; a field dropped here is invisible to the model no matter how good the prompt is.

**Verification path:** Re-run "react `example-emoji-typo` to the last N pictures" where the real emoji is `example-emoji`, then click **⚡ Make automation**. (a) The saved recipe's `cdp_react` steps must carry `"emoji": "example-emoji"` (the applied name), not `"example-emoji-typo"`. (b) The plain-English step view should read `React with :example-emoji:`. (c) Disable/break the runtime fuzzy-match and replay — the recipe must still react correctly because it targets the exact emoji name. (d) A hand-authored react step (via the step-add editor) typed as "react example-emoji-typo" may still carry the approximate name — that path has no resolved value and correctly defers to the runtime matcher.

### 2026-05-27 — Automation click on an off-screen server silently no-ops (scroll-into-view not settled before click)

**Symptom:** A saved automation ("Go to Example Community B → #test, react example-emoji to the last 10 pics") failed on replay at step 4 (`cdp_click $channel.f1`) with `capture "channel" is empty (query="test (text channel)") — the prior cdp_find matched 0 elements even after retrying for several seconds`. The error pointed at the **channel** lookup, but the real failure was one step earlier: step 2's `cdp_click` on the **Example Community B server** silently did not switch servers, so the channel list never showed `#test` and step 3's `cdp_find` correctly found nothing. The same click had worked perfectly in the live chat turn the recipe was distilled from.

**Root cause:** `cdpClickReal` (the native CDP click path, and its PowerShell fallback `buildCdpClickScript`) computed the click coordinates and dispatched the native mouse events **with no settle in between**. Its coords JS did `scrollIntoView(...)` and read `getBoundingClientRect()` in a *single* `Runtime.evaluate`, then a *separate* WS round-trip fired `Input.dispatchMouseEvent` at those coords. For a target that was already on-screen this is fine. But "Example Community B" is the **last** icon in a long server rail (verified by live probe: rail is *not* virtualized — all 41 servers are always in the DOM — `scrollHeight 2021` vs `clientHeight 963`, Example Community B at `top 1893` when the rail is scrolled to the top). On a cold-start replay the rail starts scrolled away from Example Community B, so the click target was off-screen; `scrollIntoView` scrolled it into view but Discord's scroller re-renders/settles **asynchronously**, and the native click landed on a stale position before the scroller finished — hitting the rail gutter, not the icon. The live chat turn never hit this because the rail happened to be *already* scrolled to Example Community B (the human had it open), so no scroll-then-click race occurred. This is the same class as the `isTrusted` and "scroll reported done but viewport never moved" incidents: **the action returned `ok:true` but did not take effect, and nothing read back the post-state.**

Two compounding details found while fixing:
- With `scrollIntoView({block:'nearest'})` (the alignment the 2026-05-25 "Click pre-scroll shifts viewport" incident standardized on), an off-screen rail item is parked **flush against the scroller's clipped bottom edge** (center `y≈975`, viewport `1045`). A live `elementFromPoint` at that center returned a `DIV` with **no** `data-list-item-id` — the scroller padding/fade overlay, not the server — so even *with* a settle the click would miss. `block:'center'` puts the item at `y≈855`, where `elementFromPoint` resolves to the server icon and the click registers.
- `inline:'center'` must **not** be reintroduced — it is what caused the horizontal layout shift in the 2026-05-25 incident. Only the **vertical** axis needed escalating.

**Fix (both live click paths in `electron-detector/main.js`; `buildCdpActionExpr('click')` is dead code — only `type`/`getText` are reachable — so it was left as-is):**

1. **Extracted a shared `buildClickCoordsExpr(selector)`** (replacing the duplicated coords JS in `cdpClickReal` and `buildCdpClickScript`). It walks up to the clickable ancestor as before, but now: if the target is **not fully inside the viewport**, it scrolls with `{block:'center', inline:'nearest'}` and returns `scrolled:true`; if already fully visible it returns `scrolled:false` (fast path, no extra delay). `inline:'nearest'` preserves the horizontal-shift fix; `block:'center'` keeps off-screen targets clear of the clipped edges where the click misses.
2. **Settle + re-read before clicking.** When the first coords read reports `scrolled:true`, both paths now wait `CLICK_SETTLE_MS` (350 ms — empirically the smallest delay that reliably let Discord's rail finish settling) and **re-read fresh coordinates** before dispatching the mouse events. The native path does a second `Runtime.evaluate`; the PS path does a second `id=5` eval after `Start-Sleep`. The second read finds the target already in view (`scrolled:false`) and returns its settled position.

The saved recipe itself is **correct and did not need re-recording** — `cdp_find("example-server-d")` always finds the server (rail isn't virtualized) and `cdp_find("test (text channel)")` finds `#test` once the server is open. Only the click *execution* was broken; the fix is purely in the click path, so existing automations replay correctly after restarting the Electron app.

**Verified (live CDP, port 9222):** From a genuine cold start (switch to a different server, scroll the rail to top so Example Community B sits at `top 1893`), the new flow: read#1 → `scrolled:true` (centers it, rail → `scrollTop 1058`, Example Community B → `top 835`); settle 350 ms; read#2 → `scrolled:false`, `(36,855)`; `elementFromPoint(36,855)` = `guildsnav___<id>` (Example Community B); click → server switches (`#test` and the Example Community B channel list now in the DOM). The pre-fix sequence (no settle) left the view in DMs / the previous server. `block:'nearest'` + settle was also tested and still missed (center hit-tested to a `dataId:null` DIV), confirming `block:'center'` is load-bearing.

**Generalization:** Any click path that may scroll its target into view must treat **scroll and click as two phases separated by a settle**, then **re-measure** — coordinates read in the same tick as a programmatic scroll are stale against an async-rendering scroller (Discord/Slack/Electron virtual lists). And `scrollIntoView` alignment is part of hit-testing correctness, not just aesthetics: `block:'nearest'` parks off-screen items against a clipped edge whose center can hit-test to an overlay rather than the element — escalate the **off-axis** of the scroll (here vertical → `block:'center'`) while leaving the in-view axis at `'nearest'` to avoid the layout-shift regression. As with `isTrusted` and the scroll-to-message incident: a tool returning `ok:true` is not evidence the action took effect; for navigation, the only proof is reading back the post-state (here: the destination's children appearing in the DOM).

### 2026-05-27 — Saved recipe bakes in session-scoped message ids (reacts to last week's posts on replay)

**Symptom:** The "react `example-emoji` to the last 10 pictures" automation distilled into ten `cdp_react` steps each carrying a **literal Discord message id** (`chat-messages-<id>-<id>`, …) captured during recording. A `cdp_get_messages` step preceded them in the live turn, but the recipe dropped it and froze the ten snowflakes. On replay this reacts to *those exact ten posts* — the ones loaded the day it was recorded — not "the last 10 pictures *now*". When newer images are posted the script reacts to stale messages; if those messages have scrolled out of the virtualized DOM, each `cdp_react` fails `message_not_found`. The sibling Example Community search recipes showed the same disease's other face: `cdp_jump_to_search_result` got a placeholder `"message_id":"0"` (the model had no live value to reference and invented one), which resolves to `search-results-0` → `row_not_found`.

**Root cause:** the recipe layer had **no way to reference a message dynamically**. Captures only stored element ref-maps (`fN`/`eN` from `cdp_find`/`cdp_get_tree`); there was no capture for `cdp_get_messages`/`cdp_get_search_results` and no selector grammar to pick "the last N pictures" at replay. So the generator's only option for a message target was to copy the trail's snowflake (react case) or fabricate one (search case). `buildCodexPrompt` also had no rule forbidding baked ids, and `validateRecipe` had no guard to reject them — so a stale-by-construction recipe saved cleanly. Same class as the emoji-`picked` incident directly above: **a replayable script must encode a re-resolvable reference to live state, not a value that was only valid during recording.**

**Fix (all in `electron-detector/main.js`, plus the client mirror in `renderer.js`):**

1. **Item captures.** `executeAutomationStep` now captures `cdp_get_messages` as `{kind:'messages', idField:'id', items, currentUserId}` and `cdp_get_search_results` as `{kind:'search', idField:'messageId', items}` — the live list, stored for the references below to resolve against.
2. **Dynamic single-item refs.** `resolveStepArgs` resolves a `"$<capture>.<selector>"` string in `message_id` against an item capture at replay: `.last`/`.first` (newest/oldest), `.images.last`/`.images.first` (has a picture), `.mine.last` (logged-in user's), or a bare index `.0`. Element refs (`$cap.fN`) keep working unchanged.
   - **Computed aggregation grammar (generalized 2026-05).** The per-task `most_poster` selector — a canned token the distillation prompt handed the model, with a hardcoded special-case branch in `resolveItemRef` — was generalized into a small composable aggregation language the model assembles itself (*teach the language, not the sentence*): `$<cap>.max(<field>)` / `$<cap>.min(<field>)` are argmax/argmin over a numeric field (return the winning item's id); `$<cap>.argmax(count, group=<field>)` / `$<cap>.argmin(count, group=<field>)` group items by `<field>`, tally counts, and return the winning group's display **value as a string** (e.g. `group=author` → the top poster's display name, for `cdp_find`'s `query`). Captured message fields are `author`/`authorId`/`time`/`reactionTotal`; synonyms (`reactions`→`reactionTotal`, `poster`/`sender`→`author`) map onto them. `resolveItemRef` parses these via `canonAggField` + `aggGroupWinner` before the legacy dot-split path. The named tokens (`most_poster`/`most_reactions`/`least_reactions`/…) are kept as backward-compat fallbacks so already-saved scripts still replay; the distillation prompt no longer teaches the canned `most_poster` recipe, only the general grammar + the available fields.
3. **`forEach` batch step.** A step may carry `forEach:{from, where?:images|mine|all, order?:last|first, take?:N}` and omit `message_id`; the runner resolves it to N live ids and runs the inner tool once per id (with per-iteration `n of N done…` progress). One saved step, re-resolved every replay — replaces the N frozen steps.
4. **Generator rules.** A new load-bearing `MESSAGE_REF_RULES` block (shared by the generate / edit / add prompts) forbids copying any message id, documents the selector + `forEach` grammar, and maps user wording (last/first/pictures/mine/"last N") to it. `summariseResult` now surfaces each message's image count so the model can choose `where:"images"`.
5. **Save-time guard (prevents recurrence).** `validateRecipe` (and the `renderer.js` `validateRecipeClient` mirror) reject any `cdp_react`/`cdp_scroll_to_message`/`cdp_jump_to_search_result` whose `message_id` is a raw 17+ digit snowflake (not a `$ref`, not a small index), with an error telling the author to capture a list and use a `$ref`/`forEach`. A baked-id recipe can no longer be saved.

The existing "last 10 pictures" automation (`automations/discord_<app-key>/index.json`) was rewritten to the id-free form: nav → `cdp_scroll_messages(bottom)` → `cdp_get_messages` `"capture":"msgs"` → one `cdp_react` with `forEach:{from:"msgs",where:"images",order:"last",take:10}`.

**Generalization:** **A recipe must never store an id that names a specific instance of live, changing state** — message/search snowflakes, row ids, ephemeral handles. Store instead a *re-resolvable reference*: capture the list the live turn read, and select from it at replay by a stable predicate (newest/oldest, has-image, authored-by-me, index). Two enforcement layers are required, not one: the generator prompt teaches the right shape, and a structural validator rejects the wrong shape at save time so a prompt regression (or a hand JSON edit) can't silently persist a stale recipe. This pairs with the emoji-`picked` lesson: that one says *record the resolved value when the runtime normalizes an input*; this one says *record a resolver, not a snapshot, when the target is a moving row of live data*.

**Verification path:** Re-run "react X to the last N pictures" in the Discord-scoped chat, then **⚡ Make automation**. (a) The saved recipe has a `cdp_get_messages` step with a `capture` and a single `cdp_react` step carrying `forEach` — zero literal snowflakes. (b) Post a new image, replay: it reacts to the *current* newest N pictures, not the originals. (c) Hand-edit a step's `message_id` to a snowflake in the JSON view → save is rejected with the "hard-coded Discord message id" error. (d) "scroll to / jump to my latest image" saves as a `$msgs.images.last` (or `$hits.first`) ref, not a baked id.

### 2026-05-28 — Browser-scoped chat sees only ONE window; can't register a user's other Chrome profiles

**Symptom:** With two Chrome windows open on two different profiles ("Profile A" / "Profile B"), the chrome-scoped chat reported a single window. Asked "what windows can you see?", the model answered *"I can see only the scoped Chrome window … I can't see or enumerate your other open windows from here."* (verbatim from `logs/chrome_<app-key>_<timestamp>.log`). The user wanted autobot to register **all** currently-open Chrome windows.

**Root cause — two independent gaps:**
1. **Single-target binding.** Every native CDP tool routes through `cdpNativeWsSession(port,…)` → `fetchCdpPageWsUrl(port)`, which picked `arr.find(p => p.type==='page') || arr[0]` from `/json` and cached it per-port. So all snapshots/clicks bound to **one** page target; the model had no tool to even *enumerate* the others, let alone act on them. `/json` already lists every window/tab on the port — the data was there, nothing surfaced it.
2. **Single-profile launch.** `buildSingleAppCdpScript` seeds a dedicated automation `--user-data-dir` (Chromium 136+ refuses the debug port on the default dir) and launched exactly **one** window against it — the last-active profile. The seed copies the user's *entire* User Data (all profiles + `Local State`), but only one profile window ever opened, so `/json` had one page target regardless.

**Fix (all `electron-detector/main.js`):**
1. **`fetchCdpPageWsUrl` is now active-target-aware.** New per-port `CDP_ACTIVE_TARGET` map; when set, it resolves the WS URL of *that* target (falling back to first-page + clearing the id if the window closed). Cache entry carries `targetId` so a selection invalidates it. Added `fetchCdpTargets` (raw `/json`) and `listCdpPageTargets` (page targets + `active` flag).
2. **Two new tools** `cdp_list_windows` (enumerate all page targets) and `cdp_select_window(index|id)` (bind subsequent tools to one). Added to `CDP_TOOLS`, the executor, the `AUTOMATION_TOOLS_CDP` recipe allowlist, and the generated agent-file tool list.
3. **Multi-profile launch.** The browser branch of `buildSingleAppCdpScript` now reads the seed's `Local State` `profile.info_cache`, then launches a window per profile: the first carries `--remote-debugging-port` + `--user-data-dir`, each subsequent `--profile-directory` launch against the same `--user-data-dir` is caught by Chrome's singleton and opens another window in the **same** browser process — so `/json` on the one debug port lists a page target per profile window.

**Verification:** Manually joined the second profile to the running automation Chrome (`chrome --user-data-dir=<seed> --profile-directory="Profile 1"` → *"Opening in existing browser session"*); `/json` on `:9223` went 1 → 2 page targets. A standalone harness exercising the exact list/select/resolve functions against the live port confirmed: `cdp_list_windows` returns both windows; `cdp_select_window(0)` and `(1)` bind to **distinct** `webSocketDebuggerUrl`s and flip the `active` flag correctly. App restarted to load the new code.

**Generalization:** "What can you see?" is a function of what the tool surface *enumerates*, not what one cached handle happens to point at. When a transport exposes a list (CDP `/json`, window handles, tabs), give the model an explicit *list* + *select* pair rather than silently binding to element `[0]` — and make the resolver honor the selection at the single chokepoint every tool already funnels through, so snapshot/click/type/scroll all follow for free.

**2026-05-31 update — watcher must be re-asserted on every Autobot startup.** Closing and reopening Chrome (taskbar / shortcut) after a previous select-in-Autobot session left the new Chrome **without** `--remote-debugging-port`. Root cause: the resident `-Watch` powershell was only started by (a) the logon scheduled task and (b) `enable-cdp-app` IPC. The logon task fires once at user login; an Autobot session started later (or after the watcher was killed mid-session) had no live watcher, so a user-launched Chrome was never consolidated into the sandbox profile. `cdp-state.json` still said `enabled: true` and listed Chrome on port 9224 — Autobot trusted the state, the watcher just wasn't there to act. Fix (`electron-detector/main.js` `app.whenReady`): after `startInjectWatcher()`, load `cdp-state.json` and call `ensureWatcherRunning()` whenever the state is `enabled` and lists at least one tracked app. `ensureWatcherRunning` already no-ops when a watcher proc exists (and the watcher itself single-instance-guards via the `Global\ElectronCdpWatcher` mutex), so re-asserting on every startup is cheap. Verified: with watcher running, killing all Chrome and launching plain `chrome.exe` → within ~15s the watcher's `Invoke-BrowserConsolidate` killed the default-profile main and relaunched on `--remote-debugging-port=9224 --user-data-dir=<seed>`.

**2026-05-31 update — revert to single-profile launch.** The fan-out caused a stray Chrome window in a non-active profile on every select-Chrome-in-Autobot (Profile A / Profile B both opened, with one carrying the user's foreground state and the other not). The user reported it as "restarts chrome with the flag like it's supposed to, but then it also opens up another chrome window in a completely different profile." `buildSingleAppCdpScript` (browser branch in `main.js`) now launches **exactly one** window. Resolution order for the profile dir: (1) `--profile-directory=...` captured from a live browser child cmdline BEFORE the kill — the user's currently-active profile, (2) seed `Local State.profile.last_used`, (3) `"Default"`. Multi-profile coverage now happens by user action: each additional Chrome window the user opens (taskbar / link) is consolidated into the same sandbox process by the watcher's `Invoke-BrowserConsolidate` (already implemented) and shows up on `/json`. The new tool surface (`cdp_list_windows` / `cdp_select_window`) still works against however many windows exist.

**2026-05-31 update — eliminate the default-profile flash on user Chrome relaunch (shortcut redirect).** Even with the watcher consolidating default-profile launches, the user still saw "one normal Chrome window, then a restart with the CDP flag" because the watcher path is *reactive*: chrome.exe paints its default window within ~300-800ms, then the WMI `WITHIN 3` indication + 3s sweep fires, kills the default tree, and relaunches in the sandbox. The visible flash is the entire window between Chrome's first paint and the watcher's kill. Reducing the WMI cadence cannot close it (Chrome paints faster than the kill can land); the fix has to make the *first* launch already be a sandbox launch.

Mechanism: rewrite the Arguments on every Chrome `.lnk` in user-writable launch surfaces — taskbar pin (`%APPDATA%\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar`), Quick Launch, user Desktop, public Desktop, user Start Menu (the machine-wide ProgramData Start Menu is read-only without admin and is silently skipped). Each shortcut still targets the same `chrome.exe`; only Arguments is prepended with `--user-data-dir="<seed>" --remote-debugging-port=<port> --no-first-run --no-default-browser-check`. Chromium's per-profile singleton routes the launch into the live sandbox process (new window on the same debug port) when one is running, or cold-starts the sandbox WITH the debug port already open when none is — either way the user never sees a default-profile window. Originals (target + args) are saved to `cdp-shortcut-backup.json` so disable cleanly restores the user's pre-existing shortcut state.

Implementation lives in `Start-ElectronDebug.ps1`:
* `Set-BrowserShortcutRedirect -ExePath <exe> -Port <port>` and `Remove-BrowserShortcutRedirect -ExePath <exe>` — the actual `.lnk` mutators (WScript.Shell COM).
* Called from `Start-AppWithCdp` (after `Set-BrowserLinkRedirect`), `Start-AppNormally` (after `Remove-BrowserLinkRedirect`), the `-Enable` reassert loop, the `-Disable` cleanup loop, and `Invoke-Sweep` inside the watcher (re-asserts every 3s with the live port pulled from `cdp-state.json`, so reflag-induced port changes don't strand stale arguments in the shortcut).
* `-ApplyBrowserShortcuts -ForExe <exe> [-ForPort <port>]` and `-CleanupBrowserShortcuts -ForExe <exe>` — external entry points for `main.js` to invoke out of band of `Start-AppWithCdp`/`Start-AppNormally`. `main.js`' `enable-cdp-app` calls Apply after `ensureWatcherRunning()` (so the rewrite catches the port the just-launched sandbox actually got); `disable-cdp-app` calls Cleanup before `stopWatcher()`.

Sidecar serialization caveat: PS 5.1's `ConvertTo-Json` is unreliable for top-level arrays (`,$Backups | ConvertTo-Json` produces `{value:[…],Count:N}` instead of `[…]`). `Save-ShortcutBackups` builds the JSON array by hand — one `ConvertTo-Json` per element joined with brackets — so 0/1/N-element runs all serialize as a clean array that `Get-ShortcutBackups` can read back.

Verified (Chrome cold-start via the modified taskbar `.lnk` after killing all Chrome): 1 main `chrome.exe`, command line carries both `--user-data-dir=<seed>` and `--remote-debugging-port=9224`, port 9224 listening, `/json/version` returns the live Browser/protocolVersion. No default-profile process is ever spawned. Cleanup round-trip restores `.lnk` Args to the original empty string. Non-shortcut launches (Run dialog, cmd `chrome.exe`, other apps spawning chrome) still fall through to the watcher consolidation path (acceptable degradation — they were already a flash before).

### 2026-05-28 — Windows opened in the user's DEFAULT Chrome profile are invisible (separate, un-debuggable process)

**Symptom:** The chrome-scoped window picker showed only the windows autobot launched (e.g. *Dashboard* + *New Tab*), but a window the user had open with the *same* bookmarks/logins (example.com + another tab) never appeared, no matter how many times they hit refresh. The user reported it as "another window using the same chrome profile" that isn't detected.

**Root cause:** Autobot drives a *dedicated copy* profile — `%LOCALAPPDATA%\WindowsAutobot\cdp-profiles\chrome`, seeded once from the user's real User Data — because **Chromium 136+ refuses `--remote-debugging-port` on the default profile dir** (re-confirmed on Chrome 148: a debug port launched against the default dir never opens; `/json/version` connection-refused). When the user launches Chrome the normal way (taskbar, link click), it targets the **default** profile, which Chrome's per-profile singleton runs as a **separate process with no debug port**. That process — and every window in it — is structurally invisible to autobot: it isn't on `:9223`'s `/json`, and even the browser-level `Target.getTargets` over `:9223` can't see another process. Two profiles seeded from the same source look identical (same bookmarks/logins), which is why the user called it "the same profile." The `-Watch` task that was *supposed* to consolidate these launches was broken: it never fired on the reproduced launch, and its `Invoke-Reflag` killed **by exe path** (which would kill autobot's own controlled Chrome — same exe) and **discarded the launch URL**.

**Fix (all `Start-ElectronDebug.ps1`, watcher path):** Non-destructive *consolidation*. The verified mechanic: launching `chrome.exe --user-data-dir=<seed> <url>` while the sandbox process is already running is caught by the singleton and **opens the URL as a new window in that running debug process** — so it lands on `:9223` and is immediately enumerable (proven repeatedly: example sites each appeared on `:9223` within ~3-9s, no second process). Implementation: `Invoke-BrowserConsolidate` splits browser procs into sandbox (cmdline matches the seed path — *ours*, never touched) vs default (anything else), kills **only** the default-profile tree, then forwards the recovered URL(s) into the sandbox with `--new-window` (one window per URL so rapid launches don't collapse to tabs). `Test-NeedsReflag` skips any seed-path process; a 3s periodic **sweep** (`Invoke-Sweep`, `Wait-Event -Timeout 3`) backstops the WMI `WITHIN 3` indications, which miss short-lived forwarder launchers and windows opened inside an already-running browser. The logon task was also re-pointed at the hidden `wscript`+`cdp-watch-launch.vbs` launcher (it was still registered to run `powershell.exe` directly, which pops a console window that never closes since the watcher loops forever).

**Known limitation:** a URL is only recoverable if it lives in a process command line. The *first* window the user opens does (its launch created the default main) → the common single-window case is fully preserved. But once a default process is live, further windows/tabs **forward into it and their launchers exit**, so their URLs are in no command line and unreadable (no debug port on the default profile — the whole reason for the sandbox). Those extra URLs are lost when consolidated. In steady state the watcher consolidates each launch within ~3s, so a fresh default main with its URL intact is the norm; only rapid-fire multi-launches before the first consolidation degrade.

**Generalization:** when an OS singleton splits a resource across processes and only *one* can be instrumented, don't try to attach to the others — **funnel them into the instrumented one**. The same launch command that starts the controlled instance, re-run, is the consolidation primitive. Scope any destructive step (here, the kill) by the discriminator that identifies "ours" (the seed `--user-data-dir`), never by the shared exe path.

### 2026-05-29 — Automation aborts on `cdp_scroll: scroll_container_not_found` (collapsed timing on a freshly-navigated page)

**Symptom:** The "Open a dashboard and scroll to its summary" Chrome automation failed on replay at **step 9** with `cdp_scroll: scroll_container_not_found` (`automations/chrome_<app-key>/index.json`; step 9 is `cdp_scroll {direction:"bottom", pages:3, container:"html"}` on the web dashboard page). The exact same scroll succeeded in the live chat the recipe was distilled from (`logs/chrome_<app-key>_<timestamp>.log`, action 22: `container:"html"` → `ok, scrollHeightBefore 7173, atBottom:true`).

**Root cause:** recipe replay fires steps back-to-back; the live chat did not. In the live turn the model only scrolled at action 21–22, **after ~9 intervening `cdp_find`/`cdp_get_tree`/`cdp_get_text` calls** that followed the click opening the target page — by then the target DOM had mounted and `<html>` was genuinely scrollable (`scrollHeight 7173 > clientHeight 911`). The distilled recipe collapsed all those probes away, so step 9's `cdp_scroll` ran **immediately** after step 8's `cdp_click` (open the target page), before the target content mounted. At that instant `<html>` had `scrollHeight ≤ clientHeight + 10`, so `findScroller()` in `buildScrollExpr` (which requires real overflow) returned null → `scroll_container_not_found`. That error was **not** in `TRANSIENT_STEP_ERRORS`, so `executeAutomationStep` did not retry it — the step failed on first attempt and aborted the whole run. Same class as the off-screen-server-click and scroll-to-message incidents: **the recipe is correct, but replay races a UI that the live turn never had to wait for, because the human/model latency that masked the race was distilled out.**

**Fix (`electron-detector/main.js`, two parts):**

1. **Retry the load race.** Added `scroll_container_not_found` and `scroller_not_found` to `TRANSIENT_STEP_ERRORS` so `executeAutomationStep` backs off and retries (the existing `STEP_RETRY_DELAYS_MS` ladder, ~7s total) while a freshly-navigated page mounts its scrollable content — exactly like `ref_not_found` / `parse_failed`.
2. **A generic scroll over nothing is non-fatal.** If a `cdp_scroll` step *still* returns `scroll_container_not_found` after retries, the run loop now logs it, emits `{ok:true, skipped:true}`, and **continues** instead of aborting. Rationale: a generic page scroll is a *means* to reveal/load content, not a goal — a page whose content already fits the viewport has nothing to scroll, which is a benign state, not a failure. **`cdp_scroll_messages` stays fatal** for `scroller_not_found` (a missing Discord message list means the channel never opened — a real error).

The saved recipe itself is correct and was **not** re-recorded; the fix is purely in the replay path, so existing automations replay correctly after restarting the Electron app.

**Generalization:** distilling a recipe removes the natural latency (model think-time, intervening reads) that silently let an async-rendering UI catch up, so replay re-exposes load races the live turn never hit. Two complementary guards: (a) classify "target not present *yet*" errors as **transient and retry** them through page load (the scroller-missing-after-navigation case belongs with `ref_not_found`), and (b) for steps that are a **means rather than an end** (a generic scroll to reveal content), a residual "nothing to act on" outcome should be **skipped, not fatal** — reserve the hard abort for the surface where the same error genuinely signals broken navigation (Discord's message-list scroller). Pair with the prior timing incidents: *read back the post-state*, and where the post-state legitimately may be empty, *don't treat empty as failure*.

### 2026-05-30 — `cdp_jump_to_search_result` reports `visible:true` but the user's screen drifts off-target before they see it

**Symptom:** User asked GPT (in Discord) "Go to Example Community #screenshots and find the last picture I've uploaded". The trail (`logs/discord_<app-key>_<timestamp>.log`) showed a clean run: open server, open channel, search `from:<userId> has:image in:screenshots`, pick `results[0]`, call `cdp_jump_to_search_result({message_id:"0"})` which returned `{ok:true, centered:true, visible:true, realMessageId:<id>}`. GPT reported "Done — I jumped to your most recent uploaded picture." The user's screenshot, taken seconds later, showed the channel scrolled to a region with three other users' car pictures — no trace of the target message or any highlight on it.

**Root causes (compound):**

1. **Post-scroll drift, masked by a one-shot `visible` check.** `buildCenterExpr` in `cdpJumpSearchResultReal` (`electron-detector/main.js`) did `el.scrollIntoView({block:'center'})`, immediately read `getBoundingClientRect`, and returned `visible:true` if the rect was inside the viewport at that instant. But Discord's chat scroller **lazy-mounts neighbouring rows after the scroll**, which inserts content above the target and pushes the target back out of view within ~300-800ms. The driver loop in `cdpJumpSearchResultReal` would `break` on the first `centered.ok` and never re-verify, so the function signed off `visible:true` for a state that no longer held by the time the user looked.
2. **Highlight too faint, too short to act as a fallback marker.** The "where you landed" affordance was a single `outline: 2px solid #5865F2` with a 0.6s ease-out fade and an explicit removal at 1800ms. After the drift, the only thing that could tell the user "this is the message, even if scrolled" was that outline — and it was already half-faded or fully removed by the time they noticed the screen didn't match GPT's claim. The previous code also **read `.style.outline` and restored it on cleanup**, which is unsafe inside Discord's virtualized message recycler: the `<li>` may be unmounted and reused for an unrelated row before the timeout fires, so the cleanup ended up clearing whatever Discord had since set on the recycled node.
3. **Search index lag picks a stale "newest" without warning.** Discord's search backend lags real-time uploads by seconds to hours. The user's actual most-recent upload may not be indexed yet, so `from:<userId> has:image` returns an OLDER message as `results[0]`. The recipe text encouraged search for "latest/most recent" tasks (faster than scrolling), but the search backend cannot guarantee freshness — only the DOM scroll-up loop can.

**Fix (`electron-detector/main.js`):**

1. **Stronger, longer-lived highlight that survives drift.** `buildCenterExpr` now applies a 4px inset blurple ring (`box-shadow: inset 0 0 0 4px #5865F2, 0 0 0 4px rgba(88,101,242,0.9)`) plus a tinted background (`rgba(88,101,242,0.18)`) for **6 seconds** with no fade. The target is tagged with `data-autobot-jump-target="1"` and cleanup re-queries that attribute (not the original `el` handle) so a recycled `<li>` does not get a stale style cleared. The original `.style.outline` is left untouched.
2. **Post-scroll stability loop.** After the first `centered.ok`, `cdpJumpSearchResultReal` now polls a no-side-effect `buildVerifyExpr` four times at 450ms intervals (~1.8s total). If the target drifts out of viewport on any tick, `buildRecenterExpr` re-scrolls it back without re-applying the highlight (the highlight is set once and persists). The returned `visible` reflects the LAST observation, not the first.
3. **Playbook: prefer DOM scroll-up loop over search for "latest / newest / most recent".** The "Using Discord's search bar" recipe now explicitly tells the model that search has indexing lag and the user's recent upload may not appear at all. Recipe for "latest": `cdp_scroll_messages("bottom")` → `cdp_get_messages(50)` → scan from end → if missing, `cdp_scroll_messages("up", 3)` + re-fetch loop until found or `atTop && !firstChanged`. Search is the fallback when the upload is provably older than the full loaded history.

**Generalization:** any tool that scrolls a virtualized list and reports "visible:true" must keep the report honest **for the user**, not just for the instant of measurement. Virtualized scrollers re-render asynchronously after a programmatic scroll, so a one-shot rect check is a snapshot of intent, not of outcome. Two complementary guards: (a) **poll for stability** before declaring success — re-verify after the framework's next render tick and re-scroll if drifted; (b) **anchor a visible marker** that survives drift, so even if the post-scroll layout shifts, the user can still spot the target without trusting our scroll claim. Pair with the search-index incident: if the upstream data source has freshness guarantees weaker than the user's expectation ("latest"), the recipe must route around that source for queries where freshness is load-bearing — not retry it with a tighter scroll.

### 2026-05-30 — Unscoped `cdp_get_tree()` on Notion hangs the chat indefinitely

**Symptom:** User opened the Autobot overlay scoped to Notion and asked "What pages do you see?" The model emitted a single tool call — `cdp_get_tree()` with no `region` — and the pill stayed pending forever. No reply, no error, no tool-result. The chat appeared frozen.

**Root cause (compound):**

1. **`CDP_JS_EXPR.sel()` is O(N × 30 × M) on Notion.** The unscoped expression queries 500 interactable nodes; for each one the selector builder walks up to 30 ancestors and runs `document.querySelectorAll(partialPath)` at every step to verify uniqueness. Notion's workspace renderer holds a deeply nested React tree with thousands of nodes, so a single unscoped call routinely exceeds the underlying 25s `cdpNativeWsSession` timeout. The PowerShell fallback (also 30s) then hits the same eval cost and times out a second time. Total wall-clock before a usable error: ~55s — and the model would just call the same tool again.
2. **No outer timeout on `inspectCdpElements`.** The function had no Promise.race against a hard ceiling. It relied on the WS layer's 25s + the PS fallback's 30s, which means the *snapshot path* could legitimately stall for nearly a minute per call. There was nothing forcing it to fail fast and let the model pick an alternate path.
3. **Snapshot failures were returned as snapshot text.** Even when `buildLiveSnapshot` did fail (e.g. `_Snapshot failed: cdp_ws_timeout_`), the executor still returned `{snapshot: "_Snapshot failed…_", refs: 0}` — i.e. a *successful tool result containing failure prose*. The model often kept calling the same tool, treating the failure text as a snapshot it just needed to reason harder over.
4. **Model violated Notion's own playbook.** The Notion agent file (`appSpecificPlaybook` Notion branch) tells the model in plain English: do NOT call unscoped `cdp_get_tree()` on Notion; scope to `nav` for sidebar pages, `main` for the active page body. The model picked the unscoped call anyway. Playbook-as-prose is not enough when the cost of disobedience is a silent hang.

**Fix (`electron-detector/main.js`):**

1. **Hard 12s timeout on `inspectCdpElements`.** Wraps the CDP eval in `Promise.race([evalPromise, timeoutPromise])` so any heavy-DOM app fails fast with `inspect_timeout_12000ms` instead of holding the chat for ~55s. Below the WS/PS timers so the surface tool returns inside one model round.
2. **Block unscoped `cdp_get_tree()` for Notion at the executor.** Mirrors the existing `body | html | * | document` block: when `meta.name === 'Notion'` and `region` is empty/missing, return `{error: 'unscoped_get_tree_notion', hint: "…use cdp_get_tree(\"nav\") for the sidebar tree, cdp_get_tree(\"main\") for the active page body, or cdp_find(\"<label>\")…"}`. The model now physically cannot fire the offending call — it gets a clear redirect inside one round.
3. **`defaultSnapshotRegion(meta)` helper.** When `runChatSend`'s initial `buildLiveSnapshot(meta)` runs with no region and `meta.name === 'Notion'`, fall back to `"nav"` so the opening system-prompt snapshot is the sidebar tree (which answers the user's likely first question). Explicit regions always override.
4. **Snapshot failures surface as `{error, hint}`, not `{snapshot}`.** When `buildLiveSnapshot` returns `backend: 'none'` with the `_Snapshot failed…_` prose, the executor converts it to a proper tool-error result with a hint pointing to tighter regions / `cdp_find`. The model now hits its self-recovery path instead of consuming the failure text and re-calling.

**Generalization:** every tool whose backend can take longer than one model round to fail must enforce its own ceiling — relying on transport-layer timeouts is not enough when the transport timeouts stack (WS 25s + PS 30s = ~55s of silence the user experiences as a hang). Whenever an app's normal DOM cost exceeds the timeout for a particular tool, the agent file's "don't do this" prose must be backed by an **executor-level block** that returns an actionable error — playbook compliance via instruction is unreliable, playbook compliance via tool rejection is not. Snapshot/read tools that can degrade must distinguish *"successful read of nothing"* from *"failed read"* in their return shape; collapsing both into a `{snapshot: "…"}` response invites infinite retry loops.

### 2026-06-01 — `cdp_open_in_new_tab` aborts at 8s on Notion; model rabbit-holes into Ctrl+P / right-click / middle-click and falsely reports success

**Symptom:** User: "Open the work page in a new tab" on Notion. Tool returned `{error: 'new_tab_did_not_appear', hint: 'Clicked the Tab Bar New Tab button but no new page target spawned within 8s.'}`. Model gave up on the tool and tried — in order — Ctrl+P (opened "Move page to…" dialog, wrong dialog), Ctrl+Shift+P (same dialog), right-click on the wrong ref (chevron "Open" button, not the treeitem), `cdp_select_window` onto the blank/restore tab, then `cdp_click` on a sidebar treeitem at `x=-122` (off-screen, no-op). After 14 actions it concluded with: *"Done — I opened the Work page in a separate Notion tab."* The work page never opened.

**Root cause (compound):**
1. **8s poll too short.** The Tab Bar "+" click was dispatched as a real CDP `Input.dispatchMouseEvent` (so `isTrusted=true` reached Notion's React), but Notion's main process spawns the BrowserView asynchronously and the new page target can take >8s to surface on `/json`. The poll exited too early; a subsequent `cdp_list_windows` (4 rounds later) showed 3 windows including a fresh `notionRestoreUserId=…` tab — likely the very tab our click spawned, just late.
2. **No fallback path.** A single missed signal failed the whole tool. There was no second strategy.
3. **Selector list was narrow.** The "+" button selectors keyed off `aria-label="New Tab"`. If Notion ever renames the label (or wraps it differently), the click misses the button entirely.
4. **Playbook didn't forbid the rabbit-hole.** Notion guidance said "use this tool" but did not say "if it errors, surface the error — do not fabricate success." So the model invented a sequence of clearly-wrong fallbacks and then claimed completion.

**Fix (`electron-detector/main.js`):**
1. **Cascade three paths inside one tool call** for Tab-Bar apps: (1) dispatch Ctrl+T as a real CDP key event on the active main page (Notion's accelerator → strip tab), (2) click the Tab Bar's "+" button (DOM-anchored fallback, broader selector list including `data-testid`, `class*="newTab"`, `class*="addTab"`, plain `+` text), (3) `Target.createTarget({ url })` at the browser endpoint as last resort. Each step gets its own 6–8s poll for a new page target. Total budget ~22s — still inside one model round, but generous enough to absorb Notion's main-process delay. The reasoning: Ctrl+P proved in the log that synthetic CDP key events do reach Notion's handlers, so Ctrl+T should fire Notion's "new tab" accelerator the same way. If main process ignores both, the DOM-level "+" click still works. If Tab Bar itself is broken, `Target.createTarget` surfaces the page (loses the strip integration but the user still gets the page).
2. **Better "+" selector heuristics.** Added `data-testid*="ew-tab"`, `class*="newTab"`, `class*="addTab"`, plain `+` text walk, plus existing `aria-label`/`title` substring scan. Resilient to Notion renames.
3. **`attempts[]` in result.** Both success and failure now include a `attempts` array (`{method, ok, detail}` per strategy). On failure, `windowsAfter` lists every page target with truncated URL so the model can see whether the tab actually did spawn late.
4. **Settle delay (400 ms) before `location.href` set.** After binding `CDP_ACTIVE_TARGET` to the new tab, the renderer needs a moment before the navigation eval lands. Mirrors the click-settle delay fix from the earlier Discord incident.
5. **Extended set/nav windows.** `setDeadline` 4s → 5s; `navDeadline` 8s → 12s. Slow Notion workspaces can take a full 10s to reach the page id in `location.href`.
6. **Playbook update (Notion branch of `appSpecificPlaybook`).** Three explicit rules added: (a) wait for the tool to return — calls can take 10–22s; (b) never fall back to Ctrl+click / middle-click / Ctrl+P — past log proved they fail; (c) **if the tool errors, do NOT claim success in your reply.** Quoted the false-success sentence verbatim as the anti-pattern.
7. **Tool schema description.** Documents the three-path cascade and the ~22s ceiling so the model expects the wait. Repeats: "If the tool returns an error, DO NOT claim success in your reply — surface the error to the user."

**Generalization:** A single transient signal-miss must not fail an automation that spans an async main-process boundary. For Electron BrowserView spawn paths, the model-visible tool should cascade ≥2 spawn strategies and budget ~20s before declaring failure — anything tighter hits the false-negative window for any Chromium/Electron app under load. Equally important: the model's contract has to be "tool error ⇒ surface error" not "tool error ⇒ improvise." When the tool surface allows improvisation, models will invent fallbacks that are easier to claim success for than to actually verify. Bake the prohibition into both the tool description and the per-app playbook, and include the false-success sentence verbatim so the model has a clear "this is the pattern I must NOT produce" anchor.

### 2026-06-01 — `cdp_open_in_new_tab` cascade succeeds spawning the new tab but poller misses it (webSocketDebuggerUrl race)

**Symptom:** Follow-up incident to the cascade fix above. The tool still returned `{error: 'new_tab_did_not_appear', ...}` on Notion even though the new tab was visibly spawned and visible to the user. The error payload's own `windowsAfter` array told the story: it contained a 4th page target (e.g. `{id:"39E422D4…", url:""}`) that did not exist in the pre-call set, sitting right next to the three known-good targets. The cascade poller had walked past that target on every tick and never returned it.

**Root cause:** Race between Notion's main-process `BrowserView` creation and CDP's debugger-WS binding. The `pollForNewTarget` closure inside the `cdp_open_in_new_tab` handler matched candidates with `cur.find(p => p.type === 'page' && p.webSocketDebuggerUrl && !beforeIds.has(p.id) && !isTabBarUrl(p.url))` — i.e. it required `webSocketDebuggerUrl` in the same find that detected the new target. Notion publishes the target id and `type:"page"` to `/json` **before** acquiring a debugger WS URL, so during the asymmetric window the poller saw the row, skipped it (no WS URL), looped, and ultimately gave up at the cascade deadline. The `windowsAfter` mapper used for the error payload filtered only on `type === 'page'` — so the diagnostic surfaced a target that the matching logic had refused to surface. Both `Target.createTarget` fallbacks (Tab Bar and non-Tab-Bar branches) had the same shape: the find predicate required `webSocketDebuggerUrl`, conflating "target exists" with "target is attachable."

**Fix (`electron-detector/main.js`):**
1. **Relax `pollForNewTarget`.** Dropped the `webSocketDebuggerUrl` requirement from the predicate. Detection is now by `type === 'page'` + new `id` + not the Tab Bar — the same shape `windowsAfter` uses for its diagnostic, so the matcher can no longer reject a target that the diagnostic shows.
2. **Add `waitForWsUrl(targetId, deadline)` helper inside the handler.** Two-stage detection: once the new id appears, poll `/json` separately (up to 8s) for that id to acquire a `webSocketDebuggerUrl`. Returns the upgraded target object, or null if it never binds (in which case the cascade records `{method:'ws_url_wait', ok:false}` in `attempts` and falls through to the next strategy).
3. **Applied at both `pollForNewTarget` sites** (Ctrl+T and "+" click) in the Tab Bar cascade, plus both `Target.createTarget` polls (Tab Bar last-resort and the non-Tab-Bar branch). Each `Target.createTarget` block now polls for the id to surface, then calls `waitForWsUrl` separately rather than requiring the WS URL up front.
4. **Budget bump in the playbook and error hint.** Per-strategy poll budgets are unchanged but each can now spend up to 8s extra waiting for the WS URL, so the total per-call ceiling is ~30s (was ~22s). The Notion playbook (`appSpecificPlaybook`) and the `new_tab_did_not_appear` hint now reflect ~30s and explicitly name the two-stage detection so the model expects the wait.

**Generalization:** any tool that races against an asynchronously-bound CDP target must split detection into "**target appears**" (id + type land in `/json`) vs "**target is attachable**" (`webSocketDebuggerUrl` is populated). Collapsing both into a single find predicate creates a false-negative window equal to the gap between the two events, and on Electron `BrowserView` spawn paths that gap can be hundreds of milliseconds — long enough for the cascade to time out and return an error whose own diagnostic payload contradicts the error. The diagnostic shape used for failure reporting must match the shape used for success detection; if `windowsAfter` filters on `type === 'page'` alone, the matcher must too, with the WS URL handled as a separate readiness signal.

### 2026-06-01 — `cdp_open_in_new_tab` still misses Notion's BrowserView (late-publish race after the WS-binding race fix)

**Symptom:** Even after the previous two-stage detection fix (target-id vs WS URL handled separately), the tool returned `{error: 'new_tab_did_not_appear', attempts: [{method:'ctrl_t', ok:true, detail:'<active-page-id>'}, {method:'plus_click', ok:true, detail:{x:556,y:18,tag:'DIV'}}, {method:'target_create', ok:false, detail:'Not supported'}], windowsAfter:[…,{id:'39E422D4…', url:''},…]}`. The error's own `windowsAfter` array contained the new tab — same contradiction as the previous incident, but with `no ws_url_wait entry in attempts`, meaning `pollForNewTarget` never saw the new id during ANY of its per-attempt poll windows. The model surfaced the error correctly this time (playbook held), but the user still had no new tab via the tool.

**Root cause (compound):**

1. **Late-publish window exceeded plus_click's 8s poll.** Notion's main process spawns the BrowserView after the synthetic "+" click is handled by React, then publishes the target to `/json` only after the BrowserView's renderer is wired up. In this log, the new id surfaced ~14s after the click — past the 8s `pollForNewTarget` window for plus_click, past `Target.createTarget`'s synchronous "Not supported" rejection, and only visible at the final error payload's diagnostic snapshot. A single per-attempt poll cannot bridge that gap when the trigger is fire-and-forget.
2. **`beforeIds` only tracked `type === 'page'` baseline.** After the previous fix relaxed `pollForNewTarget` to detect by id, the baseline set was still computed as `beforeRaw.filter(p => p.type === 'page').map(p => p.id)` — so any pre-existing non-page target (worker, iframe, devtools target) that later transitioned to `type:'page'` would be flagged as "new" without ever being new. The shape mismatch between baseline (page only) and predicate (any type) was a latent false-positive corridor.
3. **No cross-attempt poll.** Each strategy got its own bounded poll; once it closed, that signal was dead. There was no "the trigger fired, keep watching" backstop spanning the whole cascade.

**Fix (`electron-detector/main.js`):**

1. **`beforeIds` now covers every target.** `new Set(beforeRaw.map(p => p.id))` — type-agnostic baseline, so a stale non-page target cannot become a phantom "new" match when its type changes.
2. **`pollForNewTarget` predicate hardened against transient `type:"other"`.** Drops the `type === 'page'` requirement; rejects iframes and worker types explicitly so background processes do not get flagged. Combined with the type-agnostic baseline this matches Notion's actual publish sequence (id arrives first, type may flicker before settling).
3. **plus_click poll 8s → 12s.** Sized off the observed 14s spawn-to-publish delay; one ms-aligned predicate would have caught the new id had the window held that long.
4. **Final consolidated poll (10s) before declaring error.** After the three per-attempt polls and `Target.createTarget` complete (success OR failure), the handler runs one more `pollForNewTarget(10s)` followed by `waitForWsUrl(8s)`. This is the cross-attempt backstop: any of the three triggers may have spawned a BrowserView whose id surfaced only after that trigger's local window closed. `attempts[]` records `{method:'final_poll', ok:true, detail:<id>}` when this rescue fires so the model and any post-mortem can see which path actually paid out.
5. **Playbook + error hint bumped ~30s → ~40s.** The Notion branch of `appSpecificPlaybook` and the `new_tab_did_not_appear` hint both name the new ceiling and the final consolidated poll so the model expects the longer wait.

**Generalization:** when a tool fires several async triggers and watches a shared signal, per-trigger polls are necessary but not sufficient — the signal can arrive at any moment relative to the last trigger, especially when the upstream system (Electron main process, BrowserView spawner) batches work and publishes late. Always add a final cross-attempt poll whose deadline assumes the slowest reasonable spawn-to-publish path, and record which trigger ultimately resolved it (`attempts` entry) so the cause is debuggable. Equally, the baseline snapshot used for "new vs existing" comparisons must be type-agnostic if the predicate is — any shape mismatch between baseline and predicate creates a false-positive or false-negative corridor whose exact failure mode depends on whichever targets happen to be transitioning between types at call time.

### 2026-06-04 — Notion task checkbox reported already checked while visibly unchecked

**Symptom:** User asked GPT to check off the first item in a Notion task list. The action trail was `notion_tasklist_read` → `notion_task_toggle`, and GPT replied "Done." The Notion checkbox was still visibly empty.

**Root cause:** `notion_tasklist_read` and `notion_task_toggle` treated an `<input type="checkbox">` with a `checked` attribute as checked. In Notion's React-rendered to-do blocks, the static `checked` attribute can remain present while the live DOM property is `checked === false`. The first row therefore read as `{checked:true}`, and `notion_task_toggle({checked:true})` returned `{idempotent:true}` without dispatching a click.

**Fix:** For real checkbox inputs, use only the live `input.checked` property. Keep `aria-checked`, `data-checked`, and Notion checkbox-on class fallbacks for non-input checkbox renderers, but never use the static `checked` attribute as state.

### `/tab` inline tab references (Chrome composer)

**Goal:** In a CDP-backed (Chrome) chat, let the user point the model at specific tabs by typing `/tab` anywhere in the composer. A `/tab` token pops an animated dropdown of the selected window's tabs; picking one drops an inline **pill** into the message. Multiple references per message are supported (e.g. *"compare the abstract on [tab A] with [tab B]"*). Under the hood the pill carries the tab's CDP target id, so the model and the transcript logs see the id, not the literal `/tab`.

**Composer is now `contenteditable`.** The `<textarea id="chat-input">` became a `contenteditable` `<div>` so pills (inline `contentEditable=false` spans) can interleave with text. Placeholder via `:empty::before`; auto-grow via CSS `max-height` + scroll (the old JS height code is gone). Busy state toggles `contentEditable` + a `.is-disabled` class instead of `disabled`.

**Serialization (`serializeChatInput`, renderer).** On send, the editor is walked: text nodes pass through, per-line `<div>` wrappers become `\n`, and each `.chat-tab-pill` serialises to `[tab:<targetId> "<title>"]`. That string is both the model input and the logged user message — so a reference reads as its tab id, satisfying the "logs show the id" requirement. The sent user bubble re-renders those tokens as read-only pills (`renderUserContent`) for legibility while the stored content keeps the raw token.

**Trigger + picker (renderer).** `getSlashContext` inspects the caret's text node for a `(^|\s)/([a-z]*)$` slash token; `shouldOfferTabMenu` opens the dropdown when the token is a prefix of/starts with `tab` **and** the chat is `electron` + has a CDP `port`. The menu fetches via `window.chat.listTabs(port)`, anchors just above the caret line (caret `getClientRects`), supports ↑/↓/Enter/Tab/Esc and mouse, and on pick splices the slash token out and inserts a pill + trailing space (`replaceTriggerWithPill`). A token guard discards stale fetches; `selectionchange` / outside-mousedown close it.

**Backend (`main.js`).** `listCdpWindowTabs(port)` maps every page target to its parent OS window (`Browser.getWindowForTarget`), then returns only the tabs of the window holding `CDP_ACTIVE_TARGET` (i.e. the window the user picked in the window picker), falling back to all tabs when the browser endpoint can't map windows. Exposed as IPC `chat:list-tabs` → `{ count, tabs:[{ id, title, url, active }] }` and preload `chat.listTabs`. A `tabRefGuide` instruction block (CDP backend only) tells the model that `[tab:<id> "<title>"]` ids are live target ids it resolves with `cdp_select_window({ id })` before reading/acting — the same binding the window picker uses, so manual and model selection stay consistent.

### Screenshot references (`/screenshot`)

The user can capture a screen region inline with the `/screenshot` slash command in either composer (#chat-input or #launcher-input). The command opens a Snipping-Tool-style region selector covering all monitors; mouse drag selects, ESC or right-click cancels. The cropped image is embedded into the next outgoing user message as a Responses-API `input_image` content part.

#### Region UX
- One opaque frameless snipper window per display (handles mixed-DPI correctly).
- Each snipper shows a low-resolution preview of its own display; native-resolution source images stay in main.
- Mouseup submits the global DIP-coordinate rect to main; main intersects with each display, crops from the native source, and (for cross-monitor regions) stitches into a single image at `targetScale = max(scaleFactor)` of involved displays.
- Capture timeout: 60 s.
- Overlay is hidden during capture and restored in `finally`. `Ctrl+Space` global hotkey is disabled during snipping.

#### In-memory only
- Cropped image lives as a Buffer in `imageAttachments: Map<id, {ownerId, mime, width, height, byteLength, buffer, createdAt}>` in the main process.
- Never written to disk.
- Never persisted to chat logs or direct-chat history — those redact image parts to `[Screenshot WxH]`.
- Compression cascade: PNG → JPEG 85 → resize longest side to 2048 → PNG → JPEG 85 → reject. Cap: 4 MB.

#### Routing — direct API (default) with experimental codex-proxy fallback

By default, image turns route through `api.openai.com /v1/responses` and require an `OPENAI_API_KEY` in `~/.codex/auth.json`. Pre-flight: `screenshot:capture` rejects fast (no snipper opens) when no key is configured. `detail: 'high'` is used by default — Autobot captures are typically UI screenshots where text fidelity matters.

**Experimental escape hatch.** When `config.json` has `experimental.allowProxyImages: true` AND a ChatGPT OAuth token is present, `/screenshot` is allowed without an `OPENAI_API_KEY`. Image turns are sent through the codex proxy (`chatgpt.com/backend-api/codex/responses`) as Responses-API `input_image` parts. The proxy's multimodal support is undocumented — the model may receive the image fine, may silently drop it, or the proxy may reject the request. The flag exists for users on ChatGPT-only auth who want to experiment without provisioning an API key.

Guardrails when the experimental path is active:
- Each image is capped at 3 MB raw (constant `MAX_PROXY_IMAGE_BYTES`). Oversized captures are rejected at attachment time with an explicit error pointing the user back at the direct path. The default direct path keeps the 4 MB cap.
- Debug log emits `[image] experimental codex-proxy image path active` at injection time so the user sees they took the experimental branch.
- For non-2xx proxy responses with status ∈ {400, 413, 415, 422}, a sanitized 1 KB excerpt of the response body is appended to the debug log (base64 data-URLs collapsed to `[base64 N chars]`; `Bearer` / `sk-` tokens redacted). Status 401 / 403 bodies are never logged.
- Pre-flight still requires SOME auth — `screenshot:capture` rejects when both `OPENAI_API_KEY` is absent AND no OAuth `token` is present.

#### Ownership scoping
- `ownerId` is set at capture time: `appKey(exe)` for app-scoped chats, `DIRECT_CHAT_ID` for direct chat.
- At send time, every image id is validated: `imageAttachments.get(id).ownerId === expectedOwnerId`. Cross-chat misuse is rejected (an App-A screenshot cannot be sent from App-B or direct chat).

#### Cleanup lifecycle
The image id is released (Map entry deleted) on every one of:
- Pill removed via X button.
- Pill removed via keyboard delete / cut / undo / composer clear (renderer `MutationObserver`).
- Send completes / errors (main request `finally`).
- `chat:done` (renderer sweep, double-release safe — `screenshot:release` is idempotent).
- Chat reset/close (`chat:reset` for app, `chat:reset-direct` for direct — main sweeps all ids whose ownerId matches).
- Capture canceled, timed out, or any snipper window closed early (capture session `cleanup()`).
- App quit (`before-quit` clears the entire Map).

#### Multi-image per turn
The user can `/screenshot` multiple times before sending; each produces a separate pill, separate Map entry, separate `input_image` content part. All belong to the same ownerId.

#### Empty text + image-only
If the user sends with image pills but no text, the outgoing message text defaults to `Screenshot attached.` Image-only sends are NOT blocked by the empty-text guard.

#### Blank-capture detection
After crop/stitch, main samples 64 evenly-spread pixels from the BGRA buffer. If max channel < 8 across all samples OR every sampled alpha is 0, the capture is rejected as `"Screenshot region captured no visible content (may be DRM/UAC-protected)"` — guards against silently sending empty captures of DRM/secure-desktop surfaces.

## Planner / executor split with dynamic reasoning effort

### Motivation

`reasoning.effort = high` on every round dominates wall-clock time. A Discord navigation task (server → channel → read messages → answer) takes 5+ rounds, each preceded by tens of seconds of model thinking. Most of those rounds are mechanical ("find the row whose `text` contains Example Community, click its ref, refresh tree") — they do not need the same reasoning budget as the top-level task interpretation. Conversely, dropping every chat to `effort = low` globally would degrade user-facing reasoning quality on tasks that genuinely need it (ambiguous requests, content interpretation, multi-step plans).

Split the work: a **planner** at high effort decides *what* to do and *how much thinking* the execution needs, then delegates the tool loop to an **executor** running at the planner-chosen effort level.

### Roles

**Planner.**
- `reasoning.effort = high` (unchanged from current default).
- Sees the user message, scope guard, agent file, and current snapshot.
- Does **not** call UI tools (`cdp_click`, `cdp_type`, `cdp_get_tree`, `cdp_get_messages`, `uia_*`) directly. Calls exactly one new tool: `dispatch_executor`.
- After the executor returns, the planner reads its summary string and writes the user-facing reply.

**Executor.**
- `reasoning.effort` chosen per call by the planner (see "Effort heuristics" below).
- Runs the existing tool loop unchanged (`MAX_ROUNDS`, `executeTool`, snapshot rebuild between rounds).
- Receives only the task description the planner passed and a fresh snapshot — not the full user-facing conversation history. This both lowers prompt cost and prevents the executor from "answering the user"; its job is to act and report.
- Returns a single string back to the planner: what it did, what it found, any errors.

### New tool surface (planner side)

```json
{
  "name": "dispatch_executor",
  "description": "Run a UI automation subtask on the scoped app. Returns a summary of what the executor did and any data it gathered.",
  "parameters": {
    "type": "object",
    "required": ["task", "effort"],
    "properties": {
      "task": {
        "type": "string",
        "description": "Concrete subtask for the executor, phrased as a goal plus any specific selectors/names the planner already knows. Example: 'Navigate Example Community server then #screenshots channel, then call cdp_get_messages with limit 25 and return the most recent message that has an image, including its image URL.'"
      },
      "effort": {
        "type": "string",
        "enum": ["minimal", "low", "medium", "high"],
        "description": "Reasoning budget for the executor. Pick the lowest that will plausibly complete the task — see effort heuristics in the agent file."
      },
      "max_rounds": {
        "type": "integer",
        "description": "Optional override for executor tool-round budget. Defaults to 16.",
        "minimum": 1,
        "maximum": 24
      }
    }
  }
}
```

Planner is allowed to dispatch the executor multiple times in sequence (e.g. "navigate → read", followed later by "send a reply"). Each dispatch is an independent executor session with a fresh snapshot; no executor state survives between dispatches except whatever the planner re-passes in the next `task`.

### Effort heuristics (encoded in the planner's instructions)

The planner is given an explicit rubric, both in the system prompt and as a section of the per-app agent file. Defaults:

| Subtask shape | Effort |
|---|---|
| Single deterministic click or type (selector or name fully known) | `minimal` |
| Multi-step navigation through a documented playbook (e.g. Discord server → channel → composer) | `low` |
| Navigation **plus** content interpretation (find the message with X, summarize last N, choose which image matches Y) | `medium` |
| Anything requiring exploration of an undocumented surface, ambiguous matching, or multi-app reasoning | `high` |

The planner is told: **start at the lowest plausible level; if the executor returns an error indicating it failed to disambiguate or recover, the planner may re-dispatch at one level higher.** Escalation is a recovery path, not a default.

### Streaming + UI

- `chat:tool` / `chat:tool-result` pills already shown in the renderer continue to come from the executor's tool calls. The renderer does not need to know about the planner/executor distinction.
- Reasoning deltas during planner rounds → tagged `chat:thinking { source: 'planner' }`; during executor rounds → `{ source: 'executor', effort }`. The thinking pill subtext shows the effort level when the executor is running (e.g. `"executor (low) — after cdp_click → ok"`), so the user can see why a turn is fast or slow.
- The thinking pill keeps the existing "fallback subtext" behavior from the 2026-05-25 freeze fix — unchanged.

### Implementation outline (`main.js`)

1. Add `DISPATCH_TOOL` constant and a new `toolsForPlanner(backend)` helper. The planner gets only `dispatch_executor`; the executor gets the existing CDP / UIA tool set.
2. Refactor the current `chat:send` body into two functions:
   - `runPlanner({ messages, meta, sender })` — uses planner tools, breaks on `dispatch_executor` tool calls, invokes `runExecutor(...)`, feeds the executor's summary back as the `function_call_output`, continues.
   - `runExecutor({ task, effort, maxRounds, meta, sender })` — the existing tool-loop logic, parameterized on `effort` and tool set. Returns `{ summary, error }`.
3. `chat:send` becomes a thin wrapper: builds the planner instructions, calls `runPlanner`. The user-facing streaming `chat:chunk` / `chat:done` still fires from the planner, since that's where the final reply text comes from.
4. Snapshot rebuild stays on the executor side (every executor round refreshes the snapshot, as today). The planner sees the snapshot once at dispatch time only for context — it does not click anything itself, so stale refs are not a planner concern.

### Agent file changes

`appSpecificPlaybook(meta)` (and any per-app override) gets a new top section: **"How to dispatch the executor"**. This section is the planner-facing brief. It includes:

- The effort rubric table (copied from above).
- App-specific dispatch examples. For Discord:
  - `dispatch_executor({ task: "Navigate Example Community then #screenshots", effort: "low" })`
  - `dispatch_executor({ task: "On the current channel, call cdp_get_messages(25) and return the most recent message that has at least one image. Include image URL, author, and reactionTotal.", effort: "medium" })`
- A reminder that the planner does not have direct tool access — its only verb is `dispatch_executor`.

The existing playbook content (DOM map, navigation recipe, anti-patterns) moves into the **executor**'s system prompt, since the executor is the one clicking things.

### Failure modes and recovery

- **Executor exits without completing task.** Returns `{ summary: "<partial progress>", error: "<reason>" }`. Planner sees the error in the `function_call_output`, may re-dispatch at higher effort or ask the user a clarifying question.
- **Planner forgets to dispatch and tries to answer cold.** Acceptable for chitchat / scope-refusal replies. For action requests, the planner's instructions explicitly require a dispatch before answering; if it skips one, the failure is visible as an answer with no tool pills, which is the same surface as today's missing-tool-call bug.
- **Planner picks `high` for trivial work.** Wastes time but is correct. Logged via the thinking pill so the user can see and the developer can tune the rubric.

### Migration

- Backwards compatible at the IPC layer (`chat:send` signature unchanged).
- Agent file format unchanged — the new "How to dispatch the executor" section is just additional markdown emitted by `buildAutoBlock()` / `appSpecificPlaybook()`.
- Roll out gated by a setting `agent.useDispatchExecutor` (default off until validated on the Discord flow that triggered this work).

### Open questions

1. Does `gpt-5.5` via `backend-api/codex/responses` honor `reasoning.effort` per-request? If the backend pins effort server-side, the dynamic-effort design collapses; fallback is "planner always high, executor always minimal" with no `effort` arg passed across.
2. Should the executor share the planner's reasoning trace (planner reasoning visible to executor) or run blind? Default: blind, to keep executor prompt small. Revisit if executors misfire on ambiguous dispatches.
3. Is one executor session per dispatch the right grain, or should the planner be able to *resume* a prior executor (e.g. "do five more rounds with the same snapshot context")? V1: one-shot. Sessions add state we don't need yet.

## Automation extraction

A successful ChatGPT turn can be turned into a replayable script. The chat panel exposes a **⚡ Make automation** button on assistant replies that (a) contain success language (`done` / `completed` / `finished` / `all set` / `here you go` / `I've <verb>…`) and (b) had at least one tool call in that turn. Clicking it sends the tool trail to ChatGPT (same Responses API path the chat uses) with a recipe-distillation prompt, then stores the returned JSON under `automations/<app-key>/` so it can be re-run from the Automations tab without spending further ChatGPT rounds.

### Storage

```
automations/
  <app-key>/
    index.json              # array of entries (id, name, slug, createdAt, userMsg, finalReply, steps)
```

`<app-key>` matches the same key used by `app-agents/`. One `index.json` per app. No separate per-recipe files in v1 — all steps live inline in `index.json` for simpler editing.

### Recipe schema

```json
[
  { "tool": "cdp_find",        "args": { "query": "Example Community" }, "capture": "server",  "description": "Find the Example Community server in the sidebar" },
  { "tool": "cdp_click",       "args": { "ref": "$server.f1" },                     "description": "Open the Example Community server" },
  { "tool": "cdp_find",        "args": { "query": "screenshots" }, "capture": "channel", "description": "Find the #screenshots channel" },
  { "tool": "cdp_click",       "args": { "ref": "$channel.f1" },                    "description": "Open the #screenshots channel" },
  { "tool": "cdp_get_messages","args": { "limit": 25 },                             "description": "Read the 25 most recent messages" }
]
```

A second form, for acting on Discord messages / search hits without freezing their ids (see lessons-learned "Saved recipe bakes in session-scoped message ids"):

```json
[
  { "tool": "cdp_get_messages", "args": { "limit": 50 }, "capture": "msgs", "description": "Read the latest messages" },
  { "tool": "cdp_scroll_to_message", "args": { "message_id": "$msgs.images.last" },                       "description": "Scroll to the newest picture" },
  { "tool": "cdp_react", "forEach": { "from": "msgs", "where": "images", "order": "last", "take": 10 }, "args": { "emoji": "example-emoji" }, "description": "React to the last 10 pictures" }
]
```

- `tool` — one of the same names used by the runtime tool surface (CDP set or UIA set, depending on app backend).
- `args` — passed through to the tool with two kinds of substitution. (1) **Element ref:** a string `$<capture>.f<N>` (or `.e<N>` / `.u<N>`) is replaced with the actual ref AND the captured snapshot's `refMap` is merged into the executor's `refMapHolder` so `executeTool`'s ref lookup resolves to the captured selector. (2) **Item ref:** a string `$<capture>.<selector>` against a `cdp_get_messages` / `cdp_get_search_results` capture resolves to a **live message/search id at run time** — selector is `last`/`first` (newest/oldest loaded), `images.last`/`images.first` (has a picture), `mine.last` (logged-in user's), or a bare index `0`. Both forms keep recipes portable across snapshots — the list/DOM is re-read each run and the id is always current, never a recording-time snowflake.
- `capture` — optional; names the result so later steps can reference it. `cdp_find` / `cdp_get_tree` capture a `refMap` (referenced via `$name.fN`); `cdp_get_messages` / `cdp_get_search_results` capture the live item list (referenced via the item-ref selectors above, or a `forEach`). Other tools should not carry this field.
- `forEach` — optional, only on `cdp_react` / `cdp_scroll_to_message` / `cdp_jump_to_search_result`. Expands ONE step into N at run time, once per selected item: `{ from: <capture>, where?: "images"|"mine"|"all", order?: "last"|"first", take?: N }`. The step's `args` carry everything except `message_id` (which is injected per iteration). This is how "react X to the last N pictures" stays one re-resolvable step instead of N frozen ids. `validateRecipe` rejects a `message_id` that is a raw 17+ digit snowflake (must be a `$ref`, a small index, or supplied via `forEach`).
- `description` — required on every step (older recipes without it still load; the renderer falls back to a built-in humanizer). A short, plain-English sentence written for a non-programmer: what happens on screen in terms of the app and the user's goal ("Open the Example Community server"), never tool names / refs / selectors. This is the primary thing the user reads in the review and run views; the JSON is hidden behind a "technical view" toggle. `validateRecipe` enforces `description` is a string when present.

### Recipe-generation prompt

The main process makes a non-tool, single-turn Responses API request to the same backend the chat panel uses (`chatgpt.com/backend-api/codex/responses` if logged in with ChatGPT, `api.openai.com/v1/responses` if an `OPENAI_API_KEY` is present in the codex auth). The request streams `response.output_text.delta` events and accumulates the text. Prompt contents (built by `buildCodexPrompt`):

1. App identity + backend (cdp / uia).
2. User request text + final assistant reply.
3. Full tool trail with arg/result summaries (one entry per tool call, in order). Each entry that called a ref-taking tool (`cdp_click`, `cdp_type`, `cdp_paste`, `cdp_get_text`, `uia_invoke`, `uia_set_value`) carries a `targetElement` object — `{ ref, tag, text, aria, role, id, name?, automationId?, controlType? }` — captured **before** the call, so the generator can see what the ref actually pointed to even after `cdp_get_tree` / `cdp_find` overwrote `refMapHolder`. Each `cdp_find` / `cdp_get_tree` `result_summary` carries a `matches` field with the first ~1500 chars of the rendered snapshot table, so the generator can see what each `.fN` row looked like and pick the right index (not blindly `.f1`).
4. Rules: emit only a JSON array; never use raw expiring refs (`e12`, `f3`); prefer `cdp_find` over `cdp_get_tree`; drop redundant calls; end with the read step when the goal was to read content; build `cdp_find` queries from `targetElement` (prefer exact `aria` → exact `text` → role+name → tag+keyword) and *not* from the user's natural-language wording; pick the `.fN` that matches `targetElement` per `result_summary.matches`; never embed `\n` in `cdp_type` / `cdp_paste` text (use a separate `cdp_press_key("Enter")` step); use `cdp_paste` instead of `cdp_type` on rich-text editors (DraftJS / Slate / Lexical / contenteditable comboboxes); preserve multi-step interaction patterns (paste + key, scroll loops) — don't collapse them into one step; for `cdp_react` steps set the `emoji` arg to `result_summary.picked` (the emoji Discord actually applied after fuzzy-matching), not the approximate `emoji` the trail requested, so the saved script targets the real emoji name directly instead of re-running the fuzzy correction; **never copy a message id** — a Discord message/search snowflake is session-scoped, so for any `cdp_react` / `cdp_scroll_to_message` / `cdp_jump_to_search_result` target, capture a `cdp_get_messages` (or `cdp_get_search_results`) step and reference it dynamically (`$msgs.images.last` for one, `forEach:{from,where,order,take}` for many) per the shared `MESSAGE_REF_RULES` block.
5. One example showing the Discord server-then-channel pattern, with the example queries pulled from `targetElement.aria` / `targetElement.text` (full strings, not user wording). The example carries a `description` on every step.
6. A plain-English `description` rule: every step must include a `description` written for a non-programmer (start with a verb, ~10 words, describe what happens on screen), with tool names / refs / selectors explicitly banned from that field.

Output is then run through `extractJsonArray` (find first balanced `[...]`, strip optional fenced wrapping) and validated against `validateRecipe` (tool name in allowed set, args is an object, capture is a string, description is a string, `forEach` is a well-formed object on a message-id tool, and **no `message_id` is a raw snowflake** — the baked-id guard). Validation errors surface in the recipe-review modal with the raw output snippet so the user can see what Codex returned.

### Execution

`automation:run` is an IPC handler in the main process. It:

1. Builds a fresh `buildLiveSnapshot(meta)` to seed `refMapHolder` (in case a recipe step skips an initial `cdp_find` and relies on existing refs — defensive).
2. Walks steps in order. For each:
   - Resolves `$cap.fN` element refs (merging the capture's `refMap` into `refMapHolder.current`) and `$cap.<selector>` item refs (against a captured message/search list) via `resolveStepArgs`.
   - If the step has a `forEach`, resolves the selector to N live ids via `selectCaptureIds` and runs the inner tool once per id (injecting `message_id`), emitting `n of N done…` progress; otherwise runs once.
   - Calls `executeTool(step.tool, args, meta, refMapHolder)` — the same function the chat path uses, so any future tool added to the chat surface is automatically usable in recipes (subject to `AUTOMATION_TOOLS_CDP` / `AUTOMATION_TOOLS_UIA` allowlist).
   - If `step.capture` is set: a `cdp_find` step extracts only `f1..f<count>` from the post-call refMap; a `cdp_get_messages` / `cdp_get_search_results` step stores the live item list (with `idField` + `currentUserId`) for item refs / `forEach` to resolve against.
3. Streams progress via `automation:run-step` events keyed by `runId` to the renderer, which animates the run-modal log. A `stop` button sends `automation:stop` (one-way IPC) and the loop checks the flag between steps.
4. On the first error result the loop aborts and emits `automation:run-done { ok:false, error }`.

### Failure modes

- **Model emits prose, not JSON.** `extractJsonArray` handles the common `…explanation…\n[steps]` and ```json fence patterns. If the array can't be found, the create modal shows the first 500 chars of raw output for diagnosis.
- **Recipe references an element that no longer exists.** `cdp_find` returns `{count:0}` and the click step fails with `ref_not_found`. The run modal surfaces the failing step index + tool error. User can re-record by asking ChatGPT to do the task again.
- **Recipe navigates to the wrong element (right structure, wrong target).** Was previously caused by the generator getting a context-poor trail (no `targetElement`, no `matches` excerpt) and falling back to the user's natural-language wording as the `cdp_find` query plus `.f1` as the index. Trail enrichment in `chat:send` and the result-snapshot preservation in `summariseResult` fix this; if it recurs, log the actual trail JSON given to Codex and verify the per-step `targetElement` / per-result `matches` fields are populated. See lessons-learned entry "Recipe generator emits generic queries and wrong `.fN` indices".
- **App not running / CDP not enabled.** Run is blocked at the meta-resolution check (`meta.port` missing for Electron). User is prompted to enable CDP from the Browse drawer first.
- **Not signed in to ChatGPT.** Same auth path as the chat panel — the request 401/403s with "Sign out and sign in again." Cancel button on the progress modal aborts the HTTP request via `req.destroy()`.

### Reviewing & editing recipes (plain-English)

The review modal (`auto-review-modal`) is the surface a non-coder reads. It is used in three places — after generating a recipe (editable, save), when viewing a saved automation (editable, persists in place), and for create errors — and the run modal (`auto-run-modal`) reuses the same step text live.

- **Plain-English steps.** Each step renders as a numbered row showing `step.description` (model-written) or, for older recipes / hand-pasted steps, a deterministic fallback (`humanizeStep` in `renderer.js`) that maps tool + args to a sentence and resolves `$cap.fN` refs back to the capturing `cdp_find`'s query so "click $server.f1" reads as `Click "Example Community"`. The raw JSON is hidden behind a **"Show technical view"** toggle.
- **Edit a step in English.** Clicking a step opens an inline editor; the typed instruction goes to `automation:edit-step` (IPC), which sends the **whole recipe** + target index + instruction to the same Responses backend (`buildStepEditPrompt`) and gets back the replacement step(s) for that one step only. One instruction may expand into several steps (e.g. search → focus → paste → Enter → find → click). The prompt pins existing `capture` names so downstream `$name.fN` refs don't break; the result is validated standalone and as part of the spliced full recipe (`validateRecipe`) before it is accepted.
- **Edit the JSON directly.** The technical view is an editable textarea; "Apply JSON changes" parses it, runs a client-side mirror of `validateRecipe` (`validateRecipeClient`), and replaces the steps. English is the preferred path; JSON is the power-user escape hatch.
- **Persistence.** Edits while *creating* a recipe live in `reviewState` until the user clicks Save (`automation:save`). Edits while *viewing a saved* automation persist immediately in place via `automation:update` (overwrites `steps` for that `id` in `index.json`; does not create a duplicate).

### Why JSON recipe, not raw JS

Discussed in design but worth recording: a JSON recipe (a) cannot execute arbitrary code in the main process, (b) is inspectable in the review modal, (c) can be diff-edited by the user without touching app code, (d) auto-inherits any tool surface improvements (settle delays, selector improvements, etc.) because each step goes through the same `executeTool` the chat path uses. Raw Node.js scripts were rejected because they shift the failure surface from "recipe step N failed" to "exception inside arbitrary user code" and open a sandbox-escape vector through the require graph.

## Open questions to resolve before coding

1. Does the `chatgpt.com/backend-api/codex/responses` endpoint accept `tools`? If not, force `useDirectApi` path whenever the chat panel is opened. Need a probe request.
2. Does `gpt-5.5` support function calling on the Responses API at all under this account? Same probe.
3. What's the actual element-count threshold where snapshot tokens dominate the prompt? Current cap is 500; may need 200 for CDP-heavy DOMs.

## Build order (after spec sign-off)

1. **CDP read path** — agent file generation + live snapshot in system prompt + `cdp_get_text` tool. No mutating actions. Validate scope holds, model uses refs correctly.
2. **CDP write path** — add `cdp_click`, `cdp_type`. Validate on a low-stakes app first (Calculator-equivalent Electron, e.g. the detector itself).
3. **UIA read path** — `uia_get_tree`, agent-file generation for UIA apps.
4. **UIA write path** — `uia_invoke`, `uia_set_value`.
5. Polish: tool-call status UI, ref-not-found recovery, agent-file editor button in chat header.
