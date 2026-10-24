/**
 * CoS Agent Archive Module
 *
 * State-eviction paths: archive stale completed agents out of state.json (they
 * stay on date-bucketed disk) and the destructive clear-completed sweep.
 * Extracted from the former monolithic cosAgents.js (issue #2530).
 *
 * The `cosAgents.js` barrel that used to re-export this module is retired
 * (#3450) — callers import from here directly.
 */

import { withBackupAssetPublication } from '../lib/backupSnapshotBoundary.js';
import { rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { cosEvents } from './cosEvents.js';
import { loadState, saveState, withStateLock, AGENTS_DIR } from './cosState.js';
import { atomicWrite, ensureDir } from '../lib/fileUtils.js';
import { loadAgentIndex, saveAgentIndex, recordArchivedAgentOrder, moveAgentDir } from './cosAgentIndex.js';
import { readProtectedCleanupOwners } from './cosAgentLifecycle.js';
import { releaseAgentReservation } from './agentMaintenanceReservations.js';

// Archive stale completed agents from state.json.
// Completed agents are already persisted to per-agent metadata files on disk
// (metadata.json) by completeAgent(), so removing them from state.json only
// reduces the size of the in-memory state and the state.json file.
export async function archiveStaleAgents() {
  return withBackupAssetPublication(() => withStateLock(async () => {
    const state = await loadState();
    const retentionMs = state.config.completedAgentRetentionMs ?? 86400000;
    const cutoff = Date.now() - retentionMs;

    const staleIds = Object.keys(state.agents).filter(id => {
      const agent = state.agents[id];
      if (agent.status !== 'completed') return false;
      const completedAt = agent.completedAt ? new Date(agent.completedAt).getTime() : 0;
      return completedAt > 0 && completedAt < cutoff;
    });

    if (staleIds.length === 0) return { archived: 0 };

    const idx = await loadAgentIndex();
    const archived = [];

    for (const id of staleIds) {
      // Ensure agent is persisted to date-bucketed disk before removing from state
      if (!idx.has(id)) {
        const agent = state.agents[id];
        const dateStr = agent.completedAt?.slice(0, 10);
        if (!dateStr) continue;
        const bucketDir = join(AGENTS_DIR, dateStr);
        await ensureDir(bucketDir);

        const { output, ...agentWithoutOutput } = agent;
        const flatDir = join(AGENTS_DIR, id);
        const targetDir = join(bucketDir, id);

        if (existsSync(flatDir) && !existsSync(targetDir)) {
          // Write metadata then move (byte-safe fallback that never deletes the
          // source unless the whole copy landed)
          await atomicWrite(join(flatDir, 'metadata.json'), agentWithoutOutput).catch(() => {});
          await moveAgentDir(flatDir, targetDir)
            .catch(err => console.error(`❌ Failed to archive agent ${id}: ${err.message}`));
          if (!existsSync(targetDir)) continue; // Skip index update if move failed
        } else if (!existsSync(targetDir)) {
          await ensureDir(targetDir);
          await atomicWrite(join(targetDir, 'metadata.json'), agentWithoutOutput).catch(() => {});
        }

        idx.set(id, dateStr);
        archived.push({ ...agent, id });
      }

      delete state.agents[id];
    }

    await saveState(state);
    // Ordered before `saveAgentIndex`, which prunes the projection to the ids
    // the index owns.
    await recordArchivedAgentOrder(archived);
    await saveAgentIndex();
    console.log(`📦 Archived ${staleIds.length} stale agents from state.json (retained on disk)`);
    cosEvents.emit('agents:changed', { action: 'auto-archive', archived: staleIds.length });
    return { archived: staleIds.length };
  }));
}

// Clear completed agents from state, cache, and disk
export async function clearCompletedAgents() {
  return withBackupAssetPublication(() => withStateLock(async () => {
    const state = await loadState();
    const idx = await loadAgentIndex();
    const protectedOwners = await readProtectedCleanupOwners({ state, index: idx });

    // Remove unprotected completed agents from state; retain current cleanup/retry owners
    const stateCompleted = Object.keys(state.agents).filter(
      id => state.agents[id].status === 'completed'
    );
    const removableStateIds = [];
    const retainedIds = new Set();
    for (const id of stateCompleted) {
      if (protectedOwners.isProtected(id)) {
        retainedIds.add(id);
        continue;
      }
      removableStateIds.push(id);
      delete state.agents[id];
    }
    if (removableStateIds.length > 0) {
      await saveState(state, { changedAgentIds: removableStateIds });
    }

    const removedIndexEntries = [];
    const retainedDates = new Set();
    const allDates = new Set();
    for (const [id, date] of idx) {
      allDates.add(date);
      if (protectedOwners.isProtected(id)) {
        retainedIds.add(id);
        retainedDates.add(date);
      } else {
        removedIndexEntries.push([id, date]);
      }
    }

    const totalCleared = removedIndexEntries.length + removableStateIds.filter(id => !idx.has(id)).length;

    // Remove durable references before bytes; a failed index write must leave
    // the old archive trees readable and its in-memory lookup retryable.
    if (removedIndexEntries.length > 0) {
      for (const [id] of removedIndexEntries) idx.delete(id);
      try { await saveAgentIndex(); }
      catch (err) { for (const [id, date] of removedIndexEntries) idx.set(id, date); throw err; }
    }

    // Whole buckets with no retained entries can be removed in one pass; mixed
    // buckets remove only the unprotected agent directories inside them.
    const removals = [];
    for (const date of allDates) {
      if (retainedDates.has(date)) continue;
      const dateDir = join(AGENTS_DIR, date);
      if (existsSync(dateDir)) {
        removals.push(rm(dateDir, { recursive: true }).catch(() => {}));
      }
    }
    for (const [id, date] of removedIndexEntries) {
      if (!retainedDates.has(date)) continue;
      const agentDir = join(AGENTS_DIR, date, id);
      if (existsSync(agentDir)) {
        removals.push(rm(agentDir, { recursive: true }).catch(() => {}));
      }
    }
    await Promise.all(removals);

    for (const id of removableStateIds) await releaseAgentReservation(id);
    cosEvents.emit('agents:changed', { action: 'cleared-completed', cleared: totalCleared, retained: retainedIds.size });
    return { cleared: totalCleared, retained: retainedIds.size };
  }));
}
