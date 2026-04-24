# PortOS — Development Plan

For project goals, see [GOALS.md](./GOALS.md). For completed work, see [DONE.md](./DONE.md).

---

## Next Up

1. **God file decomposition** — routes/cos.js ✅, routes/scaffold.js ✅, client/api.js ✅, services/digital-twin.js ✅ (split into 10 focused modules), services/subAgentSpawner.js ✅ (split into 9 focused modules). **All god files decomposed.**

## Proposed Features — 2026-04-24

Three high-value work items drawn from an inventory of the current app surface (45+ pages, 50+ services, rich Brain/Memory/Twin/Goals/Calendar systems with no unified conversational surface, static Dashboard, and growing sidebar sprawl).

### 1. Global Command Palette (`Cmd+K` / `Ctrl+K`) ✅ SHIPPED 2026-04-24

> Shared-backbone implementation complete. `server/lib/navManifest.js` is the single source of truth for navigation, consumed by both the palette (`GET /api/palette/manifest`) and the voice agent (`ui_navigate` via `resolveNavCommand`). Palette-safe voice tools dispatch through `POST /api/palette/action/:id`. See CLAUDE.md "Command Palette & Voice Nav" section for the entry shape every new page must register.

**Problem.** The sidebar now carries 45+ pages across 10+ collapsible sections (Brain, Calendar, Character, CoS, Data, DevTools, Digital Twin, MeatSpace, Messages, Settings…). Finding a page is becoming the slowest part of using the app — especially on mobile where the drawer is a finger marathon. The keyboard-shortcut help modal (`?`) already proved that a global overlay paradigm works here.

**What it is.** A single keystroke-triggered overlay with a fuzzy-matched input that unifies four action types into one search surface:

- **Navigate** — every route in `Layout.jsx` nav config, plus deep routes (e.g. `/brain/inbox`, `/cos/schedule`, `/meatspace/alcohol`).
- **Do** — run CoS tasks (`> Run task "sec audit"`), quick-capture a thought to Brain (`> Capture: …`), queue a voice agent prompt, trigger a loop, run an allowlisted shell command.
- **Jump to entity** — fuzzy-pick an app, agent, goal, thought, memory, repo, JIRA issue by title/slug.
- **Recent** — last 5 navigations / last 5 CoS task runs as default results when the palette opens empty.

**Why it's high value.**
- Zero-training UX for power users; instant on mobile as well (drawer is slow on small screens).
- Naturally surfaces features the user hasn't rediscovered yet — a palette exposes the whole app without demanding nav hierarchy be "right".
- Reuses existing data: routes table, CoS task list, Brain capture endpoint, Goals + Apps + Agents lists.

**Approach.**
- `client/src/components/CommandPalette.jsx` — Headless listbox, modal overlay, subscribes to `keydown` for `Cmd+K` / `Ctrl+K`. Follow the existing keyboard-shortcut modal pattern so focus traps + ESC behavior are consistent.
- `client/src/services/commandRegistry.js` — Each nav entry, CoS task type, and quick-action exports a `{ id, label, keywords, section, run() }` record. Registry is assembled at app boot; individual pages can register contextual commands (e.g. Brain page registers "Capture thought").
- Fuzzy ranker: tiny owned implementation (subsequence score + section prefix weight) — no new dependency. ~80 lines.
- Entity search hits existing endpoints (`/api/apps`, `/api/agents`, `/api/goals`, `/api/brain/search`) debounced at 150ms; cache last result in a `Map` keyed by query.
- Keyboard shortcut registered via the existing shortcuts help modal so it shows up there too.

**Size.** Medium. ~1 week. No new deps. Mostly additive.

**Definition of done.**
- `Cmd+K` opens the palette from any page, mobile included.
- Typing `goals` jumps to `/digital-twin/goals` in ≤2 keystrokes.
- Typing `> capture buy milk` records a Brain thought without leaving the current page.
- Escape / outside-click closes cleanly; palette reopens with the last query pre-selected for 30s.

---

### 2. Customizable Dashboard with Saved Layouts

**Problem.** `client/src/pages/Dashboard.jsx` hard-codes the widget list: `BackupWidget`, `SystemHealthWidget`, `CosDashboardWidget`, `GoalProgressWidget`, `UpcomingTasksWidget`, `DecisionLogWidget`, `DeathClockWidget`, `ProactiveAlertsWidget`, `QuickBrainCapture`, `QuickTaskWidget`, `ReviewHubCard`. Every user-visible feature competes for space on the same grid; nothing can be hidden, reordered, or scoped to context. Already called out in `PLAN.md` Future Ideas as "Dashboard Customization — Drag-and-drop widgets, named layouts."

**What it is.** A dashboard with multiple named layouts the user can switch between via dropdown (or `Cmd+K`), each layout storing its own widget selection and order. Starter layouts:

- **Morning Review** — ProactiveAlerts, UpcomingTasks, ReviewHub, GoalProgress, DeathClock.
- **Focus** — QuickTask, CoS activity, UpcomingTasks only. Minimal chrome.
- **Health** — DeathClock, MeatSpace deltas, chronotype energy overlay, recent biomarkers.
- **Ops** — SystemHealth, CoS dashboard, Backup, recent app activity.
- **Everything** — the current all-widgets view, preserved as default.

**Why it's high value.**
- Dashboard is the most-opened page — every quality-of-life gain compounds.
- Context-sensitive layouts ("Focus" hides noise) directly support chronotype-aware work modes already in PortOS's DNA.
- Makes room to add new widgets later without further crowding — the feature scales.

**Approach.**
- `data/dashboard-layouts.json` — array of `{ id, name, widgets: [{ type, w, h, x, y, props? }] }`. Default layout seeded on first run from the current hard-coded order.
- `server/routes/dashboardLayouts.js` — GET/PUT with Zod validation; atomic write via `server/lib/fileUtils.js#atomicWrite` (which the audit backlog already wants extracted — this feature can be the forcing function).
- `client/src/components/DashboardGrid.jsx` — Lightweight 12-column grid. Evaluate: (a) write 150–200 lines of owned grid + drag handlers on top of HTML5 DnD, vs (b) resurrect the deferred `@dnd-kit/*` dep purely for accessibility (keyboard + ARIA). Decide in a brainstorm; lean toward owned code per project dep rules, falling back to `@dnd-kit` only if a11y correctness takes it past the 300-line ceiling.
- Widget registry: each widget exports `{ id, label, defaultSize, Component }`. Dashboard renders from the active layout, not a static import list.
- Layout picker: dropdown in the Dashboard header + palette commands `> Layout: Focus`.

**Size.** Medium–Large. ~1.5 weeks. Either no new deps (owned grid) or one resurrected dep with accessibility justification.

**Definition of done.**
- User can switch layouts from a dropdown and via `Cmd+K`.
- Drag-and-drop reorder persists across reload (keyboard-accessible).
- Hide/show widgets per layout; layouts survive PortOS restart.
- New widgets can be added by dropping a file into `client/src/components/dashboard/widgets/` and registering it — no Dashboard.jsx edit needed.

---

### 3. "Ask Yourself" — Unified Conversational Twin over Brain + Memory + Goals + Identity + Calendar

**Problem.** PortOS has spent many milestones building a rich model of the user: Brain (thoughts, daily log, notes, links), Memory (pgvector + BM25 hybrid retrieval), Digital Twin (identity, autobiography, personality, behavioral feedback), Goals, Calendar, MeatSpace biomarkers. These live on separate pages with separate inputs. There is still no single conversational surface where the user can ask their own system a question like *"What did I decide about my exercise routine in March?"*, *"What's on my plate this afternoon given how I slept?"*, or *"Draft a status update to my team as me."* Without this, the twin is a library nobody borrows from.

**What it is.** A dedicated "Ask" page (and a palette entry / voice intent) that runs a retrieval-augmented, twin-flavored chat:

- **Retrieval.** Every question fans out in parallel across memory semantic search, Brain notes full-text, Goals, Calendar events for the relevant time window, and recent MeatSpace metrics. Hybrid ranker picks top-N per source.
- **Persona.** System prompt injects the user's digital-twin preamble (tone, values, communication style) so answers sound like them — not like a generic assistant. Reuses the "Identity Context Injection" idea already in Future Ideas.
- **Modes.** `Ask` (answer as yourself), `Advise` (answer as a coach who knows you), `Draft` (produce text in your voice for a specified recipient/platform).
- **Trails.** Every answer shows its sources as expandable chips (click to jump to the Brain note / Memory / Goal / Calendar event). Builds trust and surfaces where knowledge is thin.
- **Continuations.** Each turn is saved to a short-lived conversation and can be one-click promoted to a Brain note, CoS task, or Goal update.

**Why it's high value.**
- Highest leverage feature relative to existing investment: nearly zero new data, maximum new utility. Takes the twin from "archive" to "assistant".
- Directly advances three GOALS.md pillars: Personal Knowledge Management, Digital Identity Modeling, Full Digital Autonomy.
- Pairs naturally with the existing voice widget — once text works, the same pipeline is the brain for "talk to yourself."

**Approach.**
- `server/services/askService.js` — Orchestrates: (a) parallel retrieval via existing `memoryEmbeddings` + `brain` + `goals` + `calendarGoogleApiSync` services, (b) source-weighted reranking, (c) prompt assembly with twin preamble from `services/character.js` / `services/identity.js`, (d) streamed completion through `portos-ai-toolkit` with the user's preferred model tier.
- `server/routes/ask.js` — `POST /api/ask` (stream via SSE or existing Socket.IO channel). Zod-validated `{ question, mode, timeWindow?, maxSources? }`.
- `client/src/pages/Ask.jsx` — Chat transcript, source chips, mode switcher, "turn into task/note/goal" actions. Deep-linkable per CLAUDE.md (e.g. `/ask/:conversationId`).
- Voice integration: register an `ask` intent that routes through the same service, so "Hey, what did I decide about X?" works without UI.
- Persistence: conversations live in `data/ask-conversations/` as JSON; auto-expire after 30 days unless promoted. Keeps the data store boring.
- Safety: no cross-user data (it's single-user), but cap retrieval to the user's own stores — never hit external APIs without explicit mode (`Ask web`).

**Size.** Large. ~3–4 weeks real-time. Ships in two slices: (a) text chat + sources (weeks 1–2), (b) voice + promotion actions (weeks 3–4). Each slice is shippable on its own.

**Definition of done (slice a).**
- `/ask` page accepts a question, streams an answer in the twin's voice, shows ≥3 source chips per answer.
- Clicking a source deep-links to the origin (Brain note, Memory item, Goal, Calendar event).
- Conversations persist and are listable at `/ask`.
- `Cmd+K` → typing a question routes into a new conversation.

**Definition of done (slice b).**
- Voice widget can route questions through the same pipeline.
- Each answer shows three 1-click promotions: "Save as Brain note", "Create CoS task", "Attach to Goal…".

---

## Backlog

- [ ] **Voice CoS tool expansion** — tools now include the original domain set plus `ui_navigate`, `ui_list_interactables`, `ui_click`, `ui_fill`, `ui_select`, `ui_check` for accessibility-style page driving. Remaining candidates:
  - `calendar_today` / `calendar_next` — surface today's Google Calendar events through the existing Google MCP integration
  - `meatspace_log_workout` — wrap `meatspaceHealth.js` workout/activity exports
  - `weather_now` — needs an external API choice (OpenWeather / Apple WeatherKit / NWS)
  - `timer_set` — set a voice-triggered reminder; likely reuses `agentActionExecutor.js` scheduled actions
  - `feeds_mark_read` — pair with `feeds_digest` for "mark that one read"

- [ ] **Voice agent — next power-ups** (follow-ons to the ui_* accessibility layer):
  - `ui_read` — extract visible page text (not just interactables) so "what does this say?" / "summarize this page" works without hand-navigation. Complements `ui_list_interactables`.
  - **Destructive-action confirmation gate** — when a `ui_click` target label matches `/delete|remove|discard|reset|clear/i`, pause and require spoken "confirm" / "cancel" before firing. Prevents voice mishaps.
  - **Vision fallback tool** (`ui_describe_visually`) — screenshot the current tab (or a named canvas/chart element) and send to a vision-capable model so "what's on this chart?" works on non-DOM content (CyberCity, graph views). Depends on whether `portos-ai-toolkit` wires a vision provider.
  - **Proactive CoS speech** — push-to-talk the other direction: a server event that makes the voice widget speak unprompted ("heads up: 3 things on your briefing" / "time to stretch"). Needs a quiet-hours policy and an interrupt-gracefully contract with the existing barge-in logic.
  - **Explicit long-term memory routing** — when the user says "remember that …", auto-route to `brain_capture` and inject top-N relevant memories into the voice turn's system prompt via `brain_search`. Some of this is ambiently possible today; make it explicit and self-improving.
- [x] **Test coverage** — cosRunnerClient.js ✅ (37 tests), agentActionExecutor.js ✅ (27 tests), CoS routes ✅ (170 tests across 6 test files, 83-100% route coverage). Remaining gap: cos.js service (~4% coverage)
- [ ] **CyberCity v2** — Transform from decorative scene to living systems dashboard. See [cybercity-v2.md](./docs/features/cybercity-v2.md) for full plan. Top priorities: system health atmosphere, richer billboards, brain inbox pulse, agent activity visualization, chronotype energy overlay.
- [ ] **M50 P9**: CoS Automation & Rules — Automated email classification, rule-based pre-filtering, email-to-task pipeline
- [ ] **M50 P10**: Auto-Send with AI Review Gate — Per-account trust level, second LLM reviews drafts. See [Messages Security](./docs/features/messages-security.md)
- [ ] **M34 P5-P7**: Digital Twin — Multi-modal capture, advanced testing, personas

**Known low-severity:** pm2 ReDoS (GHSA-x5gf-qvw8-r2rm) — no upstream fix, not exploitable via PortOS routes.

---

## Better Audit — 2026-04-21

Summary: 70+ findings across 45+ files. 2 foundation utilities to extract. 6 PR categories: security, code-quality, dry, bugs-perf, stack-specific, tests. Architecture + Dep Freedom categories deferred (deep refactors / high conflict risk).

### Foundation — Shared Utilities

1. `server/lib/fileUtils.js` — export `atomicWrite(filePath, data)` replacing 12 inline `tmp + rename` sequences across service files.
2. `server/services/socket.js` — add `broadcastToSet` + `registerSubscriber` helpers to collapse 6× duplicated subscriber/broadcast boilerplate (also fixes the missing `shellService.unsubscribeSessionList` on disconnect).

### Security & Secrets
- [ ] **[HIGH]** `react-router` 7.1.1 (client) — XSS CVEs (GHSA-2w69-qvjg-hvjx, GHSA-8v8x-cx79-35w7); upgrade to >= 7.5.2
- [ ] **[HIGH]** `socket.io-parser` 4.2.5 (server + client) — OOM DoS (GHSA-cqmj-92ph-6vvx); upgrade socket.io family
- [ ] **[HIGH]** `path-to-regexp` 8.3.0 via Express 5 — ReDoS; add root-package override
- [ ] **[HIGH]** `lodash` 4.17.23 via pm2 — code injection + prototype pollution; add override
- [ ] **[HIGH]** `basic-ftp` via pm2 — CRLF injection; add override
- [ ] **[MEDIUM]** `server/routes/database.js:326,330,334,422` — DDL identifier string interpolation; add `pgQuoteIdentifier` helper
- [ ] **[MEDIUM]** `server/services/jira.js:414` — JQL injection via `projectKey`/`query` string interpolation; escape `"`
- [ ] **[MEDIUM]** `follow-redirects`, `brace-expansion` transitive ReDoS/credential-leak — add overrides

### Code Quality
- [ ] **[HIGH]** `server/services/cos.js:3033-3035` — remove `NODE_ENV !== 'test'` init guard (test-specific hack in prod)
- [ ] **[HIGH]** `autofixer/server.js`, `autofixer/ui.js` — 20+ console.log statements missing emoji prefix (production server)
- [ ] **[HIGH]** `client/src/components/settings/GeneralTab.jsx` + VoiceTab/ImageGenTab/BackupTab/MortalLoomTab/TelegramTab/DatabaseTab — inconsistent `await X.then().catch().finally()` patterns; convert to try/catch
- [ ] **[MEDIUM]** `server/services/visionTest.js`, `agentPersonalityGenerator.js` — multi-line log blocks; combine
- [ ] **[MEDIUM]** `server/services/agentCliSpawning.js:293-304` — try/catch swallows claude settings read error
- [ ] **[MEDIUM]** `server/services/moltworldWs.js` (4 sites), `messageSender.js:46`, `DatabaseTab.jsx:227` — `.catch(() => {})` empty swallow; add warn logs
- [ ] **[MEDIUM]** `server/services/visionTest.js:124`, `server/routes/voice.js:160` — brittle `err.message.includes`/`startsWith` checks; use typed errors
- [ ] **[MEDIUM]** `server/services/cos.js:166,357`, `lmStudioManager.js:66` — extract magic numbers (90, 500, 30000) to named constants
- [ ] **[MEDIUM]** `client/src/components/Layout.jsx:149-171` — alphabetize nav (Data before Dev Tools)
- [ ] **[MEDIUM]** `client/src/pages/DataDog.jsx`, `Jira.jsx` — prefix `console.error` with `❌ `
- [ ] **[MEDIUM]** `server/lib/fileUtils.js:181,192,224,287` — emoji prefix on 4 console.warn
- [ ] **[MEDIUM]** `server/services/character.js:197-212` — `console.log` → `console.warn` in swallow-and-continue catch blocks

### DRY & YAGNI
- [ ] **[HIGH]** `server/services/socket.js:595-814` — 6× duplicated `broadcastTo*` + `subscribe`/`unsubscribe` pairs; extract helpers
- [ ] **[HIGH]** 12 service files — atomic write (`tmp + rename`) pattern duplicated; extract `atomicWrite` to `server/lib/fileUtils.js`
- [ ] **[HIGH]** 8 client components — `formatBytes`/`formatTime`/`formatDuration`/`timeAgo`/`formatDate` locally redefined; import from `client/src/utils/formatters.js`
- [ ] **[HIGH]** `server/services/dataManager.js:8` — lone `join(process.cwd(), 'data')`; use `PATHS.data` from `fileUtils.js` like 20+ other services
- [ ] **[MEDIUM]** `server/services/digital-twin-meta.js:12-13` — remove unused `soulEvents` alias; emit on `digitalTwinEvents` directly
- [ ] **[MEDIUM]** `server/services/messageSync.js:233` — replace dynamic `await import('uuid')` with static `lib/uuid.js` import

### Bugs, Performance & Error Handling
- [ ] **[CRITICAL]** `server/services/brain.js:113-116` — `setTimeout` never cleared on CLI child close/error; leaks for up to 300s
- [ ] **[CRITICAL]** `server/lib/telegramClient.js:94` — `pollLoop().catch(() => {})` silently kills polling; add log + 5s retry
- [ ] **[HIGH]** `server/services/clinvar.js:62` — 100MB+ NCBI fetch has no AbortSignal; add 5-minute timeout
- [ ] **[HIGH]** `server/services/brain.js:126` — API provider fetch has no AbortSignal; add `provider.timeout || 300000`
- [ ] **[HIGH]** `server/services/socket.js` disconnect handler — missing `shellService.unsubscribeSessionList(socket)`; unbounded Set growth
- [ ] **[HIGH]** `server/services/loops.js:308` — floating `executeIteration(loop)` promise; errors silently lost
- [ ] **[MEDIUM]** `server/services/aiDetect.js:166`, `meatspacePostLlm.js:91`, `memoryEmbeddings.js:202,243`, `telegramBridge.js:102` — missing AbortSignal timeouts
- [ ] **[MEDIUM]** `server/lib/httpClient.js:38` — abort event listener never removed; closure leak
- [ ] **[MEDIUM]** `server/services/feeds.js:223-231` — sequential feed refresh; use concurrency-bounded `Promise.allSettled`
- [ ] **[MEDIUM]** `server/services/feeds.js:234-248` — full-sort-then-paginate on every request

### Stack-Specific
- [ ] **[MEDIUM]** `server/routes/systemHealth.js:13,32` — wrap async handlers with `asyncHandler`
- [ ] **[MEDIUM]** `server/index.js` — no SIGTERM/SIGINT handler; add graceful pool.close() + httpServer.close() on shutdown
- [ ] **[MEDIUM]** `client/src/components/messages/MessageDetail.jsx:50` — iframe image `'load'` listeners never removed; use `{ once: true }`

### Test Quality & Coverage (Phase 4c)
- [ ] **[CRITICAL][VACUOUS]** `server/services/agents.test.js` — entire file re-implements agent logic inline; never imports `agents.js`. Rewrite against real exports.
- [ ] **[CRITICAL][VACUOUS]** `server/services/socket.test.js` — entire file tests local vars; never imports `socket.js`. Rewrite against real `initSocket`.
- [ ] **[CRITICAL][MISSING]** `server/services/cos.js` — 3035-line god file, no test sibling. Add tests for `evaluateTasks` priority ordering + `dequeueNextTask` capacity guards.
- [ ] **[CRITICAL][MISSING]** `server/services/agentLifecycle.js` — no tests for `spawnAgentForTask` or `handleAgentCompletion`.
- [ ] **[HIGH][MISSING]** `server/services/loops.js`, `clinvar.js`, `telegramBridge.js` — create test files.
- [ ] **[HIGH][VACUOUS]** `server/services/usage.test.js` — asserts `typeof === 'number'`; mock I/O and assert exact streak values.
- [ ] **[HIGH][VACUOUS]** `server/services/cosRunnerClient.test.js:68-75` — "no throw" assertion is trivially true; fire mock event, assert handler called.
- [ ] **[HIGH][WEAK]** `server/routes/cos.test.js` — mocks full service; add tests where mocked functions throw.
- [ ] **[HIGH][WEAK]** `server/services/subAgentSpawner.test.js:14-260` — `selectModelForTask` re-implemented locally; import real function.
- [ ] **[MEDIUM]** `thinkingLevels.test.js`, `brainSyncLog.test.js`, `featureAgents.test.js`, `brain.test.js` — weak/vacuous assertions.

### Deferred to Backlog (too risky / too broad for auto-remediation)

**Architecture refactors** (tracked for human-led planning):
- `server/services/cos.js` — 3035-line god file split into cosTaskStore/cosTaskGenerator/cosJobScheduler/cosHealthMonitor
- `server/services/agentLifecycle.js` — 1271 lines; extract prepareAgentWorkspace/resolveProvider/processCompletion
- `server/services/identity.js` — 1917 lines mixing genomic markers + longevity + goals + todos
- `server/services/taskSchedule.js` — 2201 lines; extract prompt management to `taskPromptService.js`
- `server/services/socket.js` — fan-in coupling hub; split into domain-specific socket modules
- `server/routes/apps.js` — 1126 lines with inline `npm install` orchestration; extract to `appBuilder.js`
- `server/routes/scaffold.js` — scaffold generation logic belongs in `services/scaffolding/`
- `server/cos-runner/index.js:395-612` — 217-line inline /spawn handler; extract service
- `client/src/components/goals/GoalDetailPanel.jsx` — 1141-line god component
- `autofixer/ui.js` — 972-line file with inline HTML template
- API contract inconsistency — standardize error response shapes (`asyncHandler` + `ServerError` everywhere)
- Dependency inversion — extract `cosTaskStore.js` so `agentLifecycle.js` doesn't import from high-level `cos.js`

**Dep Freedom**:
- `server/lib/uuid.js` — local wrapper over `crypto.randomUUID()`; retiring requires updating 43 import sites — defer until naturally touched

## Depfree Audit — 2026-03-31 (Heavy Mode) ✅ COMPLETE

**Summary:** Removed 13 of 15 targeted packages. 2 deferred (`@dnd-kit/*`, `recharts`) — replacement effort exceeds 300-line heavy-mode ceiling. ~1,100 lines of owned replacement code written across 9 new files.

### All Replacements (complete)

| Package | Replacement | Status |
|---------|-------------|--------|
| `uuid` | `server/lib/uuid.js` — `crypto.randomUUID()` shim | ✅ |
| `cors` | Inline `Access-Control-*` headers in `index.js` + scaffold | ✅ |
| `axios` | `server/lib/httpClient.js` — fetch + AbortSignal.timeout + self-signed TLS | ✅ |
| `multer` | `server/lib/multipart.js` — streaming multipart, no buffering | ✅ |
| `unzipper` | `server/lib/zipStream.js` — streaming ZIP via zlib.createInflateRaw | ✅ |
| `node-telegram-bot-api` | `server/lib/telegramClient.js` — fetch-based polling + EventEmitter | ✅ |
| `supertest` | `server/lib/testHelper.js` — HTTP server lifecycle + fetch request wrapper | ✅ |
| `geist` | Fonts self-hosted in `client/public/fonts/` | ✅ |
| `globals` | Inlined in `client/eslint.config.js` | ✅ |
| `fflate` | Native `DecompressionStream` + inline EOCD ZIP parser in `GenomeTab.jsx` | ✅ |
| `react-markdown` | Inline regex block/inline parser in `MarkdownOutput.jsx` | ✅ |
| `react-diff-viewer-continued` | Inline Myers LCS diff in `CrossDomainTab.jsx` | ✅ |
| `react-hot-toast` | `client/src/components/ui/Toast.jsx` — module-level store + Toaster | ✅ |
| `@dnd-kit/*` | **Deferred** — keyboard nav + ARIA puts replacement >300 lines | ⏸ |
| `recharts` | **Deferred** — 9-file rewrite exceeds ceiling | ⏸ |

**Note:** Validate `server/lib/zipStream.js` with a real Apple Health ZIP before next release.

### Dependencies Kept (with rationale)

| Package | Tier | Reason Kept |
|---------|------|-------------|
| `express` | 1 | Foundational web framework |
| `googleapis` | 1 | Large official Google API client — infeasible to replace |
| `node-pty` | 1 | Native PTY addon — no pure-JS equivalent |
| `pg` | 1 | PostgreSQL driver — foundational, widely audited |
| `pm2` (root + server) | 1 | Process manager SDK used throughout server for app lifecycle |
| `portos-ai-toolkit` | 1 | Internal project toolkit |
| `socket.io` + `socket.io-client` | 1 | WebSocket framework — foundational, handles transport negotiation |
| `zod` | 1 | Validation — used on every route via `lib/validation.js` |
| `vitest` + `@vitest/coverage-v8` | 1 | Test runner — build tooling |
| `sax` | 2 | Streaming XML parser for Apple Health 500MB+ exports; no native equivalent |
| `ws` | 2 | CDP protocol in 3 service files; `socket.io` transitively depends on it |
| `lucide-react` | 2 | 186 icons, 182 files — SVG replacement would be 1,000–1,500 lines |
| `@react-three/drei` | 1 | CyberCity 3D components — each alone is 200+ lines of Three.js |
| `@react-three/fiber` | 1 | React-Three.js integration — foundational for CyberCity 3D |
| `@xterm/xterm` + addons | 1 | Terminal emulator — no browser-native replacement |
| `react` + `react-dom` | 1 | Foundational |
| `react-router-dom` | 1 | Routing — foundational |
| `three` | 1 | 3D rendering engine — core to CyberCity feature |
| `@dnd-kit/*` | 2 | Deferred — accessibility (keyboard nav + ARIA) adds significant complexity |
| `recharts` | 2 | Deferred — 9-file rewrite exceeds 300-line ceiling |
| `eslint` + plugins + `tailwindcss` + `vite` | 1 | Build/lint tooling — org standard |
| `@eslint/js`, `@tailwindcss/postcss`, `@vitejs/plugin-react` | 1 | Build tooling |

---

## Future Ideas

- [x] **Chronotype-Aware Scheduling** — Genome sleep markers for peak-focus task scheduling
- **Identity Context Injection** — Per-task-type digital twin preamble toggle
- [x] **Agent Confidence & Autonomy Levels** — Dynamic tiers based on success rates
- **Content Calendar** — Unified calendar across platforms
- [x] **Proactive Insight Alerts** — Brain connections, success drops, goal stalls, cost spikes
- **Goal Decomposition Engine** — Auto-decompose goals into task sequences
- **Knowledge Graph Visualization** — Extend BrainGraph 3D to full knowledge graph
- [x] **Time Capsule Snapshots** — Periodic versioned digital twin archives
- **Autobiography Prompt Chains** — LLM follow-ups building on prior answers
- **Legacy Export Format** — Identity as portable Markdown/PDF
- **Dashboard Customization** — Drag-and-drop widgets, named layouts
- **Workspace Contexts** — Project context syncing across shell, git, tasks
- **Inline Code Review Annotations** — One-click fix from self-improvement findings
- **Major Dependency Upgrades** — React 19, Zod 4, PM2 6, Vite 8
- [x] **Voice Capture for Brain** — Microphone + Web Speech API transcription
- [x] **RSS/Feed Ingestion** — Passive feed ingestion classified by interests
- [x] **Ambient Dashboard Mode** — Live status board for wall-mounted displays
- **Dynamic Skill Marketplace** — Self-generating skill templates from task patterns
