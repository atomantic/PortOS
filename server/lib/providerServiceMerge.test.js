/**
 * Folding duplicate service instances (epic #7561). The shipped samples are
 * the regression: imported as-is they give NVIDIA NIM two services — "NVIDIA
 * NIM" (the direct API record) and "OpenCode NVIDIA NIM" (the wrapper) — when a
 * harness on a service is a preset, not a second service.
 *
 * Fixtures are synthetic or the shipped reference samples. Nothing here is read
 * out of a running install.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { importGraphFromProviders, isDerivedPreset, planGraphReconciliation } from './providerGraphRecords.js';
import { planPresetBackfill } from './providerPresets.js';
import { planServiceColumnBackfill } from './providerServiceInstances.js';
import { planServiceInstanceMerges } from './providerServiceMerge.js';

const SAMPLES = Object.values(JSON.parse(readFileSync(new URL('../../data.reference/providers.json', import.meta.url), 'utf8')).providers);

const minter = () => { let n = 0; return () => `id-${++n}`; };
const plan = (graph, providers) => planServiceInstanceMerges(graph, providers, { bootstraps: {}, env: {} });

/** What a first boot does before the fold: import, name, stamp the derivable presets. */
function bootedSamples() {
  const providers = structuredClone(SAMPLES);
  const graph = importGraphFromProviders({ providers }, minter());
  for (const row of planServiceColumnBackfill(graph, new Set())) Object.assign(graph.connections.find((c) => c.id === row.id), row);
  const { patches } = planPresetBackfill({ graph, providers, bootstraps: {}, env: {} });
  for (const record of providers) Object.assign(record, patches[record.id] || {});
  return { graph, providers };
}

/** Apply a fold in memory the way the preset write + `mergeServiceInstances` do. */
function applyFold(graph, providers, merge) {
  for (const record of providers) Object.assign(record, merge.presetPatches[record.id] || {});
  graph.connections = graph.connections.filter((c) => !merge.absorbedIds.includes(c.id)).map((c) => (c.id === merge.keeper.id ? merge.keeper : c));
  for (const { bindingId, variantKey } of merge.bindingMoves) {
    Object.assign(graph.bindings.find((b) => b.id === bindingId), { connectionId: merge.keeper.id, variantKey });
  }
}

/** The records whose routes sit on `connectionId`. */
const routedOn = (graph, connectionId) => {
  const bindings = new Set(graph.bindings.filter((b) => b.connectionId === connectionId).map((b) => b.id));
  return graph.routes.filter((route) => bindings.has(route.bindingId)).map((route) => route.providerId).sort();
};

describe('planServiceInstanceMerges over the shipped samples', () => {
  it('leaves one NVIDIA NIM service carrying the direct API and both OpenCode presets', () => {
    const { graph, providers } = bootedSamples();
    const nim = plan(graph, providers).find((merge) => merge.keeper.definitionId === 'nvidia-nim');
    expect(nim.keeper).toMatchObject({ slug: 'nvidia-nim', label: 'NVIDIA NIM', kind: 'gateway:nvidia-nim' });
    expect(nim.absorbedIds).toHaveLength(1);
    applyFold(graph, providers, nim);
    expect(routedOn(graph, nim.keeper.id)).toEqual(['nvidia-nim', 'opencode-nvidia-nim', 'opencode-nvidia-nim-tui']);
    const wrappers = providers.filter((record) => record.id.startsWith('opencode-nvidia-nim'));
    expect(wrappers.map((record) => record.serviceId)).toEqual(['nvidia-nim', 'nvidia-nim']);
  });

  it('holds after the next reconcile pass: no folded route is cloned back off the survivor', () => {
    const { graph, providers } = bootedSamples();
    const merges = plan(graph, providers);
    for (const merge of merges) applyFold(graph, providers, merge);
    expect(merges.map((merge) => merge.keeper.definitionId)).toEqual(expect.arrayContaining(['nvidia-nim', 'openrouter', 'ollama']));

    const reconciled = planGraphReconciliation(graph, providers, { mintId: minter() });
    expect(reconciled.regroups.filter((regroup) => regroup.connectionAction !== 'unchanged' || !regroup.bindingId)).toEqual([]);
    expect(reconciled.imports.routes).toEqual([]);
    // Every derived preset names a service that still exists, and a second fold plans nothing.
    const slugs = new Set(graph.connections.map((c) => c.slug));
    expect(providers.filter(isDerivedPreset).filter((record) => !slugs.has(record.serviceId))).toEqual([]);
    expect(plan(graph, providers)).toEqual([]);
  });

  it('never changes a preset\'s models: the paid-model Zen API stays off the free Zen instance', () => {
    const { graph, providers } = bootedSamples();
    const before = new Map(providers.map((record) => [record.id, structuredClone(record.models)]));
    const zenApi = graph.routes.find((route) => route.providerId === 'opencode-zen').bindingId;
    for (const merge of plan(graph, providers)) {
      expect(merge.bindingMoves.map((move) => move.bindingId)).not.toContain(zenApi);
      applyFold(graph, providers, merge);
    }
    for (const record of providers.filter(isDerivedPreset)) expect(record.models).toEqual(before.get(record.id));
  });
});

const NIM_URL = 'https://integrate.api.nvidia.com/v1';
const row = (id, overrides = {}) => ({
  id, revision: 1, kind: 'gateway:nvidia-nim', label: `Row ${id}`, slug: id, definitionId: 'nvidia-nim', plan: 'free',
  enabled: true, credentialVia: 'stored', transports: { openai: { baseUrl: NIM_URL } }, credentials: {},
  catalog: { state: 'known', models: ['example/model'] }, ...overrides,
});
const bound = (connectionId, harnessId = 'opencode') => ({
  id: `b-${connectionId}`, revision: 1, connectionId, harnessId, variantKey: 'default', label: '', enabled: false, selectedModels: [],
});
const twoRows = (a, b) => ({ connections: [row('nim-a', a), row('nim-b', b)], bindings: [bound('nim-a'), bound('nim-b')], routes: [] });

describe('planServiceInstanceMerges refusals', () => {
  it('folds two rows that are one backend under the same terms, onto a variant key free on the survivor', () => {
    const [merge] = plan(twoRows(), []);
    expect(merge).toMatchObject({ absorbedIds: ['nim-b'], bindingMoves: [{ bindingId: 'b-nim-b', variantKey: 'variant:b-nim-b' }] });
  });

  it.each([
    ['a different plan (free and paid are two instances)', {}, { plan: 'paid' }],
    ['a different endpoint', {}, { transports: { openai: { baseUrl: 'https://example.com/v1' } } }],
    ['two different keys', { credentials: { apiKey: 'key-one' } }, { credentials: { apiKey: 'key-two' } }],
    ['a different credential mode', {}, { credentialVia: 'env' }],
    ['one of them switched off', {}, { enabled: false }],
  ])('keeps two rows apart on %s', (_label, a, b) => {
    expect(plan(twoRows(a, b), [])).toEqual([]);
  });

  it('never folds away a service no harness is bound to yet', () => {
    const graph = twoRows();
    graph.bindings = [bound('nim-a')];
    expect(plan(graph, []).flatMap((merge) => merge.absorbedIds)).not.toContain('nim-b');
  });

  it('sits out a row whose route is mid-projection', () => {
    const graph = twoRows();
    graph.routes = [{ providerId: 'example', bindingId: 'b-nim-b', mode: 'cli', modelMap: {}, projected: {}, pending: {} }];
    expect(plan(graph, [{ id: 'example' }])).toEqual([]);
  });

  it('refuses a fold whose preset cannot be derived on the survivor', () => {
    const graph = twoRows();
    graph.routes = [{ providerId: 'example', bindingId: 'b-nim-b', mode: 'cli', modelMap: {}, projected: {}, pending: null }];
    const orphan = { id: 'example', harnessId: 'no-such-harness', method: 'cli', serviceId: 'nim-b' };
    expect(plan(graph, [orphan])).toEqual([]);
  });
});
