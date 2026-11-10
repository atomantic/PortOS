/**
 * Pinned actionlint: the GitHub Actions workflow linter CI and pregate share.
 *
 * GitHub silently skips a workflow it rejects (a `runner` context in job-level
 * `env`, say), so a bad file merges unnoticed. actionlint catches that class
 * before push. The version and the linux/amd64 archive SHA-256 are pinned here
 * and mirrored literally in .github/workflows/ci.yml; the parity test in
 * scripts/run-actionlint.test.js keeps the two in step.
 *
 * Builtins only: ci-test-plan.js imports this before `npm ci` runs.
 */
import { spawnSync } from 'node:child_process';

export const ACTIONLINT_VERSION = '1.7.12';
export const ACTIONLINT_SHA256_LINUX_AMD64 = '8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8';
export const WORKFLOW_FILE_RE = /^\.github\/workflows\/[^/]+\.ya?ml$/;

/** Repo-relative workflow files among a changed-file list. */
export function selectWorkflowFiles(repoFiles) {
  return repoFiles.filter((path) => WORKFLOW_FILE_RE.test(path));
}

/** The version from `actionlint -version`, whose first line is the bare number. */
export function parseActionlintVersion(output) {
  const first = String(output ?? '').trim().split(/\r?\n/)[0]?.trim() ?? '';
  return /^\d+\.\d+\.\d+$/.test(first) ? first : null;
}

function defaultRun(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return result.error || result.status !== 0 ? null : result.stdout;
}

/**
 * Can this machine run the pinned linter the way CI does? Pure given `run`.
 *
 * Requires the exact pinned version, because a different actionlint can accept
 * or reject a file CI would not. Also requires shellcheck on PATH: actionlint
 * runs its shell checks through it and silently skips them without it, so a
 * green local run would not match CI's `release.yml` findings.
 */
export function probeActionlint({ env = process.env, run = defaultRun } = {}) {
  const bin = env.ACTIONLINT_BIN || 'actionlint';
  const version = parseActionlintVersion(run(bin, ['-version']));
  if (version === null) {
    return { ok: false, bin, reason: `no actionlint at ${env.ACTIONLINT_BIN ? 'ACTIONLINT_BIN' : 'PATH'} (need ${ACTIONLINT_VERSION})` };
  }
  if (version !== ACTIONLINT_VERSION) {
    return { ok: false, bin, reason: `found actionlint ${version}, not the pinned ${ACTIONLINT_VERSION}` };
  }
  if (run('shellcheck', ['--version']) === null) {
    return { ok: false, bin, reason: 'shellcheck is not on PATH (actionlint runs its shell checks through it)' };
  }
  return { ok: true, bin, version };
}
