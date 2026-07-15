import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';
import {
  PERSONALITY_TRAIT_KEYS,
  PERSONALITY_TAXONOMY_VERSION
} from '../lib/modelPersonalityValidation.js';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'model-personality-test-'));

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: TEST_DATA_ROOT }));

// Full stub — promptRunner drags in the runner/provider stack transitively.
vi.mock('../lib/promptRunner.js', () => ({
  resolveProviderAndModel: vi.fn(),
  runPromptThroughProvider: vi.fn(),
  assertProvider: (provider, { message } = {}) => {
    if (!provider) throw new Error(message || 'no provider');
  }
}));
vi.mock('./promptService.js', () => ({
  buildPrompt: vi.fn(async (stage) => `PROMPT:${stage}`)
}));
vi.mock('./digital-twin-meta.js', () => ({
  loadMeta: vi.fn(async () => ({}))
}));

const { resolveProviderAndModel, runPromptThroughProvider } = await import('../lib/promptRunner.js');
const { buildPrompt } = await import('./promptService.js');
const { loadMeta } = await import('./digital-twin-meta.js');
const svc = await import('./modelPersonality.js');

afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

const fullTraits = Object.fromEntries(
  PERSONALITY_TRAIT_KEYS.map((k) => [k, { score: 0.4, rationale: `r-${k}` }])
);
const profileText = JSON.stringify({ traits: fullTraits, summary: 'measured and dry' });
const alignmentText = JSON.stringify({
  alignmentScore: 0.66,
  dimensions: { agreeableness: { score: 0.7, note: 'close' } }
});

const provider = { id: 'prov-1', type: 'api', name: 'Prov One' };
const scorerProvider = { id: 'prov-scorer', type: 'api', name: 'Scorer' };

function mockProfileRun({ effectiveModel = 'effective-model', effectiveProviderId = 'prov-1' } = {}) {
  runPromptThroughProvider.mockResolvedValueOnce({
    text: profileText,
    runId: 'run-a',
    model: effectiveModel,
    provider: { id: effectiveProviderId }
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  resolveProviderAndModel.mockResolvedValue({ provider, selectedModel: 'requested-model' });
  loadMeta.mockResolvedValue({});
  // Reset persisted state between tests (fresh files under the temp root).
  rmSync(join(TEST_DATA_ROOT, 'model-personality'), { recursive: true, force: true });
});

describe('runPersonalityTest', () => {
  it('persists the EFFECTIVE model/provider the runner reports, not the requested one', async () => {
    mockProfileRun({ effectiveModel: 'actually-ran-model', effectiveProviderId: 'prov-swapped' });

    const record = await svc.runPersonalityTest({
      providerId: 'prov-1', model: 'requested-model', includeAlignment: false
    });

    expect(record.model).toBe('actually-ran-model');
    expect(record.providerId).toBe('prov-swapped');
    expect(record.taxonomyVersion).toBe(PERSONALITY_TAXONOMY_VERSION);
    expect(Object.keys(record.traits)).toEqual(expect.arrayContaining(PERSONALITY_TRAIT_KEYS));

    // Survives a re-read from disk (restart-equivalent).
    const onDisk = JSON.parse(
      readFileSync(join(TEST_DATA_ROOT, 'model-personality', 'results.json'), 'utf8')
    );
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0].model).toBe('actually-ran-model');
  });

  it('passes a schema-bearing single self-eval call to the runner', async () => {
    mockProfileRun();
    await svc.runPersonalityTest({ providerId: 'prov-1', includeAlignment: false });

    expect(runPromptThroughProvider).toHaveBeenCalledTimes(1);
    const args = runPromptThroughProvider.mock.calls[0][0];
    expect(args.provider).toBe(provider);
    expect(args.source).toBe('model-personality-profile');
    expect(args.model).toBe('requested-model');
    expect(args.responseSchema).toBeTruthy();
    expect(buildPrompt).toHaveBeenCalledWith('model-personality-profile', {
      traitKeys: PERSONALITY_TRAIT_KEYS.join(', ')
    });
  });

  it('skips the alignment call with a clear message when the twin has no analyzed traits', async () => {
    mockProfileRun();
    loadMeta.mockResolvedValue({ traits: undefined });

    const record = await svc.runPersonalityTest({ providerId: 'prov-1', includeAlignment: true });

    expect(record.alignmentSkipped).toBe(svc.ALIGNMENT_SKIPPED_NO_TRAITS);
    expect(record.alignment).toBeUndefined();
    expect(runPromptThroughProvider).toHaveBeenCalledTimes(1); // profile only — no scorer call
  });

  it('scores alignment against stored twin traits with the configured scorer provider', async () => {
    await svc.updateSettings({ scorerProviderId: 'prov-scorer', scorerModel: 'scorer-model' });
    loadMeta.mockResolvedValue({ traits: { bigFive: { openness: 0.8 }, valuesHierarchy: [] } });
    mockProfileRun();
    resolveProviderAndModel
      .mockResolvedValueOnce({ provider, selectedModel: 'requested-model' }) // profile
      .mockResolvedValueOnce({ provider: scorerProvider, selectedModel: 'scorer-model' }); // scorer
    runPromptThroughProvider.mockResolvedValueOnce({
      text: alignmentText, runId: 'run-b', model: 'scorer-effective', provider: { id: 'prov-scorer' }
    });

    const record = await svc.runPersonalityTest({ providerId: 'prov-1', includeAlignment: true });

    expect(runPromptThroughProvider).toHaveBeenCalledTimes(2);
    expect(record.alignment).toEqual({
      alignmentScore: 0.66,
      dimensions: { agreeableness: { score: 0.7, note: 'close' } }
    });
    expect(record.scorerProviderId).toBe('prov-scorer');
    expect(record.scorerModel).toBe('scorer-effective');
    // The scorer resolution honored the saved settings.
    expect(resolveProviderAndModel).toHaveBeenLastCalledWith({
      providerId: 'prov-scorer', model: 'scorer-model'
    });
  });

  it('persists the self-profile with alignmentError when the scorer call fails', async () => {
    loadMeta.mockResolvedValue({ traits: { bigFive: { openness: 0.8 } } });
    mockProfileRun({ effectiveModel: 'kept-model' });
    runPromptThroughProvider.mockRejectedValueOnce(new Error('scorer exploded'));

    const record = await svc.runPersonalityTest({ providerId: 'prov-1', includeAlignment: true });

    // Call 1's paid result survives; the failure is recorded, not thrown.
    expect(record.model).toBe('kept-model');
    expect(record.alignment).toBeUndefined();
    expect(record.alignmentError).toBe('scorer exploded');
    expect(await svc.getHistory()).toHaveLength(1);
  });

  it('defaults includeAlignment from settings when the caller omits it', async () => {
    await svc.updateSettings({ defaultIncludeAlignment: false });
    mockProfileRun();

    const record = await svc.runPersonalityTest({ providerId: 'prov-1' });

    expect(record.alignment).toBeUndefined();
    expect(record.alignmentSkipped).toBeUndefined();
    expect(runPromptThroughProvider).toHaveBeenCalledTimes(1);
  });

  it('caps history at the configured historyCap, newest first', async () => {
    await svc.updateSettings({ historyCap: 3 });
    for (let i = 0; i < 5; i++) {
      mockProfileRun({ effectiveModel: `model-${i}` });
      await svc.runPersonalityTest({ providerId: 'prov-1', includeAlignment: false });
    }
    const history = await svc.getHistory();
    expect(history).toHaveLength(3);
    expect(history.map((r) => r.model)).toEqual(['model-4', 'model-3', 'model-2']);
  });

  it('tags the record with personaId when supplied', async () => {
    mockProfileRun();
    const record = await svc.runPersonalityTest({
      providerId: 'prov-1', includeAlignment: false, personaId: 'persona-9'
    });
    expect(record.personaId).toBe('persona-9');
  });
});

describe('history & settings', () => {
  it('getHistory honors limit and tolerates a missing file', async () => {
    expect(await svc.getHistory()).toEqual([]);
    mockProfileRun();
    await svc.runPersonalityTest({ providerId: 'prov-1', includeAlignment: false });
    mockProfileRun();
    await svc.runPersonalityTest({ providerId: 'prov-1', includeAlignment: false });
    expect(await svc.getHistory(1)).toHaveLength(1);
    expect(await svc.getHistory()).toHaveLength(2);
  });

  it('deleteResult removes a run and reports false for an unknown id', async () => {
    mockProfileRun();
    const record = await svc.runPersonalityTest({ providerId: 'prov-1', includeAlignment: false });
    expect(await svc.deleteResult('nope')).toBe(false);
    expect(await svc.deleteResult(record.runId)).toBe(true);
    expect(await svc.getHistory()).toEqual([]);
  });

  it('falls back to the default historyCap when a hand-edited value is malformed', async () => {
    const { writeFileSync, mkdirSync } = await import('fs');
    mkdirSync(join(TEST_DATA_ROOT, 'model-personality'), { recursive: true });
    writeFileSync(
      join(TEST_DATA_ROOT, 'model-personality', 'settings.json'),
      JSON.stringify({ historyCap: 'abc' })
    );
    expect((await svc.getSettings()).historyCap).toBe(svc.DEFAULT_SETTINGS.historyCap);
    // The malformed cap must not wipe history via slice(0, 'abc') → [].
    mockProfileRun();
    await svc.runPersonalityTest({ providerId: 'prov-1', includeAlignment: false });
    expect(await svc.getHistory()).toHaveLength(1);
  });

  it('merges settings over defaults and persists them', async () => {
    expect(await svc.getSettings()).toEqual({ ...svc.DEFAULT_SETTINGS });
    const next = await svc.updateSettings({ historyCap: 42 });
    expect(next.historyCap).toBe(42);
    expect(next.defaultIncludeAlignment).toBe(true); // untouched default survives
    expect((await svc.getSettings()).historyCap).toBe(42);
  });
});

describe('twinHasTraits', () => {
  it('detects each trait surface and rejects empty shapes', () => {
    expect(svc.twinHasTraits(null)).toBe(false);
    expect(svc.twinHasTraits({})).toBe(false);
    expect(svc.twinHasTraits({ valuesHierarchy: [] })).toBe(false);
    expect(svc.twinHasTraits({ bigFive: { openness: 0.5 } })).toBe(true);
    expect(svc.twinHasTraits({ communicationProfile: { formality: 0.5 } })).toBe(true);
    expect(svc.twinHasTraits({ valuesHierarchy: [{ value: 'honesty', priority: 1 }] })).toBe(true);
  });
});

describe('shipped prompt templates', () => {
  const stagesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data.reference', 'prompts', 'stages');
  const tokensOf = (name) =>
    [...readFileSync(join(stagesDir, name), 'utf8').matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]);

  it('model-personality-profile.md interpolates exactly the variables the service passes', () => {
    expect([...new Set(tokensOf('model-personality-profile.md'))]).toEqual(['traitKeys']);
  });

  it('model-personality-alignment-scorer.md interpolates exactly the variables the service passes', () => {
    expect([...new Set(tokensOf('model-personality-alignment-scorer.md'))].sort()).toEqual([
      'selfProfile', 'twinTraits'
    ]);
  });

  it('stage-config.json ships both stages flagged returnsJson', () => {
    const config = JSON.parse(
      readFileSync(join(stagesDir, '..', 'stage-config.json'), 'utf8')
    );
    for (const key of ['model-personality-profile', 'model-personality-alignment-scorer']) {
      expect(config.stages[key], key).toBeTruthy();
      expect(config.stages[key].returnsJson, key).toBe(true);
    }
  });
});
