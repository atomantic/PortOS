# Architecture Overview

PortOS is a monorepo application with a React frontend and Express.js backend, managed by PM2.

## System Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              PortOS                                      │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────────────┐        ┌──────────────────────────────────────┐   │
│  │   React Client   │        │          Express Server              │   │
│  │    (port 5555)   │        │           (port 5554)                │   │
│  │                  │        │                                      │   │
│  │  ┌────────────┐  │  HTTP  │  ┌──────────┐   ┌────────────────┐   │   │
│  │  │   Pages    │◄─┼────────┼──┤  Routes  │───│    Services    │   │   │
│  │  └────────────┘  │        │  └──────────┘   └────────────────┘   │   │
│  │        │         │        │        │               │             │   │
│  │  ┌────────────┐  │Socket.IO│       │         ┌─────▼─────┐       │   │
│  │  │ Components │◄─┼────────┼────────┘         │  PM2 API  │       │   │
│  │  └────────────┘  │        │                  └───────────┘       │   │
│  │        │         │        │                        │             │   │
│  │  ┌────────────┐  │        │                  ┌─────▼─────┐       │   │
│  │  │  Services  │  │        │                  │ JSON Files│       │   │
│  │  │ (api.js)   │  │        │                  │  (data/)  │       │   │
│  │  └────────────┘  │        │                  └───────────┘       │   │
│  └──────────────────┘        └──────────────────────────────────────┘   │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                    Chief of Staff (CoS)                           │   │
│  │                                                                   │   │
│  │  ┌─────────────┐  ┌──────────────┐  ┌────────────────────────┐   │   │
│  │  │ Task Watcher│  │ CoS Service  │  │   Sub-Agent Spawner    │   │   │
│  │  │(TASKS.md)   │──│ (evaluation) │──│   (Claude CLI)         │   │   │
│  │  └─────────────┘  └──────────────┘  └────────────────────────┘   │   │
│  │         │                │                     │                  │   │
│  │  ┌──────▼──────────────▼─────────────────────▼───────────────┐   │   │
│  │  │              portos-cos (Runner - port 5558)               │   │   │
│  │  │           Isolated process for agent management            │   │   │
│  │  └────────────────────────────────────────────────────────────┘   │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
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
│       └── services/          # API client (api.js, socket.js)
│
├── server/                    # Express.js backend
│   ├── routes/                # HTTP endpoint handlers
│   ├── services/              # Business logic
│   │   ├── cos.js             # Chief of Staff core
│   │   ├── subAgentSpawner.js # Claude CLI integration
│   │   ├── pm2.js             # PM2 process management
│   │   ├── runner.js          # AI execution engine
│   │   └── memory.js          # Memory system
│   ├── lib/                   # Shared utilities
│   │   ├── errorHandler.js    # Error normalization
│   │   ├── validation.js      # Zod schemas
│   │   └── taskParser.js      # TASKS.md parser
│   └── cos-runner/            # Isolated agent runner
│       └── index.js           # Standalone Express server
│
├── data/                      # Runtime data (gitignored)
│   ├── apps.json              # Registered apps
│   ├── providers.json         # AI provider configs
│   ├── history.json           # Action history
│   ├── TASKS.md               # User task file
│   ├── COS-TASKS.md           # System task file
│   ├── COS-GOALS.md           # Mission and goals
│   ├── cos/                   # CoS state and agents
│   │   ├── state.json         # Daemon state
│   │   ├── agents/            # Agent outputs
│   │   └── memory/            # Memory storage
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

| Process | Port | Purpose |
|---------|------|---------|
| portos-server | 5554 | Main API server |
| portos-client | 5555 | Vite dev server |
| portos-browser | 5556-5557 | Playwright browser (optional) |
| portos-cos | 5558 | Isolated agent runner |
| portos-autofixer | 5559 | Crash detection daemon |
| portos-autofixer-ui | 5560 | Autofixer web UI |

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
