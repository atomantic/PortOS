import { describe, it, expect, vi, beforeEach } from 'vitest';

// Spy on the real child_process surface so each wrapper can be checked for the
// exact positional shape it forwards — the overload juggling is the part most
// likely to break a caller, not the flag itself. End-to-end promisify fidelity
// needs the unmocked module and lives in childProcess.promisify.test.js.
const calls = [];
vi.mock('node:child_process', () => {
  const record = (name) => (...args) => {
    calls.push({ name, args });
    return { name, args };
  };
  return {
    ChildProcess: class ChildProcess {},
    exec: record('exec'),
    execFile: record('execFile'),
    execFileSync: record('execFileSync'),
    execSync: record('execSync'),
    fork: record('fork'),
    spawn: record('spawn'),
    spawnSync: record('spawnSync'),
  };
});

const {
  exec,
  execFile,
  execFileSync,
  execSync,
  fork,
  spawn,
  spawnSync,
} = await import('./childProcess.js');

const lastOptions = () => {
  const { args } = calls.at(-1);
  return args.find((a) => a && !Array.isArray(a) && typeof a === 'object');
};

beforeEach(() => {
  calls.length = 0;
});

describe('childProcess windowsHide default', () => {
  it('injects windowsHide into every spawn family helper', () => {
    spawn('git', ['status']);
    expect(lastOptions()).toEqual({ windowsHide: true });

    spawnSync('git', ['status']);
    expect(lastOptions()).toEqual({ windowsHide: true });

    fork('./worker.js', ['--flag']);
    expect(lastOptions()).toEqual({ windowsHide: true });

    execSync('git status');
    expect(lastOptions()).toEqual({ windowsHide: true });

    execFileSync('git', ['status']);
    expect(lastOptions()).toEqual({ windowsHide: true });

    exec('git status');
    expect(lastOptions()).toEqual({ windowsHide: true });

    execFile('git', ['status']);
    expect(lastOptions()).toEqual({ windowsHide: true });
  });

  it('preserves caller options alongside the injected flag', () => {
    spawn('git', ['status'], { cwd: '/repo', stdio: 'pipe' });
    expect(lastOptions()).toEqual({ cwd: '/repo', stdio: 'pipe', windowsHide: true });
  });

  it('respects an explicit windowsHide: false', () => {
    // The default fills a gap; it must never override a stated intent.
    spawn('git', ['status'], { windowsHide: false });
    expect(lastOptions()).toEqual({ windowsHide: false });
  });

  it('does not mutate the caller-supplied options object', () => {
    const options = { cwd: '/repo' };
    spawn('git', ['status'], options);
    expect(options).toEqual({ cwd: '/repo' });
  });
});

describe('childProcess overload handling', () => {
  it('treats a non-array second argument as options, like node does', () => {
    spawn('git', { cwd: '/repo' });
    expect(calls.at(-1).args).toEqual(['git', { cwd: '/repo', windowsHide: true }]);
  });

  it('keeps the args array in its positional slot', () => {
    spawn('git', ['status', '--porcelain'], { cwd: '/repo' });
    expect(calls.at(-1).args).toEqual([
      'git',
      ['status', '--porcelain'],
      { cwd: '/repo', windowsHide: true },
    ]);
  });

  it('handles exec(command, callback) without swallowing the callback', () => {
    const cb = () => {};
    exec('git status', cb);
    expect(calls.at(-1).args).toEqual(['git status', { windowsHide: true }, cb]);
  });

  it('handles every execFile overload', () => {
    const cb = () => {};

    execFile('git', cb);
    expect(calls.at(-1).args).toEqual(['git', { windowsHide: true }, cb]);

    execFile('git', ['status'], cb);
    expect(calls.at(-1).args).toEqual(['git', ['status'], { windowsHide: true }, cb]);

    execFile('git', { cwd: '/repo' });
    expect(calls.at(-1).args).toEqual(['git', { cwd: '/repo', windowsHide: true }]);

    execFile('git', ['status'], { cwd: '/repo' }, cb);
    expect(calls.at(-1).args).toEqual([
      'git',
      ['status'],
      { cwd: '/repo', windowsHide: true },
      cb,
    ]);
  });
});
