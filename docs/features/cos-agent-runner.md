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

## Unattended recovery gates

Nobody is watching a CoS TUI session, so nothing types into it when the model stops early. Six gates in `server/services/agentTuiSpawning.js` watch the PTY stream and act on one shared 5s poll. Five of them prefer a nudge into the live session over a kill, because the TUI still holds the whole conversation; only the retry stall ends the run, since a request the provider never answers will not answer the next one either. No gate reaps a run on the clock alone — the wall-clock ceiling was removed deliberately, after it killed agents 30 seconds past a merged PR.

| Gate | What it sees | What it does |
| --- | --- | --- |
| Self-clearing provider signal | agy's "verifying your account eligibility" banner, which REJECTS the submission | Re-pastes the whole prompt while a grace window is open, then fails over |
| Local-runtime OOM | a Metal/CUDA out-of-memory box that killed the turn | Pastes `continue` once the session is quiet; fails over to a fallback provider after 3 |
| Truncated response | a harness banner that the response was cut off mid-generation (pi's TUI halts the whole session on it) | Pastes `continue` once the session is quiet; fails over to a fallback provider after 3 |
| Retry stall | the TUI retrying one request past attempt 3, ten minutes on | Fails the run over to a fallback provider |
| Tool-permission dialog | Claude Code asking to approve a call nobody can approve | Declines it, then explains why and sends the session back to work |
| **Stall** | **nothing at all — the session went quiet with the task unfinished** | **Pastes a `continue` nudge after 3 minutes of silence, up to 3 times; then badges the agent card `Stalled`** |

The stall gate is the one with no signal to match on: the model narrates its next step ("Next: /do:pr"), ends its turn, and the TUI returns to its idle composer. Since the wall-clock ceiling was removed, nothing else would ever touch that session. It reads pure silence rather than provider chrome, because in-flight chrome is per-TUI vocabulary while bytes on the PTY are universal. Claude Code repaints its working counter about once a second for as long as any tool or API call is in flight; OpenCode barely repaints its chrome at all, but streams megabytes of transcript through the same stream. Three unbroken minutes of NOTHING is a composer at rest under both.

It stays out of the way of the other four: it is polled last, it waits for the prompt to actually be in, and it skips a run that already wrote its completion sentinel or is mid-`finish()`. Its post-nudge wait is measured from the nudge rather than from output, because a session wedged below its composer never echoes the paste. A session that prints for 30s past a nudge took the hint and gets its full budget back, so a long run that stalls again hours later is not treated as a second strike.

A session that ignores all three nudges is wedged below its composer, and no paste will reach it. Rather than give up silently — leaving a run holding its execution lane with nothing to show for it — the spawner logs the verdict and sets `metadata.phase = 'stalled'`, which the agent card renders as a non-pulsing **Stalled** badge pointing at the Shell tab. The badge clears itself on the session's next byte of output. Prevention lives on the other side of the same problem: `UNATTENDED_RUN_RULE` (`server/services/agentPromptBuilder.js`) tells every agent that naming its next step is not doing it. Constants: `STALL_NUDGE_*` in `server/lib/tuiHandshake.js`.

## Features

- **Process Isolation**: Agent processes survive server restarts
- **State Persistence**: PIDs tracked in state file for recovery
- **Bridge Communication**: HTTP/Socket.IO for cross-process messaging
- **Orphan Detection**: Automatic cleanup of orphaned agent processes

## Related Features

- [Chief of Staff](./chief-of-staff.md) - Main orchestration system
- [Error Handling](./error-handling.md) - Agent error recovery
- [Claude Ollama](./claude-ollama.md) - Run agent tasks on a local Ollama/LM Studio model
