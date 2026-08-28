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
9. **Durable Agent Feedback**: Completion notifications accept quick ratings, while the Agents tab keeps a filterable queue of loaded runs that still need feedback after a notification expires. Recent unrated completed runs are also surfaced as a CoS insight that links directly to the URL-backed review filter. Feedback details can be attached to helpful, unhelpful, or neutral ratings so learning has actionable context. The Learning tab aggregates ratings from both live state and date-bucketed agent archives, de-duplicating runs that are still present in both stores so historical feedback remains visible for the archive retention window.
10. **Learning-Aligned ETAs**: Pending tasks and active agents resolve their estimates from the same metadata-first task-learning bucket that records outcomes, including archived scheduled-agent metadata, instead of inferring a potentially different category from task text.

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
| healthCheckIntervalMs | 900000 | Health check interval (15 minutes) |
| maxConcurrentAgents | 3 | Max parallel agents (global) |
| maxConcurrentAgentsPerProject | 2 | Max parallel agents per project |
| maxProcessMemoryMb | 2048 | Memory alert threshold |
| maxTotalProcesses | 50 | Process-count alert threshold |
| alwaysOn | true | Start on server boot (`autoStart` is a legacy compatibility alias) |
| improvementEnabled | true | Allow improvement work for PortOS and managed apps |
| proactiveMode | true | Always find work when idle |
| idleReviewEnabled | true | Review managed apps while user work is idle |
| autonomousJobsEnabled | true | Enable the global scheduled-agent-job runner |
| domainAutonomy | execute per domain | Off, dry-run, or execute policy for each automatic-work domain |
| domainBudgets | unlimited | Optional daily action and runtime caps per domain |
| persistentMindProfile.enabled | false | Configure a persistent-mind profile without starting it |
| avatarStyle | svg | Default CoS UI avatar style |

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
| GET /api/cos/feedback/stats | Aggregate live and archived agent ratings |
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
- Task Learning — see `server/services/taskLearning/` and the `/api/cos/learning` endpoints
- [Self-Improvement](./cos-enhancement.md)
- [Error Handling](./error-handling.md)
- Scheduled Scripts — see the Schedule system (`server/services/taskSchedule.js`, `/api/cos/jobs`)
