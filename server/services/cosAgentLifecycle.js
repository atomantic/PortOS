/**
 * CoS Agent Lifecycle Module
 *
 * Agent register/update/complete/output/terminate/pause/kill/BTW/zombie-cleanup
 * and single-agent reads. Extracted from the former monolithic cosAgents.js
 * (issue #2530); the date-bucket index + archive layout lives in cosAgentIndex.js
 * and is shared via loadAgentIndex/saveAgentIndex/getAgentDir.
 *
 * The `cosAgents.js` barrel that used to re-export this module is retired
 * (#3450) — callers import from here directly.
 */

import { readFile, writeFile, rename, readdir, rm, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { cosEvents } from './cosEvents.js';
import { ServerError } from '../lib/errorHandler.js';
import { loadState, saveState, withStateLock, readAgentsStateForSafetyCheck, AGENTS_DIR } from './cosState.js';
import { atomicWrite, ensureDir, readFileTail, safeJSONParse, tryReadFile } from '../lib/fileUtils.js';
import { runnerEntryShieldsRunningRecord } from '../lib/runnerAgentLiveness.js';
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

    // Completion writes the archive before later completion hooks enrich an
    // agent's metadata (task summaries, scan reports, etc.). Mirror those
    // post-completion updates into the archived metadata too, otherwise they
    // disappear as soon as in-memory retention expires.
    const updatedAgent = state.agents[agentId];
    if (updatedAgent.status === 'completed' && updatedAgent.completedAt) {
      const { output: _output, ...metadata } = updatedAgent;
      const dateStr = updatedAgent.completedAt.slice(0, 10);
      await atomicWrite(join(getAgentDir(agentId, dateStr), 'metadata.json'), metadata);
    }

    cosEvents.emit('agent:updated', updatedAgent);
    return updatedAgent;
  });
}

async function copyDirContents(fromDir, toDir) {
  const files = await readdir(fromDir);
  for (const file of files) {
    const content = await readFile(join(fromDir, file));
    await writeFile(join(toDir, file), content);
  }
}

/**
 * Move a completed agent's directory into its `YYYY-MM-DD` bucket and index it.
 * Split out of `completeAgent` and made idempotent so the duplicate-completion
 * path can re-run it to finish an archive a prior call left half-done (an fs
 * failure anywhere after the state write) without touching the recorded verdict.
 */
async function archiveCompletedAgent(agentId, agent) {
  // Determine date bucket from completedAt
  const dateStr = agent.completedAt.slice(0, 10);
  const targetDir = join(AGENTS_DIR, dateStr, agentId);

  // Skipped once the bucket dir exists — a prior completion already moved it.
  // Rewriting metadata into a recreated flat dir would both litter and let a
  // later caller's verdict reach the archive the state record no longer accepts.
  if (!existsSync(targetDir)) {
    await ensureDir(join(AGENTS_DIR, dateStr));

    // Write metadata to flat dir first (may already have output.txt/prompt.txt there)
    const flatDir = join(AGENTS_DIR, agentId);
    if (!existsSync(flatDir)) {
      await ensureDir(flatDir);
    }
    const { output: _output, ...agentWithoutOutput } = agent;
    await atomicWrite(join(flatDir, 'metadata.json'), agentWithoutOutput);

    // Move entire agent dir into date bucket (atomic on same filesystem)
    await rename(flatDir, targetDir).catch(async () => {
      // Fallback for cross-filesystem: copy files then remove
      await ensureDir(targetDir);
      await copyDirContents(flatDir, targetDir).catch(async (err) => {
        // Roll the half-copied target back. `existsSync(targetDir)` is what every
        // later archive attempt (including the duplicate-completion repair) reads
        // as "already archived", so leaving a partial directory behind would
        // strand the rest of the run's output.txt/prompt.txt permanently.
        await rm(targetDir, { recursive: true, force: true })
          .catch(rmErr => console.error(`❌ Failed to roll back partial archive for ${agentId}: ${rmErr.message}`));
        throw err;
      });
      await rm(flatDir, { recursive: true });
    });
  }

  // Update index — deliberately NOT gated on the in-memory map already holding
  // this entry. `saveAgentIndex` swallows its own write errors, so a failed write
  // leaves the map correct while index.json on disk is missing the agent; after a
  // restart the archive would be unreachable from history. Re-running the write
  // is cheap (a small map, atomically written) and repairs exactly that.
  const idx = await loadAgentIndex();
  idx.set(agentId, dateStr);
  await saveAgentIndex();
}

export async function completeAgent(agentId, result = {}) {
  // Set inside the lock when the record is already terminal, so the post-lock
  // tail below (budget ledger + `agent:completed`) is skipped too — see #3384.
  let alreadyCompleted = false;

  const completed = await withStateLock(async () => {
    const state = await loadState();

    if (!state.agents[agentId]) {
      return null;
    }

    // Idempotence (#3384): six call sites funnel here and each carries the
    // "I might be second" assumption. A duplicate completion used to overwrite
    // the recorded verdict — a stray runner `agent:completed` once replaced a
    // real success with `success: false, exitCode: 143`, flipping the card to
    // Failed and requeueing a finished task. Caller-level guards read the record
    // outside this lock, so they narrow the window rather than closing it.
    // Guard on `completed` specifically, NOT `!== 'running'`: `paused` records
    // are legitimately completed on resume.
    if (state.agents[agentId].status === 'completed') {
      alreadyCompleted = true;
      // One exception to "do nothing": if a prior completion threw partway
      // through archiving, the record says completed but its directory never
      // reached the date bucket (or never got indexed). `archiveCompletedAgent`
      // is idempotent, so re-running it finishes the job with the ALREADY-
      // RECORDED result rather than the second caller's (typically bogus) one.
      if (state.agents[agentId].completedAt) {
        await archiveCompletedAgent(agentId, state.agents[agentId]);
      }
      return state.agents[agentId];
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
    } else if (!result.resumed) {
      // `resumed` records are retired by `resumeAgent`, not failed: the user paused
      // the run and its task is already requeued, so the continuation will land in
      // one of these two counters itself. Counting it here reports an error the user
      // caused deliberately and never saw.
      state.stats.errors = (state.stats.errors || 0) + 1;
    }

    await saveState(state);
    // `agent:completed` is intentionally emitted later, after the domain-usage
    // ledger is updated (see the recordDomainUsage block below, #1683). Do NOT
    // move it back here. `agent:updated` carries no scheduling side effect, so it
    // stays inside the lock.
    cosEvents.emit('agent:updated', state.agents[agentId]);

    await archiveCompletedAgent(agentId, state.agents[agentId]);

    return state.agents[agentId];
  });

  // A duplicate completion never runs the completion tail: re-recording the
  // domain-usage action would double-charge the daily budget, and re-emitting
  // `agent:completed` would re-run the scheduler hand-off for an agent that
  // already finished (#3384). The existing record still comes back to the caller.
  if (alreadyCompleted) {
    return completed;
  }

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
// AGENTS.md ("High-frequency state writes must batch"). The TUI spawner rolls
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
    // timer callbacks where an uncaught throw would crash Node (AGENTS.md "No
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

/**
 * Is this agent record still work in flight, rather than a run PortOS has
 * already finalized?
 *
 * `completed` is the only terminal status; a missing record is terminal too,
 * because a finalized agent is archived out of `state.agents` into its date
 * bucket, and an id that was never registered is not a run at all. `paused`
 * counts as live: its task is still owed a resume, and pausing already removes
 * the agent from the in-memory maps, so it can never inflate a map-derived
 * count on its own.
 */
export const isLiveAgentRecord = (record) => Boolean(record) && record.status !== 'completed';

/**
 * Returned by `readAgentRecordOrUnreadable` when the READ ITSELF failed — which
 * is not the same answer as `null` ("there is genuinely no such record"), and
 * leads to the opposite decision: an absent record means the run is finalized
 * and its tracking can go, while a failed read proves nothing and must leave
 * live state alone.
 */
export const AGENT_RECORD_UNREADABLE = Symbol('agent-record-unreadable');

/**
 * `getAgentRecord` that reports an I/O failure as `AGENT_RECORD_UNREADABLE`
 * instead of collapsing it into `null`. Pair it with `isLiveAgentRecord`:
 *
 *   const read = await readAgentRecordOrUnreadable(id);
 *   if (read !== AGENT_RECORD_UNREADABLE && !isLiveAgentRecord(read)) { … }
 */
export const readAgentRecordOrUnreadable = (agentId) =>
  getAgentRecord(agentId).then(record => record, () => AGENT_RECORD_UNREADABLE);

/**
 * Narrow a set of in-memory agent ids to the ones PortOS still considers work
 * in flight.
 *
 * The in-memory maps (`activeAgents` / `runnerAgents`) are not self-cleaning:
 * `syncRunnerAgents` adopts whatever `GET /agents` on the CoS Runner reports,
 * so a TUI PTY the runner never managed to kill stays "active" for the life of
 * the process. That is how the Update page came to sit on "4 CoS agents are
 * currently running" above an empty agent list — four finalized codex TUIs the
 * runner was still advertising, blocking the restart that would have cleared
 * them. `registerAgent` writes the record before the spawn, and the whole spawn
 * runs inside `spawningTasks`, so no genuinely starting agent falls through.
 *
 * **Fails CLOSED.** The one caller gates a pm2 restart that severs live agents,
 * so this reads the records through `readAgentsStateForSafetyCheck` — which
 * reports whether they could be established at all — rather than `loadState`,
 * which silently substitutes an EMPTY default state for a corrupt file. Reading
 * that default would judge every tracked id finalized and hand the gate a
 * confident zero, restarting PortOS out from under whatever was running. When
 * the records cannot be trusted, every tracked id counts as live instead.
 */
export async function filterLiveAgentIds(agentIds) {
  if (agentIds.length === 0) return [];
  const ids = [...new Set(agentIds)];
  const { trusted, agents } = await readAgentsStateForSafetyCheck();
  if (!trusted || !agents) {
    console.warn(`⚠️ CoS agent records could not be established — treating all ${ids.length} tracked agent(s) as live`);
    return ids;
  }
  return ids.filter(id => isLiveAgentRecord(agents[id]));
}

// Get agent by ID with full output from file
/**
 * The agent record WITHOUT its transcript — in-memory state first, falling back
 * to the on-disk `metadata.json` the index points at.
 *
 * Split out of `getAgent` so callers that only need the record's fields (the
 * worktree/provider metadata, the status) don't pay to read and line-split a
 * completed agent's entire output.txt — which for a long TUI run is megabytes,
 * and whose read failing would otherwise take the whole lookup down with it.
 * `releaseRetryHold` is the motivating caller (#3368).
 */
export async function getAgentRecord(agentId) {
  const state = await loadState();
  const agent = state.agents[agentId];
  if (agent) return agent;

  // Fall back to disk metadata via index if not in state
  const idx = await loadAgentIndex();
  const dateStr = idx.get(agentId);
  if (!dateStr) return null;
  const content = await tryReadFile(join(AGENTS_DIR, dateStr, agentId, 'metadata.json'));
  if (!content) return null;
  const raw = safeJSONParse(content, null);
  if (!raw) return null;
  const { output, ...rest } = raw;
  return { ...rest, id: raw.id || raw.agentId || agentId, status: raw.status || 'completed' };
}

// Transcript read caps for `getAgent` (#3498). `output.txt` is append-only and
// has no upper bound — a long TUI run writes tens of MB — so reading it whole
// and mapping EVERY line to a `{ line, timestamp }` object spiked heap by
// ~2x the file size per request. Both caps are load-bearing and neither
// subsumes the other:
//   - the LINE cap bounds the object count (the allocation the issue is about)
//   - the BYTE cap bounds the string read, because a repaint-heavy TUI spool
//     can be one multi-MB "line" with no newlines at all, on which a
//     line-based tail is a no-op.
export const AGENT_OUTPUT_TAIL_LINES = 1000;
export const AGENT_OUTPUT_TAIL_BYTES = 512 * 1024;

/**
 * Tail an agent's `output.txt` into the `{ line, timestamp }` shape the UI
 * renders, reading at most `maxBytes` from the end of the file and keeping at
 * most `limit` lines.
 *
 * Deliberately tail-only: an `offset` from the head of the file would have to
 * read everything before it, which is the exact cost this cap exists to avoid.
 * The interesting end of an agent transcript is the end (that's where the
 * failure and the summary are), so the trailing window is what callers want.
 *
 * @returns {Promise<{ lines: string[], truncated: boolean, totalBytes: number }|null>}
 *          null when the file is missing or unreadable. `totalBytes` is the
 *          size of the WHOLE transcript on disk, not of the window returned.
 */
async function readAgentTranscriptTail(outputFile, { limit, maxBytes }) {
  // Stat separately from the tail read: the caller needs the FULL on-disk size
  // for the truncation marker, and `readFileTail` only hands back the window.
  const info = await stat(outputFile).catch(() => null);
  if (!info) return null;
  const text = await readFileTail(outputFile, maxBytes);
  if (text === null) return null;
  const clippedByBytes = info.size > maxBytes;
  // The byte window can start mid-line (and mid-multibyte-character), so drop
  // the leading fragment rather than surfacing a garbled partial line — UNLESS
  // it is the only thing in the window. A repainted TUI transcript is one
  // enormous newline-free line, and dropping it would hand the UI an empty
  // transcript for a file that is plainly not empty; a partial last screen
  // beats nothing.
  const split = text.split('\n');
  const kept = split.filter(line => line.trim());
  const withoutFragment = clippedByBytes ? split.slice(1).filter(line => line.trim()) : kept;
  const lines = withoutFragment.length > 0 ? withoutFragment : kept;
  const clippedByLines = lines.length > limit;
  return {
    lines: clippedByLines ? lines.slice(-limit) : lines,
    truncated: clippedByBytes || clippedByLines,
    totalBytes: info.size
  };
}

/**
 * The agent record hydrated with the TAIL of its on-disk transcript.
 *
 * Callers that only need the record's fields should use `getAgentRecord` —
 * this one still touches the filesystem. When the transcript is longer than
 * the caps, the result carries `outputTruncated: true` so the UI can say the
 * transcript was clipped instead of silently presenting a partial log as whole.
 *
 * @param {string} agentId
 * @param {Object} [options]
 * @param {number} [options.limit=AGENT_OUTPUT_TAIL_LINES] - Max transcript lines to return (from the tail)
 * @param {number} [options.maxBytes=AGENT_OUTPUT_TAIL_BYTES] - Max bytes to read from the end of output.txt
 */
export async function getAgent(agentId, { limit = AGENT_OUTPUT_TAIL_LINES, maxBytes = AGENT_OUTPUT_TAIL_BYTES } = {}) {
  let agent = await getAgentRecord(agentId);
  if (!agent) return null;

  // Completed agents live in date buckets; paused agents remain in the flat
  // agent dir but should still expose their preserved transcript.
  if (agent.status === 'completed' || agent.status === 'paused') {
    const dateStr = agent.status === 'completed' ? agent.completedAt?.slice(0, 10) : null;
    const agentDir = dateStr ? getAgentDir(agentId, dateStr) : getAgentDir(agentId);
    const repaired = await repairCodexTaskSummary(agentDir, agent);
    if (repaired) agent = { ...agent, metadata: { ...agent.metadata, taskSummary: repaired } };
    const outputFile = join(agentDir, 'output.txt');
    const tail = await readAgentTranscriptTail(outputFile, { limit, maxBytes });
    if (tail) {
      const timestamp = agent.completedAt || agent.pausedAt;
      return {
        ...agent,
        output: tail.lines.map(line => ({ line, timestamp })),
        outputTruncated: tail.truncated,
        outputTotalBytes: tail.totalBytes
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

// `pauseAgent` / `killAgent` / `getAgentProcessStats` moved to
// `agentOrchestrator.js` (#3450). They lived here as deferred-import forwarders
// into the process layer, which this STATE layer cannot import statically
// without inverting the layering — so do not re-add one. Ask the facade for a
// transition; `agentImportCycles.test.js` fails on any new deferred import of
// `agentManagement.js` from this file.

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
  shellService.pasteToSession(agentInfo.tuiSessionId, message, { label: '[cosAgents] BTW' });

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
  // Direct-spawn handles in this process (not leftover runnerAgents adopts —
  // those are only a handle, same as GET /agents). Read from the side-effect-free
  // state module, not subAgentSpawner.
  const { activeAgents } = await import('./agentState.js');

  // Also check with the CoS runner for agents it's actively tracking
  const { getActiveAgentsFromRunner } = await import('./cosRunnerClient.js');
  const runnerProbe = await getActiveAgentsFromRunner().then(
    (agents) => Array.isArray(agents)
      ? { available: true, agents }
      : { available: false, agents: [] },
    () => ({ available: false, agents: [] }),
  );
  const runnerById = new Map(
    runnerProbe.agents
      .filter((row) => row?.id)
      .map((row) => [row.id, row]),
  );

  return withStateLock(async () => {
    const state = await loadState();
    const runningAgents = Object.values(state.agents).filter(a => a.status === 'running');
    const cleaned = [];

    for (const agent of runningAgents) {
      // A runner listing is only a shield when corroborated (live pid or
      // processActive from onExit/pid probe). Leftover runnerAgents ownership
      // from an earlier adopt is not.
      if (activeAgents.has(agent.id)) continue;
      const executionMode = agent.metadata?.executionMode;
      const runnerOwned = agent.metadata?.useRunner === true
        || agent.metadata?.useRunner === 'true'
        || executionMode === 'runner'
        || executionMode === 'runner-tui';
      // Same as the orphan sweep: a failed probe is not evidence the runner
      // process died. A pid-0 TUI after restart would otherwise be archived
      // as "never started" the moment the runner is unreachable.
      if (!runnerProbe.available && runnerOwned) continue;
      if (await runnerEntryShieldsRunningRecord(runnerById.get(agent.id), isPidAlive)) {
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

      // Agent is not tracked anywhere and process is dead — it's a zombie.
      // A record that never recorded a pid never spawned at all (the pid is
      // written only after a successful spawn), so "terminated unexpectedly"
      // is the wrong diagnosis: it points at a crash when the real cause is
      // upstream, at spawn time. Spawn failures now finalize themselves with
      // the actual error, so reaching here without a pid means the spawn died
      // somewhere that still doesn't report — say so rather than inventing a
      // termination that never happened.
      const neverStarted = !agent.pid;
      console.log(`🧟 Zombie agent detected: ${agent.id} (${neverStarted ? 'no process was ever launched' : `PID ${agent.pid} not running`})`);
      state.agents[agent.id] = {
        ...agent,
        status: 'completed',
        completedAt: new Date().toISOString(),
        result: {
          success: false,
          error: neverStarted
            ? 'Agent never started — no process was ever launched (check the provider command and CoS Runner logs)'
            : 'Agent process terminated unexpectedly'
        }
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
