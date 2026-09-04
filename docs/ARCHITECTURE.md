# Architecture Overview

PortOS is a monorepo application with a React frontend and Express.js backend, managed by PM2.

## System Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                                      PortOS                                         │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                     │
│  ┌────────────────────┐             ┌──────────────────────────────────────┐        │
│  │  React Client      │             │        Express Server                │        │
│  │  (port 5554)       │    HTTP     │        (port 5555)                   │        │
│  │                    │ <---------> │                                      │        │
│  │  ┌──────────────┐  │             │  ┌──────────┐  ┌──────────────────┐  │        │
│  │  │    Pages     │  │             │  │  Routes  │──│    Services      │  │        │
│  │  └──────────────┘  │             │  └──────────┘  └──────────────────┘  │        │
│  │       |            │  Socket.IO  │       |              |               │        │
│  │  ┌──────────────┐  │ <---------- │       |         ┌────v─────────┐     │        │
│  │  │  Components  │  │             │       |         │   PM2 API    │     │        │
│  │  └──────────────┘  │             │       |         └──────────────┘     │        │
│  │       |            │             │       |              |               │        │
│  │  ┌──────────────┐  │             │       |         ┌────v─────────┐     │        │
│  │  │  api.js      │  │             │       |         │ Postgres +   │     │        │
│  │  │  socket.js   │  │             │       |         │ data/ files  │     │        │
│  │  └──────────────┘  │             │       |         └──────────────┘     │        │
│  └────────────────────┘             └──────────────────────────────────────┘        │
│                                                                                     │
│  ┌───────────────────────────────────────────────────────────────────────────────┐  │
│  │                    PM2-Managed Satellite Services                             │  │
│  │                                                                               │  │
│  │  ┌─────────────────────┐  ┌────────────────────┐  ┌────────────────────────┐  │  │
│  │  │ Chief of Staff      │  │ portos-browser     │  │ portos-autofixer       │  │  │
│  │  │ portos-cos :5558    │  │ CDP :5556          │  │ daemon :5559           │  │  │
│  │  │                     │  │ health :5557       │  │ UI :5560               │  │  │
│  │  │ Task Watcher        │  │                    │  │                        │  │  │
│  │  │ CoS Evaluation      │  │ Persistent         │  │ PM2 crash monitor      │  │  │
│  │  │ CoS runner / task    │  │ Chromium instance  │  │ (polls every 15m)      │  │  │
│  │  │ execution            │  │ CDP WebSocket for  │  │ Claude CLI auto-fix    │  │  │
│  │  │                     │  │ web automation     │  │ Reads apps.json        │  │  │
│  │  └─────────────────────┘  └────────────────────┘  │ Session history        │  │  │
│  │                                                   └────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘

Communication paths:
  Client <--HTTP/Socket.IO--> Server --PM2 API--> all satellite processes
  Server --pg--> PostgreSQL + pgvector (system :5432 or Docker :5561) — mandatory primary datastore
  Server --browserService--> portos-browser (CDP :5556, health :5557)
  Server --apps.json--> portos-autofixer reads registered apps to monitor
  CoS agents --CDP WebSocket--> portos-browser for web automation tasks
  portos-autofixer --pm2 jlist--> detects crashed processes --Claude CLI--> auto-fix
  portos-autofixer-ui --reads--> data/autofixer/sessions/ for fix history
```

## Directory Structure

```
PortOS/
├── client/                    # React + Vite frontend
│   └── src/
│       ├── components/        # Reusable UI components
│       │   ├── cos/           # Chief of Staff components
│       │   └── Layout.jsx     # Main app layout
│       ├── hooks/             # Custom React hooks
│       ├── pages/             # Route-based page components
│       │   └── Browser.jsx    # Browser management dashboard
│       └── services/          # API client (api.js, socket.js)
│
├── server/                    # Express.js backend
│   ├── routes/                # HTTP endpoint handlers
│   │   └── browser.js         # /api/browser/* endpoints
│   ├── services/              # Business logic
│   │   ├── cos.js             # Chief of Staff core
│   │   ├── subAgentSpawner.js # Agent-cluster event wiring, runner communication, and slashdo loading
│   │   ├── agentCliSpawning.js # Multi-provider CLI agent spawning
│   │   ├── agentOrchestrator.js # Agent lifecycle-transition facade
│   │   ├── pm2.js             # PM2 process management
│   │   ├── runner.js          # AI execution engine
│   │   ├── memory.js          # Memory system
│   │   └── browserService.js  # Browser CDP/health/PM2 control
│   ├── lib/                   # Shared utilities
│   │   ├── errorHandler.js    # Error normalization
│   │   ├── validation.js      # Zod schemas
│   │   └── taskParser.js      # TASKS.md parser
│   └── cos-runner/            # Isolated agent runner
│       └── index.js           # Standalone Express server
│
├── browser/                   # portos-browser service
│   ├── server.js              # Launches Chromium with CDP, runs health server
│   └── package.json           # Zero third-party dependencies; Chrome launched via native child_process.spawn
│
├── autofixer/                 # portos-autofixer service
│   ├── server.js              # Crash detection daemon (polls PM2 every 15min)
│   └── ui.js                  # Standalone Express UI with SSE log streaming
│
├── data/                      # Runtime file data (gitignored) — relational records live in PostgreSQL (see docs/STORAGE.md)
│   ├── apps.json              # Registered apps (read by autofixer)
│   ├── providers.json         # AI provider configs
│   ├── history.jsonl          # Action history (JSON Lines)
│   ├── browser-config.json    # Browser CDP/health configuration
│   ├── TASKS.md               # User task file
│   ├── COS-TASKS.md           # System task file
│   ├── cos/                   # CoS state and agents
│   │   ├── state.json         # Daemon state
│   │   └── agents/            # Agent outputs
│   ├── autofixer/             # Autofixer session history
│   │   ├── index.json         # Fix session index (max 100 entries)
│   │   └── sessions/          # Per-session prompt, output, metadata
│   ├── brain/                 # Brain second-brain data (file-primary)
│   │   ├── meta.json          # Settings
│   │   ├── admin/             # Admin tasks (collectionStore: <id>/index.json)
│   │   ├── buckets/           # Custom bucket definitions (collectionStore: <id>/index.json)
│   │   ├── ideas/             # Ideas and concepts (collectionStore: <id>/index.json)
│   │   ├── inbox/             # Captured thoughts (collectionStore: <id>/index.json)
│   │   ├── journals/          # Daily Log entries (collectionStore: <id>/index.json)
│   │   ├── links/             # Saved bookmarks (collectionStore: <id>/index.json)
│   │   ├── memories/          # Brain memories (collectionStore: <id>/index.json)
│   │   ├── people/            # People records (collectionStore: <id>/index.json)
│   │   ├── projects/          # Projects with status tracking (collectionStore: <id>/index.json)
│   │   ├── songs/             # SongBook songs (collectionStore: <id>/index.json)
│   │   ├── idealoom-lists/    # Machine-local IdeaLoom lists (collectionStore: <id>/index.json)
│   │   ├── imports/           # Imported conversation archives
│   │   ├── scans/             # Repository malware scan reports
│   │   ├── songbook/          # Machine-local SongBook attachment files
│   │   ├── youtube/           # YouTube transcripts, audio, and ingest index
│   │   ├── activity-digest-settings.json # Activity digest configuration
│   │   ├── journal-settings.json # Daily Log and Obsidian mirror settings
│   │   ├── journal-obsidian-locations.json # Machine-local journal mirror paths
│   │   ├── memory-bridge-map.json # Brain↔CoS memory bridge mapping
│   │   ├── obsidian-vaults.json # Obsidian vault sync config
│   │   ├── youtube-ingest-settings.json # YouTube ingest defaults
│   │   ├── sync_log.jsonl     # Brain peer-sync mutation history
│   │   ├── digests.jsonl      # Daily digest history
│   │   └── reviews.jsonl      # Weekly review history
│   ├── digital-twin/          # Digital twin identity documents
│   │   ├── meta.json          # Settings and state
│   │   └── documents/         # Markdown identity documents
│   ├── uploads/               # Generic file uploads
│   ├── repos/                 # Cloned GitHub repositories
│   └── agent-personalities/   # Agent personality configs
│
├── docs/                      # Documentation
│   └── GOALS_OPERATIONAL.md   # Operational CoS goals
├── .github/workflows/         # CI/CD
├── GOALS.md                   # Repository mission and goals
└── ecosystem.config.cjs       # PM2 configuration
```

Each Brain `collectionStore` directory contains a schema-versioned `index.json`
and stores every record at `<id>/index.json`.

## Data Flow

### HTTP Request Flow

```
Browser → React Page → api.js → Express Route → Service → Response
                                     │
                                     ├── Zod Validation
                                     ├── Service Logic
                                     └── PostgreSQL / data/ file / PM2 API
```

### WebSocket Event Flow

```
Server Event → Socket.IO → socket.js → React Component State Update
     │
     └── Real-time: logs, CoS status, errors, memory changes
```

### Chief of Staff Flow

```
1. Task Watcher monitors TASKS.md for changes
2. CoS Service evaluates tasks on interval
3. For each pending task:
   a. Select appropriate AI model based on task complexity
   b. Build prompt with context and memory injection
   c. Spawn Claude CLI via Sub-Agent Spawner
4. Agent executes task, output captured
5. On completion:
   a. Mark task as completed
   b. Extract memories from output
   c. Update usage metrics
```

### Browser Automation Flow

```
1. portos-browser launches persistent Chromium with CDP on :5556
2. Health server on :5557 reports connection status
3. Express Server proxies browser management via browserService.js:
   - Client UI (Browser.jsx) → /api/browser/* → browserService → CDP/PM2
4. CoS agents connect directly to CDP WebSocket for web automation
5. Configuration persisted to data/browser-config.json
```

### Autofixer Flow

```
1. portos-autofixer daemon starts, reads registered apps from data/apps.json
2. Every 15 minutes, polls PM2 (pm2 jlist) for crashed processes
3. For each errored process (with 30min cooldown):
   a. Fetch last 100 lines of error logs + 50 lines of output logs
   b. Build prompt with crash context and app info
   c. Spawn Claude CLI in app's repo directory to diagnose and fix
   d. Save session (prompt.txt, output.txt, metadata.json) to data/autofixer/sessions/
4. portos-autofixer-ui (:5560) serves standalone dashboard:
   - SSE endpoint for real-time log streaming
   - Fix history viewer with success/failure status
   - Process status indicators
```

## Key Services

### Apps Service (`server/services/apps.js`)
- CRUD operations for registered apps
- Persists to `data/apps.json`

### PM2 Service (`server/services/pm2.js`)
- Start/stop/restart processes
- Status monitoring
- Log retrieval

### Runner Service (`server/services/runner.js`)
- AI provider execution
- CLI and API-based providers
- Output streaming and capture

### CoS Service (`server/services/cos.js`)
- Task evaluation and prioritization
- Agent orchestration
- Health monitoring
- Self-improvement task generation

### Sub-Agent Spawner (`server/services/subAgentSpawner.js`)
- `initSpawner()`: CoS Runner connection + runner event handlers, the `task:ready` → spawn and `agent:terminate` → terminate listeners, run-directory pruning, orphan sweep
- The work itself lives in focused siblings: `agentLifecycle.js` (spawn/completion), `agentCliSpawning.js` / `agentTuiSpawning.js` (process spawning), `agentModelSelection.js`, `agentPromptBuilder.js`, `agentRunTracking.js`

### Agent Orchestrator (`server/services/agentOrchestrator.js`)
- The one entry point for an agent LIFECYCLE TRANSITION (pause / kill / terminate / complete / spawn) — read its header before touching the agent cluster

### Memory Service (`server/services/memoryBackend.js`)
- Backend switcher: PostgreSQL + pgvector (`memoryDB.js`) for real installs; the file backend (`memory.js`) is a test-only escape hatch
- Semantic memory storage with vector embeddings via LM Studio
- Memory retrieval for context injection

### Task Learning Service (`server/services/taskLearning.js`)
- Completion tracking and success rates
- Duration estimates by task type
- Model tier effectiveness analysis
- Actionable recommendations

### Task Schedule Service (`server/services/taskSchedule.js`)
- Interval/cron scheduling for CoS self-improvement and app tasks
- Autonomous jobs (`/api/cos/jobs`) with command allowlist enforcement for shell jobs
- Prompt-template versioning with auto-upgrade of unchanged defaults

### Brain Service (`server/services/brain.js`)
- Thought capture and AI classification
- CRUD for People, Projects, Ideas, Admin
- Daily digest and weekly review generation
- Classification correction workflow
- Link capture with GitHub auto-clone

### Digital Twin Service (`server/services/digital-twin.js`)
- Identity scaffold document management
- Personality trait extraction (Big Five, values hierarchy)
- Behavioral test generation and execution
- External data import (Goodreads, Spotify, Letterboxd, iCal)
- Confidence scoring and gap recommendations

### Agent Personalities (`server/services/agentPersonalities.js`)
- Agent personality CRUD and AI generation
- Custom communication styles, tones, and quirks

### Browser Service (`server/services/browserService.js`)
- Manages portos-browser lifecycle via PM2 (launch/stop/restart)
- Proxies CDP queries (open pages, version info) via HTTP to :5556
- Health checks against :5557
- Configuration CRUD persisted to `data/browser-config.json`
- CDP host restricted to localhost to prevent SSRF

### Autofixer (`autofixer/server.js` + `autofixer/ui.js`)
- **Daemon** (:5559): Polls PM2 every 15 minutes for errored processes
- Reads `data/apps.json` to know which processes to monitor
- 30-minute cooldown per process to prevent fix loops
- Spawns Claude CLI with crash context (error logs + app info) to auto-repair
- Stores fix sessions in `data/autofixer/sessions/` (prompt, output, metadata)
- **UI** (:5560): Standalone Express server with SSE real-time log streaming
  - Serves HTTPS with the shared Tailscale cert (`data/certs/`) when one is present, plain HTTP otherwise — matching the scheme the sidebar's `//<host>:5560` link inherits from the main app
- Fix history viewer, process status dashboard

### Shell Service (`server/services/shell.js`)
- PTY-based web terminal via node-pty
- Session management with WebSocket I/O
- Terminal resize handling

## Error Handling

All routes use `asyncHandler` wrapper from `server/lib/errorHandler.js`:

```javascript
// Routes automatically catch errors and:
// 1. Log to console with emoji prefix
// 2. Emit Socket.IO event for UI notification
// 3. Return structured JSON error response
```

Error severity levels:
- **warning**: Non-critical, logged only
- **error**: Server error, shown to user
- **critical**: System-threatening, triggers auto-fix

## Security Model

1. **Network Security**: Relies on Tailscale for access control
2. **Command Allowlist**: Shell execution restricted to approved commands
3. **No Shell Interpolation**: Uses `spawn()` with argument arrays
4. **Zod Validation**: All API inputs validated
5. **Path Traversal Prevention**: Filename sanitization on uploads

## PM2 Process Map

| Process | Port | Script | Purpose |
|---------|------|--------|---------|
| portos-ui | 5554 | `client/node_modules/vite/bin/vite.js` | React frontend dev server (dev only) |
| portos-server | 5555 | `server/index.js` | Main Express API server |
| portos-browser | 5556 (CDP), 5557 (health) | `browser/server.js` | Persistent Chromium with CDP for web automation |
| portos-cos | 5558 | `server/cos-runner/index.js` | Isolated CoS agent runner |
| portos-autofixer | 5559 | `autofixer/server.js` | Autonomous crash detection and Claude CLI repair |
| portos-autofixer-ui | 5560 | `autofixer/ui.js` | Standalone fix history dashboard with SSE logs |

PostgreSQL itself is not PM2-managed — it runs as the system service (`:5432`) or the `docker-compose.yml` container (`:5561`), provisioned by `npm run setup:db`.

## Extension Points

### Adding a New Page
1. Create component in `client/src/pages/`.
2. Add `<Route>` in `client/src/App.jsx`.
3. Add a navigation command entry in `server/lib/navManifest.js` (`NAV_COMMANDS`) with its keywords, section, icon, and title so the `⌘K` command palette and the voice agent's `ui_navigate` tool can discover and navigate to the page.
4. If the page belongs to an optional feature (e.g. `post`, `datadog`, `jira`, `gsd`), register the feature in `server/lib/instanceFeatureRegistry.js` and tag the nav command with `feature: '<id>'` (or map its section in `SECTION_FEATURE`).
5. Add the sidebar navigation link in `client/src/components/Layout.jsx` (tagged with `feature` if optional).

### Adding an API Endpoint
1. Create route file in `server/routes/` and mount it in `server/index.js`.
2. Validate incoming request parameters and bodies using `validateRequest` with reusable Zod schemas (in `server/lib/validation.js` or domain-specific validation modules).
3. Register detailed API operation metadata and schemas in `server/lib/apiOperationContracts.js`. Add `x-portos-tool` if the operation should be exposed as an agent-callable tool, and declare thrown error codes in `x-portos-error-codes`.
4. If the endpoint or domain emits real-time Socket.IO events, declare their payload contracts in `server/lib/socketEventContracts.js`.

### Adding a Service
1. Create service file in `server/services/`.
2. Export pure or domain functions (favor functional programming over classes).
3. Import in routes and wrap handlers with `asyncHandler` from `server/lib/errorHandler.js`.

### Adding a Shared Helper, Hook, or Utility
1. Choose the proper directory by concern:
   - Pure / side-effect-free server helpers → `server/lib/`
   - Pure / side-effect-free client helpers → `client/src/lib/`
   - React state and lifecycle hooks → `client/src/hooks/` (prefix with `use`)
   - Pure formatting and mathematical helpers → `client/src/utils/`
   - API / network / WebSocket clients → `client/src/services/` (prefix with `api*`)
2. **Catalog Parity Rule**: Every new module MUST be re-exported in that directory's `index.js` barrel (or `services/api.js`) AND documented in that directory's `README.md` table. This invariant is enforced by unit tests (e.g., `server/lib/index.test.js`, `client/src/lib/index.test.js`).

### Adding a Data Store
1. Determine the storage tier according to `docs/STORAGE.md`.
2. Core application relational records are `db-primary` and must be stored in PostgreSQL with schema migrations in `scripts/migrations/`.
3. File-backed collections under `data/` should use `createCollectionStore` (`server/lib/collectionStore.js`) for schema-versioned layouts (`data/{type}/{id}/index.json`) with atomic writes and per-record queues.

### Adding CoS Task Types
1. Add the task type to `SELF_IMPROVEMENT_TASK_TYPES` and `DEFAULT_TASK_INTERVALS` in `server/services/taskSchedule.js`.
2. Add its prompt template to `DEFAULT_TASK_PROMPTS` in `server/services/taskPromptDefaults/prompts.js` (bump `PROMPT_VERSIONS` + append the outgoing default to `PREVIOUS_DEFAULT_PROMPTS` if you are changing an existing default).
3. If it is an audit that should be configurable to **file issues** or **do the work**, add it to `AUDIT_DEFINITIONS` in `server/lib/auditCatalog.js` (and map any matching quota-burn preset via `quotaBurnId`).
4. If it ALWAYS files findings/plans into the app's work tracker (never implements), add a wording preset to `TRACKER_FILING_PRESETS` in `server/lib/workTracker.js` and reference `{trackerInstructions}` in its prompt template — membership is what makes `resolveTrackerFilingBlock` file on every dispatch.
5. Give it a home in `WORKFLOW_STAGES` (`server/services/workflow.js`) so the Workflow tab doesn't render it under Ambient.
