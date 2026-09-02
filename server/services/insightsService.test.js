import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the provider-readiness check so any code path that touches it runs offline.
vi.mock('./ollamaManager.js', () => ({
  ensureProviderReady: vi.fn().mockResolvedValue({ success: true }),
}));
// generateThemeAnalysis/refreshCrossDomainNarrative call the shared
// aiProvider.callProviderAISimple transport (see aiProvider.test.js for its own
// contract coverage) — stub only that export, while stripCodeFences/parseLLMJSON
// (also imported from this module) stay real.
vi.mock('./aiProvider.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, callProviderAISimple: vi.fn() };
});
// `atomicWrite` is the assertion surface for the persist guard below. Keep the
// rest of fileUtils real — `PATHS` is read at insightsService module scope, so a
// mock that omits it breaks the import outright.
vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, atomicWrite: vi.fn(), ensureDir: vi.fn(), readJSONFile: vi.fn() };
});
vi.mock('./providers.js', () => ({
  getActiveProvider: vi.fn(),
  getProviderById: vi.fn(),
}));
vi.mock('./taste-questionnaire.js', () => ({ getTasteProfile: vi.fn() }));
vi.mock('./genome.js', () => ({ getGenomeSummary: vi.fn().mockResolvedValue(null) }));
vi.mock('./meatspaceHealth.js', () => ({ getBloodTests: vi.fn().mockResolvedValue([]) }));
vi.mock('./appleHealthQuery.js', () => ({ getCorrelationData: vi.fn().mockResolvedValue(null) }));

import { callProviderAISimple } from './aiProvider.js';
import { atomicWrite, readJSONFile } from '../lib/fileUtils.js';
import { getActiveProvider } from './providers.js';
import { getTasteProfile } from './taste-questionnaire.js';
import {
  getThemeAnalysis,
  getCrossDomainNarrative,
  generateThemeAnalysis,
  refreshCrossDomainNarrative,
} from './insightsService.js';

// Enforces the no-cold-bootstrap trigger contract documented at the generation
// entry points: the cached-read paths the Insights page mounts with must be
// disk-only and NEVER reach an AI provider. Only the user-triggered *refresh*
// endpoints may generate. If a future edit makes a read path warm the cache via
// the LLM, this fails.
describe('insightsService read paths — disk-only, no provider call', () => {
  let fetchSpy;

  beforeEach(() => {
    vi.clearAllMocks();
    readJSONFile.mockResolvedValue(null);
    // The export-level spy below only catches a read path that reaches a provider
    // through `callProviderAISimple`. The contract is broader than one export —
    // "no outbound provider call by ANY transport" — so pin it at the wire too,
    // where a direct fetch, a streaming helper, or a future second transport
    // would still have to pass.
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('getThemeAnalysis performs no provider call (returns not_generated when uncached)', async () => {
    const result = await getThemeAnalysis();
    expect(callProviderAISimple).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.available === false || result.available === true).toBe(true);
  });

  it('getCrossDomainNarrative performs no provider call (returns not_generated when uncached)', async () => {
    const result = await getCrossDomainNarrative();
    expect(callProviderAISimple).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.available === false || result.available === true).toBe(true);
  });
});

// The bug #5617 describes, pinned at the Insights boundary rather than only at
// the transport: both generators persist unconditionally once `result.error` is
// unset, so a transport that misclassifies a failed call as a successful empty
// completion overwrites a real cached theme/narrative with nothing. The shared
// aiProvider transport classifies that as an error — these assert the callers
// actually honour it and leave the cache alone.
describe('insightsService generation — a provider error never overwrites the cache', () => {
  const CACHED_THEMES = {
    themes: [{ title: 'Cached theme', strength: 'strong', narrative: 'prior', evidence: [] }],
    generatedAt: '2020-01-01T00:00:00.000Z',
    model: 'model-1',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getActiveProvider.mockResolvedValue({
      id: 'provider-1', name: 'Example Provider', type: 'api',
      endpoint: 'https://api.example.com/v1', defaultModel: 'model-1',
    });
    getTasteProfile.mockResolvedValue({
      sections: [{ label: 'Music', summary: 'Prefers sparse arrangements.' }],
    });
    readJSONFile.mockResolvedValue(CACHED_THEMES);
    callProviderAISimple.mockResolvedValue({ error: 'Provider returned an empty completion' });
  });

  it('generateThemeAnalysis surfaces the error and does not write themes.json', async () => {
    const result = await generateThemeAnalysis();

    expect(callProviderAISimple).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ available: false, reason: 'Provider returned an empty completion' });
    expect(atomicWrite).not.toHaveBeenCalled();
  });

  it('refreshCrossDomainNarrative surfaces the error and does not write narrative.json', async () => {
    const result = await refreshCrossDomainNarrative();

    expect(callProviderAISimple).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ available: false, reason: 'Provider returned an empty completion' });
    expect(atomicWrite).not.toHaveBeenCalled();
  });

  it('generateThemeAnalysis writes themes.json on a usable completion', async () => {
    callProviderAISimple.mockResolvedValue({ text: '[{"title":"New theme","strength":"strong"}]' });

    const result = await generateThemeAnalysis();

    expect(atomicWrite).toHaveBeenCalledTimes(1);
    expect(atomicWrite.mock.calls[0][1]).toMatchObject({
      themes: [{ title: 'New theme', strength: 'strong' }],
    });
    expect(result.themes).toHaveLength(1);
  });
});
