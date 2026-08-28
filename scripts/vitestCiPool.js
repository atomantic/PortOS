/**
 * Vitest worker caps for GitHub Actions. Standard Linux runners for public
 * repositories are 4 vCPU / 16GB; uncapped forks oversubscribe those cores
 * during transform and swap.
 * Local `npm test` stays unbounded so a developer machine can use every core.
 *
 * fileParallelism stays at Vitest's default (true): four workers stay busy on
 * independent files. The DB suite already serializes files because those
 * tests share one Postgres.
 *
 * Vitest 4 exposes `maxWorkers` only — there is no `minWorkers` / `minThreads`.
 */
export function vitestCiPool({ maxWorkers = 4 } = {}) {
  if (!process.env.CI) return {};
  return { maxWorkers };
}
