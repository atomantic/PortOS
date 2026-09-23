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

`selectModelForTask` runs a task on exactly what it was configured with:

1. **An explicit model or tier** — the task's `metadata.model` (or an orchestration role's `model`). A tier (`light`/`medium`/`heavy`/`ultra`) resolves on the provider that actually runs the task, including a fallback provider.
2. **Otherwise the provider's Default Model.**

Nothing picks a tier automatically — not the description, priority, context size, or learning history (#8149). The Learning tab reports each task type's per-tier success rate and any tier its history suggests; pin that tier on the task or schedule to act on it. See [MODEL_TIERS.md](../MODEL_TIERS.md).

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

### The decision journal

Rollups are sealed prose and memories are flat facts that decay on one clock, so neither can say *that decision is retired now*: a reversed decision sat beside its replacement, and the more-accessed stale one could outrank the correction. The journal is the third shape — typed, individually addressable, and status-bearing.

- **Kinds.** `decision`, `commitment`, `open_question`, `risk`, `goal`, `preference`. Each entry is a concise standalone statement in the mind's own words, never a transcript quote.
- **Three operations.** `append`, `supersede` (this statement replaces entry E) and `resolve` (E is settled). Supersession is the operation the memory store cannot express: the old entry stays readable with `status: superseded` and a pointer to what replaced it, and stops being quoted as current. Nothing is ever deleted.
- **Source-grounded and bounded.** Every operation cites the message sequences it came from; one citing nothing — or citing a range the extraction was never shown — is discarded while its well-grounded siblings still apply. At most five operations per extraction, and **zero is the normal outcome**: greetings, acknowledgements, tool chatter and raw reasoning produce none.
- **Where it runs.** At the same boundary that seals a rollup, on the same pinned provider and the same per-call boundary as the summary it feeds — no new provider path and no cold-bootstrap call. A malformed answer gets one narrow repair attempt and then gives up **without writing**; a failed extraction never blocks the seal.
- **What the rollup becomes.** The sealed summary compacts from the journal rather than from raw turns, so active decisions, outstanding commitments, unresolved questions and risks survive as facts, the settled history that explains the current state is kept, and superseded wording is absent by construction.
- **Untrusted evidence.** Prior entries replayed into the extraction prompt are data, not instructions: every stored statement is quoted so an injected heading or directive cannot forge a prompt section, and the prompt says so in words.
- **Correcting it.** **Mind → Journal** groups active entries by kind, collapses retired ones behind a toggle showing what replaced each, and lets the user settle or retire an entry the mind got wrong. The `history` cleanup scope clears the journal along with the messages it cites; a context-only clear does not.

Storage, retention and the privacy posture are in [STORAGE.md](../STORAGE.md).

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
| GET /api/cos/mind/journal | Persistent Mind decision journal, filterable by `kind` and `status` |
| POST /api/cos/mind/journal/:id/correct | Settle (`resolve`) or retire (`retire`) one journal entry the mind got wrong — a status transition, never a delete |

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
