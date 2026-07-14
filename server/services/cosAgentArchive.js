/**
 * CoS Agent Archive Module
 *
 * State-eviction paths: archive stale completed agents out of state.json (they
 * stay on date-bucketed disk) and the destructive clear-completed sweep.
 * Extracted from the former monolithic cosAgents.js (issue #2530).
 *
 * The public barrel `cosAgents.js` re-exports everything here.
 */

import { writeFile, rename, readdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { cosEvents } from './cosEvents.js';
import { loadState, saveState, withStateLock, AGENTS_DIR } from './cosState.js';
import { atomicWrite, ensureDir, tryReadFile } from '../lib/fileUtils.js';
import { loadAgentIndex, saveAgentIndex } from './cosAgentIndex.js';

// Archive stale completed agents from state.json.
// Completed agents are already persisted to per-agent metadata files on disk
// (metadata.json) by completeAgent(), so removing them from state.json only
// reduces the size of the in-memory state and the state.json file.
export async function archiveStaleAgents() {
  return withStateLock(async () => {
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
          // Write metadata then move (with cross-filesystem fallback)
          await atomicWrite(join(flatDir, 'metadata.json'), agentWithoutOutput).catch(() => {});
          await rename(flatDir, targetDir).catch(async () => {
            await ensureDir(targetDir);
            const files = await readdir(flatDir).catch(() => []);
            for (const file of files) {
              const content = await tryReadFile(join(flatDir, file), null);
              if (content !== null) await writeFile(join(targetDir, file), content);
            }
            await rm(flatDir, { recursive: true }).catch(() => {});
          });
          if (!existsSync(targetDir)) continue; // Skip index update if move failed
        } else if (!existsSync(targetDir)) {
          await ensureDir(targetDir);
          await atomicWrite(join(targetDir, 'metadata.json'), agentWithoutOutput).catch(() => {});
        }

        idx.set(id, dateStr);
      }

      delete state.agents[id];
    }

    await saveState(state);
    await saveAgentIndex();
    console.log(`📦 Archived ${staleIds.length} stale agents from state.json (retained on disk)`);
    cosEvents.emit('agents:changed', { action: 'auto-archive', archived: staleIds.length });
    return { archived: staleIds.length };
  });
}

// Clear completed agents from state, cache, and disk
export async function clearCompletedAgents() {
  return withStateLock(async () => {
    const state = await loadState();
    const idx = await loadAgentIndex();

    // Remove completed agents from state
    const stateCompleted = Object.keys(state.agents).filter(
      id => state.agents[id].status === 'completed'
    );
    for (const id of stateCompleted) {
      delete state.agents[id];
    }
    await saveState(state);

    // Collect all unique dates from index, then remove date bucket dirs
    const dates = new Set(idx.values());
    const totalCleared = idx.size + stateCompleted.filter(id => !idx.has(id)).length;

    const removals = [...dates].map(date => {
      const dateDir = join(AGENTS_DIR, date);
      return existsSync(dateDir)
        ? rm(dateDir, { recursive: true }).catch(() => {})
        : Promise.resolve();
    });
    await Promise.all(removals);

    // Clear index
    idx.clear();
    await saveAgentIndex();

    return { cleared: totalCleared };
  });
}
