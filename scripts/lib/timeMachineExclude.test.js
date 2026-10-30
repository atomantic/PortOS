import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { setupTimeMachine } from '../setup-timemachine.js';
import { confirmOnTty, TIME_MACHINE_EXCLUDED_DIRS } from './timeMachineExclude.js';

const root = resolve(tmpdir(), 'portos-time-machine-fixture-not-created');
const dataPaths = [
  'browser-profile', 'cache', 'browser-downloads', 'code-animation-workspaces',
  'code-animation-exports', 'composition-proofs', 'music-video-compositions',
  'music-video-film-look', 'music-video-stats-outro', 'music-video-segments',
  'music-video-song-renders', 'supercollider', 'federated-media-inbox',
  'cos/slashdo-resolved', 'cos/reference-repos', 'cos/worktrees',
  'cos/initialized-checkout-fixtures', 'autofixer/worktrees', 'backup-admission',
  'model-tests/sandboxes', 'image-thumbnails', 'video-thumbnails', 'python',
  'repos', 'training-runs', 'venvs', 'jev/corpora', 'jev/embeddings',
];
const rootPaths = [
  'tmp', 'models', 'node_modules', 'client/node_modules', 'server/node_modules',
  'autofixer/node_modules', 'scripts/node_modules', 'browser/node_modules',
];
const preservedData = [
  'images', 'videos', 'music', 'music-video', 'sprites', 'image-to-3d',
  'lora-datasets', 'loras', 'brain', 'writers-room', 'screenshots', 'uploads',
  'audio', 'compositions', 'voice-profiles', 'cos/agents', 'cos/memory',
  'cos/attachments', 'cos/held-checkout-archives', 'cos/branch-retirement-archives',
  'cos/initialized-checkout-retirements', 'jev/heads',
];
const memoryPreference = (decision = 'accepted') => ({
  get: () => decision,
  set: vi.fn(value => { decision = value; }),
});
const setup = (options = {}) => setupTimeMachine(root, {
  platform: 'darwin', env: {}, log: vi.fn(), exists: () => true, mkdir: vi.fn(),
  preference: memoryPreference(), confirm: vi.fn(), ...options,
});

describe('Time Machine setup backup boundary', () => {
  it('does not spawn on unsupported platforms or when opted out', () => {
    const run = vi.fn();
    expect(setup({ platform: 'linux', run }).status).toBe('unsupported');
    expect(setup({ env: { PORTOS_SKIP_TIMEMACHINE_EXCLUDE: '1' }, run }).status).toBe('skipped');
    expect(run).not.toHaveBeenCalled();
  });

  it('records exactly the fixed paths once, preserves creative/recovery trees, and never creates missing paths', () => {
    const excluded = new Set([join(root, 'data/cache')]);
    const calls = [];
    const run = vi.fn((command, args) => {
      calls.push([command, ...args]);
      const path = args.at(-1);
      if (command === 'tmutil') return { status: 0, stdout: `${excluded.has(path) ? '[Excluded]' : '[Included]'} ${path}` };
      if (args[0] === '-v') return { status: 0 };
      excluded.add(path);
      return { status: 0 };
    });
    const expected = [...dataPaths.map(path => `data/${path}`), ...rootPaths];
    expect(existsSync(root)).toBe(false);
    expect(TIME_MACHINE_EXCLUDED_DIRS.slice().sort()).toEqual(expected.slice().sort());
    const result = setup({ run });
    expect(result).toEqual({ status: 'updated', added: expected.length - 1, excluded: 1, created: 0, failures: [] });
    const additions = calls.filter(call => call[0] === 'sudo' && call[1] === '--');
    expect(additions).toEqual(expected.filter(path => path !== 'data/cache')
      .map(path => ['sudo', '--', 'tmutil', 'addexclusion', '-p', resolve(root, path)]));
    for (const path of preservedData.map(path => `data/${path}`)) {
      expect(expected.some(exclude => path === exclude || path.startsWith(`${exclude}/`)), path).toBe(false);
      expect(excluded.has(resolve(root, path)), path).toBe(false);
    }
    calls.length = 0;
    expect(setup({ run })).toEqual({ status: 'present', added: 0, excluded: expected.length, created: 0, failures: [] });
    expect(calls.every(call => call[0] === 'tmutil')).toBe(true);
    expect(existsSync(root)).toBe(false);
  });

  it('warns on rejected sudo, reports failures without throwing, and converges on a later successful setup', () => {
    const log = vi.fn();
    const run = vi.fn((command) => command === 'tmutil'
      ? { status: 0, stdout: '[Included]' }
      : { status: 1, stderr: 'sudo: a terminal is required\nsudo: a password is required' });
    const result = setup({ run, log });
    expect(result.status).toBe('partial');
    expect(result.added).toBe(0);
    expect(run.mock.calls.filter(([command]) => command === 'sudo')).toHaveLength(1);
    expect(result.failures).toHaveLength(TIME_MACHINE_EXCLUDED_DIRS.length);
    expect(result.failures[0].error).toBe('sudo: a terminal is required\nsudo: a password is required');
    expect(log.mock.calls.flat().join('\n')).toContain('Setup will continue');
    expect(log.mock.calls.every(([line]) => !line.includes('\n'))).toBe(true);
    run.mockImplementation(command => command === 'tmutil'
      ? { status: 0, stdout: '[Included]' } : { status: 0 });
    expect(setup({ run }).status).toBe('updated');
  });

  describe('directories that do not exist yet', () => {
    const included = vi.fn((command, args) => command === 'tmutil'
      ? { status: 0, stdout: `[Included] ${args.at(-1)}` } : { status: 0 });

    it('asks once, creates and excludes them on yes, and never asks again', () => {
      const preference = memoryPreference(null);
      const confirm = vi.fn(() => 'yes');
      const mkdir = vi.fn();
      const run = vi.fn(() => ({ status: 0 }));
      const result = setup({ run, preference, confirm, mkdir, exists: () => false });
      expect(confirm).toHaveBeenCalledWith(TIME_MACHINE_EXCLUDED_DIRS.length);
      expect(preference.set).toHaveBeenCalledWith('accepted');
      expect(mkdir).toHaveBeenCalledTimes(TIME_MACHINE_EXCLUDED_DIRS.length);
      expect(result).toMatchObject({ status: 'updated', added: TIME_MACHINE_EXCLUDED_DIRS.length, created: TIME_MACHINE_EXCLUDED_DIRS.length });
      confirm.mockClear();
      setup({ run: included, preference, confirm, mkdir, exists: () => false });
      expect(confirm).not.toHaveBeenCalled();
    });

    it('remembers a no: no directories, no sudo, no second question', () => {
      const preference = memoryPreference(null);
      const confirm = vi.fn(() => 'no');
      const mkdir = vi.fn();
      const run = vi.fn();
      expect(setup({ run, preference, confirm, mkdir, exists: () => false }).status).toBe('declined');
      expect(preference.set).toHaveBeenCalledWith('declined');
      expect(setup({ run, preference, confirm, mkdir, exists: () => false }).status).toBe('declined');
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(mkdir).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    });

    it('without a terminal neither prompts, records a decision, nor touches the disk', () => {
      const preference = memoryPreference(null);
      const mkdir = vi.fn();
      const run = vi.fn();
      const result = setup({ run, preference, confirm: () => null, mkdir, exists: () => false });
      expect(result.status).toBe('undecided');
      expect(preference.set).not.toHaveBeenCalled();
      expect(mkdir).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    });

    it('does not ask when everything is already excluded', () => {
      const confirm = vi.fn();
      const run = vi.fn((command, args) => ({ status: 0, stdout: `[Excluded] ${args.at(-1)}` }));
      expect(setup({ run, preference: memoryPreference(null), confirm }).status).toBe('present');
      expect(confirm).not.toHaveBeenCalled();
    });
  });

  describe('confirmOnTty', () => {
    const ask = (reply) => confirmOnTty(3, {
      open: () => 9, write: () => 0, close: () => {},
      read: (_fd, buf) => (reply === null ? 0 : buf.write(reply)),
    });
    it('maps answers, treats Enter as the Y default, and Ctrl-D as undecided', () => {
      expect(ask('n\n')).toBe('no');
      expect(ask('\n')).toBe('yes');
      expect(ask('y\n')).toBe('yes');
      expect(ask(null)).toBeNull();
    });
    it('returns null without a controlling terminal', () => {
      expect(confirmOnTty(3, { open: () => { throw new Error('ENXIO'); } })).toBeNull();
    });
  });

  it('does not re-prompt for sudo for an already-excluded path whose directory was since deleted', () => {
    const added = new Set();
    const preference = { ...memoryPreference(), added: () => new Set(added), markAdded: vi.fn(paths => paths.forEach(p => added.add(p))) };
    const present = new Set();
    const run = vi.fn((command, args) => command === 'tmutil'
      ? { status: 0, stdout: present.has(args[1]) ? '[Excluded]' : '[UNKNOWN]' }
      : { status: 0 });
    const mkdir = vi.fn(path => present.add(path));
    const exists = path => present.has(path);
    expect(setup({ run, preference, mkdir, exists }).status).toBe('updated');
    present.clear(); // directories deleted between runs; fixed-path exclusions persist
    run.mockClear();
    const second = setup({ run, preference, mkdir, exists });
    expect(second.status).toBe('present');
    expect(run.mock.calls.some(([command]) => command === 'sudo')).toBe(false);
  });

  it('retains missing-path and process errors as retryable setup warnings', () => {
    const run = vi.fn((command) => command === 'tmutil'
      ? { status: 1, stdout: '[Excluded]', stderr: 'No such file or directory' }
      : { status: null, error: new Error('spawn sudo ENOENT') });
    const result = setup({ run });
    expect(result.status).toBe('partial');
    expect(result.excluded).toBe(0);
    expect(result.failures[0].error).toBe('spawn sudo ENOENT');
    expect(run.mock.calls.some(([command]) => command === 'sudo')).toBe(true);
    run.mockImplementation((command, args) => command === 'tmutil'
      ? { status: 1, stderr: 'No such file or directory' }
      : args[0] === '-v' ? { status: 0 } : { status: 1, stderr: 'Path does not exist' });
    const missing = setup({ run });
    expect(missing.failures).toHaveLength(TIME_MACHINE_EXCLUDED_DIRS.length);
    expect(run.mock.calls.filter(([command, args]) => command === 'sudo' && args[0] === '--')).toHaveLength(TIME_MACHINE_EXCLUDED_DIRS.length);
    run.mockImplementation(() => { throw new Error('runner unavailable'); });
    expect(setup({ run }).failures[0].error).toBe('runner unavailable');
  });
});
