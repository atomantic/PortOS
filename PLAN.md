# PortOS — Development Plan

For project goals, see [GOALS.md](./GOALS.md). For completed work, see [DONE.md](./DONE.md).

---

## Next Up

1. **Voice agent next power-ups** — `ui_read` (extract visible page text so "what does this say?" works without hand-navigation), destructive-action confirmation gate (pause and require spoken "confirm" when `ui_click` matches `/delete|remove|discard|reset|clear/i`), proactive CoS speech (server-pushed voice with quiet-hours policy + barge-in contract).
2. **Chronotype-aware CoS scheduling** — M42 ships chronotype derivation but `taskSchedule.js` still routes round-robin. Add a `temporalPreference` field to CoS task schema (`focus` / `low-energy` / `any`) and shift priority by time-of-day from the identity chronotype profile. Targeted addition (~150 lines), no new deps.
3. **God-file test coverage** — `cos.js` (3057 lines) and `agentLifecycle.js` (1283 lines) still have no test sibling. Add tests for `evaluateTasks` priority ordering + `dequeueNextTask` capacity guards (cos), and `spawnAgentForTask` + `handleAgentCompletion` error recovery (agentLifecycle).

## Backlog

- [ ] **Voice CoS tool expansion** — `calendar_today` / `calendar_next` (Google Calendar via existing MCP), `meatspace_log_workout` (wraps `meatspaceHealth.js`), `weather_now` (needs API choice — OpenWeather / WeatherKit / NWS), `timer_set` (reuses `agentActionExecutor.js` scheduled actions).
- [ ] **Voice agent vision fallback** — `ui_describe_visually` tool: screenshot the current tab (or a named canvas/chart) and send to a vision-capable model so "what's on this chart?" works on non-DOM content (CyberCity, graph views). Depends on a vision provider in `portos-ai-toolkit`.
- [ ] **Voice agent — explicit long-term memory routing** — On "remember that …", auto-route to `brain_capture` and inject top-N relevant memories into the voice turn's system prompt via `brain_search`. Some of this is ambient today; make it explicit and self-improving.
- [ ] **CyberCity v2** — Transform from decorative scene to interactive systems map. See [cybercity-v2.md](./docs/features/cybercity-v2.md). Phase 1 (operational legibility) underway: per-building health glyphs, "needs attention" pane, search overlay, status filter chips, clickable HUD stats, hover preview with quick actions, mobile/touch support.
- [ ] **M50 P9 — CoS Automation & Rules** — Automated email classification, rule-based pre-filtering, email-to-task pipeline.
- [ ] **M50 P10 — Auto-Send with AI Review Gate** — Per-account/per-recipient trust level + dual-LLM review (drafter + reviewer). Only auto-send when both approve or trust ≥ 0.9. See [Messages Security](./docs/features/messages-security.md).
- [ ] **M34 P5-P7 — Digital Twin** — Multi-modal capture (voice/video/image identity sources), advanced testing, personas. Ties to GOALS.md secondary "Multi-Modal Identity Capture".

### Depfree Audit — 2026-04-28

All dependencies audited and justified. 0 removals. See [docs/DEPS.md](./docs/DEPS.md) for the full classification table and per-package rationale.

### Better Audit — pending (2026-04-21)

- [ ] **[HIGH][DRY]** `server/services/socket.js:595-814` — extract `broadcastToSet` + `registerSubscriber` to collapse 6× duplicated subscriber/broadcast boilerplate (also fixes missing `shellService.unsubscribeSessionList` on disconnect).
- [ ] **[HIGH][CODE]** `server/services/cos.js:3055` — remove `NODE_ENV !== 'test'` init guard (test-specific hack in prod).
- [ ] **[CRITICAL][TESTS]** `server/services/cos.js` and `server/services/agentLifecycle.js` — add test files (covered in Next Up #3).
- [ ] **[HIGH][TESTS]** Create test files for `server/services/clinvar.js`, `telegramBridge.js`.
- [ ] **[MEDIUM][CLIENT]** 8 client components redefine `formatBytes`/`formatTime`/`formatDuration`/`timeAgo`/`formatDate` locally; import from `client/src/utils/formatters.js`.
- [ ] **[MEDIUM][PERF]** `server/services/feeds.js:234-248` — full-sort-then-paginate on every request.
- [ ] **[MEDIUM][CODE]** Various magic numbers in `cos.js:166,357`, `lmStudioManager.js:66`; brittle `err.message.includes`/`startsWith` checks in `visionTest.js:124` and `routes/voice.js:160`.

### Deferred Architecture (human-led planning)

- `server/services/cos.js` (3057 lines) — split into cosTaskStore / cosTaskGenerator / cosJobScheduler / cosHealthMonitor.
- `server/services/agentLifecycle.js` (1283 lines) — extract prepareAgentWorkspace / resolveProvider / processCompletion.
- `server/services/identity.js` (1917 lines) — separate genomic markers + longevity + goals + todos.
- `server/services/taskSchedule.js` (2233 lines) — extract prompt management to `taskPromptService.js`.
- `server/services/socket.js` — split into domain-specific socket modules.
- `server/routes/apps.js` (1126 lines) — extract `npm install` orchestration to `appBuilder.js`.
- `client/src/components/goals/GoalDetailPanel.jsx` (1252 lines) — god component.
- `autofixer/ui.js` (972 lines) — inline HTML template needs extraction.
- API contract — standardize error response shapes (`asyncHandler` + `ServerError` everywhere).

**Known low-severity:** pm2 ReDoS (GHSA-x5gf-qvw8-r2rm) — no upstream fix, not exploitable via PortOS routes.

---

## Future Ideas

- **Identity Context Injection** — Per-task-type digital twin preamble toggle.
- **Content Calendar** — Unified calendar across platforms.
- **Goal Decomposition Engine** — Auto-decompose goals into task sequences.
- **Knowledge Graph Visualization** — Extend BrainGraph 3D to full knowledge graph.
- **Autobiography Prompt Chains** — LLM follow-ups building on prior answers.
- **Legacy Export Format** — Identity as portable Markdown/PDF.
- **Workspace Contexts** — Project context syncing across shell, git, tasks.
- **Inline Code Review Annotations** — One-click fix from self-improvement findings.
- **Major Dependency Upgrades** — React 19, Zod 4, PM2 6, Vite 8.
- **Dynamic Skill Marketplace** — Self-generating skill templates from task patterns.
