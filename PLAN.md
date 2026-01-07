# Port OS - Implementation Plan

See full plan at: `~/.claude/plans/mutable-inventing-eagle.md`

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

### Milestones
- [x] M0: Bootstrap (ports, basic UI shell)
- [x] M1: App registry + grid
- [x] M2: PM2 integration (start/stop/restart/status)
- [x] M3: Log viewer (Socket.IO streaming)
- [x] M4: App wizard (register existing + create new)
- [x] M5: AI providers + headless executor
- [x] M6: Dev tools (history, command runner)
- [ ] M7: App templates (create from templates, template management)
- [x] M8: Prompt manager (customizable AI prompts, variables, stages)
- [x] M9: Streaming import detection (websocket updates, progressive discovery)
- [x] M10: Enhanced DevTools (provider/model selection, screenshot upload, git status, usage metrics)
- [x] M11: AI Agents Page (process detection, kill ability, colorful UI, expandable details)
- [x] M12: History Improvements (expandable entries, runtime/output capture, full command display)
- [x] M13: Autofixer Integration (PM2 crash detection, Claude CLI auto-fix, session history UI)
- [x] M14: Chief of Staff (autonomous agent manager, TASKS.md, system health, self-improvement)
- [x] M15: Graceful Error Handling (error normalization, auto-fix integration, Socket.IO events)
- [~] M16: Memory System (semantic memory, LM Studio embeddings, auto-extraction, agent context injection)
- [x] M17: PM2 Ecosystem Config Enhancement (per-process port detection, CDP_PORT support, refresh button)
- [x] M18: PM2 Standardization (LLM-powered config refactoring, import integration, button trigger)
- [x] M19: CoS Agent Runner (isolated PM2 process for agent spawning, prevents orphaned processes)
- [x] M20: AI Provider Error Handling (error extraction, categorization, CoS investigation tasks)

### Documentation
- [Contributing Guide](./docs/CONTRIBUTING.md) - Code guidelines, git workflow
- [Versioning & Releases](./docs/VERSIONING.md) - Version format, release process

### Error Handling
The server implements comprehensive error handling:
- **asyncHandler**: All routes wrapped with error handler that catches uncaught errors
- **ServerError**: Custom error class with status, code, severity, and context
- **Socket.IO Events**: Errors broadcast to UI via `error:occurred` event
- **Process Handlers**: Unhandled rejections and uncaught exceptions emit socket events
- **Logging**: Errors logged with emoji prefixes, no server crashes
- See `server/lib/errorHandler.js` and `server/services/socket.js`

---

## M4: App Wizard (Detailed)

The wizard supports two modes:

### Mode 1: Register Existing App
For apps already running on the system (any path, any user):

**Steps:**
1. **Basic Info**: Name, description, icon
2. **Location**: Repo path (file picker or manual entry)
3. **Ports**: UI port, API port (can auto-detect from running processes)
4. **Process Config**:
   - Start command(s)
   - PM2 process name(s)
   - Env file location
5. **Confirm & Register**

**Features:**
- Detect running processes on specified ports
- Validate repo path exists
- Optional: import existing PM2 process into registry
- No scaffolding, no git operations

### Mode 2: Create New App
Scaffold a new project from template:

**Steps:**
1. **Basic Info**: Name, description
2. **Template**: Select template (vite+express, node-server, static)
3. **Location**: Parent directory for new repo
4. **Ports**: Allocate from available range
5. **Git Setup**:
   - Initialize git
   - Create GitHub repo (optional, via `gh` CLI)
6. **Confirm & Create**

**Actions on create:**
- Copy template files
- Configure .env with ports
- Run `npm install`
- Initialize git + first commit
- Create GitHub repo (if selected)
- Generate PM2 ecosystem config
- Register in PortOS
- Start with PM2

### API Endpoints (M4)
| Route | Description |
|-------|-------------|
| POST /api/apps | Register existing app |
| POST /api/scaffold | Create new app from template |
| GET /api/templates | List available templates |
| POST /api/detect/ports | Detect process on port |
| POST /api/detect/repo | Validate repo path, detect type |

---

### All API Endpoints
| Route | Description |
|-------|-------------|
| GET /api/health | Health check |
| GET/POST /api/apps | List/register apps |
| GET/PUT/DELETE /api/apps/:id | App CRUD |
| POST /api/apps/:id/start | Start via PM2 |
| POST /api/apps/:id/stop | Stop via PM2 |
| POST /api/apps/:id/restart | Restart via PM2 |
| GET /api/apps/:id/status | PM2 status |
| GET /api/apps/:id/logs | Get logs |
| GET /api/ports/scan | Scan ports |
| GET /api/logs/processes | List PM2 processes |
| GET /api/logs/:name | Get logs (static) |
| Socket.IO logs:subscribe | Stream logs (WebSocket) |
| POST /api/scaffold | Create new app |
| GET /api/templates | List templates |
| POST /api/detect/ports | Detect process on port |
| POST /api/detect/repo | Validate repo path |
| GET /api/providers | List AI providers |
| POST /api/providers | Add provider |
| PUT /api/providers/:id | Update provider |
| DELETE /api/providers/:id | Delete provider |
| POST /api/providers/:id/test | Test provider connectivity |
| PUT /api/providers/active | Set active provider |
| GET /api/runs | List run history |
| POST /api/runs | Execute new run |
| GET /api/runs/:id | Get run details |
| GET /api/runs/:id/output | Get run output |
| POST /api/runs/:id/stop | Stop active run |
| DELETE /api/runs/:id | Delete run |
| GET /api/history | List action history |
| GET /api/history/stats | Get history statistics |
| DELETE /api/history | Clear history |
| POST /api/commands/execute | Execute shell command |
| POST /api/commands/:id/stop | Stop running command |
| GET /api/commands/allowed | List allowed commands |
| GET /api/commands/processes | List PM2 processes |
| POST /api/detect/ai | AI-powered app detection |
| GET /api/templates | List available templates |
| POST /api/templates/create | Create app from template |
| POST /api/templates | Add custom template |
| DELETE /api/templates/:id | Delete custom template |
| GET /api/agents | List running AI agent processes |
| GET /api/agents/:pid | Get agent process details |
| DELETE /api/agents/:pid | Kill agent process |

---

## M7: App Templates (Planned)

Templates allow creating new apps from pre-configured project structures.

### Built-in Template: PortOS Stack
The default template mirrors this application's architecture:
- Express.js API server
- React + Vite frontend
- Tailwind CSS styling
- Collapsible navigation layout
- PM2 ecosystem configuration
- GitHub Actions CI/CD workflows
- Auto-versioning system

### Features
1. **Template Selection**: Browse available templates with feature descriptions
2. **App Creation**: Scaffold new project with chosen name and target directory
3. **Custom Templates**: Register additional templates from local paths
4. **Template Management**: View, edit, delete custom templates

### Pages
- `/templates` - Template browser and app creation
- `/templates/new` - Register custom template

### Template Structure
Templates are stored in `./data/templates/` with:
- `manifest.json` - Template metadata and feature list
- Source files to copy when creating new app

### API Endpoints
| Route | Description |
|-------|-------------|
| GET /api/templates | List all templates |
| POST /api/templates | Add custom template |
| POST /api/templates/create | Create app from template |
| DELETE /api/templates/:id | Remove custom template |

---

## M8: Prompt Manager (Planned)

Customizable AI prompts for all backend AI operations. Inspired by void-private's prompt management architecture.

### Architecture
- **File-based prompts**: Prompts stored as `.md` files for easy editing and version control
- **Variable system**: Reusable variables with metadata, categories, and usage tracking
- **Stage configuration**: Each prompt stage defines provider, model type, and execution options
- **Template rendering**: Mustache-like syntax with conditionals, arrays, and nested data

### Directory Structure
```
./data/prompts/
├── stages/              # Individual prompt templates (.md files)
│   ├── app-detection.md
│   ├── code-analysis.md
│   └── ...
├── variables.json       # Reusable prompt variables
└── stage-config.json    # Stage metadata and provider config
```

### Features
1. **Prompt Stages**: Define different prompts for different AI tasks (detection, analysis, etc.)
2. **Variables**: Reusable content blocks (personas, formats, constraints)
3. **Per-Stage Provider Config**: Each stage can use different AI providers/models
4. **Web UI**: Edit prompts, variables, and preview rendered output
5. **Template Syntax**: `{{variable}}`, `{{#condition}}...{{/condition}}`, arrays

### UI Pages
- `/prompts` - Prompt Manager with tabs for Stages, Variables, Elements
- Live preview with test variables
- Insert variable references

### API Endpoints
| Route | Description |
|-------|-------------|
| GET /api/prompts | List all prompt stages |
| GET /api/prompts/:stage | Get stage template |
| PUT /api/prompts/:stage | Update stage/template |
| POST /api/prompts/:stage/preview | Preview compiled prompt |
| GET /api/prompts/variables | List all variables |
| PUT /api/prompts/variables/:key | Update variable |
| POST /api/prompts/variables | Create variable |
| DELETE /api/prompts/variables/:key | Delete variable |

---

## M9: Streaming Import Detection (Planned)

Enhanced app import with real-time websocket updates as AI discovers project configuration.

### Features
1. **Progressive Discovery**: Form fields update in real-time as AI analyzes the project
2. **Status Animations**: Visual indicators showing detection progress
3. **PM2 Detection**: Check if app is already running in PM2
4. **Websocket Updates**: Server streams discoveries to UI as they happen

### Discovery Steps (streamed to UI)
1. Validating directory path
2. Reading package.json
3. Detecting project type (React, Express, monorepo, etc.)
4. Finding configuration files
5. Extracting ports from configs
6. Detecting start commands
7. Checking PM2 process status
8. AI-powered analysis for name, description
9. Generating PM2 process names

### UI/UX
- Progress indicator with current step
- Form fields animate in as values are discovered
- Already-running indicator if detected in PM2
- Expandable "Detection Log" showing raw discovery output

### API
| Route | Description |
|-------|-------------|
| WS /api/detect/stream | Websocket for streaming detection |
| GET /api/detect/pm2-status | Check if app running in PM2 |

---

## M13: Autofixer Integration

Autonomous crash detection and repair using Claude CLI.

### Architecture
- **Daemon Process** (`autofixer/server.js`): Monitors PM2 for crashed processes registered in PortOS
- **UI Server** (`autofixer/ui.js`): Web interface for viewing logs and fix history on port 5560
- **PM2 Integration**: Runs as `portos-autofixer` and `portos-autofixer-ui` processes

### Features
1. **Crash Detection**: Polls PM2 every 15 minutes for `errored` status on registered apps
2. **Auto-Fix**: Invokes Claude CLI with crash context (error logs, app info) to diagnose and repair
3. **Session History**: Stores fix attempts with prompts, outputs, and success/failure status
4. **Cooldown**: 30-minute cooldown per process to prevent repeated fix loops
5. **Log Streaming**: Real-time SSE log streaming from any PM2 process
6. **Tailscale Compatible**: Dynamic hostname for remote access

### Data Storage
```
./data/autofixer/
├── index.json           # Fix session index
└── sessions/
    └── {sessionId}/
        ├── prompt.txt    # Prompt sent to Claude
        ├── output.txt    # Claude's response
        └── metadata.json # Session details
```

### Autofixer UI (port 6000)
- Process sidebar with live status indicators
- SSE-powered log viewer with pause/clear controls
- History tab showing fix attempts with success/failure status
- Links back to PortOS Dashboard

### Configuration
| Setting | Value |
|---------|-------|
| UI Port | 5560 |
| Check Interval | 15 minutes |
| Fix Cooldown | 30 minutes |
| Max History | 100 entries |

---

## M14: Chief of Staff

Autonomous agent manager that watches task files, spawns sub-agents, and maintains system health.

### Architecture
- **Task Parser** (`server/lib/taskParser.js`): Parses TASKS.md and COS-TASKS.md formats
- **CoS Service** (`server/services/cos.js`): State management, health monitoring, task evaluation
- **Task Watcher** (`server/services/taskWatcher.js`): File watching with chokidar
- **Sub-Agent Spawner** (`server/services/subAgentSpawner.js`): Claude CLI execution with MCP
- **CoS Routes** (`server/routes/cos.js`): REST API endpoints
- **CoS UI** (`client/src/pages/ChiefOfStaff.jsx`): Tasks, Agents, Health, Config tabs

### Features
1. **Dual Task Lists**: User tasks (TASKS.md) and system tasks (COS-TASKS.md)
2. **Autonomous Execution**: Auto-approved tasks run without user intervention
3. **Approval Workflow**: Tasks marked APPROVAL require user confirmation
4. **System Health Monitoring**: PM2 process checks, memory usage, error detection
5. **Sub-Agent Spawning**: Claude CLI with --dangerously-skip-permissions and MCP servers
6. **Self-Improvement**: Can analyze performance and suggest prompt/config improvements
7. **Script Generation**: Creates automation scripts for repetitive tasks
8. **Report Generation**: Daily summaries of completed work

### Task File Format
```markdown
# Tasks
## Pending
- [ ] #task-001 | HIGH | Task description
  - Context: Additional context
  - App: app-name

## In Progress
- [~] #task-002 | MEDIUM | Another task
  - Agent: agent-id
  - Started: 2024-01-15T10:30:00Z

## Completed
- [x] #task-003 | LOW | Done task
  - Completed: 2024-01-14T15:45:00Z
```

### System Task Format (with approval flags)
```markdown
- [ ] #sys-001 | HIGH | AUTO | Auto-approved task
- [ ] #sys-002 | MEDIUM | APPROVAL | Needs user approval
```

### Data Storage
```
./data/cos/
├── state.json           # Daemon state and config
├── agents/{agentId}/    # Agent prompts and outputs
├── reports/{date}.json  # Daily reports
└── scripts/             # Generated automation scripts
```

### API Endpoints
| Route | Description |
|-------|-------------|
| GET /api/cos | Get CoS status |
| POST /api/cos/start | Start daemon |
| POST /api/cos/stop | Stop daemon |
| GET/PUT /api/cos/config | Configuration |
| GET /api/cos/tasks | Get all tasks |
| POST /api/cos/evaluate | Force evaluation |
| GET /api/cos/health | Health status |
| POST /api/cos/health/check | Run health check |
| GET /api/cos/agents | List agents |
| POST /api/cos/agents/:id/terminate | Terminate agent |
| GET /api/cos/reports | List reports |

### Prompt Templates
| Template | Purpose |
|----------|---------|
| cos-agent-briefing | Brief sub-agent on task |
| cos-evaluate | Evaluate tasks and decide actions |
| cos-report-summary | Generate daily summary |
| cos-self-improvement | Analyze and suggest improvements |

### Configuration
| Setting | Default | Description |
|---------|---------|-------------|
| evaluationIntervalMs | 60000 | Task evaluation interval |
| healthCheckIntervalMs | 900000 | Health check interval |
| maxConcurrentAgents | 3 | Max parallel agents |
| maxProcessMemoryMb | 2048 | Memory alert threshold |
| autoStart | false | Start on server boot |
| selfImprovementEnabled | true | Allow self-analysis |

### Model Selection Rules
The `selectModelForTask` function in `subAgentSpawner.js` routes tasks to appropriate model tiers:

| Tier | Trigger | Example Tasks |
|------|---------|---------------|
| **heavy** | Critical priority, visual analysis, complex reasoning | Architect, refactor, security audit, long context |
| **medium** | Standard development tasks, default | Most coding tasks, bug fixes, feature implementation |
| **light** | Documentation-only tasks | Update README, write docs, format text |

**Important**: Light model (haiku) is NEVER used for coding tasks. Tasks containing keywords like `fix`, `bug`, `implement`, `test`, `feature`, `api`, `component`, etc. are automatically routed to medium tier or higher.

---

## M15: Graceful Error Handling

Enhanced error handling system with automatic recovery and UI notifications.

### Architecture
- **Error Handler** (`server/lib/errorHandler.js`): Centralized error normalization and Socket.IO emission
- **Auto-Fixer** (`server/services/autoFixer.js`): Automatic agent spawning for critical errors
- **Socket.IO Integration**: Real-time error notifications to connected clients
- **Route Protection**: All routes use asyncHandler wrapper for consistent error handling

### Features
1. **Graceful Error Handling**: Server never crashes, all errors caught and handled
2. **Socket.IO Error Events**: Real-time error notifications to UI with severity and context
3. **Auto-Fix Tasks**: Critical errors automatically create CoS tasks for agent resolution
4. **Error Recovery UI**: Client can request manual error recovery via Socket.IO
5. **Process Error Handlers**: Unhandled rejections and exceptions trigger auto-fix
6. **Error Deduplication**: Prevents duplicate auto-fix tasks within 1-minute window

### Error Severity Levels
| Severity | Description | Auto-Fix |
|----------|-------------|----------|
| warning | Non-critical issues | No |
| error | Server errors, failures | No |
| critical | System-threatening errors | Yes |

### Socket.IO Events
| Event | Direction | Payload |
|-------|-----------|---------|
| error:occurred | Server → Client | Error details with severity, code, timestamp |
| system:critical-error | Server → Client | Critical errors only |
| error:notified | Server → Subscribers | Error notification to subscribed clients |
| errors:subscribe | Client → Server | Subscribe to error events |
| errors:unsubscribe | Client → Server | Unsubscribe from error events |
| error:recover | Client → Server | Request manual error recovery |
| error:recover:requested | Server → Client | Recovery task created confirmation |

### Auto-Fix Flow
1. Error occurs in route or service
2. `asyncHandler` catches and normalizes error
3. Error emitted to `errorEvents` EventEmitter
4. `autoFixer` checks if error should trigger auto-fix
5. If yes, creates CoS task with error context
6. Socket.IO broadcasts error to all connected clients
7. CoS evaluates and spawns agent to fix the error
8. Agent analyzes, fixes, and reports back

### Implementation Files
| File | Purpose |
|------|---------|
| `server/lib/errorHandler.js` | Error classes, asyncHandler, middleware |
| `server/services/autoFixer.js` | Auto-fix task creation and deduplication |
| `server/services/socket.js` | Socket.IO error event forwarding |
| `server/routes/*.js` | All routes use asyncHandler wrapper |
| `client/src/hooks/useErrorNotifications.js` | Client-side error event handler with toast notifications |
| `client/src/components/Layout.jsx` | Mounts error notification hook for app-wide coverage |

### Error Context
Errors include rich context for debugging:
- Error code and message
- HTTP status code
- Timestamp
- Stack trace (for 500+ errors)
- Custom context object
- Severity level
- Auto-fix flag

---

## M16: Memory System

Semantic memory system for the Chief of Staff that stores facts, learnings, observations, decisions, and user preferences with vector embeddings for intelligent retrieval.

### Architecture
- **Memory Service** (`server/services/memory.js`): Core CRUD, search, and lifecycle operations
- **Embeddings Service** (`server/services/memoryEmbeddings.js`): LM Studio integration for vector generation
- **Memory Extractor** (`server/services/memoryExtractor.js`): Extract memories from agent output
- **Memory Retriever** (`server/services/memoryRetriever.js`): Context injection for agent prompts
- **Memory Routes** (`server/routes/memory.js`): REST API endpoints
- **Memory Tab** (`ChiefOfStaff.jsx`): UI with list, timeline, and graph views

### Features
1. **Six Memory Types**: fact, learning, observation, decision, preference, context
2. **Semantic Search**: LM Studio embeddings for similarity-based retrieval
3. **Auto-Extraction**: Memories extracted from successful agent task completions
4. **Auto-Injection**: Relevant memories injected into agent prompts before execution
5. **Importance Decay**: Time-based decay with access-based boosts
6. **Memory Consolidation**: Merge similar memories automatically
7. **Real-time Updates**: WebSocket events for memory changes
8. **Graph Visualization**: D3.js relationship graph (planned)

### Memory Schema
```javascript
{
  id: string,              // UUID
  type: 'fact' | 'learning' | 'observation' | 'decision' | 'preference' | 'context',
  content: string,         // Full memory content
  summary: string,         // Short summary
  category: string,        // e.g., 'codebase', 'workflow', 'tools'
  tags: string[],          // Auto-extracted and user-defined
  relatedMemories: string[], // Linked memory IDs
  sourceTaskId: string,    // Origin task
  sourceAgentId: string,   // Origin agent
  embedding: number[],     // Vector (768 dims for nomic-embed)
  confidence: number,      // 0.0-1.0
  importance: number,      // 0.0-1.0 (decays over time)
  accessCount: number,
  lastAccessed: string,
  createdAt: string,
  status: 'active' | 'archived' | 'expired'
}
```

### Data Storage
```
./data/cos/memory/
├── index.json         # Lightweight metadata for listing/filtering
├── embeddings.json    # Vector storage for semantic search
└── memories/          # Full memory content
    └── {id}/
        └── memory.json
```

### API Endpoints
| Route | Description |
|-------|-------------|
| GET /api/memory | List memories with filters |
| GET /api/memory/:id | Get single memory |
| POST /api/memory | Create memory |
| PUT /api/memory/:id | Update memory |
| DELETE /api/memory/:id | Delete (soft) memory |
| POST /api/memory/search | Semantic search |
| GET /api/memory/categories | List categories |
| GET /api/memory/tags | List tags |
| GET /api/memory/timeline | Timeline view data |
| GET /api/memory/graph | Graph visualization data |
| GET /api/memory/stats | Memory statistics |
| POST /api/memory/link | Link two memories |
| POST /api/memory/consolidate | Merge similar memories |
| POST /api/memory/decay | Apply importance decay |
| DELETE /api/memory/expired | Clear expired memories |
| GET /api/memory/embeddings/status | LM Studio connection status |

### WebSocket Events
| Event | Description |
|-------|-------------|
| cos:memory:created | New memory created |
| cos:memory:updated | Memory updated |
| cos:memory:deleted | Memory deleted |
| cos:memory:extracted | Memories extracted from agent |
| cos:memory:approval-needed | Medium-confidence memories pending approval |

### LM Studio Configuration
```javascript
memory: {
  enabled: true,
  embeddingProvider: 'lmstudio',
  embeddingEndpoint: 'http://localhost:1234/v1/embeddings',
  embeddingModel: 'nomic-embed-text-v1.5',
  embeddingDimension: 768,
  maxContextTokens: 2000,
  minRelevanceThreshold: 0.7,
  autoExtractEnabled: true
}
```

### Memory Extraction
Memories are extracted from agent output:
1. **Structured Blocks**: `<MEMORY type="..." category="..." confidence="...">content</MEMORY>`
2. **Pattern Matching**: "I learned that...", "User prefers...", "I decided to..."
3. **High confidence (>0.8)**: Auto-saved
4. **Medium confidence (0.5-0.8)**: Queued for user approval

### Memory Injection
Before agent task execution:
1. Generate embedding for task description
2. Find semantically similar memories (>0.7 relevance)
3. Include high-importance user preferences
4. Include relevant codebase facts
5. Format as markdown section in agent prompt

### Implementation Files
| File | Purpose |
|------|---------|
| `server/lib/memoryValidation.js` | Zod schemas for memory operations |
| `server/lib/vectorMath.js` | Cosine similarity, clustering helpers |
| `server/services/memory.js` | Core CRUD, search, lifecycle |
| `server/services/memoryEmbeddings.js` | LM Studio embedding generation |
| `server/services/memoryExtractor.js` | Extract memories from agent output |
| `server/services/memoryRetriever.js` | Retrieve and format for injection |
| `server/routes/memory.js` | REST API endpoints |
| `client/src/pages/ChiefOfStaff.jsx` | MemoryTab, MemoryTimeline, MemoryGraph |
| `client/src/services/api.js` | Memory API client functions |

---

## M17: PM2 Ecosystem Config Enhancement

Enhanced app management to detect and track all PM2 processes with their ports.

### Features
- **Per-process port detection**: Extracts ports for each PM2 process from ecosystem.config.js/cjs
- **CDP_PORT support**: Detects Chrome DevTools Protocol ports for browser processes
- **Constant resolution**: Handles variable references like `CDP_PORT: CDP_PORT` by parsing top-level constants
- **Comment handling**: Properly skips `//` and `/* */` comments when parsing config files
- **Refresh button**: UI button to re-scan ecosystem config and update app data

### Schema Extension
```javascript
// Added to server/lib/validation.js
export const processSchema = z.object({
  name: z.string().min(1),
  port: z.number().int().min(1).max(65535).nullable().optional(),
  description: z.string().optional()
});

// Added to appSchema
processes: z.array(processSchema).optional()
```

### API Endpoint
```
POST /api/apps/:id/refresh-config
```
Re-parses the app's ecosystem config and updates the app with new process/port data.

### Implementation Files
| File | Changes |
|------|---------|
| `server/lib/validation.js` | Added `processSchema` and `processes` field to `appSchema` |
| `server/services/streamingDetect.js` | Added `parseEcosystemConfig()` with port/constant/comment parsing |
| `server/routes/apps.js` | Added `POST /:id/refresh-config` endpoint |
| `client/src/services/api.js` | Added `refreshAppConfig()` function |
| `client/src/pages/Apps.jsx` | Added "Refresh Config" button with loading state |

---

## M18: PM2 Standardization

LLM-powered refactoring to standardize app configurations to follow PM2 best practices.

### Features
1. **Standardize PM2 Button**: Available in each app's expanded details row
2. **LLM Analysis**: Uses configured AI provider to analyze project structure
3. **Auto-apply Changes**: Automatically modifies files with git backup
4. **Git Backup**: Creates backup branch before any modifications
5. **Port Consolidation**: Moves all ports to ecosystem.config.cjs env blocks
6. **Stray Port Removal**: Removes PORT from .env files, comments out port in vite.config

### PM2 Standard
- All ports defined in `ecosystem.config.cjs` env blocks
- PM2 configured with watch for live-reload on server processes
- Vite processes use `npx vite --host --port XXXX` in args
- No stray port references in .env or vite.config

### API Endpoints
| Route | Description |
|-------|-------------|
| POST /api/standardize/analyze | Analyze app and generate standardization plan |
| POST /api/standardize/apply | Apply changes with git backup |
| GET /api/standardize/template | Get standard PM2 template reference |
| POST /api/standardize/backup | Create git backup only |

### Socket Events (for streaming mode)
| Event | Description |
|-------|-------------|
| standardize:start | Client requests standardization |
| standardize:step | Progress update (analyze, backup, apply) |
| standardize:analyzed | Analysis complete with plan |
| standardize:complete | Standardization finished |

### Implementation Files
| File | Purpose |
|------|---------|
| `server/services/pm2Standardizer.js` | Core analysis and apply logic |
| `server/routes/standardize.js` | API endpoints |
| `server/services/socket.js` | Socket event handlers |
| `client/src/pages/Apps.jsx` | Standardize PM2 button |
| `client/src/services/api.js` | API functions |

---

## M19: CoS Agent Runner

Isolated PM2 process for spawning Claude CLI agents, preventing orphaned processes when portos-server restarts.

### Problem
When multiple CoS agents are running and the main portos-server restarts (due to code changes, crashes, or manual restart), child processes spawned via `child_process.spawn()` become orphaned. The parent loses track of them because the `activeAgents` Map is in memory.

### Solution
A separate `portos-cos` PM2 process that:
1. Runs independently from `portos-server`
2. Manages agent spawning via HTTP/Socket.IO bridge
3. Doesn't restart when `portos-server` restarts
4. Maintains its own state file for PID tracking

### Architecture
```
┌─────────────────┐     HTTP/Socket.IO    ┌─────────────────┐
│  portos-server  │ ──────────────────►   │   portos-cos    │
│    (5554)       │     spawn/terminate   │     (5558)      │
│                 │ ◄──────────────────   │                 │
│  subAgentSpawner│     events/output     │  cos-runner     │
└─────────────────┘                       └────────┬────────┘
                                                   │
                                                   │ spawn
                                                   ▼
                                          ┌───────────────┐
                                          │  Claude CLI   │
                                          │   Processes   │
                                          └───────────────┘
```

### Features
1. **Isolated Process**: portos-cos runs as separate PM2 app, unaffected by portos-server restarts
2. **Fallback Mode**: If portos-cos is unavailable, falls back to direct spawning
3. **Event Bridge**: Socket.IO connection forwards agent output/completion events
4. **PID Tracking**: Runner maintains state file with active PIDs for orphan cleanup
5. **Graceful Shutdown**: 30-second kill timeout to allow agents to complete

### Configuration
| Setting | Value | Description |
|---------|-------|-------------|
| Port | 5558 | HTTP/Socket.IO API port |
| kill_timeout | 30s | Grace period for agent shutdown |
| max_restarts | 5 | Limit restarts to prevent loops |
| min_uptime | 30s | Minimum runtime before healthy |

### API Endpoints (portos-cos)
| Route | Description |
|-------|-------------|
| GET /health | Health check with active agent count |
| GET /agents | List active agents |
| POST /spawn | Spawn a new agent |
| POST /terminate/:agentId | Terminate specific agent |
| POST /terminate-all | Terminate all agents |
| GET /agents/:agentId/output | Get agent output buffer |

### Socket.IO Events
| Event | Direction | Payload |
|-------|-----------|---------|
| agent:output | Runner → Server | agentId, text |
| agent:completed | Runner → Server | agentId, taskId, exitCode, success, duration |
| agent:error | Runner → Server | agentId, error |

### Implementation Files
| File | Purpose |
|------|---------|
| `server/cos-runner/index.js` | Standalone Express server for agent management |
| `server/services/cosRunnerClient.js` | Client library for portos-server to communicate with runner |
| `server/services/subAgentSpawner.js` | Updated to use runner when available |
| `ecosystem.config.cjs` | Added portos-cos PM2 configuration |

### Data Storage
```
./data/cos/
├── runner-state.json    # Active agent PIDs and stats
└── agents/{agentId}/    # Agent prompts and outputs (shared)
```

---

## M20: AI Provider Error Handling

Enhanced error extraction and display for AI provider execution failures, with automatic CoS investigation task creation.

### Problem
When AI provider executions fail (e.g., invalid model, API errors), the devtools/runner UI only showed exit codes without meaningful error information, making debugging difficult.

### Solution
1. **Error Extraction**: Extract meaningful error details from CLI output
2. **Error Categorization**: Classify errors by type (model_not_found, auth_error, rate_limit, etc.)
3. **Suggested Fixes**: Provide actionable suggestions for each error category
4. **CoS Integration**: Create investigation tasks for actionable failures
5. **UI Enhancement**: Display error details, category, and suggestions in history list

### Error Categories
| Category | Description | Actionable |
|----------|-------------|------------|
| model_not_found | Model doesn't exist in provider | Yes |
| auth_error | API key invalid or unauthorized | Yes |
| api_error | Generic API request failure | Yes |
| rate_limit | Rate limiting triggered | No (transient) |
| quota_exceeded | Billing/quota issue | Yes |
| network_error | Connection refused/timeout | No (transient) |
| timeout | Process timeout (SIGTERM) | No |
| command_not_found | CLI tool not installed | Yes |
| permission_denied | File/directory access denied | Yes |
| unknown | Unrecognized error pattern | No |

### Error Data Flow
1. **Extraction** (`runner.js::extractErrorDetails`): Parse CLI output for error messages
2. **Categorization** (`runner.js::categorizeError`): Match against known patterns
3. **Emission** (`runner.js::emitProviderError`): Emit to errorEvents EventEmitter
4. **Auto-fix** (`autoFixer.js::handleAIProviderError`): Create CoS investigation task
5. **Display** (`DevTools.jsx`): Show in history with error details, category, and fix suggestion

### Metadata Schema Enhancement
Failed runs now include additional fields:
```javascript
{
  // Existing fields
  exitCode: number,
  success: boolean,
  error: string,         // Primary error message

  // New fields
  errorDetails: string,  // Additional error context
  errorCategory: string, // e.g., 'model_not_found'
  suggestedFix: string   // Actionable suggestion
}
```

### CoS Investigation Tasks
When actionable errors occur, a CoS task is created:
```markdown
## Pending
- [ ] #task-XXX | HIGH | APPROVAL | [Auto] Investigate agent failure: Model not found
  - Context: # AI Provider Execution Failure
    - Provider: Claude Code CLI
    - Model: codex
    - Error: model: codex
    - Suggested Fix: Update model configuration
```

### Implementation Files
| File | Changes |
|------|---------|
| `server/services/runner.js` | Added `extractErrorDetails`, `categorizeError`, `emitProviderError` |
| `server/services/autoFixer.js` | Added `handleAIProviderError`, `buildAIProviderErrorContext` |
| `server/services/subAgentSpawner.js` | Added `analyzeAgentFailure`, `createInvestigationTask` |
| `client/src/pages/DevTools.jsx` | Display `errorCategory`, `errorDetails`, `suggestedFix` |

### UI Display
In the DevTools history, failed runs now show:
- **Error Category Badge**: Colored tag showing the error type
- **Error Message**: Extracted error details
- **Suggested Fix Panel**: Yellow-bordered box with actionable advice
- **Additional Details**: Expandable section with raw error context
