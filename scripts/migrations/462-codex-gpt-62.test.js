import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import migration from './462-codex-gpt-62.js';

let rootDir;
afterEach(async () => { if (rootDir) await rm(rootDir, { recursive: true, force: true }); });

it('adds missing GPT-6.2 models to existing presets without changing user settings or research', async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'portos-codex-62-'));
  await mkdir(join(rootDir, 'data'));
  const path = join(rootDir, 'data/providers.json');
  const comparisonPath = join(rootDir, 'data/model-comparison.json');
  const research = '{"schemaVersion":1,"observations":[{"id":"custom research"}]}';
  const providers = {
    codex: { models: ['custom-model'], defaultModel: 'custom-model', heavyModel: 'custom-model', extra: { enabled: true } },
    'codex-tui': { models: ['gpt-6.2-sol', 'another-custom'], defaultModel: 'another-custom' },
    unrelated: { models: ['custom-model'] },
  };
  await writeFile(path, JSON.stringify({ activeProvider: 'codex', providers }));
  await writeFile(comparisonPath, research);
  expect(await migration.up({ rootDir })).toMatchObject({ updated: 2 });
  const updated = JSON.parse(await readFile(path, 'utf8'));
  expect(updated).toEqual({ activeProvider: 'codex', providers: {
    ...providers,
    codex: { ...providers.codex, models: ['gpt-6.2-astra', 'gpt-6.2-sol', 'custom-model'] },
    'codex-tui': { ...providers['codex-tui'], models: ['gpt-6.2-astra', 'gpt-6.2-sol', 'another-custom'] },
  } });
  expect(await readFile(comparisonPath, 'utf8')).toBe(research);
  expect(await migration.up({ rootDir })).toMatchObject({ updated: 0 });
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(updated);
});

it('leaves absent presets and missing provider files alone', async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'portos-codex-62-'));
  expect(await migration.up({ rootDir })).toMatchObject({ reason: 'no-file', updated: 0 });
  await mkdir(join(rootDir, 'data'));
  const path = join(rootDir, 'data/providers.json');
  const original = JSON.stringify({ providers: { other: { models: ['custom'] } } });
  await writeFile(path, original);
  expect(await migration.up({ rootDir })).toMatchObject({ updated: 0 });
  expect(await readFile(path, 'utf8')).toBe(original);
});
