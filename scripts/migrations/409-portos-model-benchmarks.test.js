import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import migration from './409-portos-model-benchmarks.js';

let rootDir;
afterEach(async () => { if (rootDir) await rm(rootDir, { recursive: true, force: true }); });

it('preserves researched public scores and offers new Codex models without replacing user choices', async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'portos-benchmark-retirement-'));
  await mkdir(join(rootDir, 'data'));
  const seed = JSON.parse(await readFile(new URL('../../data.reference/model-comparison.json', import.meta.url), 'utf8'));
  const keeper = seed.observations[0];
  const artificialAnalysis = {
    ...keeper,
    id: 'aa-v-example-model',
    model: 'example-model',
    benchmark: 'Artificial Analysis Intelligence Index v4.3',
  };
  const sweBench = {
    ...keeper,
    id: 'swebench-example-model',
    model: 'example-model',
    benchmark: 'SWE-bench Verified (example harness)',
  };
  const catalogPath = join(rootDir, 'data/model-comparison.json');
  await writeFile(catalogPath, JSON.stringify({ schemaVersion: 1, observations: [keeper, artificialAnalysis, sweBench] }));
  const providerPath = join(rootDir, 'data/providers.json');
  await writeFile(providerPath, JSON.stringify({ providers: {
    codex: { models: ['gpt-5.6-luna', 'custom-model'], defaultModel: 'custom-model' },
    'codex-tui': { models: ['gpt-5.6-luna', 'gpt-6-sol'], defaultModel: 'gpt-6-sol' },
  } }));

  const result = await migration.up({ rootDir });
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  const providers = JSON.parse(await readFile(providerPath, 'utf8')).providers;

  expect(result.removed).toBe(0);
  expect(catalog.observations).toEqual([keeper, artificialAnalysis, sweBench]);
  expect(providers.codex.models).toEqual(['gpt-5.6-luna', 'gpt-6-sol', 'gpt-6-luna', 'custom-model']);
  expect(providers.codex.defaultModel).toBe('custom-model');
  expect(providers['codex-tui'].models).toEqual(['gpt-5.6-luna', 'gpt-6-sol', 'gpt-6-luna']);
  expect(await migration.up({ rootDir })).toMatchObject({ removed: 0, providerResult: { updated: 0 } });
});
