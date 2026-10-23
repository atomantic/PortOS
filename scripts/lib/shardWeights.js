/**
 * Time-weighted CI shard assignment for suites where a few files dominate.
 *
 * Vitest's hash slicing (`vitestShardSlice` in testMemoRunner.js) gives every
 * shard the same file COUNT, so on Windows — where the git-spawning worktree
 * suites run ~8x slower than on Linux — whichever shard the hash hands the big
 * files finishes minutes after the others (measured: 1067s / 610s / 696s of
 * file time across three shards, a 35% overrun on the slowest). Every shard
 * computes the same assignment from the same full file list, so the result is
 * still an exact partition; only the split is weighted.
 *
 * Weights are measured seconds of file time on a `windows-latest` shard
 * (October 2026 full runs). They only need to be roughly right: a stale entry
 * costs balance, never coverage, and a file that no longer exists is ignored
 * (`shardWeights.test.js` fails on one so a rename does not silently rot).
 */

import { createHash } from 'node:crypto';

/** Repo-relative path -> seconds of file time on a Windows runner. */
export const WINDOWS_SERVER_HEAVY_FILES = Object.freeze({
  'server/services/heldCheckoutRecovery.test.js': 182,
  'server/services/branchReconcile.ownership.test.js': 106,
  'server/services/worktreeReap.test.js': 79,
  'server/services/mediaJobQueue/index.test.js': 68,
  'server/lib/primaryCheckoutGuard.test.js': 63,
  'server/services/worktreeExternalCleanup.test.js': 40,
  'scripts/run-ci-tests.test.js': 39,
  'scripts/pregate.test.js': 38,
  'server/lib/detachedSpawn.test.js': 37,
  'scripts/ci-test-plan.test.js': 32,
  'server/services/git.mergePR.test.js': 23,
  'server/routes/musicVideoProductionReview.test.js': 21,
  'server/services/backup.test.js': 18,
  'server/services/sharing/integration.test.js': 17,
  'server/services/musicVideo/castAndSetsService.test.js': 16,
  'server/services/worktreeManager.recovery.test.js': 16,
  'server/services/musicVideo/projects.test.js': 15,
  'server/services/worktreeManager.defaultHead.test.js': 15,
  'server/services/worktreeManager.releaseNextHolder.test.js': 15,
  'server/services/codeAnimation/export.test.js': 15,
  'server/services/worktreeManager.forceRemove.test.js': 15,
  'server/services/worktreeManager.fork.test.js': 14,
  'server/services/initializedCheckoutRecovery.test.js': 14,
  'server/services/deepAudit.workspace.test.js': 14,
  'server/services/worktreeManager.releaseOwnerlessHolder.test.js': 14,
  'server/services/worktreeManager.pinnedHead.test.js': 13,
  'server/services/git.ensureLatest.test.js': 12,
});

/** Mean seconds of an unlisted file on the same runner (the rest of the suite over its file count). */
const WINDOWS_SERVER_REST_SECONDS = 0.43;

/**
 * The weights for a runner, or null to keep Vitest's hash slicing.
 *
 * Linux shards stay on the hash split: their files are within ~10% of each
 * other's wall time, so a table there would be upkeep for no measurable gain.
 *
 * @param {string} scope
 * @param {string} platform
 * @returns {{heavy: Record<string, number>, rest: number}|null}
 */
export function shardWeightsFor(scope, platform) {
  return scope === 'server' && platform === 'win32'
    ? { heavy: WINDOWS_SERVER_HEAVY_FILES, rest: WINDOWS_SERVER_REST_SECONDS }
    : null;
}

const byHash = (hashOf) => (a, b) => {
  const left = hashOf(a);
  const right = hashOf(b);
  return left < right ? -1 : left > right ? 1 : 0;
};

/**
 * Largest-remainder rounding of non-negative `shares` to integers summing to `total`.
 * Ties go to the lower index so every shard derives the same answer.
 */
function apportion(shares, total) {
  const floors = shares.map(Math.floor);
  let left = total - floors.reduce((sum, n) => sum + n, 0);
  const order = shares.map((share, i) => ({ i, frac: share - floors[i] }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i] += 1;
    left -= 1;
  }
  return floors;
}

/**
 * The files shard `index` of `count` runs under `weights`.
 *
 * Known-heavy files go largest-first to the least-loaded shard; the remaining
 * files keep the hash order and are cut into contiguous runs sized so every
 * shard's total (heavy load + rest count x rest weight) lands on the mean.
 * Deterministic and input-only, so the shards agree without coordinating.
 *
 * @param {string[]} files full selected list (repo-relative)
 * @param {object} options
 * @param {(rel: string) => string} options.hashInput the string Vitest would hash for a file
 */
export function weightedShardSlice(files, { index, count, weights, hashInput }) {
  const hashOf = (rel) => createHash('sha1').update(hashInput(rel)).digest('hex');
  const heavy = files.filter((rel) => weights.heavy[rel] > 0)
    .sort((a, b) => weights.heavy[b] - weights.heavy[a] || (a < b ? -1 : 1));
  const rest = files.filter((rel) => !(weights.heavy[rel] > 0)).sort(byHash(hashOf));

  const loads = new Array(count).fill(0);
  const mine = [];
  for (const rel of heavy) {
    const target = loads.indexOf(Math.min(...loads));
    loads[target] += weights.heavy[rel];
    if (target === index - 1) mine.push(rel);
  }

  // Seconds each shard can still take to reach the mean, in rest-file units.
  // A shard already past the mean takes none and the others share its excess.
  const mean = (loads.reduce((sum, n) => sum + n, 0) + rest.length * weights.rest) / count;
  const room = loads.map((load) => Math.max(0, (mean - load) / weights.rest));
  const roomTotal = room.reduce((sum, n) => sum + n, 0);
  const shares = roomTotal > 0
    ? room.map((n) => (n / roomTotal) * rest.length)
    : room.map(() => rest.length / count);
  const quotas = apportion(shares, rest.length);

  const start = quotas.slice(0, index - 1).reduce((sum, n) => sum + n, 0);
  return [...mine, ...rest.slice(start, start + quotas[index - 1])];
}
