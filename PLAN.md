# PortOS — Development Plan

For project goals, see [GOALS.md](./GOALS.md). For completed work, see [DONE.md](./DONE.md).

---

## Next Up

1. **M50 P8**: Messages — Digital Twin voice drafting for email responses (reads COMMUNICATION.md, PERSONALITY.md, VALUES.md + thread context)
2. **M42 P5**: Cross-Insights Engine — connect genome + taste + personality + goals into derived insights. See [Identity System](./docs/features/identity-system.md)
3. **M34 P5-P7**: Digital Twin — Multi-modal capture, advanced testing, personas

## Planned Details

### M50 P8-P10: Email Management (Remaining)

- [ ] **P8: Digital Twin voice drafting** — Draft responses using Digital Twin voice/style
- [ ] **P9: CoS Automation & Rules** — Automated classification on new emails via CoS job, rule-based pre-filtering, email-to-task pipeline, priority email notifications
- [ ] **P10: Auto-Send with AI Review Gate** — Configurable per-account trust level (manual > review-assisted > auto-send). Second LLM reviews drafts for prompt injection, tone drift, leaked instructions. See [Messages Security](./docs/features/messages-security.md)

### M42 P5: Cross-Insights Engine

- [ ] Connect genome markers, taste profiles, personality traits, and goal progress into cross-domain derived insights

### M34 P5-P7: Digital Twin Enhancement

- [ ] **P5**: Multi-modal capture (voice, video, image-based identity modeling)
- [ ] **P6**: Advanced testing (deeper behavioral profiling)
- [ ] **P7**: Personas (context-specific identity modes)

---

## Outstanding Audit Findings (2026-03-05)

**Known low-severity:** pm2 ReDoS (GHSA-x5gf-qvw8-r2rm) — no upstream fix, not exploitable via PortOS routes.

### Architecture (still present)
- [ ] `server/services/cos.js` (~3950 lines, 53 exports) — God file, needs decomposition
- [ ] `server/services/subAgentSpawner.js` (~3300 lines) — Mega service
- [ ] Circular dependency: `cos.js` <> `subAgentSpawner.js` via dynamic imports
- [ ] `client/src/services/api.js` (~1850 lines) — Monolithic API client
- [ ] `server/services/digital-twin.js` (~2800 lines) — Mixed concerns
- [ ] `server/routes/cos.js` (~1350 lines) — Business logic in route handlers
- [ ] `server/routes/scaffold.js` (~1670 lines) — God route file
- [ ] Inconsistent pagination patterns and error response envelope

### Bugs & Code Quality (still present)
- [ ] `server/services/agentActionExecutor.js:137` — Complex array fallback logic
- [ ] `client/src/pages/PromptManager.jsx` — Fetch calls missing response.ok check
- [ ] `server/services/memory.js` — Sort comparison not type-safe for dates
- [ ] `server/services/memorySync.js` + `server/lib/db.js` — Unsafe `rows[0]` access without bounds check
- [ ] Hardcoded localhost in `lmStudioManager.js`, `memoryClassifier.js`
- [ ] Empty `.catch(() => {})` in several client files
- [ ] Silent catch blocks in `useTheme.js`, `runner.js`, `db.js`, `Settings.jsx`

### DRY (still present)
- [ ] Duplicate DATA_DIR/path constants in 29 files
- [ ] 65 instances of `mkdir({recursive:true})` vs centralized `ensureDir()`

### Test Coverage
- ~29% service coverage, ~12% route coverage
- Critical gaps: `cos.js`, `cosRunnerClient.js`, `agentActionExecutor.js`, `memorySync.js`

---

## Future Ideas

### Tier 1: Identity Integration
- **Chronotype-Aware Scheduling** — Use genome sleep markers for peak-focus task scheduling
- **Identity Context Injection** — Per-task-type toggle for digital twin preamble injection (basic injection exists, needs granular control)

### Tier 2: Deeper Autonomy
- **Agent Confidence & Autonomy Levels** — Graduate from static presets to dynamic tiers based on success rates
- **Content Calendar** — Unified calendar view of planned content across platforms
- **Proactive Insight Alerts** — Notifications for brain connections, success drops, goal stalls, cost spikes
- **Goal Decomposition Engine** — Auto-decompose goals into task sequences with dependencies

### Tier 3: Knowledge & Legacy
- **Knowledge Graph Visualization** — Extend existing BrainGraph 3D view to full knowledge graph (goals, agent outputs, memories)
- **Time Capsule Snapshots** — Periodic versioned archives of digital twin state with "Then vs. Now" comparison
- **Autobiography Prompt Chains** — LLM-generated follow-ups building on prior autobiography answers
- **Legacy Export Format** — Compile identity into portable Markdown/PDF document

### Tier 4: Developer Experience
- **Dashboard Customization** — Drag-and-drop widget reordering, show/hide toggles, named layouts
- **Workspace Contexts** — Active project context syncing across shell, git, tasks, browser
- **Inline Code Review Annotations** — Surface self-improvement findings as inline annotations with one-click fix

### Tier 5: Multi-Modal & Future
- **Voice Capture for Brain** — Microphone + Web Speech API transcription to brain pipeline
- **RSS/Feed Ingestion** — Passive feed ingestion classified by interests
- **Ambient Dashboard Mode** — Live status board for wall-mounted displays
- **Dynamic Skill Marketplace** — Self-generating skill templates from task patterns
