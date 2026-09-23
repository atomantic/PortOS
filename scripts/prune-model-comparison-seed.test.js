import { describe, it, expect } from 'vitest';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { inScopeModels, prunedSeed } from './prune-model-comparison-seed.js';
import { BACKENDS, LOCAL_LLM_CATALOG, entryIdsForBackend } from '../server/lib/localLlmCatalog.js';
import { catalogSlugForProviderModel, localCatalogBenchmarkModels } from '../server/lib/comparisonModelScope.js';

const root = join(import.meta.dirname, '..');
const readSeed = async () => JSON.parse(await readFile(join(root, 'data.reference/model-comparison.json'), 'utf8'));

describe('model comparison seed scope', () => {
  it('keeps Grok 4.7 context-tier prices distinct from historical benchmark measurements', async () => {
    const rows = (await readSeed()).observations.filter(row => row.model === 'grok-4.7');
    expect(rows.map(row => [row.inputPerMillion.value, row.outputPerMillion.value])).toEqual([[2, 6], [4, 12]]);
    expect(new Set(rows.map(row => row.configuration)).size).toBe(2);
    for (const row of rows) {
      expect(row.inputPerMillion.source.url).toBe('https://docs.x.ai/developers/models/grok-4.7');
      for (const metric of ['quality', 'costPerTask', 'reasoningPerMillion', 'responseSeconds', 'tokensPerSecond', 'quota']) expect(row[metric]).toBeNull();
    }
  });
  it('ships only models a shipped provider can dispatch', async () => {
    const [seed, scope] = await Promise.all([readSeed(), inScopeModels()]);
    const outOfScope = [...new Set(seed.observations.map(row => row.model))].filter(model => !scope.has(model));
    // Re-run `node scripts/prune-model-comparison-seed.js` after a sync writes
    // the full public index over the seed.
    expect(outOfScope).toEqual([]);
  });

  it('is already pruned — the checked-in seed equals the pruned seed', async () => {
    const [seed, { pruned }] = await Promise.all([readSeed(), prunedSeed()]);
    expect(seed.observations.length).toBe(pruned.observations.length);
  });

  it('keeps a full reasoning-effort curve for the frontier anchor', async () => {
    const seed = await readSeed();
    const rows = seed.observations.filter(row => row.model === 'claude-fable-5.1');
    expect(rows.length).toBeGreaterThan(0);
    for (const benchmark of new Set(rows.map(row => row.benchmark))) {
      const efforts = rows.filter(row => row.benchmark === benchmark).map(row => row.effort);
      expect(efforts.sort()).toEqual(['high', 'low', 'max', 'medium', 'xhigh']);
    }
  });

  it('ships the September 22 Artificial Analysis v4.3.2 curves for current frontier models', async () => {
    const seed = await readSeed();
    const rows = seed.observations.filter(row => row.benchmark === 'Artificial Analysis Intelligence Index v4.3.2');
    const expectedEfforts = {
      'gpt-6-astra': ['high', 'low', 'max', 'medium', 'xhigh'],
      'gpt-6-sol': ['high', 'low', 'max', 'medium', 'non-reasoning', 'xhigh'],
      'gpt-6-luna': ['high', 'low', 'max', 'medium', 'non-reasoning', 'xhigh'],
      'gpt-5.6-terra': ['high', 'low', 'max', 'medium', 'non-reasoning', 'xhigh'],
      'claude-opus-5.5': ['high', 'low', 'max', 'medium', 'xhigh'],
    };
    expect(rows).toHaveLength(28);
    for (const [model, efforts] of Object.entries(expectedEfforts)) {
      const modelRows = rows.filter(row => row.model === model);
      expect(modelRows.map(row => row.effort).sort()).toEqual(efforts);
      expect(modelRows.every(row => row.id.startsWith('aa-v4.3.2-'))).toBe(true);
      expect(modelRows.every(row => row.quality)).toBe(true);
      for (const row of modelRows) {
        const metrics = ['quality', 'costPerTask', 'inputPerMillion', 'outputPerMillion', 'responseSeconds', 'tokensPerSecond']
          .map(key => row[key])
          .filter(Boolean);
        expect(metrics.length).toBeGreaterThan(0);
        expect(metrics.every(metric => metric.source.url.startsWith('https://artificialanalysis.ai/models/'))).toBe(true);
        expect(metrics.every(metric => metric.source.retrievedAt.startsWith('2026-09-22T'))).toBe(true);
      }
    }
  });

  it('scopes every benchmark name the local install catalog declares', async () => {
    // `ollama` and `lmstudio` ship with `models: []`, so providers.json alone
    // drops every model PortOS ships an installer for.
    const scope = await inScopeModels();
    const declared = localCatalogBenchmarkModels();
    expect([...declared].filter(model => !scope.has(model))).toEqual([]);
    for (const model of ['qwen3-coder-30b-a3b', 'ornith-1.0-35b']) expect(declared.has(model)).toBe(true);
  });

  it('declares a benchmark name only for a model the index actually carries', async () => {
    // A declared equivalence is a claim about a real index row. A typo or a
    // retired model would otherwise sit in the catalog looking authoritative
    // while silently contributing nothing.
    const known = new Set((await readSeed()).observations.map(row => row.model));
    const dangling = [...localCatalogBenchmarkModels()].filter(model => !known.has(model));
    expect(dangling).toEqual([]);
  });

  it('routes both backend ids of a declaring entry to the same benchmark name', async () => {
    // Catalog-wide, not just the lane under edit: both backends install the same
    // weights, so a split means one id silently contributes nothing.
    const split = [];
    for (const entry of LOCAL_LLM_CATALOG.filter(model => model.benchmarkModel)) {
      for (const backend of BACKENDS) {
        for (const id of entryIdsForBackend(entry, backend)) {
          if (catalogSlugForProviderModel(id) !== entry.benchmarkModel) split.push([entry.key, id]);
        }
      }
    }
    expect(split).toEqual([]);
  });

  it('ships the coding agents the install picker asks the user to choose between, on one scaffold', async () => {
    // The chart separates series on `benchmark` alone, so a shared axis is the
    // only thing that makes two rows comparable.
    const rows = (await readSeed()).observations.filter(row => row.benchmark === 'SWE-bench Verified (pass@1, OpenHands)');
    const scored = Object.fromEntries(rows.map(row => [row.model, row.quality.value]));
    expect(scored['qwen3-coder-30b-a3b']).toBeGreaterThan(0);
    expect(scored['ornith-1.0-35b']).toBeGreaterThan(0);
  });

  it('never mixes two evaluation methodologies into one benchmark group', async () => {
    // Guards the scaffold split above: a Cline result and an OpenHands result
    // sharing a benchmark string would plot as one curve.
    const byBenchmark = new Map();
    for (const row of (await readSeed()).observations) {
      if (!row.quality) continue;
      if (!byBenchmark.has(row.benchmark)) byBenchmark.set(row.benchmark, new Set());
      byBenchmark.get(row.benchmark).add(row.quality.source.methodology);
    }
    expect([...byBenchmark].filter(([, methodologies]) => methodologies.size > 1)).toEqual([]);
  });

  it('carries no retired generation the chart would never plot', async () => {
    const models = new Set((await readSeed()).observations.map(row => row.model));
    for (const retired of ['claude-2.0', 'gpt-4', 'palm-2', 'llama-2-chat-70b']) {
      expect(models.has(retired)).toBe(false);
    }
  });
});
