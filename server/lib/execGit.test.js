import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('./childProcess.js', () => ({
  spawn: vi.fn()
}));

import { spawn } from './childProcess.js';
vi.mock('./windowsGitProcess.js', async importOriginal => ({
  ...await importOriginal(), startGit: vi.fn((args, options, wire) => wire(spawn('git', args, options))),
}));
import { startGit } from './windowsGitProcess.js';
import { assertGitWorkSettled, execGit, execGitSafe, withGitMutationLifetime } from './execGit.js';

const makeChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
};

describe('execGit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('passes args, cwd, and shell:false to spawn', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = execGit(['status'], '/repo');
    child.emit('close', 0);
    await promise;
    expect(spawn).toHaveBeenCalledWith('git', ['status'], {
      cwd: '/repo',
      shell: false,
      env: { ...process.env, LANGUAGE: 'en' },
    });
  });

  it('keeps git diagnostics in English when the server runs under a translated locale', async () => {
    // Callers match git's English wording; a translated `branch already exists`
    // would make worktree cleanup delete a branch it did not create.
    vi.stubEnv('LANGUAGE', 'de:en');
    vi.stubEnv('LC_ALL', 'de_DE.UTF-8');
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = execGit(['worktree', 'add', '-b', 'topic', '/wt'], '/repo');
    child.emit('close', 0);
    await promise;
    const { env } = spawn.mock.calls[0][2];
    expect(env.LANGUAGE).toBe('en');
    expect(env.LC_ALL).toBe('de_DE.UTF-8');
    expect(process.env.LANGUAGE).toBe('de:en');
  });

  it('rejects embedded NUL before a native command line could truncate an argument', async () => {
    await expect(execGit(['status', 'prefix\0suffix'], '/repo')).rejects.toThrow(/without NUL/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('forwards an explicit credential environment without merging ambient variables', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const env = { GH_TOKEN: 'selected-fixture-token', GIT_TERMINAL_PROMPT: '0' };
    const promise = execGit(['push'], '/repo', { env });
    child.emit('close', 0);
    await promise;
    expect(spawn).toHaveBeenCalledWith('git', ['push'], { cwd: '/repo', shell: false, env: { ...env, LANGUAGE: 'en' } });
    expect(env).toEqual({ GH_TOKEN: 'selected-fixture-token', GIT_TERMINAL_PROMPT: '0' });
  });

  it('resolves with stdout/stderr/exitCode on successful exit', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = execGit(['log'], '/repo');
    child.stdout.emit('data', Buffer.from('commit-hash'));
    child.stderr.emit('data', Buffer.from(''));
    child.emit('close', 0);
    await expect(promise).resolves.toEqual({
      stdout: 'commit-hash',
      stderr: '',
      exitCode: 0
    });
  });

  it('preserves UTF-8 characters split across stdout and stderr chunks, including an incomplete final character', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = execGit(['diff'], '/repo');
    const stdout = 'staged:界😀';
    const stderr = 'diagnostic:é界';
    for (const byte of Buffer.from(stdout)) child.stdout.emit('data', Buffer.from([byte]));
    for (const byte of Buffer.from(stderr)) child.stderr.emit('data', Buffer.from([byte]));
    child.stdout.emit('data', Buffer.from([0xe7]));
    child.emit('close', 0);
    await expect(promise).resolves.toEqual({ stdout: `${stdout}\uFFFD`, stderr, exitCode: 0 });
  });

  it('enforces the output limit when decoder flush completes the final character', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = execGit(['show'], '/repo', { maxBuffer: 1 });
    child.stdout.emit('data', Buffer.from([0x61, 0xe7]));
    child.emit('close', 0);
    await expect(promise).rejects.toThrow(/maxBuffer/);
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns opaque output bytes while retaining the decoded output budget', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = execGit(['diff'], '/repo', { bufferOutput: true, maxBuffer: 2 });
    const bytes = Buffer.from([0xe7, 0x95, 0x8c, 0xff]);
    for (const byte of bytes) child.stdout.emit('data', Buffer.from([byte]));
    child.emit('close', 0);
    await expect(promise).resolves.toEqual({ stdout: bytes, stderr: Buffer.alloc(0), exitCode: 0 });

    const overflowing = makeChild();
    spawn.mockReturnValue(overflowing);
    const limited = execGit(['diff'], '/repo', { bufferOutput: true, maxBuffer: 2 });
    overflowing.stdout.emit('data', Buffer.from('abc'));
    overflowing.emit('close', null, 'SIGTERM');
    await expect(limited).rejects.toMatchObject({ code: 'GIT_OUTPUT_LIMIT', limitCodeUnits: 2, observedCodeUnits: 3 });
  });

  it('rejects with stderr on a non-zero exit', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = execGit(['bogus'], '/repo');
    child.stderr.emit('data', Buffer.from('not a git command'));
    child.emit('close', 1);
    await expect(promise).rejects.toThrow(/not a git command/);
  });

  it('resolves on non-zero exit when ignoreExitCode is true', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = execGit(['diff', '--exit-code'], '/repo', { ignoreExitCode: true });
    child.stdout.emit('data', Buffer.from('diff content'));
    child.emit('close', 1);
    await expect(promise).resolves.toEqual({
      stdout: 'diff content',
      stderr: '',
      exitCode: 1
    });
  });

  it('preserves signal termination and partial output when ignoring exit codes', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = execGit(['ls-remote'], '/repo', { ignoreExitCode: true });
    child.stdout.emit('data', 'partial');
    child.emit('close', null, 'SIGTERM');
    await expect(promise).resolves.toEqual({
      stdout: 'partial', stderr: '', exitCode: null, signal: 'SIGTERM', terminated: true
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a signal exit with cancellation metadata', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = execGit(['fetch'], '/repo');
    child.emit('close', null, 'SIGTERM');
    await expect(promise).rejects.toMatchObject({
      name: 'AbortError', message: 'git command cancelled by SIGTERM', signal: 'SIGTERM', terminated: true
    });
  });

  it('rejects with a timeout error and kills the child after the timeout', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = execGit(['fetch'], '/repo', { timeout: 500 });
    vi.advanceTimersByTime(500);
    child.emit('close', null, 'SIGTERM');
    await expect(promise).rejects.toMatchObject({ code: 'GIT_TIMEOUT', limitMs: 500, observedMs: expect.any(Number),
      message: expect.stringMatching(/timed out after 0\.5s/) });
    expect(child.kill).toHaveBeenCalled();
  });

  it('execGitSafe converts a timeout into a complete failed result even with ignoreExitCode', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = execGitSafe(['fetch'], '/repo', { timeout: 500, ignoreExitCode: true });
    vi.advanceTimersByTime(500);
    child.emit('close', null, 'SIGTERM');
    await expect(promise).resolves.toEqual({
      exitCode: 1,
      stdout: '',
      stderr: 'git command timed out after 0.5s',
      settlement: 'held', settlementReason: 'tree-unconfirmed'
    });
  });

  it('rejects when output exceeds maxBuffer', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = execGit(['log'], '/repo', { maxBuffer: 8 });
    child.stdout.emit('data', Buffer.from('a'.repeat(9)));
    child.emit('close', null, 'SIGTERM');
    await expect(promise).rejects.toThrow(/maxBuffer/);
    expect(child.kill).toHaveBeenCalled();
  });

  it('rejects on child spawn error', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = execGit(['status'], '/repo');
    child.emit('error', new Error('spawn ENOENT'));
    await expect(promise).rejects.toThrow(/ENOENT/);
  });

  it('holds mutation admission and teardown when cancellation cannot confirm pipe settlement', async () => {
    const child = makeChild();
    child.pid = 12345;
    child.cancelOwnedGit = vi.fn();
    child.gitSettlement = new Promise(() => {});
    spawn.mockReturnValue(child);
    const retain = vi.fn();
    const result = withGitMutationLifetime(() => execGit(['fetch', 'private-argument'], '/held-fixture/repo', { timeout: 100 }), retain).catch(error => error);
    vi.advanceTimersByTime(100);
    expect(child.cancelOwnedGit).toHaveBeenCalledOnce();
    expect(retain).not.toHaveBeenCalled();
    child.emit('exit', 1);
    expect(() => assertGitWorkSettled('/held-fixture')).toThrow(/settlement is held/);
    vi.advanceTimersByTime(5000);
    const failure = await result;
    expect(failure).toMatchObject({ code: 'GIT_TIMEOUT', settlement: 'held', settlementReason: 'pipes-unconfirmed' });
    expect(failure.message).not.toContain('private-argument');
    expect(retain).toHaveBeenCalledOnce();
    expect(() => assertGitWorkSettled('/held-fixture')).toThrow(/settlement is held/);
    expect(() => assertGitWorkSettled('/held-fixture-neighbor')).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for owned-tree evidence after close before releasing mutation admission', async () => {
    const child = makeChild();
    child.cancelOwnedGit = vi.fn();
    let confirm;
    child.gitSettlement = new Promise(resolve => { confirm = resolve; });
    spawn.mockReturnValue(child);
    const retain = vi.fn();
    const result = withGitMutationLifetime(() => execGit(['status'], '/settled-fixture/repo', { timeout: 100 }), retain).catch(error => error);
    vi.advanceTimersByTime(100);
    child.emit('close', 1);
    expect(() => assertGitWorkSettled('/settled-fixture')).toThrow(/settlement is held/);
    confirm({ settled: true, launched: true, exitCode: 1, reason: 'settled' });
    expect(await result).toMatchObject({ code: 'GIT_TIMEOUT', settlement: 'settled' });
    expect(retain).not.toHaveBeenCalled();
    expect(() => assertGitWorkSettled('/settled-fixture')).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains an unconfirmed tree despite closed pipes and a zero supervisor exit', async () => {
    const child = makeChild();
    child.gitSettlement = Promise.resolve({ settled: false, reason: 'termination-unconfirmed' });
    spawn.mockReturnValue(child);
    const retain = vi.fn();
    const result = withGitMutationLifetime(() => execGit(['status'], '/unconfirmed-fixture'), retain);
    child.emit('close', 0);
    await expect(result).rejects.toMatchObject({ code: 'GIT_SETTLEMENT_HELD', settlement: 'held', settlementReason: 'termination-unconfirmed' });
    expect(retain).toHaveBeenCalledOnce();
    expect(() => assertGitWorkSettled('/unconfirmed-fixture')).toThrow(/settlement is held/);
  });

  it('drains a live sibling before a failed mutation workflow can release its permit', async () => {
    const first = makeChild(), second = makeChild();
    spawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
    let ended = false;
    const work = withGitMutationLifetime(() => Promise.all([
      execGit(['first'], '/fanout-fixture'), execGit(['second'], '/fanout-fixture'),
    ]), vi.fn()).finally(() => { ended = true; });
    const failure = work.catch(error => error);
    first.emit('close', 1);
    await Promise.resolve(); await Promise.resolve();
    expect(ended).toBe(false);
    expect(() => assertGitWorkSettled('/fanout-fixture')).toThrow(/held/);
    second.emit('close', 0);
    expect((await failure).message).toBe('git exited with code 1');
    expect(() => assertGitWorkSettled('/fanout-fixture')).not.toThrow();
  });

  it('holds fixture teardown while containment startup is pending and clears an unlaunched failure', async () => {
    let failStartup;
    startGit.mockImplementationOnce(() => new Promise((resolve, reject) => { failStartup = reject; }));
    const result = execGit(['status'], '/starting-fixture');
    expect(() => assertGitWorkSettled('/starting-fixture')).toThrow(/held/);
    failStartup(new Error('containment startup failed'));
    await expect(result).rejects.toThrow('containment startup failed');
    expect(() => assertGitWorkSettled('/starting-fixture')).not.toThrow();
  });

  it('holds teardown across junction or symlink spellings of the owned directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'portos-owned-git-path-'));
    const physical = join(root, 'physical'), alias = join(root, 'alias');
    const child = makeChild();
    spawn.mockReturnValue(child);
    let pending;
    try {
      await mkdir(physical);
      await symlink(physical, alias, process.platform === 'win32' ? 'junction' : 'dir');
      pending = execGit(['status'], alias);
      expect(() => assertGitWorkSettled(physical)).toThrow(/held/);
      expect(() => assertGitWorkSettled(alias)).toThrow(/held/);
    } finally {
      child.emit('close', 0);
      if (pending) await pending;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses detached Git work after its mutation permit lifetime has ended', async () => {
    let resume, late;
    const later = new Promise(resolve => { resume = resolve; });
    await withGitMutationLifetime(() => {
      late = later.then(() => execGit(['status'], '/expired-fixture'));
    }, vi.fn());
    const outcome = late.catch(error => error);
    resume();
    expect(await outcome).toMatchObject({ code: 'GIT_MUTATION_LIFETIME_CLOSED' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('falls back to a generic error message when stderr is empty on non-zero exit', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = execGit(['x'], '/repo');
    child.emit('close', 2);
    await expect(promise).rejects.toThrow(/exited with code 2/);
  });
});

