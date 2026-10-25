import { afterEach, describe, expect, it as vitestIt, vi } from 'vitest';
import { readFile, readdir, writeFile } from 'fs/promises';
import { join } from 'path';

const observation = vi.hoisted(() => ({ commands: [], target: null, before: null, after: null, override: null }));
vi.mock('../lib/execGit.js', async importOriginal => {
  const actual = await importOriginal();
  return {
    ...actual,
    execGit: async (...args) => {
      observation.commands.push(args[0]);
      const target = observation.target?.(args[0]);
      if (target) await observation.before?.();
      const result = await actual.execGit(...args);
      if (target) {
        await observation.after?.(result);
        return observation.override ?? result;
      }
      return result;
    }
  };
});
import { execGit } from '../lib/execGit.js';
import { makeGitSandbox, destroyGitSandbox, SKIP_HEAVY_INTEGRATION } from '../lib/gitTestRepo.js';
import { ownTestBodies } from '../lib/mockPathsDataRoot.js';
import { ensureLatest, rebaseAndPushDefaultBranch, updateDefaultBranch } from './git.js';

const workflows = [
  { name: 'Update App', run: updateDefaultBranch, target: args => args[0] === 'pull' && args.includes('--rebase') },
  { name: 'Rebase and Push', run: rebaseAndPushDefaultBranch, target: args => args[0] === 'rebase' && args.includes('--no-autostash') },
  { name: 'pre-task update', run: ensureLatest, target: args => args[0] === 'rebase' && args[1] === 'origin/main' },
];

// The adapter pauses only at process boundaries; all operation state and edits
// come from real Git children outside the service's process-local mutation lane.
describe.skipIf(SKIP_HEAVY_INTEGRATION)('shared-checkout recovery', () => {
  const owned = ownTestBodies(vitestIt);
  const it = owned.it;
  let sandbox;
  afterEach(async () => {
    try {
      await owned.drain();
    } finally {
      Object.assign(observation, { commands: [], target: null, before: null, after: null, override: null });
      await destroyGitSandbox(sandbox?.scratch);
      sandbox = null;
    }
  });
  const head = async (dir, ref = 'HEAD') => (await execGit(['rev-parse', ref], dir)).stdout.trim();
  const commitFile = async (dir, file, contents) => {
    await writeFile(join(dir, file), contents);
    await execGit(['add', file], dir);
    await execGit(['commit', '-m', `Update ${file}`], dir);
  };
  const prepare = async ({ conflict = true } = {}) => {
    sandbox = await makeGitSandbox({ origin: true });
    const { repo, origin, scratch } = sandbox;
    const other = join(scratch, 'other');
    await execGit(['clone', origin, other], scratch);
    await execGit(['config', 'user.email', 'agent@example.com'], other);
    await execGit(['config', 'user.name', 'Example Agent'], other);
    await execGit(['config', 'commit.gpgsign', 'false'], other);
    await commitFile(other, conflict ? 'initial.txt' : 'remote.txt', 'remote change\n');
    await execGit(['push', 'origin', 'main'], other);
    await commitFile(repo, conflict ? 'initial.txt' : 'local.txt', 'local change\n');
    observation.commands = [];
    return repo;
  };
  const operationBytes = async repo => {
    const dir = join(repo, '.git', 'rebase-merge');
    const names = (await readdir(dir)).sort();
    return Promise.all(names.map(async name => [name, await readFile(join(dir, name))]));
  };
  const expectNoRecoveryOrPush = () => {
    expect(observation.commands).not.toContainEqual(['rebase', '--abort']);
    expect(observation.commands.some(args => ['reset', 'push', 'stash'].includes(args[0]))).toBe(false);
  };

  for (const workflow of workflows) {
    for (const boundary of ['before command', 'replacement after failure', 'resolution after failure']) {
      it(`${workflow.name} preserves external state and resolution bytes at ${boundary}`, async () => {
        const repo = await prepare();
        const [local, remote] = await Promise.all([head(repo), head(sandbox.origin)]);
        const { execGit: externalGit } = await vi.importActual('../lib/execGit.js');
        const resolution = Buffer.from('unfinished resolution\r\nno final newline');
        let operation;
        let index;
        const interfere = async () => {
          if (boundary === 'replacement after failure') await externalGit(['rebase', '--abort'], repo);
          if (boundary !== 'resolution after failure') {
            await externalGit(['fetch', 'origin'], repo);
            const result = await externalGit(['rebase', 'origin/main'], repo, { ignoreExitCode: true });
            expect(result.exitCode).not.toBe(0);
          }
          // After settlement, retain both staged resolution and newer unsaved work.
          if (boundary !== 'before command') {
            await writeFile(join(repo, 'initial.txt'), 'staged resolution\n');
            await externalGit(['add', 'initial.txt'], repo);
          }
          await writeFile(join(repo, 'initial.txt'), resolution);
          operation = await operationBytes(repo);
          index = await readFile(join(repo, '.git', 'index'));
        };
        observation.target = workflow.target;
        if (boundary === 'before command') observation.before = interfere;
        else observation.after = async result => {
          expect(result.exitCode).not.toBe(0);
          await interfere();
        };
        const result = await workflow.run(repo);
        expect(result).toMatchObject({ success: false, error: expect.stringContaining('preserved') });
        if (workflow.run === rebaseAndPushDefaultBranch) expect(result.pushed).toBe(false);
        expect(await readFile(join(repo, 'initial.txt'))).toEqual(resolution);
        expect(await operationBytes(repo)).toEqual(operation);
        expect(await readFile(join(repo, '.git', 'index'))).toEqual(index);
        expect(await head(repo, 'refs/heads/main')).toBe(local);
        expect(await head(sandbox.origin)).toBe(remote);
        expectNoRecoveryOrPush();
      });
    }

    it(`${workflow.name} preserves stopped state on a terminated process result`, async () => {
      const repo = await prepare();
      const remote = await head(sandbox.origin);
      let operation;
      observation.target = workflow.target;
      observation.after = async result => {
        expect(result.exitCode).not.toBe(0);
        operation = await operationBytes(repo);
      };
      // Runner termination can have empty streams; stderr keywords do not
      // establish successful completion or permission to mutate recovery state.
      observation.override = { exitCode: null, terminated: true, signal: 'SIGTERM', stdout: '', stderr: '' };
      expect(await workflow.run(repo)).toMatchObject({ success: false, error: expect.stringContaining('preserved') });
      expect(await operationBytes(repo)).toEqual(operation);
      expect(await head(sandbox.origin)).toBe(remote);
      expectNoRecoveryOrPush();
    });

    it(`${workflow.name} still reconciles nonconflicting divergence`, async () => {
      const repo = await prepare({ conflict: false });
      expect(await workflow.run(repo)).toMatchObject({ success: true });
      expect(await readFile(join(repo, 'local.txt'), 'utf8')).toBe('local change\n');
      expect(await readFile(join(repo, 'remote.txt'), 'utf8')).toBe('remote change\n');
    });
  }

  it('Update App retains the autostash and supports explicit abort after a conflict', async () => {
    const repo = await prepare();
    const local = await head(repo);
    const dirty = Buffer.from('tracked dirty bytes\r\nwithout final newline');
    await writeFile(join(repo, 'dirty.txt'), dirty);
    await execGit(['add', 'dirty.txt'], repo);
    expect(await updateDefaultBranch(repo)).toMatchObject({ success: false, conflict: true });
    const stash = (await readFile(join(repo, '.git', 'rebase-merge', 'autostash'), 'utf8')).trim();
    expect((await execGit(['show', `${stash}:dirty.txt`], repo, { bufferOutput: true })).stdout).toEqual(dirty);
    expectNoRecoveryOrPush();
    const { execGit: externalGit } = await vi.importActual('../lib/execGit.js');
    await externalGit(['rebase', '--abort'], repo);
    expect(await head(repo)).toBe(local);
    expect(await readFile(join(repo, 'dirty.txt'))).toEqual(dirty);
  });
});
