import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { atomicWrite } from './internal/atomicWrite.js';
import { createProviderService } from './providers.js';

// The whole point of `refreshProviderModelsBatch` is HOW MANY TIMES the file is
// written, and `saveProviders` is private. `atomicWrite` is the one observable
// it funnels through, so wrap it in a counting spy that still does the real
// write — a stub would make every "and the value landed" assertion vacuous.
vi.mock('./internal/atomicWrite.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, atomicWrite: vi.fn(actual.atomicWrite) };
});

// Temp dir, NOT a cwd-rooted one — see providerStatus.test.js (#3823).
let TEST_DATA_DIR;

/**
 * Fake Ollama daemon. Counts `/api/tags` hits PER base URL so a test can assert
 * "one probe per daemon", and answers `/api/show` with tool capability so every
 * listed model survives the tool-use filter.
 */
const stubOllama = (modelsByBase) => {
  const tagHits = new Map();
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const href = String(url);
    if (href.endsWith('/api/tags')) {
      const base = href.slice(0, -'/api/tags'.length);
      tagHits.set(base, (tagHits.get(base) || 0) + 1);
      const names = modelsByBase[base];
      if (!names) return { ok: false, status: 404 };
      return { ok: true, json: async () => ({ models: names.map((n) => ({ name: n })) }) };
    }
    if (href.endsWith('/api/show')) {
      return { ok: true, json: async () => ({ capabilities: ['completion', 'tools'] }) };
    }
    return { ok: false, status: 404 };
  }));
  return tagHits;
};

const LOCAL = 'http://localhost:11434';
const REMOTE = 'http://192.0.2.10:11434';

const ollamaProvider = (name, { type = 'cli', base = LOCAL, models = ['stale-model'] } = {}) => ({
  name,
  type,
  command: 'claude',
  ollamaBacked: true,
  models,
  envVars: { ANTHROPIC_BASE_URL: base },
});

describe('refreshProviderModelsBatch — one providers.json write per fan-out', () => {
  let providerService;

  beforeEach(async () => {
    TEST_DATA_DIR = await mkdtemp(join(tmpdir(), 'portos-providers-batch-'));
    providerService = createProviderService({
      dataDir: TEST_DATA_DIR,
      providersFile: 'providers.json',
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (TEST_DATA_DIR) await rm(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it('saves ONCE for a multi-provider, multi-group batch', async () => {
    const tagHits = stubOllama({ [LOCAL]: ['qwen2.5:7b'], [REMOTE]: ['gemma2:9b'] });
    const local1 = await providerService.createProvider(ollamaProvider('Local One'));
    const local2 = await providerService.createProvider(ollamaProvider('Local Two', { type: 'tui' }));
    const remote = await providerService.createProvider(ollamaProvider('Remote', { base: REMOTE }));

    // Ignore the three creates — only the batch's own writes are under test.
    atomicWrite.mockClear();

    const groups = await providerService.refreshProviderModelsBatch([local1.id, local2.id, remote.id]);

    // Three providers, two daemons — one write total, not one per provider and
    // not one per group.
    expect(atomicWrite).toHaveBeenCalledTimes(1);
    // …and one probe per daemon, not per provider.
    expect(tagHits.get(LOCAL)).toBe(1);
    expect(tagHits.get(REMOTE)).toBe(1);

    expect(groups.map((g) => g.status)).toEqual(['updated', 'updated']);
    expect(groups.map((g) => g.ids)).toEqual([[local1.id, local2.id], [remote.id]]);

    // Every member got the answer, and it survived the single write to disk.
    const { providers } = await providerService.getAllProviders();
    const byId = Object.fromEntries(providers.map((p) => [p.id, p]));
    expect(byId[local1.id].models).toEqual(['qwen2.5:7b']);
    expect(byId[local2.id].models).toEqual(['qwen2.5:7b']);
    expect(byId[remote.id].models).toEqual(['gemma2:9b']);
    // Unrelated fields survive the batch apply.
    expect(byId[local1.id].ollamaBacked).toBe(true);
    expect(byId[local2.id].type).toBe('tui');
  });

  it('persists a legitimately EMPTY catalog rather than skipping it', async () => {
    // `[]` is a real answer (the user just deleted their last model) — only a
    // failed or missing probe is a skip.
    stubOllama({ [LOCAL]: [] });
    const a = await providerService.createProvider(ollamaProvider('Local One'));
    const b = await providerService.createProvider(ollamaProvider('Local Two', { type: 'tui' }));
    atomicWrite.mockClear();

    const groups = await providerService.refreshProviderModelsBatch([a.id, b.id]);

    expect(groups).toHaveLength(1);
    expect(groups[0].status).toBe('updated');
    expect(atomicWrite).toHaveBeenCalledTimes(1);
    expect((await providerService.getProviderById(a.id)).models).toEqual([]);
    expect((await providerService.getProviderById(b.id)).models).toEqual([]);
  });

  it('writes NOTHING when the shared probe fails, and reports the group once', async () => {
    stubOllama({}); // every /api/tags 404s
    const a = await providerService.createProvider(ollamaProvider('Local One'));
    const b = await providerService.createProvider(ollamaProvider('Local Two', { type: 'tui' }));
    atomicWrite.mockClear();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const groups = await providerService.refreshProviderModelsBatch([a.id, b.id]);
    errSpy.mockRestore();

    expect(groups).toHaveLength(1);
    expect(groups[0].status).toBe('failed');
    expect(groups[0].ids).toEqual([a.id, b.id]);
    expect(groups[0].error).toBeInstanceOf(Error);
    // No half-write: the stored lists are untouched.
    expect(atomicWrite).not.toHaveBeenCalled();
    expect((await providerService.getProviderById(a.id)).models).toEqual(['stale-model']);
    expect((await providerService.getProviderById(b.id)).models).toEqual(['stale-model']);
  });

  it('one failing group does not cost the healthy groups their update', async () => {
    // The remote daemon is unreachable; the local one answers. A single write
    // still lands, carrying only the group that succeeded.
    const tagHits = stubOllama({ [LOCAL]: ['qwen2.5:7b'] });
    const local = await providerService.createProvider(ollamaProvider('Local One'));
    const remote = await providerService.createProvider(ollamaProvider('Remote', { base: REMOTE }));
    atomicWrite.mockClear();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const groups = await providerService.refreshProviderModelsBatch([local.id, remote.id]);
    errSpy.mockRestore();

    expect(groups.map((g) => g.status)).toEqual(['updated', 'failed']);
    expect(atomicWrite).toHaveBeenCalledTimes(1);
    expect(tagHits.get(REMOTE)).toBe(1);
    expect((await providerService.getProviderById(local.id)).models).toEqual(['qwen2.5:7b']);
    expect((await providerService.getProviderById(remote.id)).models).toEqual(['stale-model']);
  });

  it('reports an unknown id as missing without probing or blocking the rest', async () => {
    const tagHits = stubOllama({ [LOCAL]: ['qwen2.5:7b'] });
    const real = await providerService.createProvider(ollamaProvider('Local One'));
    atomicWrite.mockClear();

    const groups = await providerService.refreshProviderModelsBatch(['no-such-provider', real.id]);

    expect(groups[0]).toEqual({ ids: ['no-such-provider'], leadId: 'no-such-provider', status: 'missing' });
    expect(groups[1].status).toBe('updated');
    expect(tagHits.get(LOCAL)).toBe(1);
    expect(atomicWrite).toHaveBeenCalledTimes(1);
    expect((await providerService.getProviderById(real.id)).models).toEqual(['qwen2.5:7b']);
  });

  it('keeps a provider that has no shared probe in its own group', async () => {
    // An `api`-type Ollama provider persists the UNFILTERED tag list, so it must
    // never share a bucket with the tool-filtered CLI/TUI probe of the SAME
    // daemon — but it still rides the same single write.
    stubOllama({ [LOCAL]: ['qwen2.5:7b', 'embed-only:1b'] });
    const cli = await providerService.createProvider(ollamaProvider('Local CLI'));
    const api = await providerService.createProvider({
      name: 'Ollama API', type: 'api', endpoint: LOCAL, models: ['stale-model'],
    });
    atomicWrite.mockClear();

    const groups = await providerService.refreshProviderModelsBatch([cli.id, api.id]);

    expect(groups.map((g) => g.ids)).toEqual([[cli.id], [api.id]]);
    expect(atomicWrite).toHaveBeenCalledTimes(1);
    // The api arm keeps every tag; the tools arm filters — proof they did not
    // share one probe's answer.
    expect((await providerService.getProviderById(api.id)).models).toEqual(['qwen2.5:7b', 'embed-only:1b']);
    expect((await providerService.getProviderById(cli.id)).models).toEqual(['qwen2.5:7b', 'embed-only:1b']);
  });

  it('lands the same stored state as refreshing each provider one by one', async () => {
    // The parity that makes the batch a drop-in for the loop it replaces: same
    // models on every provider, at a fraction of the writes.
    stubOllama({ [LOCAL]: ['qwen2.5:7b'], [REMOTE]: ['gemma2:9b'] });
    const a = await providerService.createProvider(ollamaProvider('Local One'));
    const b = await providerService.createProvider(ollamaProvider('Local Two', { type: 'tui' }));
    const c = await providerService.createProvider(ollamaProvider('Remote', { base: REMOTE }));

    atomicWrite.mockClear();
    for (const id of [a.id, b.id, c.id]) await providerService.refreshProviderModels(id);
    const oneByOneWrites = atomicWrite.mock.calls.length;
    const oneByOne = (await providerService.getAllProviders()).providers;

    // Reset the stored lists and do it again as a batch.
    for (const id of [a.id, b.id, c.id]) await providerService.updateProvider(id, { models: ['stale-model'] });
    atomicWrite.mockClear();
    await providerService.refreshProviderModelsBatch([a.id, b.id, c.id]);
    const batched = (await providerService.getAllProviders()).providers;

    expect(batched).toEqual(oneByOne);
    expect(oneByOneWrites).toBe(3);
    expect(atomicWrite).toHaveBeenCalledTimes(1);
  });

  it('is a no-op for an empty id list', async () => {
    stubOllama({ [LOCAL]: ['qwen2.5:7b'] });
    await providerService.createProvider(ollamaProvider('Local One'));
    atomicWrite.mockClear();

    expect(await providerService.refreshProviderModelsBatch([])).toEqual([]);
    expect(await providerService.refreshProviderModelsBatch(undefined)).toEqual([]);
    expect(atomicWrite).not.toHaveBeenCalled();
  });

  it('probes a duplicated id once and writes it once', async () => {
    const tagHits = stubOllama({ [LOCAL]: ['qwen2.5:7b'] });
    const p = await providerService.createProvider(ollamaProvider('Local One'));
    atomicWrite.mockClear();

    const groups = await providerService.refreshProviderModelsBatch([p.id, p.id, p.id]);

    expect(groups).toHaveLength(1);
    expect(groups[0].ids).toEqual([p.id]);
    expect(tagHits.get(LOCAL)).toBe(1);
    expect(atomicWrite).toHaveBeenCalledTimes(1);
  });
});
