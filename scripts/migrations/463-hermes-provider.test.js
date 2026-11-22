import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import migration from './463-hermes-provider.js';

it('adds disabled Hermes presets idempotently without replacing local configuration', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'hermes-seed-'));
  await mkdir(join(rootDir, 'data'));
  const path = join(rootDir, 'data/providers.json');
  const custom = { id: 'hermes-cli', command: '/opt/bin/hermes', enabled: true };
  await writeFile(path, JSON.stringify({ activeProvider: 'hermes-cli', providers: { 'hermes-cli': custom } }));
  await migration.up({ rootDir });
  const once = await readFile(path, 'utf8');
  await migration.up({ rootDir });
  expect(await readFile(path, 'utf8')).toBe(once);
  const state = JSON.parse(once);
  expect(state.activeProvider).toBe('hermes-cli');
  expect(state.providers['hermes-cli']).toEqual(custom);
  expect(state.providers['hermes-tui']).toMatchObject({ enabled: false, models: [], defaultModel: null, command: 'hermes' });
  await rm(rootDir, { recursive: true });
});
