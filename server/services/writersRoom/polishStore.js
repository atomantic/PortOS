/**
 * Writers Room — Polish snapshot storage (#2173).
 *
 * The multi-pass Polish loop (polish.js) transforms the draft body. To keep
 * every transformation revertible, each distinct body state (the pre-polish
 * baseline + each KEPT cycle) is persisted as an IMMUTABLE snapshot under
 *   works/<workId>/polish/<snapshotId>.md
 * with a per-work index (scores, labels, run history) at
 *   works/<workId>/polish/index.json
 *
 * This mirrors the immutable `analysis/` snapshots evaluator.js writes, but for
 * bodies rather than analyses. Storage lives in its own module (fileUtils +
 * local.js only — no LLM/pipeline imports) so the snapshot/revert round-trip is
 * unit-testable without loading the Polish runner's provider stack.
 */

import { randomUUID } from 'crypto';
import { join } from 'path';
import { readFile, rm } from 'fs/promises';
import { PATHS, atomicWrite, ensureDir, safeJSONParse } from '../../lib/fileUtils.js';
import { countWords } from '../../lib/textUtils.js';
import { nowIso, notFound, assertValidWorkId } from './_shared.js';
import { saveDraftBody } from './local.js';

// Cap retained history so a heavily-polished work can't grow the index or the
// snapshot dir without bound. Newest snapshots survive (a revert targets a
// recent state); the oldest .md files are pruned. Runs are metadata-only (cheap)
// so they get a smaller, separate cap.
const MAX_SNAPSHOTS = 50;
const MAX_RUNS = 25;

const SNAPSHOT_ID_RE = /^wr-snap-[0-9a-f-]+$/i;

const polishDir = (workId) => {
  assertValidWorkId(workId);
  return join(PATHS.data, 'writers-room', 'works', workId, 'polish');
};
const snapshotBodyPath = (workId, snapshotId) => {
  if (!SNAPSHOT_ID_RE.test(snapshotId)) throw notFound('Snapshot');
  return join(polishDir(workId), `${snapshotId}.md`);
};
const polishIndexPath = (workId) => join(polishDir(workId), 'index.json');

const emptyIndex = () => ({ snapshots: [], runs: [] });

export async function loadPolishIndex(workId) {
  const content = await readFile(polishIndexPath(workId), 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (content === null) return emptyIndex();
  const parsed = safeJSONParse(content, null, { allowArray: false, logError: true, context: polishIndexPath(workId) });
  if (!parsed || typeof parsed !== 'object') return emptyIndex();
  return {
    snapshots: Array.isArray(parsed.snapshots) ? parsed.snapshots : [],
    runs: Array.isArray(parsed.runs) ? parsed.runs : [],
  };
}

async function savePolishIndex(workId, index) {
  await ensureDir(polishDir(workId));
  await atomicWrite(polishIndexPath(workId), index);
}

// Best-effort removal of a pruned snapshot's body file. A missing file is fine
// (the index is the source of truth); any other error is swallowed so pruning
// never fails a polish run.
async function removeSnapshotBody(workId, snapshotId) {
  await rm(snapshotBodyPath(workId, snapshotId), { force: true }).catch(() => {});
}

/**
 * Persist an immutable body snapshot and append its metadata to the index.
 * Returns the snapshot metadata `{ id, label, score, wordCount, createdAt }`.
 */
export async function writeSnapshot(workId, { body, label = null, score = null }) {
  const id = `wr-snap-${randomUUID()}`;
  await ensureDir(polishDir(workId));
  await atomicWrite(snapshotBodyPath(workId, id), String(body ?? ''));
  const meta = {
    id,
    label: typeof label === 'string' ? label.slice(0, 80) : null,
    score: Number.isFinite(score) ? score : null,
    wordCount: countWords(String(body ?? '')),
    createdAt: nowIso(),
  };
  const index = await loadPolishIndex(workId);
  index.snapshots.push(meta);
  // Prune oldest snapshots beyond the cap, deleting their .md bodies.
  if (index.snapshots.length > MAX_SNAPSHOTS) {
    const dropped = index.snapshots.splice(0, index.snapshots.length - MAX_SNAPSHOTS);
    await Promise.all(dropped.map((s) => removeSnapshotBody(workId, s.id)));
  }
  await savePolishIndex(workId, index);
  return meta;
}

export async function readSnapshotBody(workId, snapshotId) {
  const index = await loadPolishIndex(workId);
  if (!index.snapshots.some((s) => s.id === snapshotId)) throw notFound('Snapshot');
  return readFile(snapshotBodyPath(workId, snapshotId), 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') throw notFound('Snapshot');
    throw err;
  });
}

export async function listSnapshots(workId) {
  const index = await loadPolishIndex(workId);
  // Newest first for the revert picker.
  return [...index.snapshots].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

/**
 * Append a completed polish run to the history log. Runs are metadata-only
 * (per-cycle scores + kept/reverted decisions) — the bodies live in snapshots.
 */
export async function appendPolishRun(workId, run) {
  const index = await loadPolishIndex(workId);
  index.runs.push(run);
  if (index.runs.length > MAX_RUNS) index.runs.splice(0, index.runs.length - MAX_RUNS);
  await savePolishIndex(workId, index);
  return run;
}

/** Full polish history for the UI: snapshots (newest first) + runs (newest first). */
export async function getPolishHistory(workId) {
  const index = await loadPolishIndex(workId);
  return {
    snapshots: [...index.snapshots].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')),
    runs: [...index.runs].sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || '')),
  };
}

/**
 * Restore a snapshot's body into the work's ACTIVE draft. This is the revert
 * control: reading the immutable snapshot and writing it back through the normal
 * draft-save path (so word count / segment index / federation all update).
 * Returns `{ manifest, body }`.
 */
export async function revertToSnapshot(workId, snapshotId) {
  const body = await readSnapshotBody(workId, snapshotId);
  const result = await saveDraftBody(workId, body);
  console.log(`↩️  wr polish: reverted work=${workId.slice(0, 14)}… to snapshot=${snapshotId.slice(0, 14)}…`);
  return result;
}
