import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import migration from './357-provider-ultra-tier.js';

it('adds supported Ultra mappings, preserves explicit pins and is idempotent', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'ultra-tier-'));
  await mkdir(join(rootDir, 'data'));
  const path = join(rootDir, 'data/providers.json');
  const providers = {
    'claude-code': { command: 'claude', models: ['claude-opus-5'], defaultModel: 'claude-opus-5' },
    invalid: null,
    codex: { command: 'codex', models: ['gpt-6-astra'], defaultModel: 'old-default' },
    claude: { command: 'claude', models: ['claude-fable-5-1'] },
    legacy: { command: 'claude', models: ['opus'], heavyModel: 'opus' },
    custom: { ultraModel: 'custom-model' },
    empty: { ultraModel: null },
  };
  await writeFile(path, JSON.stringify({ activeProvider: 'legacy', providers }));
  await migration.up({ rootDir });
  const once = await readFile(path, 'utf8');
  await migration.up({ rootDir });
  expect(await readFile(path, 'utf8')).toBe(once);
  const saved = JSON.parse(once);
  expect(saved.providers['claude-code']).toEqual({ command: 'claude', models: ['claude-opus-5', 'claude-fable-5-1'], defaultModel: 'claude-opus-5', ultraModel: 'claude-fable-5-1' });
  expect(saved.activeProvider).toBe('legacy');
  expect(saved.providers.codex).toMatchObject({ ultraModel: 'gpt-6-astra', defaultModel: 'old-default' });
  expect(saved.providers.claude.ultraModel).toBe('claude-fable-5-1');
  expect(saved.providers.legacy).toEqual({ ...providers.legacy, ultraModel: null });
  expect(saved.providers.custom).toEqual(providers.custom);
  expect(saved.providers.empty).toEqual(providers.empty);
  await rm(rootDir, { recursive: true });
});
