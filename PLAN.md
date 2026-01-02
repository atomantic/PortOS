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

### Documentation
- [Contributing Guide](./docs/CONTRIBUTING.md) - Code guidelines, git workflow
- [Versioning & Releases](./docs/VERSIONING.md) - Version format, release process

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
- **UI Server** (`autofixer/ui.js`): Web interface for viewing logs and fix history on port 6000
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
| UI Port | 6000 |
| Check Interval | 15 minutes |
| Fix Cooldown | 30 minutes |
| Max History | 100 entries |
