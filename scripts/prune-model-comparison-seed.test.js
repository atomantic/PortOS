import { describe, it, expect } from 'vitest';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { inScopeModels, prunedSeed } from './prune-model-comparison-seed.js';
import { BACKENDS, LOCAL_LLM_CATALOG, entryIdsForBackend } from '../server/lib/localLlmCatalog.js';
import { catalogSlugForProviderModel, localCatalogBenchmarkModels } from '../server/lib/comparisonModelScope.js';

const root = join(import.meta.dirname, '..');
const readSeed = async () => JSON.parse(await readFile(join(root, 'data.reference/model-comparison.json'), 'utf8'));

describe('model comparison seed scope', () => {
  it('keeps official Grok 4.7 context-tier prices distinct', async () => {
    const rows = (await readSeed()).observations.filter(row => row.model === 'grok-4.7');
    expect(rows.map(row => [row.inputPerMillion.value, row.outputPerMillion.value])).toEqual([[2, 6], [4, 12]]);
    expect(new Set(rows.map(row => row.configuration)).size).toBe(2);
    for (const row of rows) {
      expect(row.inputPerMillion.source.url).toBe('https://docs.x.ai/developers/models/grok-4.7');
      for (const metric of ['quality', 'costPerTask', 'reasoningPerMillion', 'responseSeconds', 'tokensPerSecond', 'quota']) expect(row[metric]).toBeNull();
    }
  });

  it('ships public benchmark and price observations without PortOS run data', async () => {
    const { observations } = await readSeed();
    expect(observations.length).toBeGreaterThan(0);
    const scored = observations.filter(row => row.quality);
    const priced = observations.filter(row => row.inputPerMillion || row.outputPerMillion || row.reasoningPerMillion);
    expect(scored.length).toBeGreaterThan(0);
    expect(priced.length).toBeGreaterThan(0);
    expect(observations.some(row => row.quality && (row.inputPerMillion || row.outputPerMillion))).toBe(true);

    const metricFields = [
      'quality', 'costPerTask', 'apiEquivalentCost', 'inputPerMillion', 'outputPerMillion',
      'reasoningPerMillion', 'responseSeconds', 'tokensPerSecond', 'tokensPerRun',
      'inputTokens', 'outputTokens', 'quota',
    ];
    for (const row of observations) {
      expect(row.benchmark).not.toMatch(/^(?:Artificial Analysis Intelligence Index|SWE-bench\b)/i);
      expect(row.id).not.toMatch(/^(?:aa-v\d|swebench-)/i);
      for (const field of metricFields) {
        if (row[field]) expect(row[field].source.url).toMatch(/^https:\/\//);
      }
    }
  });

  it('ships only models a configured provider or a current frontier anchor can dispatch', async () => {
    const [seed, scope] = await Promise.all([readSeed(), inScopeModels()]);
    const outOfScope = [...new Set(seed.observations.map(row => row.model))].filter(model => !scope.has(model));
    expect(outOfScope).toEqual([]);
  });

  it('is already pruned — the checked-in seed equals the pruned seed', async () => {
    const [seed, { pruned }] = await Promise.all([readSeed(), prunedSeed()]);
    expect(seed.observations).toEqual(pruned.observations);
  });

  it('scopes local model identities without claiming that hosted prices apply locally', async () => {
    const declared = localCatalogBenchmarkModels();
    expect(declared.size).toBeGreaterThan(0);
    for (const entry of LOCAL_LLM_CATALOG.filter(model => model.benchmarkModel)) {
      for (const backend of BACKENDS) {
        for (const id of entryIdsForBackend(entry, backend)) {
          expect(catalogSlugForProviderModel(id)).toBe(entry.benchmarkModel);
        }
      }
    }
  });

  it('carries no retired model generations in the comparison catalog', async () => {
    const models = new Set((await readSeed()).observations.map(row => row.model));
    for (const retired of ['claude-2.0', 'gpt-4', 'palm-2', 'llama-2-chat-70b']) expect(models.has(retired)).toBe(false);
  });
});
