/**
 * The boot smoke's isolation contract (#8343). Running the real smoke is too
 * slow for the suite (CI runs it as its own step), so these pin the two halves
 * a regression would silently undo: the child environment is an allowlist, and
 * the disposable root is seeded like a fresh install, resolvable from a
 * worktree, and never left behind by a failed setup.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildSmokeEnv, createSmokeRoot, monitorSmokeChild, SMOKE_DATABASE } from './smoke-boot.js';
import { DATA_ROOT_ENV, resolveInstallRoot } from '../server/lib/dataRoot.js';

const scratch = [];
const tempDir = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};

afterEach(() => {
  delete process.env[DATA_ROOT_ENV];
  while (scratch.length) rmSync(scratch.pop(), { recursive: true, force: true });
});

describe('buildSmokeEnv', () => {
  it('passes no provider key, token, database credential, or escape hatch to the child', () => {
    const root = join(tmpdir(), 'portos-smoke-example');
    const env = buildSmokeEnv({
      root,
      parentEnv: {
        PATH: '/usr/bin',
        NODE_OPTIONS: '--max-old-space-size=4096',
        ANTHROPIC_API_KEY: 'sk-example',
        OPENAI_API_KEY: 'sk-example',
        PORTOS_API_TOKEN: 'token-example',
        PGPASSWORD: 'secret-example',
        PGDATABASE: 'portos',
        TEST_DB_OK: '1',
        MEMORY_BACKEND: 'postgres',
        PORTOS_DATA_ROOT: '/srv/live-install',
        HOME: '/home/example'
      }
    });

    for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'PORTOS_API_TOKEN', 'PGPASSWORD', 'TEST_DB_OK', 'MEMORY_BACKEND']) {
      expect(env, key).not.toHaveProperty(key);
    }
    expect(env).toMatchObject({
      PATH: '/usr/bin',
      NODE_ENV: 'test',
      PORTOS_SMOKE_BOOT: '1',
      [DATA_ROOT_ENV]: root,
      HOME: join(root, 'home'),
      TMPDIR: join(root, 'tmp'),
      PGDATABASE: SMOKE_DATABASE,
      HOST: '127.0.0.1',
      NODE_OPTIONS: '--max-old-space-size=4096 --unhandled-rejections=strict'
    });
    expect(SMOKE_DATABASE).toMatch(/_test$/);
  });
});

describe('createSmokeRoot', () => {
  const buildCodeRoot = () => {
    const codeRoot = tempDir('portos-smoke-code-');
    const reference = join(codeRoot, 'data.reference');
    mkdirSync(join(reference, 'private'), { recursive: true });
    writeFileSync(join(reference, 'providers.json'), '{"providers":{}}\n');
    writeFileSync(join(reference, 'apps.json'), '{"apps":{"portos-default":{"repoPath":"__PORTOS_ROOT__"}}}\n');
    // Migration-owned: setup-data never seeds it, so neither may the smoke.
    writeFileSync(join(reference, 'private', 'api-keys.json'), '{}\n');
    return codeRoot;
  };

  it('seeds a fresh-install tree that a worktree-executing server resolves to', () => {
    const codeRoot = buildCodeRoot();
    const root = createSmokeRoot({ codeRoot, tmpBase: tempDir('portos-smoke-base-') });

    expect(existsSync(join(root, 'data.reference', 'providers.json'))).toBe(true);
    expect(existsSync(join(root, 'data', 'providers.json'))).toBe(true);
    expect(existsSync(join(root, 'data', 'private', 'api-keys.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(root, 'data', 'apps.json'), 'utf8')).apps['portos-default'].repoPath).toBe(codeRoot);
    for (const dir of ['home', 'tmp']) expect(existsSync(join(root, dir)), dir).toBe(true);

    process.env[DATA_ROOT_ENV] = root;
    expect(resolveInstallRoot(join(codeRoot, 'data', 'cos', 'worktrees', 'claim-issue-1'))).toBe(root);
  });

  it('removes its partial tree when seeding fails', () => {
    const codeRoot = tempDir('portos-smoke-code-'); // no data.reference/
    const tmpBase = tempDir('portos-smoke-base-');
    expect(() => createSmokeRoot({ codeRoot, tmpBase })).toThrow();
    expect(readdirSync(tmpBase)).toEqual([]);
  });
});

describe('smoke child lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const start = () => {
    vi.useFakeTimers();
    const child = new EventEmitter();
    child.pid = 123;
    child.kill = vi.fn();
    const result = monitorSmokeChild(child, {
      startupMs: 1000, windowMs: 100, shutdownMs: 200, postKillMs: 50
    });
    const ready = () => child.emit('message', { type: 'portos:smoke-ready' });
    return { child, result, ready };
  };

  it('lets slow startup finish before timing survival and requires clean shutdown', async () => {
    const { child, result, ready } = start();
    child.emit('message', { type: 'unrelated' });
    vi.advanceTimersByTime(900);
    expect(child.kill).not.toHaveBeenCalled();
    ready();
    vi.advanceTimersByTime(99);
    ready(); // Duplicate readiness cannot extend the window.
    expect(child.kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    child.emit('exit', 0, null);
    expect(await result).toEqual({ ok: true, error: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails a never-ready child even when timeout cleanup exits cleanly', async () => {
    const { child, result, ready } = start();
    vi.advanceTimersByTime(1000);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    ready(); // Late readiness cannot erase the startup timeout.
    child.emit('exit', 0, null);
    expect(await result).toMatchObject({ ok: false, error: expect.stringContaining('did not become ready') });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['startup', 'survival'])('fails an unexpected zero exit during %s immediately', async (phase) => {
    const { child, result, ready } = start();
    if (phase === 'survival') ready();
    child.emit('exit', 0, null);
    expect(await result).toMatchObject({ ok: false, error: expect.stringContaining(phase) });
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([[1, null], [null, 'SIGTERM']])('rejects abnormal shutdown (code %s, signal %s)', async (code, signal) => {
    const { child, result, ready } = start();
    ready();
    vi.advanceTimersByTime(100);
    child.emit('exit', code, signal);
    expect(await result).toMatchObject({ ok: false, error: expect.stringContaining('shutdown') });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([true, false])('fails forced cleanup whether SIGKILL produces an exit event (%s)', async (exits) => {
    const { child, result, ready } = start();
    ready();
    vi.advanceTimersByTime(300);
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    if (exits) child.emit('exit', null, 'SIGKILL');
    else vi.advanceTimersByTime(50);
    expect(await result).toMatchObject({ ok: false, error: expect.stringContaining('SIGKILL') });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports spawn failure without waiting for a nonexistent child', async () => {
    const { child, result } = start();
    delete child.pid;
    child.emit('error', new Error('spawn failed'));
    expect(await result).toMatchObject({ ok: false, error: 'Child process error: spawn failed' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds cleanup after a signal error without treating it as success', async () => {
    const { child, result, ready } = start();
    ready();
    vi.advanceTimersByTime(100);
    child.emit('error', new Error('signal failed'));
    vi.advanceTimersByTime(250);
    expect(await result).toMatchObject({ ok: false, error: 'Child process error: signal failed' });
    expect(vi.getTimerCount()).toBe(0);
  });
});
