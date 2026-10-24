import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { setupTimeMachine } from '../setup-timemachine.js';
import { TIME_MACHINE_EXCLUDED_DIRS } from './timeMachineExclude.js';

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
const setup = (options = {}) => setupTimeMachine(root, {
  platform: 'darwin', env: {}, log: vi.fn(), ...options,
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
      excluded.add(path);
      return { status: 0 };
    });
    const expected = [...dataPaths.map(path => `data/${path}`), ...rootPaths];
    expect(existsSync(root)).toBe(false);
    expect(TIME_MACHINE_EXCLUDED_DIRS.slice().sort()).toEqual(expected.slice().sort());
    const result = setup({ run });
    expect(result).toEqual({ status: 'updated', added: expected.length - 1, excluded: 1, failures: [] });
    const additions = calls.filter(call => call[0] === 'sudo');
    expect(additions).toEqual(expected.filter(path => path !== 'data/cache')
      .map(path => ['sudo', '--', 'tmutil', 'addexclusion', '-p', resolve(root, path)]));
    for (const path of preservedData.map(path => `data/${path}`)) {
      expect(expected.some(exclude => path === exclude || path.startsWith(`${exclude}/`)), path).toBe(false);
      expect(excluded.has(resolve(root, path)), path).toBe(false);
    }
    calls.length = 0;
    expect(setup({ run })).toEqual({ status: 'present', added: 0, excluded: expected.length, failures: [] });
    expect(calls.every(call => call[0] === 'tmutil')).toBe(true);
    expect(existsSync(root)).toBe(false);
  });

  it('warns on rejected sudo, reports failures without throwing, and converges on a later successful setup', () => {
    const log = vi.fn();
    const run = vi.fn((command) => command === 'tmutil'
      ? { status: 0, stdout: '[Included]' }
      : { status: 1, stderr: 'sudo: a password is required' });
    const result = setup({ run, log });
    expect(result.status).toBe('partial');
    expect(result.added).toBe(0);
    expect(result.failures).toHaveLength(TIME_MACHINE_EXCLUDED_DIRS.length);
    expect(result.failures[0].error).toBe('sudo: a password is required');
    expect(log.mock.calls.flat().join('\n')).toContain('Setup will continue');
    run.mockImplementation(command => command === 'tmutil'
      ? { status: 0, stdout: '[Included]' } : { status: 0 });
    expect(setup({ run }).status).toBe('updated');
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
    run.mockImplementation(() => { throw new Error('runner unavailable'); });
    expect(setup({ run }).failures[0].error).toBe('runner unavailable');
  });
});
