/** Provider-refresh cache discovery must not load MTPLX lifecycle policy. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  findCommand: vi.fn(),
  runtime: vi.fn(),
  cache: vi.fn(),
  slotstream: vi.fn(),
}));

// Fail even on a dynamic import: static import-closure checks cannot see this
// regression, and merely importing the manager registers its idle daemon.
vi.mock('./mtplxServerManager.js', () => {
  throw new Error('MTPLX cache discovery must not import the process manager');
});
vi.mock('../lib/processEnv.js', () => ({ findCommandOnPath: mocks.findCommand }));
vi.mock('../lib/mtplxRuntime.js', () => ({ describeMtplxRuntime: mocks.runtime }));
vi.mock('../lib/mtplxModels.js', async (importOriginal) => ({
  ...await importOriginal(),
  listMtplxCachedModels: mocks.cache,
}));
vi.mock('./slotstreamServerManager.js', () => ({ slotstreamCachedModelIds: mocks.slotstream }));

import { localCachedModelIds } from './localCachedModels.js';

const local = { id: 'mtplx', type: 'api', endpoint: 'http://127.0.0.1:8000/v1' };
beforeEach(() => {
  mocks.findCommand.mockReturnValue('/example/bin/mtplx');
  mocks.runtime.mockResolvedValue({ ready: true });
  mocks.cache.mockResolvedValue({ models: [
    { repo_id: 'Vendor/Example-MTPLX', validation: { ok: true } },
    { repo_id: 'Vendor/Older-MTPLX' },
    { repo_id: 'Vendor/Partial-MTPLX', validation: { ok: false } },
  ], error: null });
  mocks.slotstream.mockResolvedValue(['example-4bit']);
});
afterEach(() => vi.clearAllMocks());

describe('localCachedModelIds', () => {
  it.each([
    ['the shipped API record', local],
    ['a marked CLI wrapper', { ...local, id: 'opencode-mtplx', type: 'cli', mtplxBacked: true }],
    ['a marked TUI wrapper', { ...local, id: 'opencode-mtplx-tui', type: 'tui', mtplxBacked: true }],
  ])('lists complete checkpoints for %s without importing MTPLX lifecycle policy', async (_label, provider) => {
    expect(await localCachedModelIds(provider)).toEqual(['Vendor/Example-MTPLX', 'Vendor/Older-MTPLX']);
    expect(mocks.cache).toHaveBeenCalledOnce();
    expect(mocks.slotstream).not.toHaveBeenCalled();
  });

  it.each([
    ['an unrelated local API on the same port', { ...local, id: 'example-api' }],
    ['a peer MTPLX', { ...local, endpoint: 'http://192.0.2.10:8000/v1' }],
    ['a cloud API', { id: 'openai', type: 'api', endpoint: 'https://api.example.com/v1' }],
  ])('does not inspect local caches for %s', async (_label, provider) => {
    expect(await localCachedModelIds(provider)).toBeNull();
    expect(mocks.findCommand).not.toHaveBeenCalled();
    expect(mocks.cache).not.toHaveBeenCalled();
    expect(mocks.slotstream).not.toHaveBeenCalled();
  });

  it('does not invoke a missing binary or bootstrap a cold runtime during refresh', async () => {
    mocks.findCommand.mockReturnValueOnce(null);
    expect(await localCachedModelIds(local)).toBeNull();
    expect(mocks.runtime).not.toHaveBeenCalled();
    mocks.runtime.mockResolvedValueOnce({ ready: false });
    expect(await localCachedModelIds(local)).toBeNull();
    expect(mocks.cache).not.toHaveBeenCalled();
  });

  it('keeps an unreadable cache distinct from a successfully read empty cache', async () => {
    mocks.cache.mockResolvedValueOnce({ models: null, error: 'listing failed' });
    expect(await localCachedModelIds(local)).toBeNull();
    mocks.cache.mockResolvedValueOnce({ models: [], error: null });
    expect(await localCachedModelIds(local)).toEqual([]);
  });

  it('preserves the Slotstream manager adapter and its refusal result', async () => {
    const provider = { id: 'slotstream', type: 'api', endpoint: 'http://127.0.0.1:5564/v1' };
    expect(await localCachedModelIds(provider)).toEqual(['example-4bit']);
    expect(mocks.slotstream).toHaveBeenCalledWith(provider);
    mocks.slotstream.mockResolvedValueOnce(null);
    expect(await localCachedModelIds(provider)).toBeNull();
    expect(mocks.findCommand).not.toHaveBeenCalled();
  });
});
