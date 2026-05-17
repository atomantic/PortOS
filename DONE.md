# PortOS — Completed Milestones

Archive of completed work — feature-level only. Each release ships a per-version file under [.changelog/](./.changelog/) with the full implementation specifics; this file is the bird's-eye view for understanding what the app does and when it shipped.

For active roadmap see [PLAN.md](./PLAN.md). For project goals see [GOALS.md](./GOALS.md).

---

## 2026-05

- **Importer — section follow-ups landed.** Auto-detect content type stage (`importer-classify`, light-tier head pass that pre-selects the radio); in-place `proseExcerpt` edit affordance per issue card so users can trim/correct boundaries without re-running Analyze (3 heavy-tier calls); `replaceMode` flag wipes existing issues + overwrites arc/seasons on re-import (destructive opt-in for existing series); partial-commit retry now drops arc/seasons/canon from the retry payload via `arcAlreadyPersisted` context so a parallel-tab edit isn't overwritten; React.memo on per-issue and per-season cards (with stable patcher + memoized seasonOptions) so unedited cards skip render on keystroke; `ARC_SHAPE_IDS` exposed via `/importer/config` and `IMPORTER_ARC_ROLES_FALLBACK` retired from the client (server is now the sole source of arc roles + shape ids); screenplay-prompt split logic gates on `isUserRequestedCount` rather than conflating it with the per-type default; "(first season)" UI label replaced with the actual lowest-numbered season + title.
- **Sharing — auto-unsubscribe on local record delete.** `recordEvents.js` now hooks `deleteSeries` / `deleteUniverse` so orphaned `data/sharing/subscriptions.json` entries clean up automatically instead of logging errors on the next re-export attempt.
- **Pipeline — `spawningTasks` lifecycle.** Widened try/finally around `spawnAgentForTask` (`server/services/agentLifecycle.js`) so a throw in any async setup step releases the per-task spawn lock instead of stranding it forever.
- **Pipeline — `creativeDirectorPrompts.test.js` imageStrength assertions.** Test now matches the updated prompt template wording; full suite passes.
- **Importer — Create Suite reverse-engineering page.** `/importer` analyzes a finished story / novel / screenplay / comic script and produces universe canon + series arc + prose-seeded issues; three new stage prompts with Mustache content-type branching; case-insensitive find-or-create; locked-arc gating.
- **Universe-as-Canon Phase B.4 schema teardown.** Removed `series.{characters,settings,objects}` from sanitizer + Zod schemas; deleted `extractAndMergeIntoSeries` / `refineCharacterDescription` / `nounRefine.js` / `purgeImageRefFromAllSeries`; routes `POST /pipeline/series/:id/extract-bible` + `/characters/:entryId/refine` removed; `seriesCanon.js` simplified to universe-or-empty.
- **Universe Canon UX follow-ups.** Per-series filter dropdown on Universe Canon page (`?series=<id>` URL param); "Appears in" list sorted by `issueCount`; per-series `stylePromptOverride` wired through `applyWorldStyle` + NounsStage previews.
- **Sharing v1.4 — collection-aware universe shares.** `mediaCollections.universeId` links a collection to its parent universe; exporter bundles the collection + items + assets + media-job records; importer find-or-creates the local collection and unions items; item add/remove emits `recordEvents` on the linked universe so subscriptions auto-re-export.
- **Sharing — route-level tests for `server/routes/sharing.js`.** New `server/routes/sharing.test.js` covers bucket CRUD, export (kinds + missing-payload refinement), inbox actions, subscriptions, activity, and error mapping (28 tests). Locks the HTTP/JSON contract (Zod rejection + 201 vs 200 + service-error code passthrough) that integration.test.js + subscriptions.test.js previously bypassed by exercising the service layer directly.
- **Sharing — manifest archive pruning.** Long-lived sharing buckets no longer accumulate thousands of one-shot manifest JSONs; owned manifests over the cap are archived (peer/subscription manifests exempt).
- **Sharing — display-name & bio settings tab.** Source-attribution fields now also editable under `/settings/sharing`.
- **Pipeline — Story Arc Planning.** PipelineSeries rebuilt into an Arc → Season → Episode tree with three LLM passes (arc overview, per-season episodes, cross-season verify) and a two-pane bible-sidebar + card-canvas layout.
- **Writers Room ↔ Pipeline unification.** Shared story-bible schema (Character/Setting/Object), staged-LLM runner, scene-prompt composer, bible-extraction service, prompt-template partials, "Promote work to Pipeline" bridge, and Storyboards auto-fill from prose or TV script.
- **Creative Director — episode video end-to-end.** Pipeline `episodeVideo` stage wires storyboards → CD treatment → render → final stitched MP4 inline; slim API endpoint, ScenePreview component, multi-frame evaluator sampling, auto-accept ffprobe watchdog, cheaper smoke-test fixture, per-scene `imageStrength` for i2v continuity.
- **CoS — Workflow tab.** Left-to-right pipeline view of all scheduled tasks + autonomous jobs grouped into seven canonical stages with `runAfter` dependency arrows.
- **CoS — review-loop auto-merge.** Tasks with `openPR + reviewLoop` now spawn a follow-up agent that polls Copilot, pushes fixes until clean, and `gh pr merge --squash --auto`.
- **CoS — dismissible AI recommendations.** Per-card X dismisses Learning Analytics suggestions; count-based alerts only re-surface on significant growth.
- **World Builder for Media Gen.** One-line starter prompt expands via LLM into a structured prompt set (style prefix, negative, 6–10 variations across five buckets) and batch-renders into an auto-named Media Collection.
- **Civitai / Z-Image follow-ups (six cleanups).** `RUNNER_FAMILIES` constants module, shared `deepMerge` / `assertSafeFilename` utilities, drift-warning for `mediaModels.js`, and CLI `--model` flag now honored across claude-code + gemini-cli + codex.
- **Shared `<Modal>` component.** Nine modal call sites converged onto one accessible Modal with backdrop + Esc + portal + ARIA.
- **Shared LLM / JSON / Python runner helpers.** Unified four near-identical "call provider, accumulate text, reject on error" implementations into `promptRunner.js`; consolidated three CLI-banner JSON extractors into `jsonExtract.js`; extracted ~200 LOC of duplicated device/HF-error handling from flux2 + z-image Python runners into `_runner_common.py`.
- **Video Gen — LTX-2.3 capabilities.** Native audio-to-video (a2v) on dgrauet (WAV/MP3 + optional first-frame conditioning); native Extend pipeline replacing the legacy chained-i2v fallback; FFLF keyframe-pair guidance hint; deprecated notapalindrome models grouped under "Legacy".
- **Pipeline — auto-run resumption.** On boot, stuck `running` issues demote to `needs-review` so a crash mid-run doesn't strand the pipeline.

## 2026-04

- **Global Command Palette (⌘K).** Single nav manifest (`navManifest.js`) shared by palette + voice agent's `ui_navigate`; any new page registered there is instantly keyboard- and voice-reachable.
- **Customizable Dashboard with Saved Layouts.** 15-widget registry + named layouts (`default` / `focus` / `morning-review` / `ops`) with drag/resize Arrange mode; `⌘K` switches layouts by name.
- **Ask Yourself.** Conversational `/ask` mode with parallel retrieval across memory + brain notes + autobiography + goals + calendar; voice `ui_ask` entry point with intent-classifier gating; per-turn promotions ("Save as Brain note" / "Create CoS task" / "Attach to Goal…").
- **God-file decomposition.** `routes/cos.js`, `routes/scaffold.js`, `client/api.js`, `services/digital-twin.js`, and `subAgentSpawner.js` split into focused modules.
- **Better-Audit remediation.** Security overrides for transitive deps (path-to-regexp, lodash, basic-ftp, etc.), centralized helpers (`pgQuoteIdentifier`, `escapeJql`, `atomicWrite`), graceful SIGTERM/SIGINT shutdown, fetch-timeouts via `AbortSignal.timeout` across remaining sites, and significant CoS-route test coverage expansion (83–100%).

## 2026-03

- **Depfree audit (heavy mode).** Removed 13 third-party packages (`uuid`, `cors`, `axios`, `multer`, `unzipper`, `node-telegram-bot-api`, `supertest`, `geist`, `globals`, `fflate`, `react-markdown`, `react-diff-viewer-continued`, `react-hot-toast`) by writing ~1,100 lines of owned in-tree replacements.
- **Keyboard Shortcuts Help Modal.** Press `?` for a global accessible overlay listing all shortcuts grouped by section.
- **Code-hardening pass.** `response.ok` checks across PromptManager fetches, type-safe sort comparators, replaced silent catches with logging, optional-chaining on DB row access, centralized 15 path constants in `PATHS`, migrated 36 files to centralized paths, replaced 57 `mkdir({recursive:true})` with `ensureDir()`.

---

## Numbered Milestones (M0–M56)

These are the major capability landmarks the app reached over its life. Each links to a feature doc where one exists.

- [x] **M0–M3**: Bootstrap, app registry, PM2 integration, log viewer — Core infrastructure
- [x] **M4**: App Wizard — Register existing apps or create from templates. See [App Wizard](./docs/features/app-wizard.md)
- [x] **M5**: AI Providers — Multi-provider AI execution with headless Claude CLI
- [x] **M6**: Dev Tools — Command runner with history and execution tracking
- [x] **M8**: Prompt Manager — Customizable AI prompts with variables and stages. See [Prompt Manager](./docs/features/prompt-manager.md)
- [x] **M9**: Streaming Import — Real-time websocket updates during app detection
- [x] **M10**: Enhanced DevTools — Provider/model selection, screenshots, git status, usage metrics
- [x] **M11**: AI Agents Page — Process detection and management
- [x] **M12**: History Improvements — Expandable entries with runtime/output capture
- [x] **M13**: Autofixer — Autonomous crash detection and repair. See [Autofixer](./docs/features/autofixer.md)
- [x] **M14**: Chief of Staff — Autonomous agent manager with task orchestration. See [Chief of Staff](./docs/features/chief-of-staff.md)
- [x] **M15**: Error Handling — Graceful error handling with auto-fix. See [Error Handling](./docs/features/error-handling.md)
- [x] **M16**: Memory System — Semantic memory with LLM classification. See [Memory System](./docs/features/memory-system.md)
- [x] **M17**: PM2 Config Enhancement — Per-process port detection and CDP_PORT support
- [x] **M18**: PM2 Standardization — LLM-powered config refactoring
- [x] **M19**: CoS Agent Runner — Isolated PM2 process for agent spawning. See [CoS Agent Runner](./docs/features/cos-agent-runner.md)
- [x] **M20**: AI Error Handling — Enhanced error extraction and CoS integration
- [x] **M21**: Usage Metrics — Comprehensive AI usage tracking and mobile UI
- [x] **M22**: Orphan Auto-Retry — Automatic retry for orphaned agents
- [x] **M23**: Self-Improvement — Automated UI/security/code analysis with Playwright
- [x] **M24**: Goal-Driven Mode — COS-GOALS.md mission file and always-working behavior
- [x] **M25**: Task Learning — Completion tracking and success-rate analysis
- [x] **M26**: Scheduled Scripts — Cron-based automation with agent triggering
- [x] **M27**: CoS Capability Enhancements — Dependency updates, performance tracking, learning insights
- [x] **M28**: Weekly Digest UI — Visual digest with insights and comparisons
- [x] **M29**: App Improvement — Comprehensive analysis extended to managed apps
- [x] **M30**: Configurable Intervals — Per-task-type scheduling (daily, weekly, once, on-demand)
- [x] **M31**: LLM Memory Classification — Intelligent memory extraction with quality filtering
- [x] **M32**: Brain System — Second-brain capture and classification. See [Brain System](./docs/features/brain-system.md)
- [x] **M33**: Soul System — Digital twin identity scaffold management. See [Soul System](./docs/features/soul-system.md)
- [x] **M34**: Digital Twin — Quantitative personality modeling and confidence scoring. See [Digital Twin](./docs/features/digital-twin.md)
- [x] **M35**: Chief of Staff Enhancement — Proactive autonomous agent with hybrid memory, missions, LM Studio, thinking levels. See [CoS Enhancement](./docs/features/cos-enhancement.md)
- [x] **M36**: Browser Management — CDP/Playwright browser page
- [x] **M37**: Autonomous Jobs — Recurring scheduled jobs the CoS executes using digital-twin identity
- [x] **M38**: Agent Tools — AI content generation, feed browsing, autonomous engagement for Moltbook agents
- [x] **M39**: Agent-Centric Drill-Down — Agent-first hierarchy with deep-linkable URLs and scoped sub-tabs
- [x] **M40**: Agent Skill System — Task-type-specific prompts and deterministic workflow skills. See [Agent Skills](./docs/features/agent-skills.md)
- [x] **M41**: CyberCity Immersive Overhaul — Procedural synthwave audio, post-processing, reflective wet-street ground (Phase 1 operational legibility shipped 2026-05)
- [x] **M42**: Unified Digital Twin Identity System — Identity orchestrator, chronotype derivation, personalized taste prompting, behavioral feedback loop, mortality-aware goal tracking, Identity Tab dashboard
- [x] **M43**: Moltworld Platform Support — Second platform integration for AI agents in a shared voxel world
- [x] **M44**: MeatSpace — Health tracker with death clock, LEV 2045 tracker, alcohol/blood/body/epigenetic/eye tracking, lifestyle questionnaire, TSV import, Apple Health integration
- [x] **M45**: Data Backup & Recovery — Rsync incremental backup with SHA-256 manifests, `pg_dump`, configurable cron, restore with dry-run preview
- [x] **M46**: Unified Search (Cmd+K) — Global search across brain, memory, history, agents, tasks, apps (later superseded by the Command Palette)
- [x] **M48**: Google Calendar Integration — MCP push sync + direct Google OAuth2, subcalendar management, goal-calendar linking, daily review, Life Calendar consolidated under Calendar > Lifetime
- [x] **M49**: Life Goals — Enhanced goal model with todos, velocity tracking, projected completion, AI phase planning, calendar time-blocking, automated weekly check-ins
- [x] **M50**: Email Management — Outlook API+Playwright sync, AI triage with security hardening, draft generation, thread capture, Gmail API sync+send
- [x] **M51**: Memory PostgreSQL Upgrade — pgvector HNSW vector search, tsvector full-text search, federation sync, `pg_dump` backup integration
- [x] **M52**: Update Detection — GitHub release polling, Socket.IO notifications, Update-tab UI with progress + health polling
- [x] **M53**: POST (Power On Self Test) — Daily cognitive self-test with mental-math, wit, and memory drills
- [x] **M54**: MeatSpace Life Calendar — "4000 Weeks" mortality-aware time mapping with goal-activity linking
- [x] **M55**: POST Enhancement — Memory builder, imagination drills, training mode, balanced sessions, wordplay games. See [POST](./docs/features/post.md)
- [x] **M56**: Telegram Bot Integration — External notification channel with conversational commands and goal check-in persistence

### Other major capabilities (un-numbered)

- [x] **GSD Tab** — Smart state detection, one-click agent spawn, actionable dashboard
- [x] **Database Management** — Native PostgreSQL mode reusing system pg on :5432, Docker/native switching UI, resource stats, per-backend backup buttons
- [x] **Review Hub** — Aggregated review page with alerts, CoS actions, todos, daily briefings
- [x] **JIRA Sprint Manager** — Autonomous JIRA triage and implementation as opt-in per-app scheduled task. See [JIRA Sprint Manager](./docs/features/jira-sprint-manager.md)
- [x] **App Icons + Non-PM2 Support** — Icon detection for iOS/macOS/Swift projects, non-PM2 app type management

---

## Code Audits

- **2025-02-19 Security Audit** — All 10 items resolved. See [Security Audit](./docs/SECURITY_AUDIT.md).
- **2026-03-05 Audit (Passes 1–3, PRs #67–72)** — App-status duplication, TOCTOU races, fetch-timeout gaps, Socket.IO reconnection bounds, memory-load races, duplicate constants, hook overuse.
- **2026-04 Better-Audit remediation** — See the 2026-04 section above.
- **Known low-severity:** pm2 ReDoS (GHSA-x5gf-qvw8-r2rm) — no upstream fix, not exploitable via PortOS routes.

---

## Documentation

### Architecture & Guides
- [Architecture Overview](./docs/ARCHITECTURE.md) — System design, data flow
- [API Reference](./docs/API.md) — REST endpoints, WebSocket events
- [Contributing Guide](./docs/CONTRIBUTING.md) — Code guidelines, git workflow
- [GitHub Actions](./docs/GITHUB_ACTIONS.md) — CI/CD workflow patterns
- [PM2 Configuration](./docs/PM2.md) — PM2 patterns and best practices
- [Port Allocation](./docs/PORTS.md) — Port conventions and allocation
- [Security Audit](./docs/SECURITY_AUDIT.md) — 2025-02-19 hardening audit (all resolved)
- [Troubleshooting](./docs/TROUBLESHOOTING.md) — Common issues and solutions
- [Versioning & Releases](./docs/VERSIONING.md) — Version format, release process

### Feature Documentation
- [Agent Skills](./docs/features/agent-skills.md)
- [App Wizard](./docs/features/app-wizard.md)
- [Autofixer](./docs/features/autofixer.md)
- [Brain System](./docs/features/brain-system.md)
- [Browser Management](./docs/features/browser.md)
- [Chief of Staff](./docs/features/chief-of-staff.md)
- [CoS Agent Runner](./docs/features/cos-agent-runner.md)
- [CoS Enhancement](./docs/features/cos-enhancement.md)
- [Digital Twin](./docs/features/digital-twin.md)
- [Error Handling](./docs/features/error-handling.md)
- [Identity System](./docs/features/identity-system.md)
- [JIRA Sprint Manager](./docs/features/jira-sprint-manager.md)
- [Memory System](./docs/features/memory-system.md)
- [Messages Security](./docs/features/messages-security.md)
- [POST](./docs/features/post.md)
- [Prompt Manager](./docs/features/prompt-manager.md)
- [Soul System](./docs/features/soul-system.md)
