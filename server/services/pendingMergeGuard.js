import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import { execFile } from '../lib/childProcess.js';
import { execGit } from '../lib/execGit.js';
import { scrubSecretTokens } from '../lib/secretText.js';
import { redactPii } from '../lib/piiRedactionPatterns.js';

const run = promisify(execFile);
const SHA = /^[0-9a-f]{40}$/;
const SCRIPT = 'scripts/pregate.js';
const GUARD_ENV_KEYS = new Set([
  'PATH', 'Path', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'SystemRoot', 'SystemDrive',
  'ComSpec', 'PATHEXT', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LANGUAGE', 'TZ', 'PORTOS_PREGATE_MAX_WORKERS',
]);
const readOptional = path => readFile(path, 'utf8').catch(error => {
  if (error.code === 'ENOENT') return null;
  throw error;
});

export const summarizeMergeGuardOutput = text => redactPii(scrubSecretTokens(stripVTControlCharacters(String(text))))
  .replace(/\s+/g, ' ').trim().slice(0, 500);

// Capability, not upstream slug: forks inherit the guard, ordinary managed apps
// and older PortOS checkouts without merged-tree support keep their behavior.
async function supportsPendingMergeGuard(repoPath) {
  const source = await readOptional(resolve(repoPath, SCRIPT));
  return source !== null && source.includes("case '--guards-only':") && source.includes("case '--merged-with':");
}

export async function verifyPendingMergeCheckout(repoPath, worktreePath, branch, headSha) {
  if (!worktreePath || resolve(repoPath) === resolve(worktreePath)) return false;
  const read = async (args, cwd = worktreePath) => (await execGit(args, cwd)).stdout.trim();
  // Drain sibling Git processes even if a probe rejects (such as detached
  // HEAD); their live cwd handles can otherwise block checkout retirement.
  const checked = await Promise.allSettled([
    read(['rev-parse', '--path-format=absolute', '--git-common-dir']),
    read(['rev-parse', '--path-format=absolute', '--git-common-dir'], repoPath),
    read(['rev-parse', '--verify', 'HEAD^{commit}']),
    read(['symbolic-ref', '--quiet', '--short', 'HEAD']),
    read(['status', '--porcelain=v1', '--untracked-files=all']),
  ]);
  if (checked.some(result => result.status === 'rejected')) return false;
  const [common, primaryCommon, head, ref, status] = checked.map(result => result.value);
  return common === primaryCommon && head === headSha && ref === branch && !status;
}

/** Runs only on the handed-off, reviewed checkout, before acquiring admission. */
export async function preparePendingMergeGuard({ app, entry, binding, prView, readDefault, env }) {
  if (!await supportsPendingMergeGuard(app.repoPath)) return { ok: true, evidence: null };
  if (!binding) return { ok: false, reason: 'merged-tree-recovery-required', evidence: { headSha: prView.headRefOid } };
  const worktreePath = binding.worktreePath;
  const headSha = binding?.headSha;
  if (!SHA.test(headSha || '') || prView.headRefOid !== headSha
    || !await verifyPendingMergeCheckout(app.repoPath, worktreePath, entry.prBranch, headSha)) {
    return { ok: false, reason: 'merged-tree-checkout-unverified' };
  }
  if (!await supportsPendingMergeGuard(worktreePath)) return { ok: false, reason: 'merged-tree-command-unavailable' };
  const base = await readDefault();
  if (!base || !SHA.test(base.sha)) return { ok: false, reason: 'merged-tree-default-branch-unavailable' };
  if (prView.baseRefName !== base.name) {
    return { ok: false, reason: 'merged-tree-default-branch-unverified' };
  }
  // Fetch the named ref, then pin the command to the fetched object. Concurrent
  // fetches cannot silently replace the base whose evidence we record.
  await execGit(['fetch', '--no-tags', 'origin', `refs/heads/${base.name}`], worktreePath, { env, timeout: 60000 });
  const fetched = (await execGit(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], worktreePath)).stdout.trim();
  if (fetched !== base.sha) return { ok: false, reason: 'merged-tree-base-moved' };
  const gitPath = (await execGit(['rev-parse', '--git-path', `portos-merged-guards-${headSha}-${base.sha}.log`], worktreePath)).stdout.trim();
  const evidence = { headSha, baseSha: base.sha, baseBranch: base.name, logPath: resolve(worktreePath, gitPath) };
  const result = await run(process.execPath, [SCRIPT, '--guards-only', '--merged-with', base.sha], {
    cwd: worktreePath, env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => GUARD_ENV_KEYS.has(key) || key.startsWith('LC_'))),
      PORTOS_TEST_MEMO: 'off',
    },
    timeout: 15 * 60 * 1000, maxBuffer: 16 * 1024 * 1024,
  }).then(value => ({ ...value, ok: true }), error => ({
    ok: false, stdout: error.stdout || '', stderr: error.stderr || error.message,
  }));
  await writeFile(evidence.logPath, `HEAD ${headSha}\nBASE ${base.sha}\n${result.stdout}\n${result.stderr}`, { mode: 0o600 });
  if (!result.ok) {
    const failedTest = stripVTControlCharacters(`${result.stdout}\n${result.stderr}`).match(/\bFAIL\s+([^\r\n]+)/)?.[1];
    return { ok: false, reason: 'merged-tree-guards-failed', evidence: {
      ...evidence, failedTest: failedTest ? summarizeMergeGuardOutput(failedTest) : null,
    } };
  }
  if (!await verifyPendingMergeCheckout(app.repoPath, worktreePath, entry.prBranch, headSha)) {
    return { ok: false, reason: 'merged-tree-checkout-changed', evidence };
  }
  return { ok: true, evidence };
}

/** Live reads happen inside admission; stale evidence never grants a merge. */
export async function pendingMergeGuardCurrent(evidence, prView, readDefault) {
  if (!evidence) return true;
  if (prView.headRefOid !== evidence.headSha || prView.baseRefName !== evidence.baseBranch) return false;
  const base = await readDefault();
  return base?.name === evidence.baseBranch && base.sha === evidence.baseSha;
}
