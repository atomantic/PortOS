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
    spawn('example-program', ['status']);
    expect(lastOptions()).toEqual({ windowsHide: true });

    spawnSync('example-program', ['status']);
    expect(lastOptions()).toEqual({ windowsHide: true });

    fork('./worker.js', ['--flag']);
    expect(lastOptions()).toEqual({ windowsHide: true });

    execSync('example-program status');
    expect(lastOptions()).toEqual({ windowsHide: true });

    execFileSync('example-program', ['status']);
    expect(lastOptions()).toEqual({ windowsHide: true });

    exec('example-program status');
    expect(lastOptions()).toEqual({ windowsHide: true });

    execFile('example-program', ['status']);
    expect(lastOptions()).toEqual({ windowsHide: true });
  });

  it('preserves caller options alongside the injected flag', () => {
    spawn('example-program', ['status'], { cwd: '/repo', stdio: 'pipe' });
    expect(lastOptions()).toEqual({ cwd: '/repo', stdio: 'pipe', windowsHide: true });
  });

  it('respects an explicit windowsHide: false', () => {
    // The default fills a gap; it must never override a stated intent.
    spawn('example-program', ['status'], { windowsHide: false });
    expect(lastOptions()).toEqual({ windowsHide: false });
  });

  it('does not mutate the caller-supplied options object', () => {
    const options = { cwd: '/repo' };
    spawn('example-program', ['status'], options);
    expect(options).toEqual({ cwd: '/repo' });
  });
});

describe('childProcess overload handling', () => {
  it('treats a non-array second argument as options, like node does', () => {
    spawn('example-program', { cwd: '/repo' });
    expect(calls.at(-1).args).toEqual(['example-program', { cwd: '/repo', windowsHide: true }]);
  });

  it('keeps the args array in its positional slot', () => {
    spawn('example-program', ['status', '--porcelain'], { cwd: '/repo' });
    expect(calls.at(-1).args).toEqual([
      'example-program',
      ['status', '--porcelain'],
      { cwd: '/repo', windowsHide: true },
    ]);
  });

  it('handles exec(command, callback) without swallowing the callback', () => {
    const cb = () => {};
    exec('example-program status', cb);
    expect(calls.at(-1).args).toEqual(['example-program status', { windowsHide: true }, cb]);
  });

  it('handles every execFile overload', () => {
    const cb = () => {};

    execFile('example-program', cb);
    expect(calls.at(-1).args).toEqual(['example-program', { windowsHide: true }, cb]);

    execFile('example-program', ['status'], cb);
    expect(calls.at(-1).args).toEqual(['example-program', ['status'], { windowsHide: true }, cb]);

    execFile('example-program', { cwd: '/repo' });
    expect(calls.at(-1).args).toEqual(['example-program', { cwd: '/repo', windowsHide: true }]);

    execFile('example-program', ['status'], { cwd: '/repo' }, cb);
    expect(calls.at(-1).args).toEqual([
      'example-program',
      ['status'],
      { cwd: '/repo', windowsHide: true },
      cb,
    ]);
  });
});
