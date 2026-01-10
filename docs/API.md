# API Reference

PortOS exposes a REST API on port 5554 and WebSocket events via Socket.IO.

## Base URL

```
http://localhost:5554/api
```

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
| POST | `/detect/ports` | Detect process on port |
| POST | `/detect/repo` | Validate repo path |
| POST | `/detect/ai` | AI-powered app detection |

### Templates

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/templates` | List available templates |
| POST | `/templates` | Add custom template |
| POST | `/templates/create` | Create app from template |
| DELETE | `/templates/:id` | Delete custom template |

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

### CoS Scheduled Scripts

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/cos/scripts` | List all scheduled scripts |
| POST | `/cos/scripts` | Create a new script |
| GET | `/cos/scripts/presets` | Get available schedule presets |
| GET | `/cos/scripts/allowed-commands` | Get allowed commands for scripts |
| GET | `/cos/scripts/jobs` | Get scheduled job info |
| GET | `/cos/scripts/:id` | Get a specific script |
| PUT | `/cos/scripts/:id` | Update a script |
| DELETE | `/cos/scripts/:id` | Delete a script |
| POST | `/cos/scripts/:id/run` | Execute a script immediately |
| GET | `/cos/scripts/:id/runs` | Get script run history |

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

## WebSocket Events

Connect to Socket.IO at `http://localhost:5554`.

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

```javascript
// Subscribe to errors
socket.emit('errors:subscribe');

// Receive error events
socket.on('error:occurred', (error) => {
  console.error('Server error:', error.message, error.code);
});

// Unsubscribe
socket.emit('errors:unsubscribe');
```

### Chief of Staff Events

```javascript
// CoS status updates
socket.on('cos:status', (status) => {
  console.log('CoS running:', status.running);
});

// Agent activity
socket.on('cos:agent:started', (agent) => {
  console.log('Agent started:', agent.id, agent.task);
});

socket.on('cos:agent:completed', (agent) => {
  console.log('Agent completed:', agent.id, agent.success);
});

// Task updates
socket.on('cos:task:updated', (task) => {
  console.log('Task updated:', task.id, task.status);
});

// Logs from CoS
socket.on('cos:log', (entry) => {
  console.log(`[CoS] ${entry.level}: ${entry.message}`);
});
```

### Memory Events

```javascript
socket.on('cos:memory:created', (memory) => {
  console.log('Memory created:', memory.id);
});

socket.on('cos:memory:updated', (memory) => {
  console.log('Memory updated:', memory.id);
});
```

### Script Events

```javascript
socket.on('script:created', (script) => {
  console.log('Script created:', script.id, script.name);
});

socket.on('script:started', ({ scriptId, name }) => {
  console.log('Script started:', scriptId);
});

socket.on('script:completed', ({ scriptId, exitCode, duration }) => {
  console.log('Script completed:', scriptId, exitCode);
});

socket.on('script:error', ({ scriptId, error }) => {
  console.error('Script error:', scriptId, error);
});
```

### App Detection (Streaming)

```javascript
// Start streaming detection
socket.emit('detect:stream', { path: '/path/to/repo' });

// Receive discovery steps
socket.on('detect:step', (step) => {
  console.log('Discovered:', step.field, step.value);
});

// Detection complete
socket.on('detect:complete', (appData) => {
  console.log('Detection complete:', appData);
});
```

## Request Examples

### Register an App

```bash
curl -X POST http://localhost:5554/api/apps \
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
curl -X POST http://localhost:5554/api/runs \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "List all files in the current directory",
    "workspacePath": "/path/to/workspace"
  }'
```

### Get PM2 Process Logs

```bash
curl http://localhost:5554/api/logs/portos-server?lines=50
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
