import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import migration from './355-unify-provider-modes.js';
let rootDir;
afterEach(async () => { if (rootDir) await rm(rootDir, { recursive: true, force: true }); });
it('unifies either-enabled siblings, preserves execution pins and separate connections, and is idempotent', async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'portos-provider-modes-'));
  expect(await migration.up({ rootDir })).toEqual({ updated: 0 });
  await mkdir(join(rootDir, 'data'));
  const path = join(rootDir, 'data', 'providers.json');
  const providers = {};
  for (const [stem, cliEnabled, tuiEnabled] of [['first', false, true], ['second', true, false], ['off', false, false]]) {
    providers[stem] = { id: stem, type: 'cli', command: 'example', enabled: cliEnabled, models: ['model-a'], defaultModel: 'model-a', args: ['--print'] };
    providers[`${stem}-tui`] = { id: `${stem}-tui`, type: 'tui', command: 'example', enabled: tuiEnabled, models: ['model-b'], defaultModel: 'model-b', args: [] };
  }
  providers.remote = { id: 'remote', type: 'api', endpoint: 'http://192.0.2.10:11434', enabled: false, models: ['remote-model'] };
  providers['remote-tui'] = { id: 'remote-tui', type: 'tui', command: 'example', enabled: true };
  providers.custom = { id: 'custom', type: 'cli', command: 'example', envVars: { BACKEND: 'one' }, enabled: false };
  providers['custom-tui'] = { id: 'custom-tui', type: 'tui', command: 'example', envVars: { BACKEND: 'two' }, enabled: true };
  const before = structuredClone(providers);
  await writeFile(path, JSON.stringify({ activeProvider: 'first-tui', providers }));
  expect(await migration.up({ rootDir })).toEqual({ updated: 1 });
  const result = JSON.parse(await readFile(path, 'utf8'));
  expect(result.activeProvider).toBe('first-tui');
  for (const stem of ['first', 'second', 'off']) {
    for (const id of [stem, `${stem}-tui`]) {
      expect(result.providers[id]).toEqual({ ...before[id], enabled: stem !== 'off', models: ['model-a', 'model-b'] });
    }
  }
  for (const id of ['remote', 'remote-tui', 'custom', 'custom-tui']) expect(result.providers[id]).toEqual(before[id]);
  expect(await migration.up({ rootDir })).toEqual({ updated: 0 });
});
