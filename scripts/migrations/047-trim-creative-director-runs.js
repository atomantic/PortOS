/**
 * Truncate accumulated per-project `runs[]` history in
 * `data/creative-director-projects.json` so existing installs immediately shed
 * the bloat that turned per-scene orchestration into O(N²) wall-clock during
 * long sessions.
 *
 * Without this one-shot, the cap added in `server/services/creativeDirector/local.js`
 * only shrinks a project's runs[] the next time something writes that project
 * — so until that happens, every list / get / scene update still parses and
 * serializes the legacy multi-thousand-entry payload from disk.
 *
 * Trim policy mirrors `trimRuns` in `local.js`: keep every non-terminal run
 * (load-bearing for orphan / dedup detection in completionHook and the boot
 * recovery scan) plus the most-recent terminal entries, up to MAX_PERSISTED_RUNS
 * total. Skip projects whose runs[] is already under the cap.
 *
 * Idempotent: a second run finds everything already at or under the cap and
 * exits without writing.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { atomicWrite } from '../../server/lib/fileUtils.js';

const REL_PATH = 'data/creative-director-projects.json';
const MAX_PERSISTED_RUNS = 200;
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed']);

function trimRuns(runs) {
  if (!Array.isArray(runs) || runs.length <= MAX_PERSISTED_RUNS) return runs;
  let inflightCount = 0;
  for (const r of runs) {
    if (!(r && TERMINAL_RUN_STATUSES.has(r.status))) inflightCount += 1;
  }
  const terminalBudget = Math.max(0, MAX_PERSISTED_RUNS - inflightCount);
  const kept = [];
  let terminalsKept = 0;
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const r = runs[i];
    const isTerminal = r && TERMINAL_RUN_STATUSES.has(r.status);
    if (!isTerminal) {
      kept.push(r);
    } else if (terminalsKept < terminalBudget) {
      kept.push(r);
      terminalsKept += 1;
    }
  }
  return kept.reverse();
}

export default {
  async up({ rootDir }) {
    const path = join(rootDir, REL_PATH);
    const raw = await readFile(path, 'utf-8').catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (raw == null) {
      console.log(`📄 ${REL_PATH} not present — skipping (fresh install)`);
      return;
    }

    let projects;
    try {
      projects = JSON.parse(raw);
    } catch (err) {
      console.log(`⚠️ ${REL_PATH}: invalid JSON, skipping (${err.message})`);
      return;
    }
    if (!Array.isArray(projects)) {
      console.log(`⚠️ ${REL_PATH}: expected array, found ${typeof projects} — skipping`);
      return;
    }

    let trimmedCount = 0;
    let entriesDropped = 0;
    for (const p of projects) {
      if (!p || !Array.isArray(p.runs) || p.runs.length <= MAX_PERSISTED_RUNS) continue;
      const before = p.runs.length;
      p.runs = trimRuns(p.runs);
      entriesDropped += before - p.runs.length;
      trimmedCount += 1;
    }

    if (trimmedCount === 0) {
      console.log(`✅ ${REL_PATH}: all ${projects.length} project(s) already under runs[] cap of ${MAX_PERSISTED_RUNS}, nothing to migrate`);
      return;
    }

    await atomicWrite(path, `${JSON.stringify(projects, null, 2)}\n`);
    console.log(`📝 ${REL_PATH}: trimmed ${trimmedCount} project(s), dropped ${entriesDropped} stale run entries (cap ${MAX_PERSISTED_RUNS})`);
  },
};
