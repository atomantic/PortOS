# CoS Agent Runner

Isolated PM2 process for spawning Claude CLI agents, preventing orphaned processes when portos-server restarts.

## Problem

When multiple CoS agents are running and the main portos-server restarts (due to code changes, crashes, or manual restart), child processes spawned via `child_process.spawn()` become orphaned. The parent loses track of them because the `activeAgents` Map is in memory.

## Solution

A separate `portos-cos` PM2 process that:
1. Runs independently from `portos-server`
2. Manages agent spawning via HTTP/Socket.IO bridge
3. Doesn't restart when `portos-server` restarts
4. Maintains its own state file for PID tracking

## Architecture

```
┌─────────────────┐     HTTP/Socket.IO    ┌─────────────────┐
│  portos-server  │ ──────────────────►   │   portos-cos    │
│    (5555)       │     spawn/terminate   │     (5558)      │
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

## Mode selection (runner vs direct)

`portos-server` spawns agents through the runner when it is there, and directly (as its own children) when it is not. The choice is not frozen at boot:

- A health probe at spawner init seeds the mode, for the window before the socket connects.
- The Socket.IO connection is opened either way and reconnects indefinitely with capped backoff. The first `connect` **promotes** a direct-mode process to runner mode, logs `🔼 CoS Runner came up …`, and reconciles agents the runner was already driving — so starting `portos-cos` after `portos-server` takes effect immediately, with no server restart.
- A disconnect does **not** demote. In runner mode the runner owns every agent process, so while it is down new tasks are **held** as `pending` (logged once, not per task) and resume on reconnect. Demoting would spawn them as children of `portos-server` — the orphaning this app exists to prevent.
- Agents already spawned directly keep completing through the direct path across a promotion; reconciliation only adopts agents this server does not already own.

## Features

- **Process Isolation**: Agent processes survive server restarts
- **State Persistence**: PIDs tracked in state file for recovery
- **Bridge Communication**: HTTP/Socket.IO for cross-process messaging
- **Orphan Detection**: Automatic cleanup of orphaned agent processes

## Related Features

- [Chief of Staff](./chief-of-staff.md) - Main orchestration system
- [Error Handling](./error-handling.md) - Agent error recovery
- [Claude Ollama](./claude-ollama.md) - Run agent tasks on a local Ollama/LM Studio model
