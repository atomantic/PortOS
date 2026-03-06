# Port OS - Implementation Plan

See [GOALS.md](./GOALS.md) for project goals and direction.

## Quick Reference

### Tech Stack
- Frontend: React + Tailwind CSS + Vite (port 5554)
- Backend: Express.js (port 5555)
- Process Manager: PM2
- Data Storage: JSON files in `./data/`, PostgreSQL + pgvector (memory system)

### Commands
```bash
# Install all dependencies
npm run install:all

# Start development (both client and server)
npm run dev

# Start with PM2
pm2 start ecosystem.config.cjs

# View PM2 logs
pm2 logs
```

---

## Milestones

### Completed

- [x] **M0-M3**: Bootstrap, app registry, PM2 integration, log viewer - Core infrastructure
- [x] **M4**: App Wizard - Register existing apps or create from templates. See [App Wizard](./docs/features/app-wizard.md)
- [x] **M5**: AI Providers - Multi-provider AI execution with headless Claude CLI
- [x] **M6**: Dev Tools - Command runner with history and execution tracking
- [x] **M8**: Prompt Manager - Customizable AI prompts with variables and stages. See [Prompt Manager](./docs/features/prompt-manager.md)
- [x] **M9**: Streaming Import - Real-time websocket updates during app detection
- [x] **M10**: Enhanced DevTools - Provider/model selection, screenshots, git status, usage metrics
- [x] **M11**: AI Agents Page - Process detection and management with colorful UI
- [x] **M12**: History Improvements - Expandable entries with runtime/output capture
- [x] **M13**: Autofixer - Autonomous crash detection and repair. See [Autofixer](./docs/features/autofixer.md)
- [x] **M14**: Chief of Staff - Autonomous agent manager with task orchestration. See [Chief of Staff](./docs/features/chief-of-staff.md)
- [x] **M15**: Error Handling - Graceful error handling with auto-fix. See [Error Handling](./docs/features/error-handling.md)
- [x] **M16**: Memory System - Semantic memory with LLM classification. See [Memory System](./docs/features/memory-system.md)
- [x] **M17**: PM2 Config Enhancement - Per-process port detection and CDP_PORT support
- [x] **M18**: PM2 Standardization - LLM-powered config refactoring
- [x] **M19**: CoS Agent Runner - Isolated PM2 process for agent spawning. See [CoS Agent Runner](./docs/features/cos-agent-runner.md)
- [x] **M20**: AI Error Handling - Enhanced error extraction and CoS integration
- [x] **M21**: Usage Metrics - Comprehensive AI usage tracking and mobile UI
- [x] **M22**: Orphan Auto-Retry - Automatic retry for orphaned agents
- [x] **M23**: Self-Improvement - Automated UI/security/code analysis with Playwright
- [x] **M24**: Goal-Driven Mode - COS-GOALS.md mission file and always-working behavior
- [x] **M25**: Task Learning - Completion tracking and success rate analysis
- [x] **M26**: Scheduled Scripts - Cron-based automation with agent triggering
- [x] **M27**: CoS Capability Enhancements - Dependency updates, performance tracking, learning insights
- [x] **M28**: Weekly Digest UI - Visual digest with insights and comparisons
- [x] **M29**: App Improvement - Comprehensive analysis extended to managed apps
- [x] **M30**: Configurable Intervals - Per-task-type scheduling (daily, weekly, once, on-demand)
- [x] **M31**: LLM Memory Classification - Intelligent memory extraction with quality filtering
- [x] **M32**: Brain System - Second-brain capture and classification. See [Brain System](./docs/features/brain-system.md)
- [x] **M33**: Soul System - Digital twin identity scaffold management. See [Soul System](./docs/features/soul-system.md)
- [x] **M34 P1-P2,P4**: Digital Twin - Quantitative personality modeling and confidence scoring. See [Digital Twin](./docs/features/digital-twin.md)
- [x] **M35**: Chief of Staff Enhancement - Proactive autonomous agent with hybrid memory, missions, LM Studio, thinking levels. See [CoS Enhancement](./docs/features/cos-enhancement.md)
- [x] **M35.1**: CoS UI - Added Arcane Sigil (3D) avatar style option alongside Cyberpunk 3D
- [x] **M36**: Browser Management - CDP/Playwright browser page with status, controls, config, and logs
- [x] **M37**: Autonomous Jobs - Recurring scheduled jobs that the CoS executes proactively using digital twin identity
- [x] **M38**: Agent Tools - AI content generation, feed browsing, and autonomous engagement for Moltbook agents
- [x] **M39**: Agent-Centric Drill-Down - Redesigned Agents section with agent-first hierarchy, deep-linkable URLs, and scoped sub-tabs
- [x] **M40**: Agent Skill System - Task-type-specific prompts, context compaction, negative routing examples, deterministic workflow skills. See [Agent Skills](./docs/features/agent-skills.md)
- [x] **M41**: CyberCity Immersive Overhaul - Procedural synthwave audio, enhanced post-processing, reflective wet-street ground, settings system
- [x] **M42 P1-P3**: Unified Digital Twin Identity System - Identity orchestrator, chronotype derivation, personalized taste prompting, behavioral feedback loop, mortality-aware goal tracking
- [x] **M42 P4**: Unified Digital Twin Identity System - Identity Tab UI dashboard with completeness header, 5 summary cards, derive actions
- [x] **M43**: Moltworld Platform Support - Second platform integration for AI agents in a shared voxel world
- [x] **M44 P1-P5**: MeatSpace - Health tracker with death clock, LEV 2045 tracker, alcohol logging, blood/body/epigenetic/eye tracking, lifestyle questionnaire, TSV import, dashboard widget, compact grid overview

- [x] **M51**: Memory System PostgreSQL Upgrade - PostgreSQL + pgvector backend with HNSW vector search, tsvector full-text search, federation sync, and pg_dump backup integration

### In Progress

- [x] **M44 P6**: MeatSpace - Genome/Epigenetic Migration cleanup (route comments updated to `/api/meatspace/genome/`, IdentityTab genome link points to `/meatspace/genome`)
- [x] **M53 P1**: POST (Power On Self Test) - Foundation + Mental Math (daily cognitive self-test with 5 drill types, scoring, history, config). Phase 1 complete: server service/routes/tests, client UI with drill runner, results, history charts, config editor
- [ ] **M53 P2**: POST - LLM-Powered Wit & Memory Drills (5 AI drill types: word association, story recall, verbal fluency, wit/comeback, pun/wordplay). Per-drill provider/model config, LLM-scored responses with feedback. Server: meatspacePostLlm.js service, score-llm route. Client: PostLlmDrillRunner component, provider selector in config

### Planned

- [x] **GSD Tab: Smart State Detection & Guided Setup** — Extend `GET /api/apps/:id/documents` to return GSD status fields and update GSD tab empty state with stepped setup guide
- [x] **GSD Tab: One-Click Agent Spawn & Open Claude Code** — Run buttons on setup steps create CoS tasks, Open Claude Code button launches CLI in app directory
- [x] **GSD Tab: Actionable Dashboard** — Fix phase file parsing bug, add phase action triggers, document CRUD, expandable phase cards with sub-plans/verification/research, deep-linkable phase and document views

#### GSD Smart State Detection

The GSD tab currently shows a binary state: project loaded or "No GSD project initialized". This misses intermediate states where partial GSD work exists (e.g., codebase mapped but no project created).

**Server Changes** — Extend `GET /api/apps/:id/documents` response to include GSD status:
- `hasCodebaseMap` — `.planning/codebase/` directory exists with analysis files
- `hasProject` — `.planning/PROJECT.md` exists
- `hasRoadmap` — `.planning/ROADMAP.md` exists
- `hasState` — `.planning/STATE.md` exists
- `hasConcerns` — `.planning/CONCERNS.md` exists

Check via `existsSync()` against `app.repoPath + '/.planning/...'` (same pattern as existing document checks).

**GSD Tab UI Changes** — Replace single empty state with stepped guide:
| State | What to show |
|---|---|
| Nothing (no `.planning/`) | "Run `/gsd:map-codebase` to analyze your codebase" |
| Has `.planning/codebase/` only | "Codebase mapped! Run `/gsd:new-project` to create a project" |
| Has `PROJECT.md` but no `ROADMAP.md` | "Project created. Run `/gsd:plan-phase` or create a roadmap" |
| Has `ROADMAP.md` + `STATE.md` | Full project view (current behavior) |

*Touches: `server/routes/apps.js` (extend documents endpoint), `client/src/components/apps/tabs/GsdTab.jsx` (stepped empty state), `client/src/services/api.js` (consume new fields)*

- [ ] **M34 P5-P7**: Digital Twin - Multi-modal capture, advanced testing, personas
- [ ] **M42 P5**: Unified Digital Twin Identity System - Cross-Insights Engine. See [Identity System](./docs/features/identity-system.md)
- [ ] **M44 P7**: MeatSpace - Apple Health Integration (live sync via Health Auto Export app + bulk XML import)
- [ ] **M45**: Data Backup & Recovery - Scheduled backup of `./data/` to external drive or NAS. All persistence is JSON files with zero redundancy — one bad write or disk failure loses brain, identity, health, and memory data. Incremental backup with restore verification.
- [ ] **M46**: Unified Search (Cmd+K) - Global search across brain, memory, history, agents, tasks, and apps. Hybrid vector + BM25 extended to all data sources. Keyboard-driven launcher overlay.
- [ ] **M47**: Push Notifications - Webhook-based alerts when agents complete tasks, critical errors occur, or goals stall. Discord/Telegram integration for mobile awareness without needing the dashboard open.
- [ ] **M48 P1-P4**: Google Calendar Integration - OAuth2, two-way event sync, chronotype-aware smart scheduling, CoS autonomous rescheduling, calendar UI with week/month views
- [ ] **M49 P1-P4**: Life Goals & Todo Planning - Enhanced goal model with todos and milestones, calendar time-blocking, AI-powered periodic check-ins, mortality-aware progress dashboard
- [ ] **M50 P1-P4**: Email Management - Gmail + Outlook integration, AI categorization and priority extraction, Digital Twin voice drafting, review-before-send outbox, Brain knowledge capture
- [ ] **M52**: Update Detection - Poll GitHub releases for new version tags, compare against local `package.json` version, surface update availability in dashboard and settings

---

## Planned Feature Details

### M44 P7: Apple Health Integration

Bring Apple Health data into MeatSpace via two complementary paths: live sync from the [Health Auto Export](https://apps.apple.com/us/app/health-auto-export-json-csv/id1115567069) iOS app (~$4) and bulk historical import from Apple Health XML exports.

**Live Sync (Health Auto Export)**
- `POST /api/health/ingest` — accepts Health Auto Export JSON payload (metrics, workouts, sleep, ECG, medications)
- Validate payload with Zod, deduplicate by metric name + timestamp
- Persist to `data/health/YYYY-MM-DD.json` (one file per day, append/merge)
- Configure app to POST to `http://<tailscale-ip>:5554/api/health/ingest` on 15-60 min interval
- Support custom auth header for basic request validation
- 150+ metric types: steps, heart rate, HRV, VO2 max, sleep stages, blood pressure, workouts with GPS routes, etc.
- Reference: [health-auto-export-server](https://github.com/HealthyApps/health-auto-export-server), [payload schema](https://github.com/Lybron/health-auto-export)

**Bulk Historical Import (XML Export)**
- `POST /api/health/import-xml` — accepts Apple Health export ZIP upload
- Stream-parse `export.xml` using `xml-stream` (files can be 500MB+), extract records into same `data/health/YYYY-MM-DD.json` format
- Progress reporting via WebSocket during import
- Reference: [apple-health-parser](https://github.com/cvyl/apple-health-parser)

**MeatSpace Dashboard Integration**
- New dashboard cards for key Apple Health metrics (steps, heart rate, sleep, HRV trends)
- Correlate with existing MeatSpace data (alcohol intake vs. HRV/sleep, blood work trends vs. activity)
- Time-series charts with configurable date ranges

*Touches: server/routes/health.js, server/services/healthIngest.js, MeatSpace UI, data/health/*

### M45: Data Backup & Recovery

All PortOS data lives in `./data/` as JSON files with no redundancy. A corrupted write, accidental deletion, or disk failure loses everything — brain captures, digital identity, health records, memory embeddings, agent state, and run history.

**Scheduled Backup**
- Configurable backup target (external drive path, NAS mount, or rsync destination)
- Incremental backups using file modification timestamps — only copy changed files
- Configurable schedule (daily default) via existing automation scheduler
- Retention policy: keep N daily + N weekly snapshots, prune older
- Backup manifest with file checksums for integrity verification

**Restore**
- `POST /api/backup/restore` — restore from a named snapshot
- Dry-run mode that shows what would change before applying
- Per-directory selective restore (e.g., restore only `data/brain/` without touching `data/cos/`)

**Dashboard Widget**
- Last backup time, next scheduled backup, total backup size
- Backup health status (green/yellow/red based on age and integrity)
- One-click manual backup trigger

*Touches: new server/services/backup.js, server/routes/backup.js, Dashboard widget, settings.json, automation scheduler*

### M46: Unified Search (Cmd+K)

Global keyboard-driven search across all PortOS data sources from any page.

**Search Sources**
- Brain captures (ideas, projects, people, admin)
- Semantic memory (vector + BM25 hybrid, already exists)
- Command history and AI run history
- Agent activity and task logs
- Apps registry
- Digital twin documents, autobiography, taste summaries
- MeatSpace health entries

**UI**
- `Cmd+K` / `Ctrl+K` opens search overlay from any page
- Type-ahead with categorized results (Brain, Memory, Apps, History, etc.)
- Result cards with source icon, snippet, and timestamp
- Click navigates to deep-linked location (e.g., specific brain capture, agent run, history entry)

**Implementation**
- Server-side `/api/search` endpoint that fans out to existing service search functions
- Client-side `GlobalSearch` component mounted in Layout.jsx
- Debounced input with 200ms delay
- Results ranked by relevance with source-type boosting

*Touches: new server/routes/search.js, new server/services/search.js, new client/src/components/GlobalSearch.jsx, Layout.jsx*

### M47: Push Notifications

External notification delivery for critical events when not actively viewing the dashboard.

**Notification Channels**
- Discord webhook (post to a private channel)
- Telegram bot (send to chat ID)
- Generic webhook (POST JSON to any URL)
- Configurable per-channel: which event types to send

**Events**
- Agent task completed (with success/failure status and summary)
- Critical errors (PM2 crash, autofixer triggered)
- Goal milestone reached
- CoS health alert (agent stuck, high failure rate)
- Backup completed or failed (M45)

**Configuration**
- Settings page section for notification channels
- Per-channel event type toggles
- Test button to verify delivery
- Rate limiting to prevent notification spam (max N per hour per channel)

*Touches: new server/services/pushNotify.js, server/routes/settings.js, Settings UI, cosEvents.js, errorRecovery.js*

### M48: Google Calendar Integration

Shared Google OAuth2 foundation — `server/services/googleAuth.js` handles OAuth2 consent flow, token storage/refresh, scope management. Tokens stored in `data/google/auth.json`. Reused by both Calendar and Gmail.

**Phases:**

- **P1: Calendar Read & OAuth** — Google OAuth2 service, calendar event listing, basic week/month calendar UI, settings page for Google connection
- **P2: Calendar Write & Sync** — Event CRUD (create/update/delete synced to Google), two-way incremental sync using Google's `syncToken`, conflict detection (last-writer-wins, Google as source of truth for external events), configurable sync interval (default 5min)
- **P3: Smart Scheduling & CoS** — Free slot finder API, chronotype-aware slot selection (reads `data/digital-twin/chronotype.json` for peak-focus windows), auto-schedule human tasks during optimal windows, CoS autonomous job `job-calendar-schedule` for rescheduling when conflicts arise
- **P4: Calendar UI Polish** — Week/day/month views, color coding by source/type, dashboard calendar widget (today's events), linked goal/todo indicators on events

**Data:** `data/google/auth.json` (OAuth tokens), `data/calendar/events.json` (local event cache with Google sync tokens), `data/calendar/config.json` (sync settings, working hours, chronotype preferences)

**Routes:** `GET/POST/PUT/DELETE /api/calendar/events`, `POST /api/calendar/sync`, `GET /api/calendar/free-slots`, `POST /api/calendar/schedule-task`, `GET /api/google/oauth/start`, `GET /api/google/oauth/callback`, `GET /api/google/status`

**Nav:** Top-level sidebar item "Calendar" (alphabetically between Chief of Staff and Dev Tools)

*Touches: new server/services/googleAuth.js, server/services/calendar.js, server/services/calendarScheduler.js, server/routes/google.js, server/routes/calendar.js, client/src/pages/Calendar.jsx, client/src/components/calendar/tabs/, Layout.jsx, autonomousJobs.js, data/digital-twin/chronotype.json*

### M49: Life Goals & Todo Planning

Extends the existing goal system in `server/services/identity.js` and `data/digital-twin/goals.json`. Adds rich progress tracking, todo sub-tasks, calendar time-blocking, and AI-powered check-ins. Gets its own top-level Goals page (not buried under Digital Twin).

**Phases:**

- **P1: Enhanced Goal Model & Todos** — Extend goal schema with: progress percentage + history, velocity (percent/month + trend), projected completion date, todo sub-tasks with status/priority/time estimates, time tracking (total minutes, weekly average). Dedicated Goals page with goal list and detail view
- **P2: Calendar Time-Blocking** (depends on M48 P2) — Schedule recurring goal work sessions on calendar, link calendar events to goals/todos via IDs, track actual time spent from calendar event durations, per-goal calendar config (preferred days, time slot preference, session duration)
- **P3: Check-in & Evaluation** — Periodic check-in prompts (weekly/monthly configurable per goal), AI evaluator uses Digital Twin + progress data to assess trajectory, timeline adjustment recommendations when behind schedule, CoS autonomous job `job-goal-check-in` for weekly evaluations, check-in history with mood/notes
- **P4: Dashboard & Visualization** — Goal progress dashboard widget with urgency badges, burn-down / progress timeline charts, integration with existing mortality-aware urgency scoring (M42 P3), "on track" / "behind" / "at risk" status indicators

**Data:** Extended `data/digital-twin/goals.json` with `todos[]`, `progressHistory[]`, `velocity{}`, `checkIns[]`, `calendarConfig{}`, `timeTracking{}` per goal. `checkInSchedule{}` at root level.

**Routes:** Extend `/api/digital-twin/identity/goals` with: `PUT /:id/progress`, `POST /:id/check-in`, `POST /:id/todos`, `PUT /:id/todos/:tid`, `POST /:id/schedule`, `POST /evaluate`

**Nav:** Top-level sidebar item "Goals" (alphabetically between Digital Twin and Insights)

*Touches: server/services/identity.js (extend), new server/services/goalEvaluator.js, server/routes/identity.js (extend), client/src/pages/Goals.jsx, client/src/components/goals/tabs/, Layout.jsx, autonomousJobs.js*

### M50: Messages (Email Management)

Multi-provider email integration — Gmail via MCP, Outlook/Teams via CDP browser automation (Playwright). Unified Messages page with Inbox, Drafts, Sync, and Config sub-pages.

Always review before send — AI-generated drafts go to an outbox queue. The user reviews, edits, and approves each response before it's sent. No auto-send.

**Completed:**

- [x] **P1: Email Read & Sync** — Outlook CDP browser scraping with `[role='listbox'] [role='option']` selectors, Gmail MCP integration, account CRUD, Sync Unread / Full Sync modes with scrolling for virtualized lists, message caching with dedup
- [x] **P2: AI Triage & Inbox Actions** — AI evaluation endpoint (`POST /messages/evaluate`) classifies messages as reply/archive/delete/review with priority, inbox shows action badges + priority dots + pin/flag indicators, 1-click "Draft" button generates AI reply and navigates to Drafts
- [x] **P3: AI Reply Generation** — Real AI reply using configured provider/model and customizable prompt templates (reply + forward), `{{variable}}` substitution, settings persisted in `settings.json`
- [x] **P3.5: Full Body & Thread Capture** — Outlook sync clicks into each conversation to extract full email body (not just 300-char preview). Conversation threads linked by `threadId`. `GET /messages/thread/:accountId/:threadId` endpoint. MessageDetail shows full conversation chain with "Preview only" indicator for uncaptured messages. Dedup preserves full body upgrades on re-sync.
- [x] **P4: Config Page** — Unified Config tab with AI Provider & Model selector, prompt template editor, and email account management

**Remaining TODO:**

- [x] **P5: Per-action model selection** — Separate provider/model configs for triage vs reply generation (different cost/capability tiers). Expand `settings.messages` to `{ triage: { providerId, model }, reply: { providerId, model } }`. Update ConfigTab with two `ProviderModelSelector` sections.
- [x] **P6: Prompt injection hardening** — XML-fence untrusted email content in AI prompts to prevent injection. Add content sanitization layer (`sanitize()` escapes `<>`), `<emails>` XML fencing on eval prompt.
- [ ] **P7: Digital Twin voice drafting** — Draft responses using Digital Twin voice/style (reads COMMUNICATION.md, PERSONALITY.md, VALUES.md + recent thread context)
- [ ] **P8: CoS Automation & Rules** — Automated classification on new emails via CoS job, rule-based pre-filtering, email-to-task pipeline, priority email notifications
- [ ] **P9: Auto-Send with AI Review Gate** — Remove human-in-the-loop for trusted accounts. Before auto-sending, a second LLM call reviews the draft against the original email for: prompt injection artifacts, off-topic content, tone/identity drift, leaked system instructions. Configurable per-account trust level (manual → review-assisted → auto-send). See [Messages Security](./docs/features/messages-security.md) for threat model.
- [x] **Cleanup** — Delete unused `client/src/components/messages/AccountsTab.jsx` (replaced by ConfigTab)

**Data:** `data/messages/accounts.json`, `data/messages/cache/{accountId}.json`, `data/messages/selectors.json`, `settings.json` (messages key for AI config + templates)

**Routes:** `GET /api/messages/inbox`, `GET /api/messages/:accountId/:messageId`, `GET /api/messages/thread/:accountId/:threadId`, `POST /api/messages/sync/:accountId`, `POST /api/messages/evaluate`, `POST /api/messages/drafts/generate`, CRUD for accounts/drafts/selectors

**Nav:** Collapsible "Messages" sidebar section with Drafts, Inbox, Sync, Config sub-pages

### M52: Update Detection

Check for new PortOS releases on GitHub and notify the user when an update is available.

**Version Check**
- Scheduled service polls `GET https://api.github.com/repos/atomantic/PortOS/releases/latest` (or tags endpoint) on a configurable interval (default: daily)
- Compare remote latest tag against local version from `package.json`
- Semver comparison — only flag when remote is newer (ignore pre-release tags unless opted in)
- Cache last-checked timestamp and latest remote version in `data/settings.json` or `data/update-check.json`

**UI Notifications**
- Dashboard widget: subtle banner when update available showing current vs. latest version
- Settings page: "Check for Updates" button with last-checked timestamp, auto-check toggle, and interval config
- Sidebar badge or indicator on Settings nav item when update is pending

**Update Action**
- Display release notes summary (fetched from GitHub release body)
- "View Release" link opens GitHub release page
- Optional: show one-liner shell command to pull the update (`git pull && npm run install:all && pm2 restart ecosystem.config.cjs`)

**Routes:** `GET /api/system/update-check` (returns current version, latest version, update available boolean, release notes), `POST /api/system/update-check` (trigger manual check)

**Nav:** No new nav item — surfaces in Dashboard widget and Settings page

*Touches: new server/services/updateCheck.js, server/routes/system.js, Dashboard.jsx (update banner widget), Settings page (update check section), data/update-check.json*

### Tier 1: Identity Integration (aligns with M42 direction)

- **Chronotype-Aware Scheduling** — Chronotype derivation exists (M42 P1) but isn't applied to task scheduling yet. Use peak-focus windows from genome sleep markers to schedule deep-work tasks during peak hours, routine tasks during low-energy. Display energy curve on Schedule tab. *Touches: taskSchedule.js, genome.js, CoS Schedule tab*
- **Identity Context Injection** — Identity context is used for taste questions (M42 P2.5) but not yet injected as a system preamble for general AI calls. Build identity brief from EXISTENTIAL.md, taste, personality, autobiography; inject via toolkit. Per-task-type toggle. *Touches: portos-ai-toolkit, runner.js, CoS Config*
- ~~**Mortality-Aware Goal Widget**~~ ✅ Shipped as M42 P3
- ~~**Behavioral Feedback Loop**~~ ✅ Shipped as M34 P3

### Tier 2: Deeper Autonomy

- **Agent Confidence & Autonomy Levels** — Graduated autonomy tiers based on historical success rates and blast radius. System earns more autonomy over time. *Touches: cos.js, taskLearning.js, CoS Tasks UI*
- **Content Calendar** — Unified calendar view of planned content across platforms. CoS auto-schedules based on engagement patterns. Draft → review → published pipeline. *Touches: New ContentCalendar page/route*
- **Proactive Insight Alerts** — Real-time notifications when: brain captures connect to old memories, agent success rate drops, goals stall, costs spike. *Touches: notifications.js, brain.js, taskLearning.js*
- **Goal Decomposition Engine** — Auto-decompose new goals into task sequences with dependencies by analyzing codebase and capabilities. Goal → task → outcome lineage tracking. *Touches: cos.js, goalProgress.js, missions.js*

### Tier 3: Knowledge & Legacy

- **Knowledge Graph Visualization** — Interactive force-directed graph mapping connections between brain captures, memories, goals, agent outputs. Color-coded nodes, semantic link edges. *Touches: New visualization component, brain.js, memory.js*
- **Time Capsule Snapshots** — Periodic versioned archives of full digital twin state. "Then vs. Now" comparison view tracking identity evolution. *Touches: New timeCapsule service, digital-twin snapshots*
- **Autobiography Prompt Chains** — Themed prompt chains (childhood → education → career → turning points → hopes) that build on prior answers. LLM-generated follow-ups. *(Extends M34 P5)* *Touches: autobiography.js, Digital Twin UI*
- **Legacy Export Format** — Compile autobiography, personality, genome, taste, decisions, brain highlights into portable human-readable document (Markdown/PDF). *Touches: New export service*

### Tier 4: Developer Experience

- ~~**Unified Search (Cmd+K)**~~ → Promoted to M46
- **Dashboard Customization** — Drag-and-drop widget reordering, show/hide toggles, named layouts ("morning briefing", "deep work"). *Touches: Dashboard.jsx, settings.js, dnd-kit*
- **Workspace Contexts** — Active project context that syncs shell, git, tasks, and browser to current project. Persists across navigation. *Touches: Settings state, Layout context, Shell/Git/Browser*
- **Inline Code Review Annotations** — Surface self-improvement findings as inline annotations in a code viewer. One-click "fix this" spawns CoS task. *Touches: New code viewer, selfImprovement.js*

### Tier 5: Multi-Modal & Future

- **Voice Capture for Brain** — Microphone button using Web Speech API for transcription. Feeds into brain classification pipeline. *Touches: Brain capture UI, Web Speech API*
- **RSS/Feed Ingestion** — Passive ingestion from subscribed feeds, LLM-classified by user interests. Brain becomes personalized research aggregator. *Touches: New feedIngestion service, Brain inbox*
- **Ambient Dashboard Mode** — Live status board for wall-mounted displays: tasks, agent activity, health, schedule, energy curve. Real-time WebSocket updates. *Touches: New AmbientDashboard page*
- **Dynamic Skill Marketplace** — Skills as JSON/YAML documents in data/skills/. CoS discovers and routes dynamically. Self-generates new skill templates from task patterns. *Touches: taskClassifier.js, Prompt Manager*

---

## Documentation

### Architecture & Guides
- [Architecture Overview](./docs/ARCHITECTURE.md) - System design, data flow
- [API Reference](./docs/API.md) - REST endpoints, WebSocket events
- [Contributing Guide](./docs/CONTRIBUTING.md) - Code guidelines, git workflow
- [GitHub Actions](./docs/GITHUB_ACTIONS.md) - CI/CD workflow patterns
- [PM2 Configuration](./docs/PM2.md) - PM2 patterns and best practices
- [Port Allocation](./docs/PORTS.md) - Port conventions and allocation
- [Security Audit](./docs/SECURITY_AUDIT.md) - 2025-02-19 hardening audit (all resolved)
- [Troubleshooting](./docs/TROUBLESHOOTING.md) - Common issues and solutions
- [Versioning & Releases](./docs/VERSIONING.md) - Version format, release process

### Feature Documentation
- [Agent Skills](./docs/features/agent-skills.md) - Task-type-specific prompt templates and routing
- [App Wizard](./docs/features/app-wizard.md) - Register apps and create from templates
- [Autofixer](./docs/features/autofixer.md) - Autonomous crash detection and repair
- [Brain System](./docs/features/brain-system.md) - Second-brain capture and classification
- [Browser Management](./docs/features/browser.md) - CDP/Playwright browser management
- [Chief of Staff](./docs/features/chief-of-staff.md) - Autonomous agent orchestration
- [CoS Agent Runner](./docs/features/cos-agent-runner.md) - Isolated agent process management
- [CoS Enhancement](./docs/features/cos-enhancement.md) - M35 hybrid memory, missions, thinking levels
- [Digital Twin](./docs/features/digital-twin.md) - Quantitative personality modeling
- [Error Handling](./docs/features/error-handling.md) - Graceful error handling with auto-fix
- [Identity System](./docs/features/identity-system.md) - Unified identity architecture (M42 spec)
- [JIRA Sprint Manager](./docs/features/jira-sprint-manager.md) - Autonomous JIRA triage and implementation
- [Memory System](./docs/features/memory-system.md) - Semantic memory with LLM classification
- [Messages Security](./docs/features/messages-security.md) - AI prompt injection threat model and defenses
- [Prompt Manager](./docs/features/prompt-manager.md) - Customizable AI prompts
- [Soul System](./docs/features/soul-system.md) - Digital twin identity scaffold

---

## Security Hardening ✅

All 10 audit items (S1–S10) from the 2025-02-19 security audit have been resolved. See [Security Audit](./docs/SECURITY_AUDIT.md) for details.

---

## Better Audit - 2026-03-05

Summary: 35 findings across 28 files. 0 shared utilities to extract (ensureDataDir removal is deletion, not extraction).

### File Ownership Map

| File | Primary Category | Reason |
|------|-----------------|--------|
| `server/lib/db.js` | Security | Hardcoded DB password |
| `server/routes/cos.js` | Security | Mass assignment (HIGH) + string concat bug |
| `server/services/backup.js` | Security | Hardcoded DB password in backup |
| `server/lib/ports.js` | Code Quality | Hardcoded localhost |
| `server/services/browserService.js` | Code Quality | Hardcoded 127.0.0.1 |
| `server/services/instances.js` | Code Quality | Magic number + bare catch |
| `server/services/worktreeManager.js` | Code Quality | Silent .catch blocks |
| `client/src/pages/PromptManager.jsx` | Bugs & Perf | window.alert/confirm |
| `server/lib/errorHandler.js` | Bugs & Perf | process.exit in library |
| `server/services/socket.js` | Bugs & Perf | Socket cleanup for dropped clients |
| `client/src/hooks/useCityData.js` | Stack-Specific | Incorrect socket.off() |
| `client/src/pages/ChiefOfStaff.jsx` | Stack-Specific | Incorrect socket.off() |
| `client/src/pages/Instances.jsx` | Stack-Specific | Incorrect socket.off() |
| `client/src/pages/AIProviders.jsx` | Stack-Specific | Stale closure in useEffect |
| `client/src/services/api.js` | Stack-Specific | Missing response.ok check |
| `client/src/utils/fileUpload.js` | DRY | Duplicate formatFileSize |
| `client/src/components/cos/TaskAddForm.jsx` | DRY | Import update for formatFileSize |
| `server/services/cosEvolution.js` | DRY | ensureDataDir wrapper removal |
| `server/services/apps.js` | DRY | ensureDataDir wrapper removal |
| `server/services/missions.js` | DRY | ensureDataDir wrapper removal |
| `server/services/appActivity.js` | DRY | ensureDataDir wrapper removal |
| `server/services/productivity.js` | DRY | ensureDataDir wrapper removal |
| `server/services/autonomousJobs.js` | DRY | ensureDataDir wrapper removal |
| `server/services/history.js` | DRY | ensureDataDir wrapper removal |
| `server/services/memoryBM25.js` | DRY | ensureDataDir wrapper removal |
| `server/services/autobiography.js` | DRY | ensureDataDir wrapper removal |

### Security & Secrets
- [x] **[HIGH]** `server/lib/db.js:18` - Hardcoded default DB password 'portos' as fallback. *(Fixed: PR #71)*
- [x] **[HIGH]** `server/routes/cos.js:77` - Mass assignment: `req.body` spread directly into config without Zod validation. *(Already had Zod `.strict()` validation)*
- [x] **[HIGH]** `server/routes/cos.js:991` - String concatenation with potentially undefined value. *(Fixed: PR #71)*
- [x] **[MEDIUM]** `server/services/backup.js:173` - Same hardcoded 'portos' password fallback. *(Fixed: PR #71)*
- [x] **[HIGH]** npm audit: multer DoS vulnerability (GHSA-5528-5vmv-3xc2). *(Already resolved)*
- [ ] **[LOW]** npm audit: pm2 ReDoS (GHSA-x5gf-qvw8-r2rm). No upstream fix available. (Tracked only)

### Code Quality & Style
- [x] **[HIGH]** `server/lib/ports.js:4` - Hardcoded `localhost`. *(Fixed: PR #67)*
- [x] **[HIGH]** `server/services/browserService.js:26,66` - Hardcoded `127.0.0.1` for CDP. *(Fixed: PR #67)*
- [x] **[HIGH]** `server/services/instances.js:384` - Magic number `2000`. *(Fixed: PR #67)*
- [x] **[MEDIUM]** `server/services/instances.js:190,316` - Bare catch blocks. *(Fixed: PR #67)*
- [x] **[MEDIUM]** `server/services/worktreeManager.js` - Silent `.catch(() => {})` blocks. *(Fixed: PR #67)*

### DRY & YAGNI
- [x] **[MEDIUM]** `client/src/utils/fileUpload.js:247` - Duplicate `formatFileSize`. *(Fixed: PR #68)*
- [x] **[HIGH]** 9 files with redundant `ensureDataDir()` wrappers. *(Fixed: PR #68)*

### Architecture & SOLID (tracked, not auto-remediated)
- [ ] **[CRITICAL]** `server/services/cos.js` (3827 lines) - God file with 40+ exports, mixed concerns. Needs decomposition into cosOrchestrator, cosStateManager, taskGenerator, agentRegistry. (Complexity: Very Complex)
- [ ] **[CRITICAL]** `server/services/subAgentSpawner.js` (3284 lines) - Mega service spanning model selection, spawning, worktrees, JIRA, git, memory. (Complexity: Very Complex)
- [ ] **[HIGH]** `server/services/digital-twin.js:280-375` - Mixed API/CLI provider abstraction in single function. (Complexity: Medium)
- [ ] **[MEDIUM]** `client/src/pages/ChiefOfStaff.jsx:43-150` - 14+ useState hooks, should extract custom hooks. (Complexity: Medium)
- [ ] **[MEDIUM]** Inconsistent pagination patterns across routes. (Complexity: Medium)
- [ ] **[MEDIUM]** Error response envelope not fully consistent. (Complexity: Simple)

### Bugs, Performance & Error Handling
- [x] **[HIGH]** `client/src/pages/PromptManager.jsx` - Uses `alert()` and `confirm()`. *(Fixed: PR #69)*
- [x] **[MEDIUM]** `server/lib/errorHandler.js:224` - `process.exit(1)` in library code. *(Fixed: PR #69)*
- [x] **[MEDIUM]** `server/services/socket.js` - Socket event handlers not cleaned up for dropped clients. *(Fixed: PR #72)*

### Stack-Specific (Node/React)
- [x] **[HIGH]** `client/src/hooks/useCityData.js` - Incorrect `socket.off()`. *(Fixed: PR #70)*
- [x] **[HIGH]** `client/src/pages/ChiefOfStaff.jsx` - Incorrect `socket.off()`. *(Fixed: PR #70)*
- [x] **[HIGH]** `client/src/pages/Instances.jsx` - Incorrect `socket.off()`. *(Fixed: PR #70)*
- [x] **[HIGH]** `client/src/pages/AIProviders.jsx` - Stale closure. *(Fixed: PR #70)*
- [x] **[MEDIUM]** `client/src/services/api.js` - Missing `response.ok` check. *(Fixed: PR #69)*

### Test Coverage (tracked, not auto-remediated)
- [ ] **[CRITICAL]** `server/services/cos.js` - No service tests for core 3827-line business logic
- [ ] **[CRITICAL]** `server/services/subAgentSpawner.js` - Partial tests (657 lines), most spawn logic untested
- [ ] **[HIGH]** `server/services/instances.js` - No tests for federation logic
- [ ] **[HIGH]** `server/services/digital-twin.js` - No tests for 2823-line service
- [ ] **[HIGH]** `server/services/memory.js` - No tests for CRUD and search
- [ ] **[HIGH]** `server/services/brain.js` - No service tests (route tests only)
- [ ] **[HIGH]** `server/services/pm2.js` - No tests for process management
- [ ] **[HIGH]** `server/services/shell.js` - No tests for PTY sessions
- [ ] Overall: 29.4% service coverage (35/119), 12.0% route coverage (6/50)

## Better Audit - 2026-03-05 (Pass 2)

Summary: 18 new findings across 16 files. 2 shared utilities to extract.

### Foundation — Shared Utilities
1. **dateUtils** — `getDateString(date)` → `date.toISOString().split('T')[0]`. Replaces duplicates in agentActivity.js, productivity.js. Add to `server/lib/fileUtils.js`.
2. **timeConstants** — `HOUR`, `DAY` constants. Replaces duplicates in autonomousJobs.js, taskSchedule.js. Add to `server/lib/fileUtils.js`.

### File Ownership Map

| File | Primary Category | Reason |
|------|-----------------|--------|
| `server/services/cos.js` | Bugs & Perf | CRITICAL TOCTOU race condition |
| `server/services/cosRunnerClient.js` | Bugs & Perf | Missing fetch timeout |
| `client/src/pages/PromptManager.jsx` | Bugs & Perf | Missing fetch error handling |
| `server/services/mediaService.js` | Code Quality | Class-based → functional |
| `client/src/hooks/useTheme.js` | Code Quality | Empty catch blocks |
| `server/services/runner.js` | Code Quality | Silent JSON parse catch |
| `server/lib/db.js` | Code Quality | Silent health check error |
| `client/src/pages/Settings.jsx` | Code Quality | Empty catch handlers |
| `server/services/agentActivity.js` | DRY | Duplicate getDateString |
| `server/services/productivity.js` | DRY | Duplicate getDateString |
| `server/services/autonomousJobs.js` | DRY | Duplicate time constants |
| `server/services/taskSchedule.js` | DRY | Duplicate time constants |
| `server/lib/logger.js` | DRY | Unused module — DELETE |
| `server/lib/logger.test.js` | DRY | Unused test — DELETE |
| `server/lib/fileUtils.js` | DRY | Add shared getDateString + time constants |
| `server/integrations/moltworld/api.js` | Stack-Specific | Missing fetch timeout |
| `server/integrations/moltbook/api.js` | Stack-Specific | Missing fetch timeout |

### Bugs, Performance & Error Handling
- [ ] **[CRITICAL]** `server/services/cos.js:3103,3394,3454,3486,3526` - TOCTOU race condition: addTask, updateTask, deleteTask, reorderTasks, approveTask lack withStateLock mutex. Concurrent calls lose data. Fix: Wrap read-modify-write in withStateLock(). Complexity: Simple
- [ ] **[MEDIUM]** `server/services/cosRunnerClient.js:237-268` - executeCliRunViaRunner() fetch has no timeout. Fix: Add AbortController with 60s timeout. Complexity: Simple
- [ ] **[HIGH]** `client/src/pages/PromptManager.jsx:85-91,95-100,112-127` - Multiple fetch calls missing response.ok check. Fix: Add error handling with toast notifications. Complexity: Simple

### Code Quality & Style
- [ ] **[HIGH]** `server/services/mediaService.js:4-186` - Class-based implementation violates functional programming convention. Fix: Convert to functional module with closures. Complexity: Medium
- [ ] **[MEDIUM]** `client/src/hooks/useTheme.js:123,136` - Empty .catch(() => {}) swallows errors. Fix: Add console.log with warning. Complexity: Simple
- [ ] **[MEDIUM]** `server/services/runner.js:140` - Silent try/catch on JSON parse without logging. Fix: Add warning log. Complexity: Simple
- [ ] **[MEDIUM]** `server/lib/db.js:87-89` - Health check error swallowed without logging. Fix: Add error log. Complexity: Simple
- [ ] **[MEDIUM]** `client/src/pages/Settings.jsx:23,30` - Empty .catch(() => {}) handlers. Fix: Add toast.error() feedback. Complexity: Simple

### DRY & YAGNI
- [ ] **[HIGH]** `server/services/agentActivity.js:42` + `server/services/productivity.js:28` - Duplicate getDateString. Fix: Extract to fileUtils.js. Complexity: Simple
- [ ] **[HIGH]** `server/services/autonomousJobs.js:5-6` + `server/services/taskSchedule.js:9-10` - Duplicate HOUR/DAY constants. Fix: Extract to fileUtils.js. Complexity: Simple
- [ ] **[HIGH]** `server/lib/logger.js` - Unused 84-line module (0 imports). Fix: Delete file and its test. Complexity: Simple

### Stack-Specific (Node/React)
- [ ] **[MEDIUM]** `server/integrations/moltworld/api.js:41` + `server/integrations/moltbook/api.js:84` - Fetch calls without timeout. Fix: Add AbortController with 10s timeout. Complexity: Simple

### Architecture & SOLID (tracked, not auto-remediated)
- [ ] **[CRITICAL]** `server/services/cos.js` ↔ `server/services/subAgentSpawner.js` - Circular dependency via dynamic imports. (Complexity: Complex)
- [ ] **[HIGH]** `server/routes/apps.js:68-77,126-135` - Duplicated app status computation logic. (Complexity: Simple)
- [ ] **[HIGH]** `server/routes/scaffold.js` (1270 lines) - God route file mixing navigation, templates, scaffolding, GitHub. (Complexity: Medium)

### Test Coverage (tracked, not auto-remediated)
- Same gaps as Pass 1 — see above section.

---

## Better Audit - 2026-03-05 (Pass 3)

Summary: 22 new actionable findings across 16 files. 1 shared utility to extract (fetchWithTimeout).

### Foundation — Shared Utilities
1. **fetchWithTimeout** — `fetchWithTimeout(url, options, timeoutMs)` wraps fetch with AbortController timeout. Replaces 8+ duplicate patterns in cosRunnerClient.js, memoryClassifier.js, visionTest.js, lmStudioManager.js, etc. Create as `server/lib/fetchWithTimeout.js`.

### File Ownership Map

| File | Primary Category | Reason |
|------|-----------------|--------|
| `server/services/cosRunnerClient.js` | Bugs & Perf | CRITICAL: 12 fetch calls missing timeouts + socket config |
| `server/services/memory.js` | Bugs & Perf | HIGH: data race in getMemory + MEDIUM: sorting type safety |
| `server/services/agentActionExecutor.js` | Bugs & Perf | HIGH: unsafe array fallback |
| `server/services/cos.js` | Bugs & Perf | MEDIUM: migration error + lazy-load race |
| `server/services/memorySync.js` | Code Quality | HIGH: unsafe rows[0] access |
| `server/lib/db.js` | Code Quality | HIGH: unsafe rows[0] destructuring |
| `server/services/lmStudioManager.js` | Code Quality | MEDIUM: hardcoded localhost |
| `server/services/memoryClassifier.js` | Code Quality | MEDIUM: hardcoded localhost |
| `client/src/pages/Browser.jsx` | Code Quality | MEDIUM: empty catch |
| `client/src/pages/Shell.jsx` | Code Quality | MEDIUM: empty catch |
| `client/src/components/cos/TaskAddForm.jsx` | Code Quality | MEDIUM: empty catch |
| `client/src/hooks/useAgentFeedbackToast.jsx` | Code Quality | MEDIUM: empty catch |
| `client/src/components/meatspace/HealthCategorySection.jsx` | Code Quality | MEDIUM: empty catch |
| `client/src/pages/DevTools.jsx` | Code Quality | MEDIUM: stale closure |
| `server/services/contextUpgrader.js` | Code Quality | MEDIUM: unused 350-line module (DELETE) |
| `server/lib/fetchWithTimeout.js` | Foundation | NEW: shared utility |

### Bugs, Performance & Error Handling
- [ ] **[CRITICAL]** `server/services/cosRunnerClient.js:91-313` - 12 fetch calls missing AbortController/timeout (only spawnAgentViaRunner and executeCliRunViaRunner have timeouts). Fix: Use fetchWithTimeout for all calls. Complexity: Simple
- [ ] **[HIGH]** `server/services/cosRunnerClient.js:19-26` - Socket.IO with `reconnectionAttempts: Infinity` and no error handler. Fix: Cap at 10, add error handler. Complexity: Simple
- [ ] **[HIGH]** `server/services/memory.js:203-214` - Data race: loadMemory() called outside withMemoryLock, then accessCount incremented inside lock. Fix: Move loadMemory inside lock. Complexity: Simple
- [ ] **[HIGH]** `server/services/agentActionExecutor.js:137` - Unsafe fallback: `commentsResponse.comments || commentsResponse || []` may yield non-array. Fix: Use Array.isArray check. Complexity: Simple
- [ ] **[MEDIUM]** `server/services/cos.js:211-221` - Migration rename fallback: copy failure silently swallowed. Fix: Add error propagation in fallback path. Complexity: Simple
- [ ] **[MEDIUM]** `server/services/memory.js:220-265` - Sort comparison not type-safe for dates (ISO strings compared as numbers via `|| 0`). Fix: Add type-aware comparison. Complexity: Medium
- [ ] **[MEDIUM]** `server/services/cos.js:83-101` - Agent index lazy-load race: concurrent calls both trigger migration. Fix: Use promise-based singleton pattern. Complexity: Medium

### Code Quality & Style
- [ ] **[HIGH]** `server/services/memorySync.js:156` - `result.rows[0].max_seq` without checking rows length. Fix: Add bounds check. Complexity: Simple
- [ ] **[HIGH]** `server/lib/db.js:85` - Destructuring `result.rows[0]` without row existence check. Fix: Add bounds check. Complexity: Simple
- [ ] **[MEDIUM]** `server/services/lmStudioManager.js:12` - Hardcoded `http://localhost:1234`. Fix: Use `process.env.LM_STUDIO_URL` with fallback. Complexity: Simple
- [ ] **[MEDIUM]** `server/services/memoryClassifier.js:24` - Hardcoded `http://localhost:1234/v1/chat/completions`. Fix: Use env var with fallback. Complexity: Simple
- [ ] **[MEDIUM]** `client/src/pages/Browser.jsx:87`, `client/src/pages/Shell.jsx:81`, `client/src/components/cos/TaskAddForm.jsx:106`, `client/src/hooks/useAgentFeedbackToast.jsx:43`, `client/src/components/meatspace/HealthCategorySection.jsx:48` - Empty `.catch(() => {})` swallowing errors. Fix: Replace with `console.warn`. Complexity: Simple
- [ ] **[MEDIUM]** `client/src/pages/DevTools.jsx:21-40` - Stale closure risk: `loadData` depends on `filter` but not wrapped in useCallback. Fix: Wrap in useCallback with [filter] dep. Complexity: Simple
- [ ] **[MEDIUM]** `server/services/contextUpgrader.js` - Unused 350-line module with 0 imports. Fix: DELETE file. Complexity: Simple

### Architecture & SOLID (tracked, not auto-remediated)
- [ ] **[CRITICAL]** `server/services/cos.js` (3837 lines) - God file with 40+ exports. evaluateTasks() is 346 lines with 5-level nesting. (Complexity: Very Complex)
- [ ] **[CRITICAL]** `server/services/subAgentSpawner.js` (3284 lines) - 10 imports from cos.js, spawnDirectly/spawnViaRunner have 11/10 parameters. (Complexity: Very Complex)
- [ ] **[HIGH]** `client/src/services/api.js` (1627 lines) - Monolithic API client mixing 20+ domains. (Complexity: Medium)
- [ ] **[HIGH]** `server/services/digital-twin.js` (2823 lines) - Mixed CRUD, LLM testing, enrichment, export. (Complexity: Complex)
- [ ] **[HIGH]** `server/routes/cos.js` (1253 lines) - Business logic mixed with HTTP handlers. (Complexity: Medium)
- [ ] **[HIGH]** `client/src/pages/ChiefOfStaff.jsx` (864 lines) - 24 useState hooks. (Complexity: Medium)

### DRY & YAGNI (tracked for future passes)
- [ ] **[HIGH]** Duplicate DATA_DIR/path constants in 8+ files — should import from PATHS in fileUtils.js
- [ ] **[MEDIUM]** 39 instances of `mkdir({recursive:true})` vs centralized `ensureDir()`
- [ ] **[MEDIUM]** JSON read/write pattern variations (203 occurrences)

### Test Coverage (tracked, not auto-remediated)
- [ ] **[CRITICAL]** `server/services/cos.js` - No tests for 3837-line core service (45 test cases needed)
- [ ] **[CRITICAL]** `server/services/cosRunnerClient.js` - No tests for 16 fetch functions (32 test cases needed)
- [ ] **[CRITICAL]** `server/services/agentActionExecutor.js` - No tests for 661-line service (24 test cases needed)
- [ ] **[CRITICAL]** `server/services/memorySync.js` - No tests for sync service (18 test cases needed)
- [ ] **[HIGH]** `server/services/autoFixer.js` - No tests for 301-line service
- [ ] **[HIGH]** `server/services/subAgentSpawner.test.js` - Tests use copy-pasted logic instead of importing real functions
- [ ] **[HIGH]** `server/services/digital-twin.test.js` - runTests(), validateCompleteness(), getGapRecommendations() untested

---

## Next Actions

1. **M44 P6**: Finish genome/epigenetic migration cleanup — update route comments, remove Genome card from IdentityTab or redirect to `/meatspace/genome`
2. **M42 P5**: Cross-Insights Engine — connect genome + taste + personality + goals into derived insights
3. **M45**: Data Backup & Recovery — protect `./data/` from data loss
4. **M44 P7**: Apple Health Integration — live sync + bulk XML import (spec above)
5. **M46**: Unified Search (Cmd+K) — cross-cutting search across all data sources
6. **M48 P1**: Google Calendar — OAuth2 foundation + calendar read
7. **M49 P1**: Life Goals — Enhanced goal model with todos and progress tracking
8. **M48 P2**: Google Calendar — Event CRUD and two-way sync
9. **M52**: Update Detection — GitHub release polling and update notification
