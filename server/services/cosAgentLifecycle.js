/**
 * CoS Agent Lifecycle Module
 *
 * Agent register/update/complete/output/terminate/pause/kill/BTW/zombie-cleanup
 * and single-agent reads. Extracted from the former monolithic cosAgents.js
 * (issue #2530); the date-bucket index + archive layout lives in cosAgentIndex.js
 * and is shared via loadAgentIndex/saveAgentIndex/getAgentDir.
 *
 * The public barrel `cosAgents.js` re-exports everything here.
 */

import { readFile, writeFile, rename, readdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { cosEvents } from './cosEvents.js';
import { ServerError } from '../lib/errorHandler.js';
import { loadState, saveState, withStateLock, AGENTS_DIR } from './cosState.js';
import { atomicWrite, ensureDir, safeJSONParse, tryReadFile } from '../lib/fileUtils.js';
import { recordDomainUsage } from './domainUsage.js';
import { repairCodexTaskSummary } from './codexSummaryRepair.js';
import { loadAgentIndex, saveAgentIndex, getAgentDir } from './cosAgentIndex.js';

export async function registerAgent(agentId, taskId, metadata = {}) {
  return withStateLock(async () => {
    const state = await loadState();

    state.agents[agentId] = {
      id: agentId,
      taskId,
      status: 'running',
      startedAt: new Date().toISOString(),
      metadata,
      output: []
    };

    state.stats.agentsSpawned++;
    await saveState(state);

    cosEvents.emit('agent:spawned', state.agents[agentId]);
    return state.agents[agentId];
  });
}

export async function updateAgent(agentId, updates) {
  return withStateLock(async () => {
    const state = await loadState();

    if (!state.agents[agentId]) {
      return null;
    }

    // Merge metadata if present in updates
    if (updates.metadata) {
      state.agents[agentId] = {
        ...state.agents[agentId],
        ...updates,
        metadata: { ...state.agents[agentId].metadata, ...updates.metadata }
      };
    } else {
      state.agents[agentId] = { ...state.agents[agentId], ...updates };
    }
    await saveState(state);

    cosEvents.emit('agent:updated', state.agents[agentId]);
    return state.agents[agentId];
  });
}

export async function completeAgent(agentId, result = {}) {
  const completed = await withStateLock(async () => {
    const state = await loadState();

    if (!state.agents[agentId]) {
      return null;
    }

    state.agents[agentId] = {
      ...state.agents[agentId],
      status: 'completed',
      completedAt: new Date().toISOString(),
      // Success-criteria validation verdict (issue #2344): normalize to an
      // explicit null sentinel when a completion path didn't declare/evaluate a
      // machine-checkable criterion, so persisted telemetry never conflates
      // "not declared" with "declared and failed" (false). Distinct from
      // result.success (the runner's exit-code verdict).
      result: { validationPassed: null, ...result },
    };

    if (result.success) {
      state.stats.tasksCompleted++;
    } else {
      state.stats.errors = (state.stats.errors || 0) + 1;
    }

    await saveState(state);
    // `agent:completed` is intentionally emitted later, after the domain-usage
    // ledger is updated (see the recordDomainUsage block below, #1683). Do NOT
    // move it back here. `agent:updated` carries no scheduling side effect, so it
    // stays inside the lock.
    cosEvents.emit('agent:updated', state.agents[agentId]);

    // Determine date bucket from completedAt
    const dateStr = state.agents[agentId].completedAt.slice(0, 10);
    const bucketDir = join(AGENTS_DIR, dateStr);
    await ensureDir(bucketDir);

    // Write metadata to flat dir first (may already have output.txt/prompt.txt there)
    const flatDir = join(AGENTS_DIR, agentId);
    if (!existsSync(flatDir)) {
      await ensureDir(flatDir);
    }
    const { output: _output, ...agentWithoutOutput } = state.agents[agentId];
    await atomicWrite(join(flatDir, 'metadata.json'), agentWithoutOutput);

    // Move entire agent dir into date bucket (atomic on same filesystem)
    const targetDir = join(bucketDir, agentId);
    if (!existsSync(targetDir)) {
      await rename(flatDir, targetDir).catch(async () => {
        // Fallback for cross-filesystem: copy files then remove
        await ensureDir(targetDir);
        const files = await readdir(flatDir);
        for (const file of files) {
          const content = await readFile(join(flatDir, file));
          await writeFile(join(targetDir, file), content);
        }
        await rm(flatDir, { recursive: true });
      });
    }

    // Update index
    const idx = await loadAgentIndex();
    idx.set(agentId, dateStr);
    await saveAgentIndex();

    return state.agents[agentId];
  });

  // Daily CoS budget accounting (#711): count only AUTONOMOUS runs (non-user
  // tasks) — the same set the CoS auto-run gate withholds when over budget —
  // toward the domain's actions/minutes ledger. Recorded outside the state lock
  // (separate ledger file + write tail) so it never serializes against state.json.
  //
  // This MUST land before the `agent:completed` emit below: that event's handler
  // schedules `dequeueNextTask()`, whose daily action-budget gate reads this
  // ledger. Recording first ensures the gate counts the just-finished action, so
  // a perpetual drain can't admit one spawn past `maxActionsPerDay` at the
  // boundary (#1683).
  if (completed?.metadata?.taskType && completed.metadata.taskType !== 'user') {
    await recordDomainUsage('cos', { actions: 1, ms: Number(result.duration) || 0 })
      .catch(err => console.error(`❌ Failed to record CoS budget usage for ${agentId}: ${err.message}`));
  }

  // Emit now that the ledger reflects this action (#1683). Fires for every
  // completed agent, matching prior behavior — only the timing moved.
  if (completed) {
    cosEvents.emit('agent:completed', completed);
  }

  return completed;
}

export async function appendAgentOutput(agentId, line) {
  const result = await withStateLock(async () => {
    const state = await loadState();

    if (!state.agents[agentId]) {
      return null;
    }

    state.agents[agentId].output.push({
      timestamp: new Date().toISOString(),
      line
    });

    // Trim to last 1000 lines in state
    if (state.agents[agentId].output.length > 1000) {
      state.agents[agentId].output = state.agents[agentId].output.slice(-1000);
    }

    await saveState(state);
    return state.agents[agentId];
  });

  if (result) {
    cosEvents.emit('agent:output', { agentId, line });
  }

  return result;
}

// Batched variant — single state load+save for many lines. Used by the TUI
// spawner to avoid write-amplification on chatty TUIs that emit hundreds of
// lines per second; per-line appendAgentOutput would re-load and re-save the
// entire state JSON for every line.
export async function appendAgentOutputLines(agentId, lines) {
  if (!Array.isArray(lines) || lines.length === 0) return null;
  const result = await withStateLock(async () => {
    const state = await loadState();
    if (!state.agents[agentId]) return null;
    const timestamp = new Date().toISOString();
    for (const line of lines) {
      state.agents[agentId].output.push({ timestamp, line });
    }
    if (state.agents[agentId].output.length > 1000) {
      state.agents[agentId].output = state.agents[agentId].output.slice(-1000);
    }
    await saveState(state);
    return state.agents[agentId];
  });

  if (result) {
    for (const line of lines) {
      cosEvents.emit('agent:output', { agentId, line });
    }
  }

  return result;
}

// Debounce window for batching streamed agent output to state. A chatty
// producer (CoS Runner stream events, non-stream CLI stdout) can emit dozens
// of lines/sec; without batching, each line round-trips a full state
// load+save (see appendAgentOutput). 250ms is invisible to the live tail but
// cuts state I/O by 1-2 orders of magnitude. Matches OUTPUT_FLUSH_INTERVAL_MS
// in agentTuiSpawning.js.
const OUTPUT_FLUSH_INTERVAL_MS = 250;

// Debounced per-agent output batcher. Wraps appendAgentOutputLines with a
// ~250ms flush window so a hot streaming producer triggers one state load+save
// per window instead of per line — the write-amplification guard documented in
// CLAUDE.md ("High-frequency state writes must batch"). The TUI spawner rolls
// its own equivalent inline because it co-flushes an output.txt appendFile in
// the same batch; producers that only need the state write should use this.
//
// Callers MUST `await flush()` in their finish/cleanup path before the
// completion event so the final lines land before the agent is marked done.
export function createAgentOutputBatcher(agentId, { intervalMs = OUTPUT_FLUSH_INTERVAL_MS } = {}) {
  let pending = [];
  let timer = null;
  let flushing = null;

  const drain = async () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    // Swallow+log state-write failures so neither the debounced timer nor a
    // caller's `await flush()` ever rejects — this runs in child-process /
    // timer callbacks where an uncaught throw would crash Node (CLAUDE.md "No
    // try/catch" exception). The authoritative transcript lives in output.txt;
    // a dropped live-tail batch is non-fatal. Mirrors the TUI spawner's
    // `.catch(() => {})` on its own batched append.
    await appendAgentOutputLines(agentId, batch).catch((err) => {
      console.error(`❌ agent ${agentId} output batch flush failed: ${err.message}`);
    });
  };

  const schedule = () => {
    if (timer || flushing) return;
    timer = setTimeout(() => {
      timer = null;
      flushing = drain().finally(() => {
        flushing = null;
        // Catch lines that arrived during the in-flight drain — without this a
        // producer that goes quiet right after the timer fires strands its last
        // batch in `pending` until flush().
        if (pending.length > 0) schedule();
      });
    }, intervalMs);
  };

  return {
    push(lineOrLines) {
      if (Array.isArray(lineOrLines)) {
        if (lineOrLines.length === 0) return;
        pending.push(...lineOrLines);
      } else {
        pending.push(lineOrLines);
      }
      schedule();
    },
    // Wait for any in-flight drain, then fully empty `pending`. A push can race
    // in during an awaited drain, so loop until nothing is left rather than
    // draining a fixed number of times (which could strand a late line to the
    // debounce timer). flush() is only called once the producer has stopped, so
    // the loop terminates promptly.
    async flush() {
      if (flushing) await flushing;
      while (pending.length > 0) await drain();
    },
  };
}

// Get all agents from in-memory state (includes running and recently completed; archived agents loaded via getAgentsByDate)
export async function getAgents() {
  const state = await loadState();
  return Object.values(state.agents);
}

// Get agent by ID with full output from file
export async function getAgent(agentId) {
  const state = await loadState();
  let agent = state.agents[agentId];

  // Fall back to disk metadata via index if not in state
  if (!agent) {
    const idx = await loadAgentIndex();
    const dateStr = idx.get(agentId);
    if (dateStr) {
      const metaPath = join(AGENTS_DIR, dateStr, agentId, 'metadata.json');
      const content = await tryReadFile(metaPath);
      if (content) {
        const raw = safeJSONParse(content, null);
        if (raw) {
          const { output, ...rest } = raw;
          agent = { ...rest, id: raw.id || raw.agentId || agentId, status: raw.status || 'completed' };
        }
      }
    }
  }
  if (!agent) return null;

  // Completed agents live in date buckets; paused agents remain in the flat
  // agent dir but should still expose their preserved full transcript.
  if (agent.status === 'completed' || agent.status === 'paused') {
    const dateStr = agent.status === 'completed' ? agent.completedAt?.slice(0, 10) : null;
    const agentDir = dateStr ? getAgentDir(agentId, dateStr) : getAgentDir(agentId);
    const repaired = await repairCodexTaskSummary(agentDir, agent);
    if (repaired) agent = { ...agent, metadata: { ...agent.metadata, taskSummary: repaired } };
    const outputFile = join(agentDir, 'output.txt');
    if (existsSync(outputFile)) {
      const fullOutput = await readFile(outputFile, 'utf-8');
      const lines = fullOutput.split('\n').filter(line => line.trim());
      const timestamp = agent.completedAt || agent.pausedAt;
      return {
        ...agent,
        output: lines.map(line => ({ line, timestamp }))
      };
    }
  }

  return agent;
}

// Read the prompt that was sent to an agent at spawn time.
// Used by the AgentCard UI to let the user inspect what was pasted into the
// TUI / sent to the CLI so the prompt can be iterated on.
export async function getAgentPrompt(agentId) {
  const state = await loadState();
  const agent = state.agents[agentId];
  if (!agent) throw new ServerError('Agent not found', { status: 404, code: 'NOT_FOUND' });
  const agentDir = getAgentDir(agentId, agent.archiveDate);
  const promptPath = join(agentDir, 'prompt.txt');
  if (!existsSync(promptPath)) throw new ServerError('Prompt file not found', { status: 404, code: 'NOT_FOUND' });
  const prompt = await readFile(promptPath, 'utf8');
  return { prompt, bytes: prompt.length };
}

// Terminate an agent (will be handled by spawner)
export async function terminateAgent(agentId) {
  // Emit event to kill the process FIRST
  cosEvents.emit('agent:terminate', agentId);
  // The spawner will handle marking the agent as completed after termination
  return { success: true, agentId };
}

// Pause an agent without completing its task or cleaning up its worktree.
export async function pauseAgent(agentId, reason = null) {
  const { pauseAgent: pauseAgentFromSpawner } = await import('./subAgentSpawner.js');
  return pauseAgentFromSpawner(agentId, reason);
}

// Force kill an agent with SIGKILL (immediate, no graceful shutdown)
export async function killAgent(agentId) {
  const { killAgent: killAgentFromSpawner } = await import('./subAgentSpawner.js');
  return killAgentFromSpawner(agentId);
}

// Send a BTW (additional context) message to a running agent.
//
// BTW is only supported for Claude Code TUI agents — the message gets
// bracket-pasted directly into the live PTY session as if the user typed it
// themselves. The legacy BTW.md path is gone: it required headless agents to
// poll a file mid-run, which most CLIs (codex / antigravity / LM Studio) don't do
// reliably anyway, and the indirection had to be reflected in the prompt with
// a brittle "check this file" instruction. Other TUI kinds (codex, antigravity)
// don't honor bracketed-paste in the same way, so they're not eligible
// either.
export async function sendBtwToAgent(agentId, message) {
  const agentInfo = await withStateLock(async () => {
    const state = await loadState();
    const agent = state.agents[agentId];
    if (!agent) throw new ServerError('Agent not found', { status: 404, code: 'NOT_FOUND' });
    if (agent.status !== 'running') throw new ServerError('Agent is not running', { status: 400, code: 'INVALID_STATE' });
    if (agent.metadata?.executionMode !== 'tui') {
      throw new ServerError('BTW is only supported for Claude Code TUI agents.', { status: 400, code: 'INVALID_STATE' });
    }
    if (agent.metadata?.tuiKind !== 'claude') {
      throw new ServerError(`BTW is only supported for Claude Code TUI agents (this agent runs ${agent.metadata.tuiKind || 'an unknown TUI'}).`, { status: 400, code: 'INVALID_STATE' });
    }
    if (!agent.metadata?.tuiSessionId) {
      throw new ServerError('Agent has no attached TUI session', { status: 400, code: 'INVALID_STATE' });
    }
    return { tuiSessionId: agent.metadata.tuiSessionId };
  });

  const shellService = await import('./shell.js');
  if (!shellService.getSession(agentInfo.tuiSessionId)) {
    throw new ServerError('TUI session is no longer alive', { status: 400, code: 'INVALID_STATE' });
  }
  // Bracketed-paste + delayed Enter, mirroring the initial prompt paste in
  // agentTuiSpawning.js: Claude Code commits the paste buffer before the
  // submit arrives, so multi-line messages land as a single paste event.
  shellService.writeToSession(agentInfo.tuiSessionId, `\x1b[200~${message}\x1b[201~`);
  setTimeout(() => {
    try {
      // Re-check session liveness: the TUI session may have died in the 400ms window.
      if (shellService.getSession(agentInfo.tuiSessionId)) {
        shellService.writeToSession(agentInfo.tuiSessionId, '\r');
      }
    } catch (err) {
      console.error(`❌ [cosAgents] BTW delayed Enter failed for session ${agentInfo.tuiSessionId}: ${err.message}`);
    }
  }, 400);

  // Track in agent state (cap at 50 messages)
  const timestamp = new Date().toISOString();
  await withStateLock(async () => {
    const state = await loadState();
    if (!state.agents[agentId]) return;
    if (!state.agents[agentId].btwMessages) {
      state.agents[agentId].btwMessages = [];
    }
    state.agents[agentId].btwMessages.push({ message, timestamp });
    if (state.agents[agentId].btwMessages.length > 50) {
      state.agents[agentId].btwMessages = state.agents[agentId].btwMessages.slice(-50);
    }
    await saveState(state);
  });

  cosEvents.emit('agent:btw', { agentId, message, timestamp });
  return { success: true, delivered: 'tui-paste', tuiSessionId: agentInfo.tuiSessionId };
}

// Get process stats for an agent (CPU, memory)
export async function getAgentProcessStats(agentId) {
  const { getAgentProcessStats: getStatsFromSpawner } = await import('./subAgentSpawner.js');
  return getStatsFromSpawner(agentId);
}

// Check if a PID is still running
async function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Cleanup zombie agents - agents marked as running but whose process is dead
export async function cleanupZombieAgents() {
  // Check local tracking maps (read from the side-effect-free state module, not
  // subAgentSpawner — avoids pulling in the heavier orchestrator just to read the maps).
  const { getActiveAgentIds } = await import('./agentState.js');
  const activeIds = getActiveAgentIds();

  // Also check with the CoS runner for agents it's actively tracking
  const { getActiveAgentsFromRunner } = await import('./cosRunnerClient.js');
  const runnerAgents = await getActiveAgentsFromRunner().catch(() => []);
  const runnerAgentIds = new Set(runnerAgents.map(a => a.id));

  return withStateLock(async () => {
    const state = await loadState();
    const runningAgents = Object.values(state.agents).filter(a => a.status === 'running');
    const cleaned = [];

    for (const agent of runningAgents) {
      // Skip if tracked in local maps or runner
      if (activeIds.includes(agent.id) || runnerAgentIds.has(agent.id)) {
        continue;
      }

      // If agent has a PID, verify the process is actually dead
      if (agent.pid) {
        const alive = await isPidAlive(agent.pid);
        if (alive) continue;
      } else {
        // No PID yet - agent might still be initializing
        // Give it a 30 second grace period before marking as zombie
        const startedAt = agent.startedAt ? new Date(agent.startedAt).getTime() : 0;
        const ageMs = Date.now() - startedAt;
        if (ageMs < 30000) continue;
      }

      // Agent is not tracked anywhere and process is dead — it's a zombie
      console.log(`🧟 Zombie agent detected: ${agent.id} (PID ${agent.pid || 'unknown'} not running)`);
      state.agents[agent.id] = {
        ...agent,
        status: 'completed',
        completedAt: new Date().toISOString(),
        result: { success: false, error: 'Agent process terminated unexpectedly' }
      };
      cleaned.push(agent.id);
    }

    if (cleaned.length > 0) {
      await saveState(state);

      // Persist zombie-cleaned agents to date-bucketed dirs and update index
      const idx = await loadAgentIndex();
      for (const agentId of cleaned) {
        const agent = state.agents[agentId];
        const dateStr = agent.completedAt?.slice(0, 10);
        if (!dateStr) continue;
        const bucketDir = join(AGENTS_DIR, dateStr);
        await ensureDir(bucketDir);

        const flatDir = join(AGENTS_DIR, agentId);
        const { output, ...agentWithoutOutput } = agent;

        // Ensure metadata is written before move
        if (!existsSync(flatDir)) await ensureDir(flatDir);
        await atomicWrite(join(flatDir, 'metadata.json'), agentWithoutOutput).catch(() => {});

        // Move to date bucket
        const targetDir = join(bucketDir, agentId);
        if (!existsSync(targetDir)) {
          await rename(flatDir, targetDir).catch(async () => {
            await ensureDir(targetDir);
            const files = await readdir(flatDir);
            for (const file of files) {
              const content = await readFile(join(flatDir, file));
              await writeFile(join(targetDir, file), content);
            }
            await rm(flatDir, { recursive: true });
          });
        }

        idx.set(agentId, dateStr);
      }
      await saveAgentIndex();

      console.log(`🧹 Cleaned up ${cleaned.length} zombie agents: ${cleaned.join(', ')}`);
      cosEvents.emit('agents:changed', { action: 'zombie-cleanup', cleaned });
    }

    return { cleaned, count: cleaned.length };
  });
}

// Delete a single agent from state and disk
export async function deleteAgent(agentId) {
  return withStateLock(async () => {
    const state = await loadState();
    const idx = await loadAgentIndex();

    const inState = !!state.agents[agentId];
    const inIndex = idx.has(agentId);
    if (!inState && !inIndex) {
      throw new ServerError('Agent not found', { status: 404, code: 'NOT_FOUND' });
    }

    delete state.agents[agentId];
    await saveState(state);

    // Remove from disk (date-bucketed or flat)
    const agentDir = getAgentDir(agentId);
    if (existsSync(agentDir)) {
      await rm(agentDir, { recursive: true }).catch(() => {});
    }

    // Remove from index
    idx.delete(agentId);
    await saveAgentIndex();

    cosEvents.emit('agents:changed', { action: 'deleted', agentId });
    return { success: true, agentId };
  });
}
