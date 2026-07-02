# API Reference

PortOS exposes a REST API on port 5555 and WebSocket events via Socket.IO.

## Base URL

```
http://localhost:5555/api
```

When a TLS cert is provisioned (`npm run setup:cert`), `:5555` serves HTTPS instead and a loopback-only HTTP mirror runs on `http://127.0.0.1:5553` for local scripts. See [PORTS.md](./PORTS.md).

This document covers the most commonly used endpoints plus a [complete route-domain index](#route-domain-index). A machine-readable OpenAPI 3.1 spec for the public API surface is served at `GET /api/api-docs/openapi.json` and rendered in the UI at `/api-access`.

## Security Model

PortOS is designed for personal/developer use on trusted networks. It implements the following security measures:

- **Network isolation**: By default, access should be restricted to trusted networks (e.g., Tailscale VPN, localhost)
- **Command allowlist**: Shell command execution is restricted to an approved allowlist (see `server/lib/commandAllowlist.js`)
- **Input validation**: All API inputs are validated using Zod schemas
- **No application-level authentication**: PortOS assumes network-level access control

**Important**: Do not expose PortOS APIs directly to untrusted networks. For production deployments, consider:
- Binding to `127.0.0.1` instead of `0.0.0.0`
- Running behind an authenticated reverse proxy
- Using Tailscale or similar VPN for remote access

## REST Endpoints

### Apps

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/apps` | List all registered apps |
| POST | `/apps` | Register a new app |
| GET | `/apps/:id` | Get app details |
| PUT | `/apps/:id` | Update app |
| DELETE | `/apps/:id` | Unregister app |
| POST | `/apps/:id/start` | Start app via PM2 |
| POST | `/apps/:id/stop` | Stop app via PM2 |
| POST | `/apps/:id/restart` | Restart app via PM2 |
| GET | `/apps/:id/status` | Get PM2 status |
| GET | `/apps/:id/logs` | Get recent logs |
| POST | `/apps/:id/refresh-config` | Re-parse ecosystem config |

### Processes & Logs

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/logs/processes` | List all PM2 processes |
| GET | `/logs/:name` | Get logs for process |
| GET | `/ports/scan` | Scan for active ports |

### AI Providers

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/providers` | List all AI providers |
| POST | `/providers` | Add new provider |
| PUT | `/providers/:id` | Update provider |
| DELETE | `/providers/:id` | Delete provider |
| POST | `/providers/:id/test` | Test provider connectivity |
| PUT | `/providers/active` | Set active provider |

### AI Runs (DevTools)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/runs` | List run history |
| POST | `/runs` | Execute new AI run |
| GET | `/runs/:id` | Get run details |
| GET | `/runs/:id/output` | Get run output |
| POST | `/runs/:id/stop` | Stop active run |
| DELETE | `/runs/:id` | Delete run |

### AI Agents

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/agents` | List running AI agent processes |
| GET | `/agents/:pid` | Get agent process details |
| DELETE | `/agents/:pid` | Kill agent process |

### Command Execution

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/commands/execute` | Execute shell command |
| POST | `/commands/:id/stop` | Stop running command |
| GET | `/commands/allowed` | List allowed commands |
| GET | `/commands/processes` | List PM2 processes |

### History

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/history` | List action history |
| GET | `/history/stats` | Get history statistics |
| DELETE | `/history` | Clear history |

### Detection & Import

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/detect/port` | Detect process on port |
| POST | `/detect/repo` | Validate repo path |
| POST | `/detect/pm2` | Detect PM2 processes for a repo |
| POST | `/detect/ai` | AI-powered app detection |

### Scaffold (App Templates)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/scaffold/directories` | List candidate parent directories |
| GET | `/scaffold/templates` | List available templates |
| POST | `/scaffold/templates/create` | Create app from template |
| POST | `/scaffold` | Scaffold a new app |

### Prompts

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/prompts` | List all prompt stages |
| GET | `/prompts/:stage` | Get stage template |
| PUT | `/prompts/:stage` | Update stage/template |
| POST | `/prompts/:stage/preview` | Preview compiled prompt |
| GET | `/prompts/variables` | List all variables |
| PUT | `/prompts/variables/:key` | Update variable |
| POST | `/prompts/variables` | Create variable |
| DELETE | `/prompts/variables/:key` | Delete variable |

### Chief of Staff

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/cos` | Get CoS status |
| POST | `/cos/start` | Start daemon |
| POST | `/cos/stop` | Stop daemon |
| GET | `/cos/config` | Get configuration |
| PUT | `/cos/config` | Update configuration |
| GET | `/cos/tasks` | Get all tasks |
| POST | `/cos/evaluate` | Force task evaluation |
| GET | `/cos/health` | Get health status |
| POST | `/cos/health/check` | Run health check |
| GET | `/cos/agents` | List active agents |
| POST | `/cos/agents/:id/terminate` | Terminate agent |
| GET | `/cos/reports` | List reports |

### CoS Task Learning

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/cos/learning` | Get learning insights and recommendations |
| GET | `/cos/learning/durations` | Get task duration estimates by type |
| POST | `/cos/learning/backfill` | Backfill learning data from history |

### CoS Jobs (Autonomous Jobs)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/cos/jobs` | List all jobs |
| GET | `/cos/jobs/due` | List jobs due to run |
| GET | `/cos/jobs/intervals` | Get available interval options |
| GET | `/cos/jobs/allowed-commands` | Get allowed commands for shell jobs |
| GET | `/cos/jobs/gates` | Get job gate status |
| GET | `/cos/jobs/:id` | Get a specific job |
| POST | `/cos/jobs` | Create a new job |
| PUT | `/cos/jobs/:id` | Update a job |
| DELETE | `/cos/jobs/:id` | Delete a job |
| POST | `/cos/jobs/:id/toggle` | Toggle job on/off |
| POST | `/cos/jobs/:id/trigger` | Run a job immediately |
| POST | `/cos/jobs/:id/gate-check` | Evaluate a job's gates |

(`GET /cos/scripts` still exists but now lists generated scripts only; scheduling lives in `/cos/jobs` and `/cos/schedule`.)

### CoS Weekly Digest

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/cos/digest` | Get current week's digest |
| GET | `/cos/digest/list` | List all available weekly digests |
| GET | `/cos/digest/progress` | Get current week's live progress |
| GET | `/cos/digest/text` | Get text summary for notifications |
| GET | `/cos/digest/:weekId` | Get digest for specific week |
| POST | `/cos/digest/generate` | Force generate digest for a week |
| GET | `/cos/digest/compare` | Compare two weeks |

### Memory System

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/memory` | List memories with filters |
| GET | `/memory/:id` | Get single memory |
| POST | `/memory` | Create memory |
| PUT | `/memory/:id` | Update memory |
| DELETE | `/memory/:id` | Delete (soft) memory |
| POST | `/memory/search` | Semantic search |
| GET | `/memory/categories` | List categories |
| GET | `/memory/tags` | List tags |
| GET | `/memory/timeline` | Timeline view data |
| GET | `/memory/graph` | Graph visualization data |
| GET | `/memory/stats` | Memory statistics |
| POST | `/memory/link` | Link two memories |
| POST | `/memory/consolidate` | Merge similar memories |
| POST | `/memory/decay` | Apply importance decay |
| DELETE | `/memory/expired` | Clear expired memories |
| GET | `/memory/embeddings/status` | LM Studio connection status |

### PM2 Standardization

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/standardize/analyze` | Analyze app for standardization |
| POST | `/standardize/apply` | Apply standardization changes |
| GET | `/standardize/template` | Get PM2 template reference |
| POST | `/standardize/backup` | Create git backup |

### Usage Metrics

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/usage` | Get usage statistics |
| GET | `/usage/daily` | Get daily activity |
| GET | `/usage/hourly` | Get hourly activity |

### CyberCity

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/city/snapshots` | Recorded city-state series, oldest-first (`since`, `limit` query params) |
| POST | `/city/snapshots/capture` | Capture a city snapshot frame on demand |
| GET | `/city/snapshots/config` | Effective snapshot capture config + next run time |
| GET | `/city/introspection` | DB tables (rows/size/pgvector) + `data/` domain sizes for the Data Harbor district. Cached server-side; `db: null` means the database is unreachable (distinct from reachable-but-empty) |

### Brain (Second Brain)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/brain/capture` | Capture and classify thought |
| GET | `/brain/inbox` | List inbox log with filters |
| POST | `/brain/review/resolve` | Resolve needs_review item |
| POST | `/brain/fix` | Correct misclassified item |
| GET | `/brain/people` | List people |
| POST | `/brain/people` | Create person |
| GET | `/brain/people/:id` | Get person |
| PUT | `/brain/people/:id` | Update person |
| DELETE | `/brain/people/:id` | Delete person |
| GET | `/brain/projects` | List projects |
| POST | `/brain/projects` | Create project |
| GET | `/brain/projects/:id` | Get project |
| PUT | `/brain/projects/:id` | Update project |
| DELETE | `/brain/projects/:id` | Delete project |
| GET | `/brain/ideas` | List ideas |
| POST | `/brain/ideas` | Create idea |
| GET | `/brain/ideas/:id` | Get idea |
| PUT | `/brain/ideas/:id` | Update idea |
| DELETE | `/brain/ideas/:id` | Delete idea |
| GET | `/brain/admin` | List admin tasks |
| POST | `/brain/admin` | Create admin task |
| GET | `/brain/admin/:id` | Get admin task |
| PUT | `/brain/admin/:id` | Update admin task |
| DELETE | `/brain/admin/:id` | Delete admin task |
| GET | `/brain/digest/latest` | Get latest daily digest |
| GET | `/brain/review/latest` | Get latest weekly review |
| POST | `/brain/digest/run` | Trigger daily digest |
| POST | `/brain/review/run` | Trigger weekly review |
| GET | `/brain/settings` | Get Brain settings |
| PUT | `/brain/settings` | Update Brain settings |
| GET | `/brain/summary` | Get brain statistics summary |

### Brain Links

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/brain/links` | List saved links |
| GET | `/brain/links/:id` | Get link details |
| POST | `/brain/links` | Save a new link |
| PUT | `/brain/links/:id` | Update link |
| DELETE | `/brain/links/:id` | Delete link |
| POST | `/brain/links/:id/clone` | Clone GitHub repo |
| POST | `/brain/links/:id/pull` | Pull updates for cloned repo |
| POST | `/brain/links/:id/open-folder` | Open cloned repo in file manager |

### File Uploads

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/uploads` | List all uploaded files |
| POST | `/uploads` | Upload file (base64) |
| GET | `/uploads/:filename` | Download/serve file |
| DELETE | `/uploads/:filename` | Delete file |
| DELETE | `/uploads?confirm=true` | Delete all files |

### Task Attachments

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/attachments` | List all attachments |
| POST | `/attachments` | Upload task attachment |
| GET | `/attachments/:filename` | Download attachment |
| DELETE | `/attachments/:filename` | Delete attachment |

### Digital Twin

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/digital-twin/documents` | List all documents |
| GET | `/digital-twin/documents/:id` | Get document content |
| POST | `/digital-twin/documents` | Create document |
| PUT | `/digital-twin/documents/:id` | Update document |
| DELETE | `/digital-twin/documents/:id` | Delete document |
| GET | `/digital-twin/categories` | List document categories |
| GET | `/digital-twin/export` | Export twin in various formats |
| POST | `/digital-twin/tests/run` | Run behavioral tests |
| GET | `/digital-twin/tests/results` | Get test results |
| GET | `/digital-twin/enrichment/categories` | List enrichment categories |
| POST | `/digital-twin/enrichment/generate` | Generate content from answers |
| GET | `/digital-twin/traits` | Get extracted personality traits |
| POST | `/digital-twin/traits/analyze` | Analyze traits from documents |
| GET | `/digital-twin/confidence` | Get confidence scores |
| POST | `/digital-twin/confidence/calculate` | Calculate confidence |
| GET | `/digital-twin/gaps` | Get enrichment recommendations |
| GET | `/digital-twin/completeness` | Get completeness validation |
| POST | `/digital-twin/contradictions` | Detect contradictions |
| POST | `/digital-twin/import/analyze` | Analyze external data import |
| POST | `/digital-twin/import/save` | Save analyzed import as document |

### Agent Personalities

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/agents/personalities` | List all agent personalities |
| GET | `/agents/personalities/:id` | Get personality details |
| POST | `/agents/personalities` | Create personality |
| PUT | `/agents/personalities/:id` | Update personality |
| DELETE | `/agents/personalities/:id` | Delete personality |
| POST | `/agents/personalities/generate` | AI-generate personality |
| POST | `/agents/personalities/:id/toggle` | Toggle personality active state |

### Platform Accounts

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/agents/accounts` | List linked platform accounts |
| GET | `/agents/accounts/:id` | Get account details |
| POST | `/agents/accounts` | Link new account |
| DELETE | `/agents/accounts/:id` | Unlink account |
| POST | `/agents/accounts/:id/test` | Test account connection |
| POST | `/agents/accounts/:id/claim` | Claim account for an agent |

### Automation Schedules

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/agents/schedules` | List all schedules |
| GET | `/agents/schedules/stats` | Get schedule statistics |
| GET | `/agents/schedules/:id` | Get schedule details |
| POST | `/agents/schedules` | Create schedule |
| PUT | `/agents/schedules/:id` | Update schedule |
| DELETE | `/agents/schedules/:id` | Delete schedule |
| POST | `/agents/schedules/:id/toggle` | Toggle schedule on/off |
| POST | `/agents/schedules/:id/run` | Run schedule immediately |

### Agent Activity

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/agents/activity` | List activity logs |
| GET | `/agents/activity/timeline` | Get activity timeline |
| GET | `/agents/activity/agent/:agentId` | Get agent's activity |
| GET | `/agents/activity/agent/:agentId/stats` | Get agent statistics |
| POST | `/agents/activity/cleanup` | Clean up old activity logs |

### Notifications

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/notifications` | List notifications |
| GET | `/notifications/count` | Get unread count |
| GET | `/notifications/counts` | Get counts by type |
| POST | `/notifications/:id/read` | Mark as read |
| POST | `/notifications/read-all` | Mark all as read |
| DELETE | `/notifications/:id` | Delete notification |
| DELETE | `/notifications` | Clear all notifications |

### Media (Audio/Video Capture)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/media/devices` | List available media devices |
| GET | `/media/status` | Get capture status |
| POST | `/media/start` | Start capture |
| POST | `/media/stop` | Stop capture |
| GET | `/media/video` | Get video stream |
| GET | `/media/audio` | Get audio stream |

### Browser Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/browser` | Get browser status |
| GET | `/browser/config` | Get browser configuration |
| PUT | `/browser/config` | Update browser configuration |
| POST | `/browser/launch` | Launch browser instance |
| POST | `/browser/stop` | Stop browser instance |
| POST | `/browser/restart` | Restart browser instance |
| POST | `/browser/navigate` | Navigate browser to URL |
| GET | `/browser/health` | Get browser health status |
| GET | `/browser/process` | Get browser process info |
| GET | `/browser/pages` | Get open browser pages |
| GET | `/browser/version` | Get browser version info |
| GET | `/browser/logs` | Get browser logs |

### Meatspace Genome

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/meatspace/genome` | Get genome summary |
| POST | `/meatspace/genome/upload` | Upload 23andMe genome file |
| POST | `/meatspace/genome/scan` | Scan curated SNP markers |
| POST | `/meatspace/genome/search` | Search SNP by rsid |
| GET | `/meatspace/genome/markers` | Get scanned markers |
| GET | `/meatspace/genome/markers/:rsid` | Get single marker details |
| PUT | `/meatspace/genome/markers/:rsid/notes` | Update marker notes |
| POST | `/meatspace/genome/markers/:rsid/save` | Save marker to genome.json |
| DELETE | `/meatspace/genome/markers/:rsid` | Remove saved marker |
| GET | `/meatspace/genome/categories` | Get marker categories |
| GET | `/meatspace/genome/clinvar/:rsid` | Lookup ClinVar data for rsid |
| GET | `/meatspace/genome/epigenetic` | Get epigenetic interventions |
| POST | `/meatspace/genome/epigenetic` | Add epigenetic intervention |
| PUT | `/meatspace/genome/epigenetic/:id` | Update intervention |
| DELETE | `/meatspace/genome/epigenetic/:id` | Delete intervention |
| POST | `/meatspace/genome/epigenetic/:id/log` | Log intervention entry |

### Moltworld Agent Tools

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/agents/tools/moltworld/join` | Join/move agent in world |
| POST | `/agents/tools/moltworld/explore` | Get nearby entities |
| POST | `/agents/tools/moltworld/build` | Place/remove blocks |
| POST | `/agents/tools/moltworld/think` | Display thinking bubble |
| POST | `/agents/tools/moltworld/say` | Send chat message |
| GET | `/agents/tools/moltworld/status` | Get world status |

## Route Domain Index

Every mounted API prefix (see `server/index.js` for the authoritative list). Domains documented in detail above are omitted. Each prefix corresponds to a router in `server/routes/`.

| Prefix | Domain |
|--------|--------|
| `/api/auth` | Optional password gate |
| `/api/alerts` | System alerts |
| `/api/avatar` | Avatar rendering/config |
| `/api/system` | System health metrics |
| `/api/capabilities` | Feature capability flags |
| `/api/workspace-contexts` | Workspace context management |
| `/api/apps/:appId/reference-repos` | Per-app reference repos |
| `/api/network-exposure` | Network exposure checks |
| `/api/git` | Git operations for managed apps |
| `/api/screenshots` | Screenshot capture |
| `/api/search` | Global search |
| `/api/palette` | ⌘K command palette manifest + actions |
| `/api/dashboard/layouts` | Dashboard widget layouts |
| `/api/media/collections`, `/api/media/annotations` | Media library collections/annotations |
| `/api/client-errors` | Client-side error reporting |
| `/api/backup` | Backup snapshots + restore |
| `/api/legacy-export` | Legacy data export |
| `/api/database` | Postgres introspection |
| `/api/image-clean` | Image metadata cleaning |
| `/api/city` | CyberCity snapshots/introspection |
| `/api/cos/gsd` | CoS GSD workflow |
| `/api/feature-agents` | Feature agent runs |
| `/api/feeds` | RSS/content feeds |
| `/api/catalog` | Creative ingredients catalog |
| `/api/tribe` | Tribe relationship graph |
| `/api/notes` | Notes |
| `/api/calendar` | Calendar integration |
| `/api/messages` | Messages (email) integration |
| `/api/digital-twin/social-accounts`, `/identity`, `/autobiography` | Digital-twin sub-domains |
| `/api/meatspace` | MeatSpace (health, POST, genome) |
| `/api/lmstudio`, `/api/local-llm` | Local LLM backends |
| `/api/code-review` | Code review runs |
| `/api/voice`, `/api/voice/public` | Voice assistant |
| `/api/api-docs` | OpenAPI 3.1 spec |
| `/api/data` | Data manager/sync |
| `/api/datadog`, `/api/jira`, `/api/github`, `/api/telegram` | External integrations |
| `/api/health` | Health check |
| `/api/insights` | Cross-domain insights |
| `/api/instances`, `/api/sync`, `/api/peer-sync`, `/api/sharing` | Federation / peer sync |
| `/api/mortalloom` | MortalLoom |
| `/api/review` | Review queue |
| `/api/settings` | App settings |
| `/api/update` | Self-update flow |
| `/api/loops` | Loops |
| `/api/character` | Character management |
| `/api/tools` | Agent tool registry |
| `/api/image-gen`, `/api/video-gen`, `/api/image-video/models` | Image/video generation |
| `/api/devtools/video-download` | Video download |
| `/api/video-timeline` | Video timeline editor |
| `/api/media-jobs` | Async media job queue |
| `/api/creative-director` | Creative Director projects |
| `/api/music-video` | Music video projects |
| `/api/mood-boards` | Mood boards |
| `/api/writers-room` | Writers Room |
| `/api/universe-builder` | Universe Builder |
| `/api/authors`, `/api/artists`, `/api/albums`, `/api/tracks`, `/api/music` | Music/creator catalogs |
| `/api/pipeline` | Series/comic pipeline |
| `/api/conflict-journal` | Sync conflict journal |
| `/api/importer` | Story importer |
| `/api/story-builder` | Story Builder |
| `/api/loras`, `/api/lora-datasets`, `/api/lora-training` | LoRA management/training |
| `/api/openclaw` | OpenClaw operator chat |
| `/api/rounds` | Rounds (music + Morse training) |
| `/api/ask` | Ask (LLM Q&A) |

## WebSocket Events

Connect to Socket.IO at `http://localhost:5555`.

### Log Streaming

```javascript
// Subscribe to process logs
socket.emit('logs:subscribe', { processName: 'portos-server', lines: 100 });

// Receive log lines
socket.on('logs:line', ({ processName, line }) => {
  console.log(`[${processName}] ${line}`);
});

// Unsubscribe
socket.emit('logs:unsubscribe', { processName: 'portos-server' });
```

### Error Notifications

Server errors are broadcast to all connected sockets — no subscription handshake is needed.

```javascript
// Receive error events
socket.on('error:occurred', (error) => {
  console.error('Server error:', error.message, error.code);
});
```

### Chief of Staff Events

```javascript
// Join the CoS room to receive agent lifecycle events
socket.emit('cos:subscribe');

socket.on('cos:agent:spawned', (agent) => {
  console.log('Agent spawned:', agent.id, agent.task);
});

socket.on('cos:agent:updated', (agent) => {
  console.log('Agent updated:', agent.id, agent.status);
});

socket.on('cos:agent:completed', (agent) => {
  console.log('Agent completed:', agent.id, agent.success);
});

socket.on('cos:agent:output', ({ agentId, lines }) => {
  console.log('Agent output:', agentId, lines);
});
```

### Memory Events

```javascript
socket.on('memory:created', (memory) => {
  console.log('Memory created:', memory.id);
});

socket.on('memory:updated', (memory) => {
  console.log('Memory updated:', memory.id);
});

socket.on('memory:deleted', ({ id }) => {
  console.log('Memory deleted:', id);
});
```

### App Detection (Streaming)

```javascript
// Start streaming detection
socket.emit('detect:start', { path: '/path/to/repo' });

// Receive discovery steps
socket.on('detect:step', (step) => {
  console.log('Discovered:', step.field, step.value);
});

// Detection complete
socket.on('detect:complete', (appData) => {
  console.log('Detection complete:', appData);
});
```

### Shell Terminal

> **Security**: The shell WebSocket API provides full terminal access as the PortOS process user. It relies on PortOS's network-level access control (see [Security Model](#security-model)) — do not expose the PortOS server to untrusted networks.

```javascript
// Start a shell session
socket.emit('shell:start', { id: 'my-session' });

// Send input to shell
socket.emit('shell:input', { id: 'my-session', data: 'ls -la\n' });

// Receive shell output
socket.on('shell:output', ({ id, data }) => {
  console.log(data); // Terminal output
});

// Resize terminal
socket.emit('shell:resize', { id: 'my-session', cols: 120, rows: 40 });

// Stop shell session
socket.emit('shell:stop', { id: 'my-session' });
```

### Provider Status

```javascript
// Provider availability changed
socket.on('provider:status:changed', ({ providerId, status, reason }) => {
  console.log(`Provider ${providerId}: ${status}`, reason);
});
```

## Request Examples

### Register an App

```bash
curl -X POST http://localhost:5555/api/apps \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My App",
    "repoPath": "/path/to/repo",
    "uiPort": 3000,
    "apiPort": 3001,
    "pm2ProcessNames": ["myapp-server", "myapp-client"]
  }'
```

### Execute AI Run

```bash
curl -X POST http://localhost:5555/api/runs \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "List all files in the current directory",
    "workspacePath": "/path/to/workspace"
  }'
```

### Get PM2 Process Logs

```bash
curl http://localhost:5555/api/logs/portos-server?lines=50
```

## Error Responses

All errors return JSON with consistent structure:

```json
{
  "error": "Error message",
  "code": "ERROR_CODE",
  "timestamp": 1704067200000,
  "context": {}
}
```

Common error codes:
- `NOT_FOUND` - Resource not found
- `VALIDATION_ERROR` - Invalid request data
- `COMMAND_NOT_ALLOWED` - Shell command not in allowlist
- `INTERNAL_ERROR` - Server error
