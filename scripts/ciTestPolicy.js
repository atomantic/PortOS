import { fileURLToPath } from 'node:url';

// The workflow opts in only for a frozen, same-repository release candidate.
// A full ordinary PR, nightly, local run, or release push retains bail=1.
export function releaseCandidateDiagnostics(env = process.env) {
  if (!env.PORTOS_CI_TEST_POLICY) return false;
  if (env.PORTOS_CI_TEST_POLICY !== 'release-candidate'
    || env.GITHUB_EVENT_NAME !== 'pull_request' || env.GITHUB_BASE_REF !== 'release'
    || !env.GITHUB_HEAD_REF?.startsWith('codex/release-')
    || !env.GITHUB_REPOSITORY || env.PORTOS_CI_HEAD_REPOSITORY !== env.GITHUB_REPOSITORY) {
    throw new Error('Release-candidate diagnostics require a same-repository frozen candidate PR into release.');
  }
  return true;
}

export function ciTestConfig(env = process.env) {
  return env.PORTOS_CI_COLLECTION === '1'
    ? { runner: fileURLToPath(new URL('./vitestCandidateRunner.js', import.meta.url)) } : {};
}
