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
│  │  (port 5555)       │    HTTP     │        (port 5554)                   │        │
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
│  │  │  api.js      │  │             │       |         │  JSON Files  │     │        │
│  │  │  socket.js   │  │             │       |         │   (data/)    │     │        │
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
│  │  │ Sub-Agent Spawner   │  │ Chromium instance  │  │ (polls every 15m)      │  │  │
│  │  │ (Claude CLI) -------|->│ CDP WebSocket for  │  │ Claude CLI auto-fix    │  │  │
│  │  │                     │  │ web automation     │  │ Reads apps.json        │  │  │
│  │  └─────────────────────┘  └────────────────────┘  │ Session history        │  │  │
│  │                                                   └────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘

Communication paths:
  Client <--HTTP/Socket.IO--> Server --PM2 API--> all satellite processes
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
│   │   ├── subAgentSpawner.js # Claude CLI integration
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
│   └── package.json           # Playwright dependency
│
├── autofixer/                 # portos-autofixer service
│   ├── server.js              # Crash detection daemon (polls PM2 every 15min)
│   └── ui.js                  # Standalone Express UI with SSE log streaming
│
├── data/                      # Runtime data (gitignored)
│   ├── apps.json              # Registered apps (read by autofixer)
│   ├── providers.json         # AI provider configs
│   ├── history.json           # Action history
│   ├── browser-config.json    # Browser CDP/health configuration
│   ├── TASKS.md               # User task file
│   ├── COS-TASKS.md           # System task file
│   ├── COS-GOALS.md           # Mission and goals
│   ├── cos/                   # CoS state and agents
│   │   ├── state.json         # Daemon state
│   │   ├── agents/            # Agent outputs
│   │   └── memory/            # Memory storage
│   ├── autofixer/             # Autofixer session history
│   │   ├── index.json         # Fix session index (max 100 entries)
│   │   └── sessions/          # Per-session prompt, output, metadata
│   ├── brain/                 # Brain second-brain data
│   │   ├── meta.json          # Settings
│   │   ├── inbox_log.jsonl    # Captured thoughts
│   │   ├── people.jsonl       # People records
│   │   ├── projects.jsonl     # Project records
│   │   ├── ideas.jsonl        # Ideas
│   │   ├── admin.jsonl        # Admin tasks
│   │   ├── links.json         # Saved links
│   │   └── digests.jsonl      # Daily/weekly digests
│   ├── digital-twin/          # Digital twin identity documents
│   │   ├── meta.json          # Settings and state
│   │   └── documents/         # Markdown identity documents
│   ├── uploads/               # Generic file uploads
│   ├── repos/                 # Cloned GitHub repositories
│   └── agent-personalities/   # Agent personality configs
│
├── docs/                      # Documentation
├── .github/workflows/         # CI/CD
└── ecosystem.config.cjs       # PM2 configuration
```

## Data Flow

### HTTP Request Flow

```
Browser → React Page → api.js → Express Route → Service → Response
                                     │
                                     ├── Zod Validation
                                     ├── Service Logic
                                     └── JSON File / PM2 API
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
- Claude CLI process spawning
- Model selection based on task complexity
- MCP server integration
- Usage tracking

### Memory Service (`server/services/memory.js`)
- Semantic memory storage
- Vector embeddings via LM Studio
- Memory retrieval for context injection

### Task Learning Service (`server/services/taskLearning.js`)
- Completion tracking and success rates
- Duration estimates by task type
- Model tier effectiveness analysis
- Actionable recommendations

### Script Runner Service (`server/services/scriptRunner.js`)
- Cron-based script scheduling
- Command allowlist enforcement
- Agent trigger integration
- Run history tracking

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
| portos-server | 5554 | `server/index.js` | Main Express API server |
| portos-client | 5555 | `client/` (Vite) | React frontend dev server |
| portos-browser | 5556 (CDP), 5557 (health) | `browser/server.js` | Persistent Chromium with CDP for web automation |
| portos-cos | 5558 | `server/cos-runner/index.js` | Isolated CoS agent runner |
| portos-autofixer | 5559 | `autofixer/server.js` | Autonomous crash detection and Claude CLI repair |
| portos-autofixer-ui | 5560 | `autofixer/ui.js` | Standalone fix history dashboard with SSE logs |

## Extension Points

### Adding a New Page
1. Create component in `client/src/pages/`
2. Add route in `client/src/App.jsx`
3. Add navigation link in `client/src/components/Layout.jsx`

### Adding an API Endpoint
1. Create route file in `server/routes/`
2. Register in `server/index.js`
3. Add Zod schema if needed in `server/lib/validation.js`

### Adding a Service
1. Create service file in `server/services/`
2. Export functions (not classes)
3. Import in routes as needed

### Adding CoS Task Types
1. Update `SELF_IMPROVEMENT_TYPES` in `server/services/cos.js`
2. Add prompt template in `generateSelfImprovementTask()`
