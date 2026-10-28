import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { _createInitializedCheckoutRecovery } from './initializedCheckoutRecovery.js';
import { execGit } from '../lib/execGit.js';

describe.skipIf(process.platform !== 'darwin')('locked initialized retirement', () => {
  it.each(['success', 'interruption'])('preserves private module data for a synthetic candidate: %s', async scenario => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'locked-initialized-fixture-')));
    const repo = join(root, 'repo'), module = join(root, 'module'), checkout = join(root, 'checkout');
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    try {
      for (const dir of [repo, module]) {
        await mkdir(dir); git(dir, 'init', '-b', 'main');
        await writeFile(join(dir, 'file'), 'fixture\n'); git(dir, 'add', '.'); git(dir, 'commit', '-m', 'fixture');
      }
      git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', pathToFileURL(module).href, 'sub');
      git(repo, 'commit', '-am', 'module');
      git(repo, 'worktree', 'add', '-b', 'candidate', checkout);
      git(checkout, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init');
      const privateHead = git(join(checkout, 'sub'), 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'private fixture');
      git(join(checkout, 'sub'), 'update-ref', 'refs/private/fixture', privateHead);
      git(repo, 'worktree', 'lock', '--reason', 'fixture held', checkout);
      const head = git(checkout, 'rev-parse', 'HEAD');
      const release = { path: checkout, branch: 'candidate', head, locked: true, lockReason: 'fixture held' };
      const prUrl = 'https://github.com/example/repo/pull/1';
      const service = _createInitializedCheckoutRecovery({ root: () => join(root, 'transactions'),
        fenced: work => work(), context: async () => ({ repoPath: repo }), ownership: async () => ({ ok: true, policy: null }),
        forge: async () => ({ prUrl, prHead: head, mergeCommit: 'c'.repeat(40), defaultHead: head }),
        comparison: async (_ctx, current, _url, _snapshot, policy, forge) => ({ release: current, forge, policy,
          comparison: { disposition: 'integrated', difference: '' } }),
        retainReleaseSynchronizationReview: async () => true, prepareLegacyReleaseRetirement: async () => new Map(),
        validateLegacyReleaseRetirement: async () => true, validateLockedPublisherRetirement: async () => true,
        execGit: async (args, cwd, options) => scenario === 'interruption' && args[0] === 'worktree' && args[1] === 'remove'
          ? { exitCode: 1, stdout: '' } : execGit(args, cwd, options),
        deleteRef: async () => { git(repo, 'update-ref', '-d', 'refs/heads/candidate', head); return true; },
        recordRetirement: async (_app, row) => ({ retired: [{ ...row, archiveDir: null }] }),
      });
      const preview = await service.review({ appId: 'fixture', release, prUrl });
      expect(preview.ok, JSON.stringify(preview)).toBe(true);
      const retired = await service.retire({ appId: 'fixture', release, review: { prUrl, digest: preview.review.digest } });
      if (scenario === 'success') {
        expect(retired.ok, JSON.stringify(retired)).toBe(true);
        expect(retired.branchDeleted).toBe(true);
      } else {
        expect(retired).toMatchObject({ ok: false, reason: 'checkout-removal-uncertain' });
        const row = (await service.discover()).transactions.find(value => value.transactionId === retired.transactionId);
        const recovered = await service.recoverAutomatically({ appId: 'fixture', transactionId: row.transactionId,
          journalDigest: row.journalDigest }, { blocked: async () => null });
        expect(recovered.ok, JSON.stringify(recovered)).toBe(true);
        expect(git(repo, 'worktree', 'list', '--porcelain')).toContain('locked fixture held');
        expect(git(join(checkout, 'sub'), 'rev-parse', 'refs/private/fixture')).toBe(privateHead);
      }
      const saved = await readFile(join(root, 'transactions', retired.transactionId, 'archive', 'administration', 'modules', 'sub', 'refs', 'private', 'fixture'), 'utf8');
      expect(saved.trim()).toBe(privateHead);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 120000);
});
