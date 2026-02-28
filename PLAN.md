# Port OS - Implementation Plan

See [GOALS.md](./GOALS.md) for project goals and direction.

## Quick Reference

### Tech Stack
- Frontend: React + Tailwind CSS + Vite (port 5555)
- Backend: Express.js (port 5554)
- Process Manager: PM2
- Data Storage: JSON files in `./data/`

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

### In Progress

- [ ] **M44 P6**: MeatSpace - Genome/Epigenetic Migration cleanup (genome routes moved, but route comments still reference `/api/digital-twin/genome/` and IdentityTab still renders a Genome card with broken link to `/digital-twin/genome`)

### Planned

- [ ] **M34 P5-P7**: Digital Twin - Multi-modal capture, advanced testing, personas
- [ ] **M42 P5**: Unified Digital Twin Identity System - Cross-Insights Engine. See [Identity System](./docs/features/identity-system.md)
- [ ] **M44 P7**: MeatSpace - Apple Health Integration (live sync via Health Auto Export app + bulk XML import)
- [ ] **M45**: Data Backup & Recovery - Scheduled backup of `./data/` to external drive or NAS. All persistence is JSON files with zero redundancy — one bad write or disk failure loses brain, identity, health, and memory data. Incremental backup with restore verification.
- [ ] **M46**: Unified Search (Cmd+K) - Global search across brain, memory, history, agents, tasks, and apps. Hybrid vector + BM25 extended to all data sources. Keyboard-driven launcher overlay.
- [ ] **M47**: Push Notifications - Webhook-based alerts when agents complete tasks, critical errors occur, or goals stall. Discord/Telegram integration for mobile awareness without needing the dashboard open.
- [ ] **M48 P1-P4**: Google Calendar Integration - OAuth2, two-way event sync, chronotype-aware smart scheduling, CoS autonomous rescheduling, calendar UI with week/month views
- [ ] **M49 P1-P4**: Life Goals & Todo Planning - Enhanced goal model with todos and milestones, calendar time-blocking, AI-powered periodic check-ins, mortality-aware progress dashboard
- [ ] **M50 P1-P4**: Email Management - Gmail + Outlook integration, AI categorization and priority extraction, Digital Twin voice drafting, review-before-send outbox, Brain knowledge capture

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

### M50: Email Management

Multi-provider email integration — Gmail via Google OAuth (shared with M48) + Outlook via Microsoft Graph API (separate OAuth2 flow). Provider abstraction layer so both behave identically from the service layer up.

Always review before send — AI-generated drafts go to an outbox queue. The user reviews, edits, and approves each response before it's sent. No auto-send.

**Phases:**

- **P1: Email Read & Provider Auth** — Gmail API integration using shared Google OAuth (`gmail.modify` scope), Microsoft Graph API with separate OAuth2 for Outlook, provider abstraction layer (`emailProvider.js`), email listing with pagination, thread view, basic email inbox UI
- **P2: AI Categorization & Priority Extraction** — LLM-powered classification (action required, informational, promotional, social, receipts), configurable rules for known senders (skip AI for obvious categories like GitHub notifications), todo extraction from email content (linkable to M49 goal todos), priority scoring, Brain system integration for knowledge capture from action/info emails
- **P3: Response Drafting with Digital Twin** — Draft responses using Digital Twin voice/style (reads COMMUNICATION.md, PERSONALITY.md, VALUES.md + recent thread context), outbox queue with pending/approved/sent states, draft review/editing UI, all drafts require manual approval before sending
- **P4: CoS Automation & Rules** — Automated classification on new emails via CoS job `job-email-triage`, rule-based pre-filtering, email-to-task pipeline (email todos → M49 goal todos), priority email notifications via existing notification system

**Data:** `data/email/config.json` (sync settings, categories, rules, brain capture config), `data/email/cache/YYYY-MM-DD.jsonl` (date-bucketed email cache, bodies fetched on demand), `data/email/outbox.json` (draft queue with status tracking), `data/outlook/auth.json` (Microsoft OAuth tokens)

**Routes:** `GET /api/email/messages`, `GET /api/email/threads/:threadId`, `POST /api/email/sync`, `POST /api/email/classify/:id`, `POST /api/email/draft/:id`, `GET/PUT/POST/DELETE /api/email/outbox/:id`, `POST /api/email/outbox/:id/approve`

**Nav:** Top-level sidebar item "Email" (alphabetically between Digital Twin and Goals)

**Dependency Graph:**

```
M48 P1 (Google OAuth + Calendar Read)
  ├── M48 P2 (Calendar Write + Sync)
  │     ├── M49 P2 (Calendar Time-Blocking)
  │     └── M48 P3 (Smart Scheduling + CoS)
  │           └── M48 P4 (Calendar UI Polish)
  └── M50 P1 (Gmail + Outlook Read — reuses Google OAuth)
        └── M50 P2 (AI Classification)
              └── M50 P3 (Response Drafting)
                    └── M50 P4 (CoS Automation)

M49 P1 (Enhanced Goals + Todos) — independent, no deps
  ├── M49 P2 (Calendar Integration — needs M48 P2)
  └── M49 P3 (Check-ins) → M49 P4 (Dashboard)
```

*Touches: new server/services/email.js, server/services/emailProvider.js, server/services/emailClassifier.js, server/services/emailDrafter.js, server/routes/email.js, client/src/pages/Email.jsx, client/src/components/email/tabs/, Layout.jsx, brain.js, autonomousJobs.js, portos-ai-toolkit (Digital Twin context for drafting)*

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
- [Prompt Manager](./docs/features/prompt-manager.md) - Customizable AI prompts
- [Soul System](./docs/features/soul-system.md) - Digital twin identity scaffold

---

## Security Hardening ✅

All 10 audit items (S1–S10) from the 2025-02-19 security audit have been resolved. See [Security Audit](./docs/SECURITY_AUDIT.md) for details.

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
