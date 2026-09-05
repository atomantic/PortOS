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
| alwaysOn | false | Start on server boot (`autoStart` is a legacy compatibility alias). Off by default so a never-configured install does not begin autonomous LLM-backed work on its own |
| improvementEnabled | true | Allow improvement work for PortOS and managed apps |
| proactiveMode | true | Always find work when idle |
| idleReviewEnabled | true | Review managed apps while user work is idle |
| autonomousJobsEnabled | true | Enable the global scheduled-agent-job runner |
| domainAutonomy | execute per domain | Off, dry-run, or execute policy for each automatic-work domain |
| domainBudgets | unlimited | Optional daily action and runtime caps per domain |
| persistentMindProfile.enabled | false | Configure a persistent-mind profile without starting it |
| persistentMindThinkingPresets.presets | [] | Saved named alternates (exact provider/model/effort) one message may borrow for a single turn. Empty by default; storing one changes nothing about the route the mind wakes on |
| avatarStyle | svg | Default CoS UI avatar style (`svg`, `ascii`, `core`, the 3D styles, or a `rigged-<modelId>` record) |

### Temporary thinking sessions in the Mind UI

Saved alternates are managed in **Mind → Models** (`/cos/mind?panel=models`). Adding, editing, previewing, or removing a preset writes only `persistentMindThinkingPresets` through `PATCH /api/cos/config` — it never starts a turn, never resumes a paused mind, never infers, and never downloads a model. A list PATCH replaces the whole array, because a merge cannot express "remove this one entry" and would resurrect a deleted preset.

The composer's **Send with another model** picker arms one preset for the **next single message**, and nothing else:

- The armed preset lives in the URL (`?preset=<id>`), so it is shareable and reload-safe. Previewing shows the exact provider/model/effort plus whether the route is machine-local, account-backed, or unclassifiable — an unclassifiable route is treated as billable.
- **Pressing send is the authorization.** It covers that one message, including its bounded tool rounds and its summary. The selection clears on acceptance, so the next message and every scheduled wake use the unchanged home profile.
- The route is frozen with the draft: a duplicate click or a transport retry re-submits the same id **and** the same route, because the server's retry fingerprint covers both. Changing the armed preset mints a new id instead.
- A preset that disappears is refused, never substituted — the composer blocks the send rather than answering on the default profile the user was stepping away from.
- Attached images are validated against the borrowed route, not the default one, so a text-only alternate refuses the message instead of dropping the image.
- A paused mind stays paused: the message queues on the selected route and runs only when the user resumes it.

**Mind → Thinking route** (the sidebar card) shows the default profile beside the route the current turn is *actually* taking, warns when a preset was edited after its message was accepted, and offers **Return to default**. **Cancel this session** goes through the existing pause lifecycle, which retires a temporary session rather than requeueing it — a cancelled temporary turn never replays itself.

**Mind → Models** also lists the per-session receipts (`?turn=<turnId>`): preset, actual route, elapsed time, run and turn ids, outcome, and usage/cost. Telemetry a provider never reported renders as *unknown*, never as zero — "free" and "not measured" are different claims.

Temporary thinking messages retain the exact accepted provider, model, and effort. Changing or revoking a preset refuses the pending session; a label-only rename preserves its route. Revoked selections and interruptions after inference may have begun require a fresh message to run again. Temporary provider outages before inference leave the accepted message queued. Matching transport retries keep the original selection even after revocation. Older queued temporary messages without a recorded route retain their content but require explicit resubmission.

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
