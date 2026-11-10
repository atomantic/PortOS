import { afterEach, describe, expect, it, vi } from 'vitest';

const spawned = vi.hoisted(() => ({ bufferedSpawn: vi.fn() }));
// Partial mock: only the spawn is faked — `spawnFailureDetail` is the real pure
// helper, so the failure sentence this asserts on is the shipped one.
vi.mock('./bufferedSpawn.js', async (importOriginal) => ({ ...(await importOriginal()), ...spawned }));

const pathLookup = vi.hoisted(() => ({ findCommandOnPath: vi.fn(() => '/opt/homebrew/bin/mtplx') }));
vi.mock('./processEnv.js', () => pathLookup);

import * as mtplxRuntime from './mtplxRuntime.js';
import { describeMtplxCache, listMtplxCachedModels, pickMtplxCachedModel } from './mtplxModels.js';

const ok = (stdout) => ({ success: true, code: 0, signal: null, stdout, stderr: '', timedOut: false });

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  pathLookup.findCommandOnPath.mockReturnValue('/opt/homebrew/bin/mtplx');
});

describe('listMtplxCachedModels', () => {
  it('reads the cache listing without touching the network', async () => {
    spawned.bufferedSpawn.mockResolvedValue(ok(JSON.stringify({
      cache_dir: '/cache/models',
      models: [{ repo_id: 'Example/Model-A', validation: { ok: true } }],
    })));

    const result = await listMtplxCachedModels();

    expect(spawned.bufferedSpawn).toHaveBeenCalledWith('/opt/homebrew/bin/mtplx', ['models', '--json'], expect.objectContaining({ shell: false }));
    expect(result).toEqual({ models: [{ repo_id: 'Example/Model-A', validation: { ok: true } }], error: null });
  });

  it('reads models from a private install that is absent from the global PATH', async () => {
    pathLookup.findCommandOnPath.mockReturnValue(null);
    vi.spyOn(mtplxRuntime, 'resolveMtplxBinary').mockReturnValue('/private/mtplx/bin/mtplx');
    spawned.bufferedSpawn.mockResolvedValue(ok(JSON.stringify({ models: [{ repo_id: 'Example/Private' }] })));
    expect(await listMtplxCachedModels()).toEqual({ models: [{ repo_id: 'Example/Private' }], error: null });
    expect(spawned.bufferedSpawn).toHaveBeenCalledWith('/private/mtplx/bin/mtplx', ['models', '--json'], expect.any(Object));
  });

  it('reports an EMPTY cache as [], not as a failure', async () => {
    // The sentinel that matters: `[]` means "read it, nothing is there" and the
    // caller must refuse to start; collapsing it into `null` would launch a
    // server that exits 1 the moment it looks for weights.
    spawned.bufferedSpawn.mockResolvedValue(ok(JSON.stringify({ cache_dir: '/cache/models', models: [] })));

    expect(await listMtplxCachedModels()).toMatchObject({ models: [], error: null });
  });

  it('returns null models — never [] — when the cache cannot be read at all', async () => {
    pathLookup.findCommandOnPath.mockReturnValue(null);
    expect(await listMtplxCachedModels()).toMatchObject({ models: null, error: expect.stringMatching(/PATH/) });
    expect(spawned.bufferedSpawn).not.toHaveBeenCalled();

    pathLookup.findCommandOnPath.mockReturnValue('/opt/homebrew/bin/mtplx');
    spawned.bufferedSpawn.mockResolvedValue({ success: false, code: 2, stdout: '', stderr: 'usage: mtplx models\nerror: unknown flag', timedOut: false });
    expect(await listMtplxCachedModels()).toMatchObject({ models: null, error: 'error: unknown flag' });

    spawned.bufferedSpawn.mockResolvedValue({ success: false, code: -1, stdout: '', stderr: '', timedOut: true });
    expect(await listMtplxCachedModels()).toMatchObject({ models: null, error: expect.stringMatching(/timed out/) });

    // A spawn failure writes to neither stream — its reason is on `error`.
    spawned.bufferedSpawn.mockResolvedValue({ success: false, code: -1, stdout: '', stderr: '', timedOut: false, error: new Error('spawn EACCES') });
    expect(await listMtplxCachedModels()).toMatchObject({ models: null, error: 'spawn EACCES' });

    spawned.bufferedSpawn.mockResolvedValue(ok('not json at all'));
    expect(await listMtplxCachedModels()).toMatchObject({ models: null, error: expect.stringMatching(/did not return a model list/) });
  });

  it('skips a banner printed ahead of the JSON payload', async () => {
    spawned.bufferedSpawn.mockResolvedValue(ok(`MTPLX 2.9.0\n${JSON.stringify({ cache_dir: '/c', models: [] })}`));
    expect(await listMtplxCachedModels()).toMatchObject({ models: [], error: null });
  });

  it('honours a custom command name', async () => {
    pathLookup.findCommandOnPath.mockReturnValue(null);
    await listMtplxCachedModels({ command: 'mtplx-next' });
    expect(pathLookup.findCommandOnPath).toHaveBeenCalledWith('mtplx-next');
  });
});

describe('pickMtplxCachedModel', () => {
  it('prefers a model carrying the recorded exactness contract', () => {
    expect(pickMtplxCachedModel([
      { repo_id: 'Example/Plain', has_runtime_contract: false, validation: { ok: true } },
      { repo_id: 'Example/Verified', has_runtime_contract: true, validation: { ok: true } },
    ])).toBe('Example/Verified');
  });

  it('falls back to any complete model when none carries a contract', () => {
    expect(pickMtplxCachedModel([{ repo_id: 'Example/Plain', validation: { ok: true } }])).toBe('Example/Plain');
  });

  it('refuses a half-finished pull — a partial directory would fail on load', () => {
    expect(pickMtplxCachedModel([
      { repo_id: 'Example/Partial', has_runtime_contract: true, validation: { ok: false, missing_files: ['mtp sidecar'] } },
    ])).toBeNull();
  });

  it('accepts a row from an older CLI that reports no validation block', () => {
    expect(pickMtplxCachedModel([{ repo_id: 'Example/Old' }])).toBe('Example/Old');
  });

  it('returns null for an empty, unreadable, or id-less cache', () => {
    expect(pickMtplxCachedModel([])).toBeNull();
    expect(pickMtplxCachedModel(null)).toBeNull();
    expect(pickMtplxCachedModel([{ path: '/cache/broken' }])).toBeNull();
  });
});

describe('describeMtplxCache', () => {
  it('reports a servable cache with the model a start would use', () => {
    expect(describeMtplxCache({
      models: [{ repo_id: 'Example/Plain', validation: { ok: true } }, { repo_id: 'Example/Verified', has_runtime_contract: true, validation: { ok: true } }],
      error: null,
    })).toEqual({ state: 'ready', model: 'Example/Verified', count: 2, error: null });
  });

  it('separates a cache nobody pulled into from one holding a half-finished pull', () => {
    // Different sentences on the checklist: "no weights cached" vs "only an
    // unfinished download". Both block a start; only the second implies a retry
    // of something the user already began.
    expect(describeMtplxCache({ models: [], error: null })).toEqual({ state: 'empty', model: null, count: 0, error: null });
    expect(describeMtplxCache({ models: [{ repo_id: 'Example/Partial', validation: { ok: false } }], error: null }))
      .toEqual({ state: 'partial', model: null, count: 1, error: null });
  });

  it('never calls an UNREADABLE cache empty — that would claim a fact PortOS lacks', () => {
    // The whole point of `models: null`: an empty cache blocks a start, an
    // unreadable one must not.
    expect(describeMtplxCache({ models: null, error: '`mtplx models` timed out' }))
      .toEqual({ state: 'unknown', model: null, count: 0, error: '`mtplx models` timed out' });
    expect(describeMtplxCache()).toMatchObject({ state: 'unknown', error: null });
  });
});
