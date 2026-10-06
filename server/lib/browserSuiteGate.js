/**
 * Keep cross-workspace browser suites as visible skips on machines without
 * Chrome, ffmpeg or the client workspace, while letting the one CI job that
 * provisions them fail fast instead of passing green on a skip.
 *
 * `prerequisites` maps a human label to whatever was discovered (a path, a
 * resolved bundler list, or undefined/null when absent). `onUnavailable` runs
 * before the skip or the throw: prerequisite discovery can initialize mocked
 * path fixtures, and Vitest runs no cleanup hooks for a skipped (or failed) file.
 */
export function browserSuiteCanRun(label, prerequisites, { onUnavailable } = {}) {
  const missing = Object.entries(prerequisites).filter(([, found]) => !found).map(([name]) => name);
  if (missing.length === 0) return true;

  onUnavailable?.();
  const reason = `missing ${missing.join(', ')}`;
  if (process.env.PORTOS_REQUIRE_BROWSER_SUITES) {
    throw new Error(`${label}: browser suite skipped but PORTOS_REQUIRE_BROWSER_SUITES is set — ${reason}`);
  }

  console.log(`⏭️ ${label}: skipping suite — ${reason}`);
  return false;
}
