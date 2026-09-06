import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import migration from './354-pi-provider.js';

it('adds disabled Pi presets idempotently without replacing local configuration', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'pi-seed-'));
  await mkdir(join(rootDir, 'data'));
  const path = join(rootDir, 'data/providers.json');
  const custom = { id: 'pi-cli', command: '/opt/bin/pi', enabled: true };
  await writeFile(path, JSON.stringify({ activeProvider: 'pi-cli', providers: { 'pi-cli': custom } }));
  await migration.up({ rootDir });
  const once = await readFile(path, 'utf8');
  await migration.up({ rootDir });
  expect(await readFile(path, 'utf8')).toBe(once);
  const state = JSON.parse(once);
  expect(state.activeProvider).toBe('pi-cli');
  expect(state.providers['pi-cli']).toEqual(custom);
  expect(state.providers['pi-tui']).toMatchObject({ enabled: false, models: [], defaultModel: null, command: 'pi' });
  await rm(rootDir, { recursive: true });
});
