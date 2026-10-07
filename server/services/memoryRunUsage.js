/**
 * Memory → runs lineage: which recent agent runs had a memory injected into
 * their prompt. Run records are files (`data/runs/<runId>/metadata.json`), so
 * this is a bounded scan of the newest run directories rather than an index.
 * Records written before #10495 have no `injectedMemories` and never match.
 */

import { join } from 'path';
import { readdir, stat } from 'fs/promises';
import { PATHS, readJSONFile } from '../lib/fileUtils.js';

export const DEFAULT_RUN_SCAN_LIMIT = 200;

/**
 * @param {string} memoryId
 * @param {{ scanLimit?: number, limit?: number }} [options] - `scanLimit` caps how
 *   many of the newest run records are read; `limit` caps matches returned.
 * @returns {Promise<Array<{ runId: string, agentId: string|null, taskId: string|null, startTime: string|null, success: boolean|null, version: number|null, relevance: number|null }>>}
 */
export async function findRecentRunsUsingMemory(memoryId, { scanLimit = DEFAULT_RUN_SCAN_LIMIT, limit = 20 } = {}) {
  const entries = await readdir(PATHS.runs, { withFileTypes: true }).catch(() => []);
  const dirs = await Promise.all(entries
    .filter(e => e.isDirectory())
    .map(async e => ({ name: e.name, mtimeMs: (await stat(join(PATHS.runs, e.name)).catch(() => null))?.mtimeMs ?? 0 })));
  const newest = dirs.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, scanLimit);

  const records = await Promise.all(newest.map(d => readJSONFile(join(PATHS.runs, d.name, 'metadata.json'), null)));
  const matches = [];
  for (const meta of records) {
    const hit = Array.isArray(meta?.injectedMemories)
      ? meta.injectedMemories.find(m => m?.id === memoryId)
      : null;
    if (!hit) continue;
    matches.push({
      runId: meta.id,
      agentId: meta.agentId ?? null,
      taskId: meta.taskId ?? null,
      startTime: meta.startTime ?? null,
      success: meta.success ?? null,
      version: hit.version ?? null,
      relevance: hit.relevance ?? null,
    });
  }
  return matches
    .sort((a, b) => String(b.startTime).localeCompare(String(a.startTime)))
    .slice(0, limit);
}
