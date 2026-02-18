# Chief of Staff

Autonomous agent manager that watches task files, spawns sub-agents, and maintains system health.

## Architecture

- **Task Parser** (`server/lib/taskParser.js`): Parses TASKS.md and COS-TASKS.md formats
- **CoS Service** (`server/services/cos.js`): State management, health monitoring, task evaluation
- **Task Watcher** (`server/services/taskWatcher.js`): File watching with chokidar
- **Sub-Agent Spawner** (`server/services/subAgentSpawner.js`): Claude CLI execution with MCP
- **CoS Routes** (`server/routes/cos.js`): REST API endpoints
- **CoS UI** (`client/src/pages/ChiefOfStaff.jsx`): Tasks, Agents, Health, Config tabs

## Features

1. **Dual Task Lists**: User tasks (TASKS.md) and system tasks (COS-TASKS.md)
2. **Autonomous Execution**: Auto-approved tasks run without user intervention
3. **Approval Workflow**: Tasks marked APPROVAL require user confirmation
4. **System Health Monitoring**: PM2 process checks, memory usage, error detection
5. **Sub-Agent Spawning**: Claude CLI with --dangerously-skip-permissions and MCP servers
6. **Self-Improvement**: Can analyze performance and suggest prompt/config improvements
7. **Script Generation**: Creates automation scripts for repetitive tasks
8. **Report Generation**: Daily summaries of completed work

## Task File Format

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

## System Task Format

```markdown
- [ ] #sys-001 | HIGH | AUTO | Auto-approved task
- [ ] #sys-002 | MEDIUM | APPROVAL | Needs user approval
```

## Data Storage

```
./data/cos/
├── state.json           # Daemon state and config
├── agents/{agentId}/    # Agent prompts and outputs
├── reports/{date}.json  # Daily reports
└── scripts/             # Generated automation scripts
```

## Model Selection Rules

The `selectModelForTask` function routes tasks to appropriate model tiers:

| Tier | Trigger | Example Tasks |
|------|---------|---------------|
| **heavy** | Critical priority, visual analysis, complex reasoning | Architect, refactor, security audit, long context |
| **medium** | Standard development tasks, default | Most coding tasks, bug fixes, feature implementation |
| **light** | Documentation-only tasks | Update README, write docs, format text |

**Important**: Light model (haiku) is NEVER used for coding tasks. Tasks containing keywords like `fix`, `bug`, `implement`, `test`, `feature`, `api`, `component`, etc. are automatically routed to medium tier or higher.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| evaluationIntervalMs | 60000 | Task evaluation interval (1 minute) |
| healthCheckIntervalMs | 900000 | Health check interval (15 minutes) |
| maxConcurrentAgents | 3 | Max parallel agents (global) |
| maxConcurrentAgentsPerProject | 2 | Max parallel agents per project |
| maxProcessMemoryMb | 2048 | Memory alert threshold |
| autoStart | false | Start on server boot |
| selfImprovementEnabled | true | Allow self-analysis |
| proactiveMode | true | Always find work when idle |
| comprehensiveAppImprovement | true | Apply full analysis to managed apps |
| avatarStyle | svg | CoS UI avatar style: `svg`, `cyber`, `sigil`, or `ascii` |

## API Endpoints

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
| GET /api/cos/learning | Get learning insights |
| GET /api/cos/digest | Get weekly digest |

## Prompt Templates

| Template | Purpose |
|----------|---------|
| cos-agent-briefing | Brief sub-agent on task |
| cos-evaluate | Evaluate tasks and decide actions |
| cos-report-summary | Generate daily summary |
| cos-self-improvement | Analyze and suggest improvements |

## Related Features

- [Memory System](./memory-system.md)
- [Task Learning](./task-learning.md)
- [Self-Improvement](./self-improvement.md)
- [Error Handling](./error-handling.md)
- [Scheduled Scripts](./scheduled-scripts.md)
