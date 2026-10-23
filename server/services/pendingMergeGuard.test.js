import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execGit } from '../lib/execGit.js';
import { preparePendingMergeGuard, pendingMergeGuardCurrent } from './pendingMergeGuard.js';

const roots = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture({ fail = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pending-merge-guard-'));
  roots.push(root);
  const repoPath = join(root, 'repo');
  const remote = join(root, 'remote');
  const worktreePath = join(root, 'claim');
  await mkdir(repoPath);
  const git = async (args, cwd = repoPath) => (await execGit(args, cwd)).stdout.trim();
  await git(['init', '-b', 'main']);
  await mkdir(join(repoPath, 'scripts'));
  await writeFile(join(repoPath, 'scripts/pregate.js'), `
const { execFileSync } = require('node:child_process');
for (const arg of process.argv.slice(2)) { switch (arg) {
  case '--guards-only': break;
  case '--merged-with': break;
} }
console.log(JSON.stringify({ args: process.argv.slice(2), memo: process.env.PORTOS_TEST_MEMO, token: process.env.PORTOS_API_TOKEN || null }));
// Stand in for a structural guard which is red only on the combined inputs.
const base = execFileSync('git', ['show', process.argv[4] + ':base-contract'], { encoding: 'utf8' });
if (base.trim() === 'strict' && ${fail}) {
  console.error('FAIL server/routeValidationConventions.test.js > combined route inventory ' + 'ghp_' + 'x'.repeat(24) + ' ' + 'x'.repeat(600));
  process.exitCode = 1;
}
`);
  await writeFile(join(repoPath, 'base-contract'), 'permissive');
  const commit = async message => {
    await git(['add', '.']);
    await git(['-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-m', message]);
    return git(['rev-parse', 'HEAD']);
  };
  await commit('initial');
  await git(['clone', '--bare', repoPath, remote], root);
  await git(['remote', 'add', 'origin', remote]);
  await git(['worktree', 'add', '-b', 'claim/issue-1', worktreePath]);
  const headSha = await git(['rev-parse', 'HEAD'], worktreePath);
  await writeFile(join(repoPath, 'base-contract'), 'strict');
  const baseSha = await commit('stricter base');
  await git(['push', 'origin', 'main']);
  return { repoPath, worktreePath, headSha, baseSha, git,
    input: { app: { repoPath }, entry: { prBranch: 'claim/issue-1' }, binding: { headSha, worktreePath },
      prView: { headRefOid: headSha, baseRefName: 'main' }, readDefault: async () => ({ name: 'main', sha: baseSha }) } };
}

describe('pending merged-tree validation', () => {
  it('requires checkout recovery for a supported repository without a handoff instead of bypassing guards', async () => {
    const { input, headSha } = await fixture();
    expect(await preparePendingMergeGuard({ ...input, binding: null })).toEqual({
      ok: false, reason: 'merged-tree-recovery-required', evidence: { headSha },
    });
  });
  it('fetches the live base, pins both full SHAs, and preserves the clean claim checkout', async () => {
    vi.stubEnv('PORTOS_API_TOKEN', 'example-secret-not-for-tests');
    const { input, git, worktreePath, headSha, baseSha } = await fixture();
    const result = await preparePendingMergeGuard(input);
    expect(result).toMatchObject({ ok: true, evidence: { headSha, baseSha, baseBranch: 'main' } });
    const log = await readFile(result.evidence.logPath, 'utf8');
    expect(log).toContain(JSON.stringify({ args: ['--guards-only', '--merged-with', baseSha], memo: 'off', token: null }));
    expect(await git(['rev-parse', 'HEAD'], worktreePath)).toBe(headSha);
    expect(await git(['status', '--porcelain'], worktreePath)).toBe('');
    expect(await pendingMergeGuardCurrent(result.evidence, input.prView, input.readDefault)).toBe(true);
    expect(await pendingMergeGuardCurrent(result.evidence, input.prView, async () => ({ name: 'main', sha: headSha }))).toBe(false);
    expect(await pendingMergeGuardCurrent(result.evidence, { ...input.prView, headRefOid: baseSha }, input.readDefault)).toBe(false);
  });

  it('retains the failing structural test with exact merge inputs and does not alter the claim', async () => {
    const { input, git, worktreePath, headSha, baseSha } = await fixture({ fail: true });
    const result = await preparePendingMergeGuard(input);
    expect(result).toMatchObject({ ok: false, reason: 'merged-tree-guards-failed', evidence: { headSha, baseSha } });
    expect(result.evidence.failedTest).toContain('[REDACTED]');
    expect(result.evidence.failedTest.length).toBeLessThanOrEqual(500);
    expect(await readFile(result.evidence.logPath, 'utf8')).toContain('FAIL server/routeValidationConventions.test.js > combined route inventory');
    expect(await git(['rev-parse', 'HEAD'], worktreePath)).toBe(headSha);
    expect(await git(['status', '--porcelain'], worktreePath)).toBe('');
  });

  it('refuses a dirty or wrong-head checkout before executing its guard', async () => {
    const { input, worktreePath, baseSha } = await fixture();
    const wrongHead = await preparePendingMergeGuard({ ...input, binding: { ...input.binding, headSha: baseSha } });
    expect(wrongHead).toEqual({ ok: false, reason: 'merged-tree-checkout-unverified' });
    await writeFile(join(worktreePath, 'uncommitted'), 'preserve me');
    expect(await preparePendingMergeGuard(input)).toEqual({ ok: false, reason: 'merged-tree-checkout-unverified' });
    expect(await readFile(join(worktreePath, 'uncommitted'), 'utf8')).toBe('preserve me');
  });

  it('identifies a detached handed-off checkout as unverified without running its guard', async () => {
    const { input, git, worktreePath, headSha } = await fixture();
    await git(['checkout', '--detach', headSha], worktreePath);
    expect(await preparePendingMergeGuard(input)).toEqual({ ok: false, reason: 'merged-tree-checkout-unverified' });
  });

  it('leaves an ordinary managed app without the supported command unchanged', async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'ordinary-managed-app-'));
    roots.push(repoPath);
    expect(await preparePendingMergeGuard({ app: { repoPath } })).toEqual({ ok: true, evidence: null });
  });
});
