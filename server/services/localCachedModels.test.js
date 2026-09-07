/**
 * The routing half of the cached-checkpoint refresh hook.
 *
 * The per-runtime probes are pinned in their own managers' suites; what this
 * file guards is the dispatch around them: which providers reach a probe at all,
 * and — the property with a real cost behind it — that a provider belonging to
 * neither runtime never loads either daemon manager. That import is the only
 * reason the hook is a module rather than a direct call, so a regression there
 * is silent and expensive rather than visible.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mtplxProbe = vi.hoisted(() => vi.fn());
const slotstreamProbe = vi.hoisted(() => vi.fn());
const loaded = vi.hoisted(() => []);

vi.mock('./mtplxServerManager.js', () => {
  loaded.push('mtplx');
  return { mtplxCachedModelIds: mtplxProbe };
});
vi.mock('./slotstreamServerManager.js', () => {
  loaded.push('slotstream');
  return { slotstreamCachedModelIds: slotstreamProbe };
});

import { localCachedModelIds } from './localCachedModels.js';

beforeEach(() => {
  loaded.length = 0;
  mtplxProbe.mockResolvedValue(['Vendor/Example-MTPLX']);
  slotstreamProbe.mockResolvedValue(['example-4bit']);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('localCachedModelIds', () => {
  // FIRST in the file on purpose. A mock factory runs once per module, so
  // `loaded` only ever records the very first import of each manager — after any
  // routing case below has run, this assertion would read empty however the
  // dispatcher behaved. Its positive control at the end is what proves the
  // recorder works at all, and it is only available here.
  it('loads neither daemon manager for a provider of no cached-catalog runtime', async () => {
    expect(await localCachedModelIds({ id: 'claude-ollama', type: 'cli', ollamaBacked: true, endpoint: 'http://127.0.0.1:11434/v1' })).toBeNull();
    expect(await localCachedModelIds({ id: 'openai', type: 'api', endpoint: 'https://api.example.com/v1' })).toBeNull();
    // The whole reason this is a module of lazy loaders rather than a direct
    // call: an install running neither daemon must not pull their PM2/daemon
    // subtrees in on an unrelated provider's refresh.
    expect(loaded).toEqual([]);

    await localCachedModelIds({ id: 'mtplx', type: 'api', endpoint: 'http://127.0.0.1:8000/v1' });
    expect(loaded).toEqual(['mtplx']);
  });

  it.each([
    ['the marked OpenCode wrapper', { id: 'opencode-mtplx', type: 'cli', command: 'opencode', mtplxBacked: true, endpoint: 'http://127.0.0.1:8000/v1' }],
    // The shipped record is a plain OpenAI-compatible endpoint with no vendor
    // marker, so its id is the only thing left to route on.
    ['the unmarked API record', { id: 'mtplx', type: 'api', endpoint: 'http://127.0.0.1:8000/v1' }],
  ])('routes %s to the MTPLX probe', async (_label, provider) => {
    expect(await localCachedModelIds(provider)).toEqual(['Vendor/Example-MTPLX']);
    expect(mtplxProbe).toHaveBeenCalledWith(provider);
    expect(slotstreamProbe).not.toHaveBeenCalled();
  });

  it('routes a Slotstream provider to the Slotstream probe', async () => {
    const provider = { id: 'slotstream', type: 'api', endpoint: 'http://127.0.0.1:5564/v1' };
    expect(await localCachedModelIds(provider)).toEqual(['example-4bit']);
    expect(mtplxProbe).not.toHaveBeenCalled();
  });

  // A daemon on a tailnet peer is someone else's process and its checkpoints are
  // on that machine — answering with THIS host's cache would put models the
  // provider cannot reach into its catalog.
  it('refuses a provider pointed at another machine even when it names the runtime', async () => {
    expect(await localCachedModelIds({ id: 'mtplx', type: 'api', mtplxBacked: true, endpoint: 'http://100.64.0.5:8000/v1' })).toBeNull();
    expect(mtplxProbe).not.toHaveBeenCalled();
  });


  it('passes a probe’s own refusal straight through', async () => {
    // `null` from a probe means "read nothing usable" — the toolkit leaves the
    // endpoint's answer untouched, which is not the same as this router deciding
    // the provider was never a candidate.
    mtplxProbe.mockResolvedValue(null);
    expect(await localCachedModelIds({ id: 'mtplx', type: 'api', endpoint: 'http://127.0.0.1:8000/v1' })).toBeNull();
    expect(mtplxProbe).toHaveBeenCalled();
  });
});
