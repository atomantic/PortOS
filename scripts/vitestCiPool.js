/**
 * Vitest worker caps for GitHub Actions. Standard hosted runners are 2 vCPU /
 * 7GB; uncapped forks oversubscribe those cores during transform and swap.
 * Local `npm test` stays unbounded so a developer machine can use every core.
 *
 * fileParallelism stays at Vitest's default (true): two workers stay busy on
 * independent files. The DB suite already serializes files because those
 * tests share one Postgres.
 *
 * Vitest 4 exposes `maxWorkers` only — there is no `minWorkers` / `minThreads`.
 */
export function vitestCiPool() {
  if (!process.env.CI) return {};
  return { maxWorkers: 2 };
}
