import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdir, writeFile } from 'fs/promises';
import { rmSync } from 'fs';
import { join } from 'path';
import { execGit } from '../lib/execGit.js';
import { makeGitSandbox, destroyGitSandbox, SKIP_HEAVY_INTEGRATION } from '../lib/gitTestRepo.js';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { isDependencyReconcilePending } from '../../scripts/lib/dependencyReconcile.js';

const injected = vi.hoisted(() => ({ repo: null, data: `${process.env.TMPDIR || '/tmp'}/portos-reconcile-${process.pid}-${Date.now()}` }));
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => injected.data, extraOverrides: () => ({ root: injected.repo }) }));

const { ensureLatest } = await import('./git.js');

// A fast-forward of the PortOS source checkout onto new lockfiles must queue a
// dependency reconcile (#17511); a fast-forward that leaves them alone must not.
describe.skipIf(SKIP_HEAVY_INTEGRATION)('ensureLatest dependency reconcile marker', () => {
  let sandbox;
  afterEach(async () => {
    if (sandbox) await destroyGitSandbox(sandbox.scratch);
    sandbox = null;
    rmSync(injected.data, { recursive: true, force: true });
  });

  const advanceOrigin = async (file, body) => {
    sandbox = await makeGitSandbox({ origin: true });
    const { scratch, repo, origin } = sandbox;
    injected.repo = repo;
    rmSync(injected.data, { recursive: true, force: true });
    await execGit(['push', '-u', 'origin', 'main'], repo, { ignoreExitCode: true });
    const other = join(scratch, 'other');
    await execGit(['clone', origin, other], scratch);
    await execGit(['config', 'user.email', 'agent@example.com'], other);
    await execGit(['config', 'user.name', 'Example Agent'], other);
    await mkdir(join(other, file, '..'), { recursive: true });
    await writeFile(join(other, file), body);
    await execGit(['add', file], other);
    await execGit(['commit', '-m', 'origin change'], other);
    await execGit(['push', 'origin', 'HEAD:main'], other);
    return repo;
  };

  it('queues a reconcile when the fast-forward changes a workspace lockfile', async () => {
    const repo = await advanceOrigin('server/package-lock.json', '{}\n');
    expect(await ensureLatest(repo)).toMatchObject({ success: true });
    expect(isDependencyReconcilePending(injected.data)).toBe(true);
  });

  it('does not queue one when the lockfiles are untouched', async () => {
    const repo = await advanceOrigin('notes.txt', 'hello\n');
    expect(await ensureLatest(repo)).toMatchObject({ success: true });
    expect(isDependencyReconcilePending(injected.data)).toBe(false);
  });
});
