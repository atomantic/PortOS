# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install all dependencies
npm run install:all

# Start (builds client, serves production UI + API on port 5555)
npm start

# Development (Vite hot-reload on 5554, API on 5555)
npm run dev

# Run tests
cd server && npm test
cd server && npm run test:watch  # Watch mode

# PM2 management
pm2 start ecosystem.config.cjs
pm2 stop ecosystem.config.cjs
pm2 logs
```

## Security Model

PortOS is a **single-user, single-instance** application running on a private network behind Tailscale VPN. It is not exposed to the public internet. There is exactly one user and one server process — concurrent request races, mutex locking on file I/O, and atomic write patterns are unnecessary and should not be added or flagged as concerns. Simple re-entrancy guards (e.g., per-account sync locks to prevent duplicate in-flight operations) are fine and expected. As such, it intentionally omits authentication, CORS restrictions, rate limiting, HTTPS, and full concurrency controls — these are non-issues for its deployment context. Do not add these or flag their absence as security concerns.

The default database password `portos` (in `ecosystem.config.cjs`, `docker-compose.yml`, and `.env.example`) is an intentional backward-compatible fallback for local development. Do not remove it or flag it as a security concern. Production deployments override it via the `PGPASSWORD` environment variable.

## Architecture

PortOS is a monorepo with Express.js server (always user-facing on `:5555`, HTTP or HTTPS) and React/Vite client (Vite dev server on `:5554` in `npm run dev`; in `npm start` the built client is served from `:5555` directly). PM2 manages app lifecycles. Data persists to JSON files in `./data/`.

### Port Allocation

PortOS uses ports 5553-5561. In native mode, PostgreSQL uses the system pg on port 5432; in Docker mode, port 5561.

The user-facing port is always **`:5555`** — its scheme flips between HTTP and HTTPS based on whether a TLS cert is provisioned (`npm run setup:cert`), but the port number does not. When HTTPS is on, a loopback-only HTTP mirror also spawns on `:5553` so local curl/scripts don't have to deal with cert warnings. `:5554` is the Vite dev server, used only in `npm run dev`.

Define all ports in the top-level `PORTS` object in `ecosystem.config.cjs` (see `server/lib/ports.js` for the canonical re-export). See `docs/PORTS.md` for the full port allocation guide and a diagram of how `:5555`, `:5553`, and `:5554` relate.

### Server (`server/`)
- **Routes**: HTTP handlers with Zod validation
- **Services**: Business logic, PM2/file/Socket.IO operations
- **Lib**: Shared validation schemas

### Client (`client/src/`)
- **Pages**: Route-based components
- **Components**: Reusable UI elements
- **Services**: `api.js` (HTTP) and `socket.js` (WebSocket)
- **Hooks**: `useErrorNotifications.js` subscribes to server errors, shows toast notifications

### Data Flow
Client → HTTP/WebSocket → Routes (validate) → Services (logic) → JSON files/PM2

### AI Toolkit (`server/lib/aiToolkit/`)

The AI provider/runner/prompt toolkit is vendored in-tree at `server/lib/aiToolkit/`. (It was previously the `portos-ai-toolkit` npm package.) Keep the directory self-contained — no imports out to other PortOS modules — so future upstream syncs don't fight local edits.

**Key points:**
- `server/lib/aiToolkit/index.js` exports `createAIToolkit`, `createProviderStatusService`, and the four Router factories (providers / runs / prompts / providerStatus)
- Provider configuration (models, tiers, fallbacks) lives in `server/lib/aiToolkit/providers.js`
- `loadProviders()` auto-migrates legacy codex configs to the `codex-configured-default` sentinel; `server/index.js` warms it at startup so the rewrite happens before any request
- PortOS extends toolkit routes in `server/routes/providers.js` for vision testing and provider status (status routes live in PortOS, not the toolkit, because they call PortOS-side socket helpers)
- When adding new provider fields (e.g., `fallbackProvider`, `lightModel`), update `createProvider()` in `server/lib/aiToolkit/providers.js`
- `updateProvider()` uses spread so existing providers preserve custom fields, but `createProvider()` has an explicit field list

**Override consistency.** PortOS replaces `aiToolkit.services.runner.executeCliRun` in `server/index.js` with a stdin-based variant that knows the per-CLI argv conventions (Codex `exec -`, Gemini stdin piping, Claude Code `-p -`). The PortOS variant tracks live child processes in `_portosActiveRuns`, not the toolkit's internal `activeRuns` map. **Every sibling method that reads or writes the runner's process map must be patched together** — `stopRun` and `isRunActive` are already overridden alongside `executeCliRun`; if you add a new method that touches active runs (e.g. `pauseRun`, `getActiveRunCount`), add a matching override or the runs router will report inconsistent state. The same principle applies to time-based state transitions: `providerStatus.init()` clears expired `estimatedRecovery` entries, so every reader (`getStatus`, `getAllStatuses`, `isAvailable`) must re-apply the same recovery check on read — otherwise providers stay "unavailable" past their recovery deadline until the next process restart.

### Command Palette & Voice Nav — shared backbone (`server/lib/navManifest.js`)

PortOS has a single source of truth for navigation: `server/lib/navManifest.js` exports `NAV_COMMANDS` (every navigable page: `{ id, path, label, section, aliases, keywords }`) and `resolveNavCommand()` (the fuzzy resolver). It is consumed by:

- The **`⌘K` Command Palette** (`client/src/components/CmdKSearch.jsx`) via `GET /api/palette/manifest`.
- The **voice agent's `ui_navigate` tool** (`server/services/voice/tools.js`) — so "take me to tasks" resolves through the same map the palette uses.

**When adding a new page, you MUST also add an entry to `NAV_COMMANDS`.** Adding only a `<Route>` in `App.jsx` and a sidebar link in `Layout.jsx` will leave the page unreachable from `⌘K` and un-navigable by voice. Entry shape:

```js
{ id: 'nav.<section>.<slug>', path: '/foo/bar', label: 'Bar', section: 'Foo',
  aliases: ['foo-bar', 'bar'], keywords: ['synonyms', 'context'] }
```

- `id` — stable, dotted (`nav.brain.inbox`). Must be unique.
- `path` — exact route the client router matches; must start with `/`.
- `section` — matches the sidebar group label so the palette and sidebar stay visually aligned.
- `aliases` — short spoken/typed tokens the user is likely to say. The voice agent's fuzzy resolver tries each alias with tiered matching; more aliases = more forgiving voice navigation.
- `keywords` — extra terms used only by the palette's in-UI scorer (synonyms, feature names).

Fail-fast guards at module load catch missing fields, non-slash paths, and duplicate ids — so a bad entry blocks server boot instead of silently breaking palette/voice.

**For NEW voice-tool-style actions that should appear in `⌘K`:** add the tool to `server/services/voice/tools.js` (it's the single source of action schemas), then whitelist its `id` in the `PALETTE_ACTIONS` array in `server/routes/palette.js` with a `section` + `label`. Do not duplicate the tool's description or parameters — the palette route hydrates them from `getToolSpecs()` at request time. DOM-driving tools (`ui_click`, `ui_fill`, etc.) stay off the palette whitelist because the palette has no live DOM context.

**Tests:** `server/lib/navManifest.test.js` asserts shape invariants + alias resolution; `server/routes/palette.test.js` asserts the manifest endpoint + action dispatch + whitelist enforcement. Any new entry is automatically covered by the shape-invariant tests.

### Dashboard Widgets & Layouts

Dashboard widgets are registered in `client/src/components/dashboard/widgetRegistry.jsx` — each entry has `{ id, label, Component, width, defaultH?, gate? }`. The Dashboard page renders the active layout's widget list from this registry; named layouts persist in `data/dashboard-layouts.json` and are managed via `GET/PUT/DELETE /api/dashboard/layouts`. Built-in layouts (`default`, `focus`, `morning-review`, `ops`) are seeded on first read and cannot be deleted.

**Grid positions:** layouts also carry a `grid: [{ id, x, y, w, h }]` array — free-form positions on a 12-column grid (rows ~80px each). When `grid` is empty (legacy/unmigrated layouts) the renderer auto-flows widgets using `synthesizeGrid` based on each widget's `width` keyword and `defaultH`. The "Arrange" button on the Dashboard enters edit mode where every widget exposes a move (top-right) and resize (bottom-right) handle; drag is snap-to-grid with collision-resolve via `placeAndCompact` (pins the moved item, slots others into the smallest non-colliding y). Save persists to the active layout's `grid`. The grid renderer collapses to a single-column stack below 640px viewport width — drag/resize is desktop-only.

**When adding a new dashboard widget:**
1. Add a `{ id, label, Component, width, defaultH?, gate? }` entry to `WIDGETS` in `widgetRegistry.jsx`. Use a stable `id` (kebab-case) — it's the contract stored in layouts. Pick `defaultH` based on the widget's natural content height (default `4`); this controls the size when it's first auto-placed into a grid.
2. If the widget needs dashboard data (apps/usage/health), read it from the `dashboardState` prop — do NOT issue a duplicate fetch from inside the widget.
3. If the widget only makes sense in some cases (e.g. only when apps exist), add a `gate: (state) => boolean` predicate.
4. Add the widget id to the built-in `default` layout in `server/services/dashboardLayouts.js` if it should appear out of the box.
5. Users can toggle widgets on/off per layout via the Dashboard's layout picker → Edit, and arrange/resize them via the "Arrange" button.

Switching layouts is also wired into the `⌘K` palette — it synthesizes a `Dashboard: <name>` command per layout at palette-open time, so any layout the user creates is instantly keyboard-reachable without further registration.

### Slashdo Commands (`lib/slashdo`)

PortOS bundles [slashdo](https://github.com/atomantic/slashdo) as a git submodule at `lib/slashdo`. This provides slash commands (`/do:review`, `/do:pr`, `/do:push`, `/do:release`, etc.) and shared libraries without requiring a separate global install.

**Key points:**
- Submodule lives at `lib/slashdo`, symlinked into `.claude/commands/do/` and `.claude/lib/`
- `npm run install:all` runs `git submodule update --init --recursive` automatically
- To update slashdo: `git submodule update --remote lib/slashdo`
- CoS agents can use `loadSlashdoCommand(name)` from `subAgentSpawner.js` to inline command content into prompts (resolves `!cat` lib includes automatically)
- The `.claude/commands/do/` symlinks make all `/do:*` commands available as project-level Claude Code slash commands

## Scope Boundary

When CoS agents or AI tools work on managed apps outside PortOS, all research, plans, docs, and code for those apps must be written to the target app's own repository/directory -- never to this repo. PortOS stores only its own features, plans, and documentation. If an agent generates a PLAN.md, research doc, or feature spec for another app, it goes in that app's directory.

## Worktrees

When working **directly in the Claude Code TUI** with the user driving, edit the main repo directly — don't spawn a worktree. Use normal feature branches and PRs (or push to `main`) when the work is done. The user is at the keyboard, so there is no risk of stepping on in-flight work.

**Worktrees are required only for CoS sub-agents** spawned out of `server/services/cos/subAgentSpawner.js`. Those run unattended in parallel and need isolation so they don't trample each other or the user's working tree. The worktree manager (`server/services/cos/worktreeManager.js`) handles this automatically — TUI sessions should not duplicate that behavior.

## Code Conventions

- **No try/catch** - errors bubble to centralized middleware. **Exception:** PTY/child-process/`setTimeout`/`setInterval` callbacks and any code that runs *outside* the Express request lifecycle. An uncaught throw there crashes the Node process (there is no `next(err)` to bubble to). At those boundaries, wrap hook invocation in try/catch and log via the emoji-prefixed `console.error` style. Async event handlers that mutate shared module-level state (e.g. the TUI spawner's `handleData`) must also be serialized — chain them onto a per-session/per-actor `Promise.resolve()` queue rather than firing concurrently, otherwise interleaved awaits race on shared buffers.
- **No window.alert/confirm** - use inline confirmations or toast notifications
- **Linkable routes for all views** - tabbed pages use URL params, not local state (e.g., `/devtools/history` not `/devtools` with tab state)
- **Functional programming** - no classes, use hooks in React
- **Zod validation** - all route inputs validated via `lib/validation.js`
- **Command allowlist** - shell execution restricted to approved commands only
- **Mobile responsive** - all pages should be mobile responsive friendly
- **Above the fold** - keep actionable content and info above the fold and design pages for maximum information and access without scrolling
- **No hardcoded localhost** - use `window.location.hostname` for URLs; app accessed via Tailscale remotely
- **Alphabetical navigation** - sidebar nav items in `Layout.jsx` are alphabetically ordered after the Dashboard+CyberCity top section and separator; children within collapsible sections are also alphabetical
- **Every new page registers in the nav manifest** - when adding a `<Route>` + sidebar link, also add a `NAV_COMMANDS` entry in `server/lib/navManifest.js`. This makes the page reachable via `⌘K` and voice (`ui_navigate`) automatically. See the "Command Palette & Voice Nav" section above for the entry shape.
- **Reactive UI updates** - after mutations (delete, create, update), update local state directly instead of refetching the entire list from the server. Use `setState(prev => prev.filter(...))` or similar patterns for immediate feedback
- **Single-line logging** - use emoji prefixes and string interpolation, never log full JSON blobs or arrays
  ```js
  console.log(`🚀 Server started on port ${PORT}`);
  console.log(`📜 Processing ${items.length} items`);
  console.error(`❌ Failed to connect: ${err.message}`);
  ```
- **LLM response merging — distinguish absent vs intentionally empty.** When merging an LLM response with existing state, "key absent" must preserve the original while "key present with empty value" must apply the intentional clear. Don't use `.length` truthiness as the signal — that conflates the two cases and silently restores values the user (or LLM) just cleared. Conventions:
  - Strings: treat `null`/`undefined` as absent, `""` as a clear. Server helpers like `universeBuilderExpand.trimField` should return `null` for non-strings, not `""`.
  - Arrays/objects: gate on `Array.isArray(parsed?.field)` / `typeof parsed?.field === 'object'` before deciding to fall back to the original.
  - Keep server-side merges and the client's `pick` helpers mirrored — a one-sided change breaks the round-trip.
- **Schema parity when adding fields.** When you add a field to a sanitizer, `createXxx`, or a payload shape, update the corresponding Zod schema (`server/lib/aiToolkit/validation.js` for toolkit shapes, `server/lib/validation.js` for PortOS routes) in the same change. Wire validation into POST and PUT (PUT can use `schema.partial()`); the PortOS convention is *all* inputs validated. Tolerate UI sentinels (`endpoint: ''` for CLI providers) with `z.preprocess(v => v === '' ? undefined : v, …)`. When a service migrates legacy keys on read, the schema must still accept the legacy shape so older clients don't 400 before the migration runs.
- **Silent vs. toasting API requests.** The `request()` helper in `client/src/services/apiCore.js` toasts errors by default. When a caller already owns its own error UI — either via `useAsyncAction` (which toasts on throw) or a `.catch(() => fallback)` that intentionally swallows the failure — pass `{ silent: true }` to the API helper so the toast only fires from one layer. Add an `options` parameter to new API wrappers so callers can opt into silent mode.
- **"Run Now" actions must gate on saved state, not the form input.** When a settings page has a companion "Run this now" button that triggers a server action reading server-side settings (not the local form values), the button must be gated on the *saved* value, not the in-memory input. Track a parallel `saved*` state for each setting the action depends on, update it on successful save, and use it for the action's enabled gate. Disable the action while the form is dirty *or* a save is in flight — a tooltip-only warning is missed on touch and produces surprising "I edited X and ran, but X didn't apply" bugs.
- **In-flight saves must gate dependent actions, not just the form.** When a field's PATCH is async and a button triggers server-side work that reads that field (auto-run, regenerate, etc.), the button must disable while the PATCH is in flight — not just while the input is "dirty." Otherwise the user picks a new value, the input clears, and they click the action before the server has the new value persisted. Track a `<field>Saving` boolean alongside the action's other disable predicates, set it before the PATCH and clear it in `.finally()`. See `PipelineIssue.jsx` `lengthProfileSaving` for the canonical example.
- **Async PATCH races on shared records — serialize writes server-side.** When two write paths can mutate the same record concurrently (e.g. a blur-save plus an explicit "Render" button against `stages.comicPages.cover`), client-side guards (refs, `onMouseDown`, status checks) are unreliable — keyboard activation, status==='unknown' stalls, and `loadState → modify → saveState` interleaving all defeat them. The correct fix is to serialize writes at the *file* level on the server (every PATCH awaits the previous one to settle before reading state, so it merges against the freshest persisted record). See `issueWriteTail` in `server/services/pipeline/issues.js`. A `Map<recordId, Promise>` is *not* enough — two writes to different record ids share the same JSON state file and can still clobber each other; collapse the queue to a single tail per shared file.
- **Stage-prompt template changes need a migration.** `scripts/setup-data.js` only copies *missing* prompt files to `data/prompts/stages/` — existing installs keep their old templates. When you add a `{{template.variable}}` reference to a `data.sample/prompts/stages/*.md` file, also add an entry to `data/migrations/NNN-…js` that updates the corresponding installed prompt when its hash still matches the pre-change shipped version. Normalize line endings (`\r\n` → `\n`, bare `\r` → `\n`) before hashing so the comparison is correct on Windows checkouts. The drift warning in `scripts/setup-data.js` distinguishes auto-updatable (matches old shipped hash) from customized (matches neither) — when adding to the migrated list, mirror both `OLD_SHIPPED_MD5` and `NEW_SHIPPED_MD5` there too so the warning stays actionable. See `data/migrations/003-update-pipeline-stage-prompts.js`.
- **High-frequency state writes must batch.** Per-line state mutations that round-trip through `withStateLock → loadState → saveState` (e.g. `appendAgentOutput` in `cosAgents.js`) are fine for human-pace events but catastrophic when called from a hot loop — PTY output streams, AI tool-call streams, or any producer that can emit dozens of events per second. When wiring a new streaming producer, add a batched variant that takes an array (see `appendAgentOutputLines` for the pattern) and flush from the caller on a ~250ms debounce. Always drain the pending buffer in the producer's `finish`/`cleanup` path before the final state write so completion events don't beat the last output batch to disk.
- **Socket event-driven state — don't pre-clear before the server confirms.** When swapping which entity a socket-driven UI is showing (shell session, agent run, etc.), wait for the server's success event to drive the swap atomically; the error event is the recovery point. Pre-clearing the local `*Ref` / visible state up front leaves the UI stranded on a dead URL when the success event never arrives (target died mid-request, server rejected the switch). Pair every `socket.on('X:error')` that follows a stateful request with a recovery branch that restores the previously-displayed state or falls back to a live alternative.
- **Single-subscriber socket resources need notify + recipient-relative advertise + filter + claim.** Some server-side resources (PTY shell sessions, etc.) intentionally store one attached socket and fan output to it. The contract: (1) emit `<resource>:detached` on the previous socket when a new socket takes over so the displaced client can drop its local view; (2) include an `attached: boolean` field on each list-entry payload, computed *relative to the recipient socket* (true only when bound to a different socket) — a globally-truthy `attached` makes a client's own sessions look unavailable to itself; (3) broadcast list updates from both attach AND detach paths; (4) auto-pick paths send `claim: true` and the server refuses to displace a different socket. Manual paths (tab click, deep-link URL) default to `claim: false` so explicit intent still wins. See `server/services/shell.js` for the canonical implementation.
- **Pending socket-request tracking — `{ target, generation }` ref.** When a stateful socket operation is in flight, track it as `{ target, generation }` and increment `generation` on every change. Response handlers gate on strict equality with `target` — null/stale/cancelled all fall through, so a cancelled-mid-flight response can't re-activate after the user moved on. Deferred work (`setTimeout` fallbacks) captures `generation` and aborts if it advanced. Pair every cancellation path with explicit `cancelPendingAttach()`-style helpers rather than overloading a `clearActiveSession()` helper — clearing the displayed entity and cancelling an in-flight request are *separate* concerns, and conflating them cancels user-initiated switches when an unrelated session dies. See `client/src/pages/Shell.jsx` `pendingAttachRef` for the pattern.
- **Server-correlate every async response, then filter display.** When the server emits `<resource>:error` in response to a client request, include the original `sessionId` / request id in the payload so the client can match against its pending state. Drop stale errors silently and gate the red-error display on correlation — rendering before classification flashes noise in the UI for requests the user has already moved past (rapid tab clicks, expected `claim:true` race rejections). Passive errors against the currently-displayed resource (e.g. `shell:input` to a now-dead session) should still display, but must not mutate pending state.
- **Distinguish intentional idle from passive idle.** A "no entity displayed" state can come from a user action (Stop / dismiss) or from passive circumstance (initial load found everything in-use elsewhere). Recovery branches that auto-adopt the next free entity must gate on a `userIdle*Ref` flag set by explicit user-clear paths and cleared by every user-initiated start/attach. The gate needs to cover every reconnect-triggered re-init path, not just the initial-load branch — a transient disconnect resets initialization flags, and an empty-list auto-start or survivor adoption can otherwise undo an explicit Stop on reconnect.
- **Deferred work must respect both staleness and unmount.** Any `setTimeout`-scheduled side effect that emits to the network or mutates shared state needs two guards: (1) a generation counter check so user actions during the delay window abort it, and (2) a `mountedRef` so a navigation-away unmount stops it from firing into the void. Pattern: `const mountedRef = useRef(true); useEffect(() => () => { mountedRef.current = false; }, []);` — never reset to `true` (handles dev-mode double-mount cleanly). Without the unmount guard, a deferred socket emit can claim a resource (e.g. shell session) with no listener left to render it.

## Tailwind Design Tokens

```
port-bg: #0f0f0f       port-card: #1a1a1a
port-border: #2a2a2a   port-accent: #3b82f6
port-success: #22c55e  port-warning: #f59e0b
port-error: #ef4444
```

## Git Workflow

- **main**: Active development
- **release**: Push `main` to `release` to trigger GitHub Release workflow
- **Push pattern**: `git pull --rebase --autostash && git push`
- **Changelog**: Append entries to `.changelog/NEXT.md` during development; `/do:release` (Claude Code slash command) finalizes it into a versioned file
- **Versioning**: Version in `package.json` reflects the last release. Do not bump during development — `/do:release` handles version bumps
- After each feature or bug fix, run `/simplify` and then commit and push code
- **Capture deferred work before finishing.** If during a task you identify a refactor, cleanup, abstraction, or enhancement that you decide *not* to do (out of scope, risk, time), append it to `PLAN.md` as a `- [ ]` item under the most relevant section (or a new sub-heading) with enough specificity that it can be picked up cold — file paths, line numbers, why it was skipped. Examples: code-review findings rated "skip for this PR," `/simplify` items deferred for scope, "we should also do X but later." Don't end a session with these living only in chat — they evaporate.
- If we have created enough commits to wrap up a feature or issue to warrant a production release, pull the latest main and release branches and then run `/do:release` from main

See `.changelog/README.md` for detailed format and best practices.
