/**
 * Initialize the per-task-type recent-outcomes ring on data/cos/learning.json
 * and bump the store version to 2 (issue #2460).
 *
 * Background: the CoS task-learning counters (`byTaskType[type].completed/
 * succeeded/failed/successRate`) are lifetime-cumulative and never decay, so a
 * burst of since-resolved failures permanently depresses the success rate the
 * Layered Intelligence reasoner reads via its `cosMetrics` source. `metrics.js`
 * now appends every completion to a bounded `recentOutcomes` ring, and LI reads a
 * recency-windowed rate derived from it (`computeWindowedStats`). Existing
 * installs' learning.json predate the ring; this migration adds an empty ring to
 * each task-type bucket so the store shape matches v2.
 *
 * Deliberately EMPTY, not backfilled: `failureSignatures.recent` holds only
 * FAILURE samples, so seeding the ring from it would fabricate an all-failure
 * recent window — the exact false signal this issue removes. The ring fills from
 * real outcomes going forward; until it holds samples, LI's windowed rate is null
 * and the reasoner falls back to the intact lifetime rate.
 *
 * Idempotent: a second run finds every bucket already has a `recentOutcomes`
 * array and the version already at 2, so it writes nothing.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const readJson = async (path, fallback) => {
  const raw = await readFile(path, 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (raw == null) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
};

const writeJson = (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2) + '\n');

export async function up({ rootDir }) {
  const learningPath = join(rootDir, 'data', 'cos', 'learning.json');
  const data = await readJson(learningPath, null);

  // No learning.json yet — a fresh install seeds v2 with empty rings on first
  // completion (DEFAULT_LEARNING_DATA + bucket init in metrics.js). Nothing to do.
  if (!data || typeof data !== 'object') {
    console.log('📚 cos-learning ring: no learning.json — nothing to migrate (fresh install seeds v2)');
    return { migrated: false, initialized: 0 };
  }

  const byTaskType = data.byTaskType && typeof data.byTaskType === 'object' ? data.byTaskType : {};
  let initialized = 0;
  for (const metrics of Object.values(byTaskType)) {
    if (metrics && typeof metrics === 'object' && !Array.isArray(metrics.recentOutcomes)) {
      metrics.recentOutcomes = [];
      initialized++;
    }
  }

  const bumpedVersion = data.version !== 2;
  if (bumpedVersion) data.version = 2;

  if (initialized > 0 || bumpedVersion) {
    await writeJson(learningPath, data);
    console.log(`📚 cos-learning ring: initialized recentOutcomes on ${initialized} task type(s), version → 2`);
    return { migrated: true, initialized };
  }

  console.log('✅ cos-learning ring: already initialized — no changes');
  return { migrated: false, initialized: 0 };
}

export default { up };
