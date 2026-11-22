import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { PATHS } from '../lib/paths.js';
import { createModelComparisonRoutes } from './modelComparison.js';
import { importModelComparison } from '../services/modelComparison.js';
import codex62Migration from '../../scripts/migrations/462-codex-gpt-62.js';

let dir;
let originalData;
let originalRoot;
let app;
let seed;
let observation;

beforeEach(async () => {
  vi.clearAllMocks();
  originalData = PATHS.data;
  originalRoot = PATHS.root;
  dir = await mkdtemp(join(tmpdir(), 'portos-comparison-test-'));
  PATHS.data = dir;
  seed = JSON.parse(await readFile(join(PATHS.root, 'data.reference/model-comparison.json'), 'utf8'));
  observation = seed.observations.find(row => row.quality && row.inputPerMillion);
  app = express();
  app.use(express.json());
  app.use('/comparison', createModelComparisonRoutes({ getSelectableProviders: async () => ({ providers: [{ id: 'example-provider', name: 'Example provider', models: [observation.model], enabled: true }, { id: 'disabled', name: 'Disabled', models: ['hidden-model'], enabled: false }] }) }));
  app.use(errorMiddleware);
});

afterEach(async () => {
  PATHS.data = originalData;
  PATHS.root = originalRoot;
  await rm(dir, { recursive: true, force: true });
});

it('exposes newly shipped evidence to an existing instance without replacing its local observations', async () => {
  await mkdir(join(dir, 'data.reference'));
  const shippedPath = join(dir, 'data.reference/model-comparison.json');
  const localPath = join(dir, 'model-comparison.json');
  const local = { ...observation, id: 'local-research' };
  const addition = { ...observation, id: 'new-shipped-research' };
  const localContents = JSON.stringify({ schemaVersion: 1, observations: [local] });
  await writeFile(localPath, localContents);
  await writeFile(shippedPath, JSON.stringify({ schemaVersion: 1, observations: [observation] }));
  PATHS.root = dir;
  expect((await request(app).get('/comparison')).body.observations.map(row => row.id)).not.toContain(addition.id);
  await writeFile(shippedPath, JSON.stringify({ schemaVersion: 1, observations: [observation, addition] }));
  const updated = await request(app).get('/comparison');
  expect(updated.status).toBe(200);
  expect(updated.body.observations.map(row => row.id)).toEqual(expect.arrayContaining([local.id, addition.id]));
  expect(await readFile(localPath, 'utf8')).toBe(localContents);
});

it('merges newer installed evidence with shipped evidence and includes only selectable enabled models', async () => {
  const localObservation = { ...observation, notes: 'Updated evidence: https://example.com/new-source', quality: { ...observation.quality, value: 1, source: { ...observation.quality.source, retrievedAt: new Date().toISOString() } } };
  await writeFile(join(dir, 'model-comparison.json'), JSON.stringify({ schemaVersion: 1, observations: [localObservation] }));
  const result = await request(app).get('/comparison');
  expect(result.status).toBe(200);
  expect(result.body.observations.find(row => row.id === observation.id).quality.value).toBe(1);
  expect(result.body.observations.find(row => row.id === observation.id).notes).toBe(localObservation.notes);
  expect(result.body.observations).toHaveLength(seed.observations.length);
  expect(result.body.inventory).toEqual([{ id: 'example-provider', name: 'Example provider', gateway: null, localInference: false, runtime: null, models: [{ model: observation.model, efforts: [] }] }]);
  expect(result.body.composite.rows.length).toBeGreaterThan(0);
  expect(result.body.composite.rows.every(row => row.providerId === 'example-provider')).toBe(true);
  for (const path of ['/comparison/discover', '/comparison/run']) expect((await request(app).post(path).send({})).status).toBe(404);
  const imported = { ...observation, id: 'research-import' };
  expect((await request(app).post('/comparison/import').send({ schemaVersion: 1, observations: [imported] })).status).toBe(200);
  expect((await request(app).get('/comparison')).body.observations.some(row => row.id === imported.id)).toBe(true);
});

it('exposes Terra pricing and measured effort scores to existing Codex installs', async () => {
  await writeFile(join(dir, 'model-comparison.json'), JSON.stringify({ schemaVersion: 1, observations: [observation] }));
  const codexApp = express();
  codexApp.use('/comparison', createModelComparisonRoutes({ getSelectableProviders: async () => ({ providers: [
    { id: 'codex', name: 'Codex', command: 'codex', models: ['gpt-6.1-terra'] },
  ] }) }));
  codexApp.use(errorMiddleware);

  const result = await request(codexApp).get('/comparison');
  expect(result.status).toBe(200);
  const pricing = result.body.observations.find(row => row.id === 'openai-gpt-6.1-terra-pricing-2026-10-27-standard');
  expect(pricing).toMatchObject({ quality: null, inputPerMillion: { value: 1 }, outputPerMillion: { value: 5 } });
  const max = result.body.composite.rows.find(row => row.model === 'gpt-6.1-terra' && row.effort === 'max');
  expect(max.quality).toMatchObject({ value: 48, estimated: false });
  expect(max.costPerTask).toMatchObject({ value: 0.4, estimated: false });
  const medium = result.body.composite.rows.find(row => row.model === 'gpt-6.1-terra' && row.effort === 'medium');
  expect(medium.quality).toMatchObject({ value: 41, estimated: false });
  expect(medium.costPerTask).toMatchObject({ value: 0.1, estimated: false });
  const ultra = result.body.composite.rows.find(row => row.model === 'gpt-6.1-terra' && row.effort === 'ultra');
  expect(ultra.inputPerMillion).toMatchObject({ value: 1, estimated: false });
  expect(ultra.outputPerMillion).toMatchObject({ value: 5, estimated: false });
  expect(ultra.quality).toMatchObject({ value: 48, estimated: true });
  expect(ultra.quality.method).toContain('Nearest effort of this exact model');
  expect(ultra.costPerTask).toBeNull();
  expect(ultra.needsResearch).toBe(true);
});

it('exposes every supported GPT-6.2 effort after upgrading an existing Codex catalog', async () => {
  await mkdir(join(dir, 'data'));
  const local = { ...observation, id: 'local-research', notes: 'Local research retained' };
  const localContents = JSON.stringify({ schemaVersion: 1, observations: [local] });
  await writeFile(join(dir, 'model-comparison.json'), localContents);
  await writeFile(join(dir, 'data/providers.json'), JSON.stringify({ providers: {
    codex: { id: 'codex', name: 'Codex', command: 'codex', models: ['custom'], defaultModel: 'custom' },
  } }));
  await codex62Migration.up({ rootDir: dir });
  const { providers } = JSON.parse(await readFile(join(dir, 'data/providers.json'), 'utf8'));
  const codexApp = express();
  codexApp.use('/comparison', createModelComparisonRoutes({ getSelectableProviders: async () => ({ providers: [providers.codex] }) }));
  codexApp.use(errorMiddleware);

  const result = await request(codexApp).get('/comparison');
  expect(result.status).toBe(200);
  for (const model of ['gpt-6.2-astra', 'gpt-6.2-sol']) {
    const expected = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
    expect(result.body.inventory[0].models.find(row => row.model === model).efforts).toEqual(expected);
    const rows = result.body.composite.rows.filter(row => row.model === model);
    expect(rows.map(row => row.effort)).toEqual(expected);
    for (const row of rows) {
      expect(row.quality).toMatchObject({ estimated: true });
      expect(row.needsResearch).toBe(true);
      expect(row.costPerTask).toBeNull();
    }
    expect(result.body.observations.some(row => row.model === model && row.benchmark.startsWith('Official API pricing'))).toBe(true);
  }
  expect(result.body.observations).toContainEqual(local);
  expect(await readFile(join(dir, 'model-comparison.json'), 'utf8')).toBe(localContents);
  expect(providers.codex.defaultModel).toBe('custom');
});

it('ships both GPT-6.2 models in the Codex preset lists', async () => {
  const { providers } = JSON.parse(await readFile(join(PATHS.root, 'data.reference/providers.json'), 'utf8'));
  for (const id of ['codex', 'codex-tui']) {
    expect(providers[id].models).toEqual(expect.arrayContaining(['gpt-6.2-astra', 'gpt-6.2-sol']));
  }
});

it('plots published GPT-6.2 v5 scores and task costs on an existing install without overwriting local research', async () => {
  const local = { ...observation, id: 'local-research-v5', notes: 'Local research retained' };
  const localContents = JSON.stringify({ schemaVersion: 1, observations: [local] });
  await writeFile(join(dir, 'model-comparison.json'), localContents);
  const codexApp = express();
  codexApp.use('/comparison', createModelComparisonRoutes({ getSelectableProviders: async () => ({ providers: [
    { id: 'codex', name: 'Codex', command: 'codex', models: ['gpt-6.2-astra', 'gpt-6.2-sol'] },
  ] }) }));
  codexApp.use(errorMiddleware);
  const result = await request(codexApp).get('/comparison');
  expect(result.status).toBe(200);
  for (const [model, scores, costs] of [
    ['gpt-6.2-astra', [46, 57, 60, 62, 62], [0.66, 1.62, 2.07, 2.52, 4]],
    ['gpt-6.2-sol', [41, 53, 55, 56, 57], [0.18, 0.41, 0.56, 0.65, 1.01]],
  ]) {
    const rows = result.body.currentComposite.rows.filter(row => row.model === model);
    for (const [index, effort] of ['low', 'medium', 'high', 'xhigh', 'max'].entries()) {
      const row = rows.find(candidate => candidate.effort === effort);
      expect(row.quality).toMatchObject({ value: scores[index], estimated: false });
      expect(row.costPerTask).toMatchObject({ value: costs[index], estimated: false });
      const evidence = result.body.observations.find(item => item.model === model && item.effort === effort && item.benchmark === 'Artificial Analysis Intelligence Index v5.0.1');
      expect(evidence.quality.source.url).toBe(`https://artificialanalysis.ai/models/${model.replaceAll('.', '-')}`);
      expect(evidence.costPerTask.source.methodology).toContain('rounded to cents');
    }
    expect(rows.find(row => row.effort === 'ultra').costPerTask).toBeNull();
    expect(result.body.observations.some(row => row.model === model && row.effort === 'ultra' && row.benchmark === 'Artificial Analysis Intelligence Index v5.0.1')).toBe(false);
  }
  expect(result.body.observations).toContainEqual(local);
  expect(await readFile(join(dir, 'model-comparison.json'), 'utf8')).toBe(localContents);
});

it('exposes shipped GPT-6.2 prices to existing installs without inventing benchmark measurements', async () => {
  await writeFile(join(dir, 'model-comparison.json'), JSON.stringify({ schemaVersion: 1, observations: [observation] }));
  const result = await request(app).get('/comparison');
  expect(result.status).toBe(200);
  for (const [model, input, output] of [['gpt-6.2-astra', 8, 40], ['gpt-6.2-sol', 2, 10]]) {
    const rows = result.body.observations.filter(row => row.model === model && row.benchmark.startsWith('Official API pricing'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      effort: 'unspecified', billing: 'api', quality: null, costPerTask: null,
      inputPerMillion: { value: input, source: { url: `https://developers.openai.com/api/docs/models/${model}` } },
      outputPerMillion: { value: output }, reasoningPerMillion: null,
      responseSeconds: null, tokensPerSecond: null, quota: null,
    });
  }
});

it('ships measured GPT-6.2 coding efforts without treating evaluation totals as per-task metrics', async () => {
  const result = await request(app).get('/comparison');
  expect(result.status).toBe(200);
  const measured = model => result.body.observations.filter(row => row.model === model && row.benchmark.startsWith('ModelDial'));
  expect(measured('gpt-6.2-astra').map(row => [row.effort, row.quality.value])).toEqual([
    ['low', 87.1], ['medium', 86.15], ['high', 89.4], ['xhigh', 92.05], ['max', 93],
  ]);
  expect(measured('gpt-6.2-sol').map(row => [row.effort, row.quality.value])).toEqual([['max', 88.9]]);
  for (const row of [...measured('gpt-6.2-astra'), ...measured('gpt-6.2-sol')]) {
    expect(row.costPerTask).toBeNull();
    expect(row.responseSeconds).toBeNull();
    expect(row.quality.source.url).toBe(`https://modeldial.com/en/models/${row.model}`);
  }
});

it('exposes Fable 5.2 task costs and scores on the matching v5 workload without changing the legacy composite', async () => {
  await writeFile(join(dir, 'model-comparison.json'), JSON.stringify({ schemaVersion: 1, observations: [observation] }));
  const claudeApp = express();
  claudeApp.use('/comparison', createModelComparisonRoutes({ getSelectableProviders: async () => ({ providers: [
    { id: 'claude-code', name: 'Claude Code', command: 'claude', models: ['claude-fable-5-2'] },
  ] }) }));
  claudeApp.use(errorMiddleware);

  const result = await request(claudeApp).get('/comparison');
  expect(result.status).toBe(200);
  expect(result.body.composite.anchor).toBe('Artificial Analysis Intelligence Index v4.3.2');
  expect(result.body.composite.rows.every(row => row.costPerTask === null)).toBe(true);
  expect(result.body.currentComposite.anchor).toBe('Artificial Analysis Intelligence Index v5.0.1');
  const rows = result.body.currentComposite.rows;
  const expected = [
    ['low', 53.9249388799182, 3.097241904274546],
    ['medium', 56.4083157101519, 3.8026050641787634],
    ['high', 61.8218785440284, 9.078414777860381],
    ['xhigh', 62.2167392403357, 14.828587632511116],
    ['max', 64.563595756626, 26.53855780398091],
  ];
  for (const [effort, score, cost] of expected) {
    const row = rows.find(candidate => candidate.effort === effort);
    expect(row.quality).toMatchObject({ value: score, estimated: false });
    expect(row.costPerTask).toMatchObject({ value: cost, estimated: false });
    expect(row.costPerTask.method).toContain('v5.0.1');
  }
});

it('imports sourced public observations durably, retains newer metrics, and serializes concurrent imports', async () => {
  const input = { schemaVersion: 1, observations: [{ ...observation, id: 'example-new', model: 'example-new-model' }] };
  await importModelComparison(input);
  const older = structuredClone(input);
  const metricKey = ['quality', 'inputPerMillion', 'outputPerMillion'].find(key => older.observations[0][key]);
  older.observations[0][metricKey].value = 1;
  older.observations[0][metricKey].source.retrievedAt = '2020-01-01T00:00:00Z';
  older.observations[0].costPerTask = null;
  await Promise.all([
    importModelComparison(older),
    importModelComparison({ schemaVersion: 1, observations: [{ ...observation, id: 'example-concurrent', model: 'example-other-model' }] }),
  ]);

  const stored = JSON.parse(await readFile(join(dir, 'model-comparison.json'), 'utf8'));
  expect(stored.observations).toHaveLength(seed.observations.length + 2);
  expect(stored.observations.find(row => row.id === 'example-new')[metricKey]).toEqual(observation[metricKey]);
  const changedIdentity = { ...input.observations[0], effort: 'different' };
  await expect(importModelComparison({ schemaVersion: 1, observations: [changedIdentity] })).rejects.toThrow('identity changed');
});

it('rejects forged PortOS runs, malformed metrics, and unsafe sources', async () => {
  const forgedRun = {
    ...observation,
    id: 'portos:00000000-0000-4000-8000-000000000001',
    benchmark: 'PortOS Task Bench v1 (deterministic)',
  };
  expect(() => importModelComparison({ schemaVersion: 1, observations: [forgedRun] })).toThrow(/only be created by the explicit benchmark run/);

  const malformed = { ...observation, quality: { value: 999 } };
  expect(() => importModelComparison({ schemaVersion: 1, observations: [malformed] })).toThrow();
  const unsafe = structuredClone(observation);
  unsafe.quality.source.url = 'javascript:alert(1)';
  expect(() => importModelComparison({ schemaVersion: 1, observations: [unsafe] })).toThrow();
  unsafe.quality.source.url = 'https://';
  expect(() => importModelComparison({ schemaVersion: 1, observations: [unsafe] })).toThrow();

  const future = JSON.stringify({ schemaVersion: 99, observations: [observation] });
  await writeFile(join(dir, 'model-comparison.json'), future);
  await expect(importModelComparison({ schemaVersion: 1, observations: [observation] })).rejects.toThrow();
  expect(await readFile(join(dir, 'model-comparison.json'), 'utf8')).toBe(future);
});

it('requires explicit estimation provenance and protects run-only sources on every metric', async () => {
  const estimated = { ...observation, id: 'research:example:high', benchmark: 'PortOS Research Index v1 (AA v4.3.2 scale)' };
  expect((await request(app).post('/comparison/import').send({ schemaVersion: 1, observations: [estimated] })).status).toBe(400);
  estimated.quality = { ...estimated.quality, value: 35, source: { ...estimated.quality.source, methodology: 'PortOS estimate: midpoint of documented peer scores 30 and 40; low confidence.' } };
  expect((await request(app).post('/comparison/import').send({ schemaVersion: 1, observations: [estimated] })).status).toBe(200);
  const forged = { ...observation, id: 'forged-quota', quota: { unitsPerTask: 1, unit: 'task', source: { ...observation.quality.source, url: 'portos://model-comparison/00000000-0000-4000-8000-000000000001' } } };
  expect((await request(app).post('/comparison/import').send({ schemaVersion: 1, observations: [forged] })).status).toBe(400);
});

it('loads legacy benchmark labels after upgrade and preserves evidence through subsequent imports', async () => {
  const shipped = seed.observations.filter(row => row.id.startsWith('lcb-generation-2023-05-08--2025-04-07-'));
  expect(shipped.length).toBeGreaterThan(0);
  const legacy = shipped.map(row => ({ ...row,
    benchmark: 'LiveCodeBench (generation, pass@1, 2023-05-08 to 2025-04-07)',
    inputPerMillion: null, outputPerMillion: null,
  }));
  const stored = JSON.stringify({ schemaVersion: 1, observations: legacy });
  await writeFile(join(dir, 'model-comparison.json'), stored);
  for (let reload = 0; reload < 2; reload++) {
    const result = await request(app).get('/comparison');
    expect(result.status).toBe(200);
    expect(result.body.observations).toHaveLength(seed.observations.length);
    for (const row of shipped) expect(result.body.observations.find(item => item.id === row.id)).toMatchObject({
      benchmark: row.benchmark, quality: row.quality, inputPerMillion: row.inputPerMillion, outputPerMillion: row.outputPerMillion,
    });
  }
  // Reload is read-only; persistence occurs only during an explicit import.
  expect(await readFile(join(dir, 'model-comparison.json'), 'utf8')).toBe(stored);
  expect((await request(app).post('/comparison/import').send({ schemaVersion: 1, observations: legacy })).status).toBe(200);
  const saved = JSON.parse(await readFile(join(dir, 'model-comparison.json'), 'utf8'));
  expect(saved.observations).toHaveLength(seed.observations.length);
  for (const row of shipped) expect(saved.observations.find(item => item.id === row.id)).toMatchObject({
    benchmark: row.benchmark, quality: row.quality, inputPerMillion: row.inputPerMillion, outputPerMillion: row.outputPerMillion,
  });
  const changed = { ...legacy[0], benchmark: 'LiveCodeBench (generation, pass@1, 2025-01-01 to 2025-04-07)' };
  expect((await request(app).post('/comparison/import').send({ schemaVersion: 1, observations: [changed] })).status).toBe(409);
  expect((await request(app).get('/comparison')).status).toBe(200);
});

it('plots local Ornith and Qwen Coder with zero API charges and sourced quality without borrowing hosted costs', async () => {
  const providers = [
    { id: 'ollama', name: 'Ollama', models: ['ornith:35b', 'qwen3-coder:30b', 'qwen2.5-coder:32b', 'inkling-2-mini:26b-a5b', 'inkling-2-mini:26b-a5b-nvfp4', 'unknown:7b'] },
    { id: 'local-wrapper', name: 'Example CLI', ollamaBacked: true, models: ['ollama/qwen3-coder:30b'] },
    { id: 'declared-local', name: 'Example private runtime', servicePlan: 'local', models: ['ornith:35b'] },
    { id: 'lmstudio', name: 'LM Studio', models: ['lmstudio-community/Ornith-1.0-35B-GGUF'] },
    { id: 'hosted', name: 'Example hosted', servicePlan: 'paid', ollamaBacked: true, models: ['qwen/qwen3-coder-30b-a3b-instruct'] },
    { id: 'gateway', name: 'Example gateway', gatewayBacked: 'openrouter', ollamaBacked: true, models: ['qwen/qwen3-coder-30b-a3b-instruct'] },
    { id: 'free-tier', name: 'Example free service', servicePlan: 'free', models: ['qwen/qwen3-coder-30b-a3b-instruct'] },
  ];
  const localApp = express();
  localApp.use('/comparison', createModelComparisonRoutes({ getSelectableProviders: async () => ({ providers }) }));
  localApp.use(errorMiddleware);
  const result = await request(localApp).get('/comparison');
  expect(result.status).toBe(200);
  const { rows, sources } = result.body.composite;
  const local = rows.filter(row => ['ollama', 'local-wrapper', 'declared-local', 'lmstudio'].includes(row.providerId));
  expect(local.length).toBeGreaterThanOrEqual(7);
  for (const row of local) {
    for (const field of ['inputPerMillion', 'outputPerMillion', 'blendedPerMillion', 'costPerTask']) {
      expect(row[field]).toMatchObject({ value: 0, estimated: false, sourceIds: [] });
      expect(row[field].method).toContain('Hardware, electricity');
    }
    if (row.model === 'unknown:7b') {
      expect(row.quality).toBeNull();
    } else {
      expect(row.quality.estimated).toBe(true);
      expect(row.quality.sourceIds.length).toBeGreaterThan(0);
      expect(row.quality.method).toContain('local build');
    }
  }
  const ornith = local.find(row => row.model === 'ornith:35b');
  expect(ornith.quality.value).toBe(19);
  expect(ornith.quality.method).toContain('base-model proxy');
  expect(sources[ornith.quality.sourceIds[0]].url).toBe('https://huggingface.co/ornith-ai/Ornith-1.0-35B');
  expect(local.find(row => row.model === 'qwen3-coder:30b').quality.value).toBeGreaterThan(0);
  for (const tag of ['inkling-2-mini:26b-a5b', 'inkling-2-mini:26b-a5b-nvfp4']) {
    const inkling = local.find(row => row.model === tag);
    expect(inkling.quality.estimated).toBe(true);
    expect(inkling.quality.value).toBeGreaterThan(0);
    expect(inkling.quality.sourceIds.length).toBeGreaterThan(0);
    expect(inkling.quality.method).toContain('quantization');
  }
  for (const row of rows.filter(row => ['hosted', 'gateway', 'free-tier'].includes(row.providerId))) {
    expect(row.inputPerMillion.value).toBeGreaterThan(0);
    expect(row.costPerTask).toBeNull();
  }
  expect(result.body.observations.find(row => row.id === 'ornith-publisher-20261001-35b-swebench-verified').quality.value).toBe(75.6);
});

it('loads shipped Hydrogen effort scores and workload costs for an existing Antigravity install', async () => {
  await writeFile(join(dir, 'model-comparison.json'), JSON.stringify({ schemaVersion: 1, observations: [observation] }));
  const hydrogenApp = express();
  hydrogenApp.use('/comparison', createModelComparisonRoutes({ getSelectableProviders: async () => ({ providers: [
    { id: 'antigravity', name: 'Antigravity', command: 'agy', models: ['gemini-4-hydrogen-low', 'gemini-4-hydrogen-medium', 'gemini-4-hydrogen-high', 'gemini-4-hydrogen-xhigh'] },
  ] }) }));
  hydrogenApp.use(errorMiddleware);
  const result = await request(hydrogenApp).get('/comparison');
  expect(result.status).toBe(200);
  expect(result.body.inventory[0].models).toEqual([{ model: 'gemini-4-hydrogen', efforts: ['low', 'medium', 'high', 'xhigh'] }]);
  expect(result.body.currentComposite.rows.map(row => row.effort)).toEqual(['low', 'medium', 'high', 'xhigh']);
  const expected = [
    ['low', 26.8936694361562, 0.2922227000200506],
    ['medium', 41.2329566992579, 0.7979866055252406],
    ['high', 50.7870826951304, 1.8733140062520008],
    ['xhigh', 53.9192287317542, 3.1601590757006157],
  ];
  for (const [effort, score, cost] of expected) {
    const row = result.body.currentComposite.rows.find(candidate => candidate.effort === effort);
    expect(row.comparisonModel).toBe('gemini-4-hydrogen');
    expect(row.quality).toMatchObject({ value: score, estimated: false });
    expect(row.costPerTask).toMatchObject({ value: cost, estimated: false });
    expect(row.inputPerMillion).toMatchObject({ value: 1.5, estimated: false });
    expect(row.outputPerMillion).toMatchObject({ value: 7.5, estimated: false });
    expect(result.body.currentComposite.sources[row.costPerTask.sourceIds[0]].url).toMatch(/^https:\/\/artificialanalysis.ai\/models\/gemini-4-hydrogen/);
  }
  expect(result.body.composite.rows.every(row => row.costPerTask === null)).toBe(true);
});

it('plots published speed for API routes and this machine\'s measured speed for local runtimes, never a public figure for a local build', async () => {
  const fast = seed.observations.find(row => row.quality && row.tokensPerSecond?.value > 0);
  await mkdir(join(dir, 'local-llm'), { recursive: true });
  await writeFile(join(dir, 'local-llm', 'assessments.json'), JSON.stringify({ schemaVersion: 1, assessments: [
    { backend: 'mtplx', modelId: 'example-local', tuningKey: '', assessedAt: '2026-11-20T00:00:00.000Z', performance: { meanTokensPerSecond: 120.5, samplesOk: 3, tokensEstimated: false } },
    { backend: 'mtplx', modelId: 'example-local', tuningKey: 'depth=7', assessedAt: '2026-11-21T00:00:00.000Z', performance: { meanTokensPerSecond: 140, samplesOk: 3 } },
  ] }));
  app = express();
  app.use(express.json());
  app.use('/comparison', createModelComparisonRoutes({ getSelectableProviders: async () => ({ providers: [
    { id: 'example-provider', name: 'Example provider', models: [fast.model], enabled: true },
    { id: 'mtplx', name: 'MTPLX', servicePlan: 'local', models: ['example-local', 'unmeasured-local'], enabled: true },
  ] }) }));
  app.use(errorMiddleware);

  const body = (await request(app).get('/comparison')).body;
  const rows = body.composite.rows;
  const api = rows.find(row => row.providerId === 'example-provider' && row.tokensPerSecond);
  expect(api.tokensPerSecond.value).toBeGreaterThan(0);
  expect(api.tokensPerSecond.estimated).toBe(false);

  const local = rows.find(row => row.model === 'example-local');
  // The untuned reading wins over a newer tuned one: the axis describes the runtime as configured.
  expect(local.tokensPerSecond).toMatchObject({ value: 120.5, estimated: false });
  expect(body.composite.sources[local.tokensPerSecond.sourceIds[0]].url).toBe('/models/performance/results');
  expect(rows.find(row => row.model === 'unmeasured-local').tokensPerSecond).toBeNull();
});
