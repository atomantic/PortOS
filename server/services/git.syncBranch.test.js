import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

const observation = vi.hoisted(() => ({ commands: [], beforePull: null, afterPull: null, pullOverride: null, pullExitCode: null }));
vi.mock('../lib/execGit.js', async importOriginal => {
  const actual = await importOriginal();
  return {
    ...actual,
    execGit: async (...args) => {
      observation.commands.push(args[0]);
      if (args[0][0] === 'pull') await observation.beforePull?.();
      const result = await actual.execGit(...args);
      if (args[0][0] === 'pull') {
        observation.pullExitCode = result.exitCode;
        await observation.afterPull?.();
        return observation.pullOverride ?? result;
      }
      return result;
    }
  };
});
import { execGit } from '../lib/execGit.js';
import { makeGitSandbox, destroyGitSandbox, SKIP_HEAVY_INTEGRATION } from '../lib/gitTestRepo.js';
import { checkout, syncBranch } from './git.js';

// Real Git pins autostash preservation and ownership across the entire Sync.
describe.skipIf(SKIP_HEAVY_INTEGRATION)('branch Sync', () => {
  let sandbox;
  afterEach(async () => {
    observation.beforePull = null;
    observation.afterPull = null;
    observation.pullOverride = null;
    observation.pullExitCode = null;
    observation.commands = [];
    await destroyGitSandbox(sandbox?.scratch);
    sandbox = null;
  });
  const head = async dir => (await execGit(['rev-parse', 'HEAD'], dir)).stdout.trim();
  const commitFile = async (dir, file, contents) => {
    await writeFile(join(dir, file), contents);
    await execGit(['add', file], dir);
    await execGit(['commit', '-m', `Update ${file}`], dir);
  };
  const prepare = async ({ conflict = false, localCommit = true } = {}) => {
    sandbox = await makeGitSandbox({ origin: true });
    const { repo, origin, scratch } = sandbox;
    const other = join(scratch, 'other');
    await execGit(['clone', origin, other], scratch);
    await execGit(['config', 'user.email', 'agent@example.com'], other);
    await execGit(['config', 'user.name', 'Example Agent'], other);
    await execGit(['config', 'commit.gpgsign', 'false'], other);
    await commitFile(other, conflict ? 'initial.txt' : 'remote.txt', 'remote change\n');
    await execGit(['push', 'origin', 'main'], other);
    if (localCommit) await commitFile(repo, conflict ? 'initial.txt' : 'local.txt', 'local change\n');
    observation.commands = [];
    return repo;
  };

  it('publishes reconciled commits and preserves dirty work while refusing concurrent mutations', async () => {
    const repo = await prepare();
    await writeFile(join(repo, 'initial.txt'), 'uncommitted work\n');
    let markPulled;
    let releasePull;
    const pulled = new Promise(resolve => { markPulled = resolve; });
    const proceed = new Promise(resolve => { releasePull = resolve; });
    observation.afterPull = () => { markPulled(); return proceed; };
    const syncing = syncBranch(repo, 'main');
    await pulled;
    try {
      await expect(syncBranch(repo, 'main')).rejects.toMatchObject({ code: 'GIT_BUSY' });
      await expect(checkout(repo, 'feature/work')).rejects.toMatchObject({ code: 'GIT_BUSY' });
    } finally {
      releasePull();
      await syncing;
    }
    expect(await syncing).toMatchObject({ success: true, pulled: true, pushed: true });
    expect(await head(repo)).toBe(await head(sandbox.origin));
    expect(await readFile(join(repo, 'initial.txt'), 'utf8')).toBe('uncommitted work\n');
    expect(await readFile(join(repo, 'local.txt'), 'utf8')).toBe('local change\n');
    expect(await readFile(join(repo, 'remote.txt'), 'utf8')).toBe('remote change\n');
    observation.afterPull = null;
    expect(await syncBranch(repo, 'main')).toMatchObject({ success: true });
  });

  it('preserves a conflicting rebase and its autostash for explicit recovery without pushing', async () => {
    const repo = await prepare({ conflict: true });
    await writeFile(join(repo, 'dirty.txt'), 'tracked work\n');
    await execGit(['add', 'dirty.txt'], repo);
    const [local, remote] = await Promise.all([head(repo), head(sandbox.origin)]);
    observation.commands = [];
    expect(await syncBranch(repo, 'main')).toMatchObject({ success: false, pulled: false, pushed: false, error: expect.stringMatching(/CONFLICT|could not apply/) });
    expect(observation.commands).not.toContainEqual(['rebase', '--abort']);
    expect(existsSync(join(repo, '.git', 'rebase-merge'))).toBe(true);
    const stash = (await readFile(join(repo, '.git', 'rebase-merge', 'autostash'), 'utf8')).trim();
    expect((await execGit(['show', `${stash}:dirty.txt`], repo, { bufferOutput: true })).stdout).toEqual(Buffer.from('tracked work\n'));
    // Explicit recovery still restores the original head and stashed bytes.
    await execGit(['rebase', '--abort'], repo);
    expect(observation.commands.some(args => args[0] === 'push')).toBe(false);
    expect(await head(repo)).toBe(local);
    expect(await head(sandbox.origin)).toBe(remote);
    expect(existsSync(join(repo, '.git', 'rebase-merge'))).toBe(false);
    expect(await readFile(join(repo, 'dirty.txt'), 'utf8')).toBe('tracked work\n');
  });

  it('preserves zero-exit autostash conflicts and their saved stash without pushing', async () => {
    const repo = await prepare({ conflict: true, localCommit: false });
    await writeFile(join(repo, 'initial.txt'), 'uncommitted local change\n');
    const remote = await head(sandbox.origin);
    observation.commands = [];
    expect(await syncBranch(repo, 'main')).toMatchObject({ success: false, pulled: false, pushed: false, error: expect.stringContaining('autostashed local changes conflicted') });
    expect(observation.pullExitCode).toBe(0);
    expect(observation.commands.some(args => args[0] === 'push' || args[0] === 'rebase')).toBe(false);
    expect((await execGit(['diff', '--name-only', '--diff-filter=U'], repo)).stdout.trim()).toBe('initial.txt');
    expect((await execGit(['stash', 'show', '-p'], repo)).stdout).toContain('uncommitted local change');
    expect(await readFile(join(repo, 'initial.txt'), 'utf8')).toContain('uncommitted local change');
    expect(await head(sandbox.origin)).toBe(remote);
  });

  it('preserves recovery state after an interrupted pull', async () => {
    const repo = await prepare({ conflict: true });
    const remote = await head(sandbox.origin);
    observation.pullOverride = { exitCode: null, signal: 'SIGTERM', terminated: true, stdout: '', stderr: '' };
    observation.commands = [];
    expect(await syncBranch(repo, 'main')).toMatchObject({ success: false, pushed: false, error: expect.stringMatching(/Pull failed.*preserved/) });
    expect(observation.commands.some(args => args[0] === 'rebase' || args[0] === 'push')).toBe(false);
    expect(existsSync(join(repo, '.git', 'rebase-merge'))).toBe(true);
    expect(await head(sandbox.origin)).toBe(remote);
  });

  it.each(['before pull', 'after failed pull', 'after failed pull with same operation'])(
    "preserves an external actor's operation and raw resolution bytes %s", async boundary => {
      const repo = await prepare({ conflict: true });
      const remote = await head(sandbox.origin);
      // Bypass the Sync adapter: these are independent real Git invocations.
      const { execGit: externalGit } = await vi.importActual('../lib/execGit.js');
      const resolution = Buffer.from('unfinished resolution\r\nno final newline');
      const interfere = async () => {
        if (boundary === 'after failed pull') await externalGit(['rebase', '--abort'], repo);
        if (boundary !== 'after failed pull with same operation') {
          await externalGit(['fetch', 'origin'], repo);
          const rebased = await externalGit(['rebase', 'origin/main'], repo, { ignoreExitCode: true });
          expect(rebased.exitCode).not.toBe(0);
        }
        await writeFile(join(repo, 'initial.txt'), resolution);
      };
      if (boundary === 'before pull') observation.beforePull = interfere;
      else observation.afterPull = interfere;
      observation.commands = [];
      const result = await syncBranch(repo, 'main');
      expect(await readFile(join(repo, 'initial.txt'))).toEqual(resolution);
      expect(result).toMatchObject({
        success: false, pulled: false, pushed: false, error: expect.stringContaining('preserved')
      });
      expect(observation.pullExitCode).not.toBe(0);
      expect(observation.commands.some(args => args[0] === 'rebase' || args[0] === 'push')).toBe(false);
      expect(existsSync(join(repo, '.git', 'rebase-merge'))).toBe(true);
      expect(await head(sandbox.origin)).toBe(remote);
    }
  );

  it('refuses to push when pull exits zero during an external rebase with staged resolutions', async () => {
    const repo = await prepare({ conflict: true });
    const remote = await head(sandbox.origin);
    const { execGit: externalGit } = await vi.importActual('../lib/execGit.js');
    const resolution = Buffer.from('staged external resolution\r\n');
    observation.beforePull = async () => {
      await externalGit(['fetch', 'origin'], repo);
      const rebased = await externalGit(['rebase', 'origin/main'], repo, { ignoreExitCode: true });
      expect(rebased.exitCode).not.toBe(0);
      await writeFile(join(repo, 'initial.txt'), resolution);
      await externalGit(['add', 'initial.txt'], repo);
    };
    observation.commands = [];
    expect(await syncBranch(repo, 'main')).toMatchObject({
      success: false, pulled: false, pushed: false, error: expect.stringContaining('preserved')
    });
    expect(observation.pullExitCode).toBe(0);
    expect(observation.commands.some(args => args[0] === 'rebase' || args[0] === 'push')).toBe(false);
    expect(existsSync(join(repo, '.git', 'rebase-merge'))).toBe(true);
    expect(await readFile(join(repo, 'initial.txt'))).toEqual(resolution);
    expect((await externalGit(['show', ':initial.txt'], repo, { bufferOutput: true })).stdout).toEqual(resolution);
    expect(await head(sandbox.origin)).toBe(remote);
  });

  it.each(['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'sequencer'])(
    'leaves an existing %s operation untouched', async marker => {
      sandbox = await makeGitSandbox({ origin: true });
      const markerPath = join(sandbox.repo, '.git', marker);
      if (marker.includes('-') || marker === 'sequencer') await mkdir(markerPath);
      else await writeFile(markerPath, `${await head(sandbox.repo)}\n`);
      observation.commands = [];
      expect(await syncBranch(sandbox.repo, 'main')).toMatchObject({ success: false, pulled: false, pushed: false, error: expect.stringContaining('already in progress') });
      expect(existsSync(markerPath)).toBe(true);
      expect(observation.commands.some(args => ['pull', 'push', 'rebase'].includes(args[0]))).toBe(false);
    }
  );
});
