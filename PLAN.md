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

### Code Guidelines
- **No `window.alert` or `window.confirm`** - Use inline confirmation components or toast notifications for better UX
- Favor functional components and hooks over class components
- Use Tailwind for all styling

### Git Workflow
- **`dev`** - Development branch, all features branch from here
- **`main`** - Production branch, releases only
- **Release Process**:
  1. Work on `dev` branch (or feature branches merged to `dev`)
  2. Create PR from `dev` to `main`
  3. CI runs tests on PR
  4. On merge, GitHub Action creates a release with version from `package.json`
- Bump version in `package.json` before merging to `main`

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
