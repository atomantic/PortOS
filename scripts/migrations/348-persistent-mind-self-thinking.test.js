import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import migration from './348-persistent-mind-self-thinking.js';
let rootDir;
afterEach(async () => { if (rootDir) await rm(rootDir, { recursive: true, force: true }); });
it('adds disabled grants and durable state while preserving old preferences, unrelated fields and existing allowance', async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'portos-self-thinking-'));
  await mkdir(join(rootDir, 'data', 'cos'), { recursive: true });
  const configPath = join(rootDir, 'data', 'cos', 'config.json');
  const statePath = join(rootDir, 'data', 'cos', 'state.json');
  const config = { persistentMindProfile: { providerId: 'example-default', model: 'example-model' }, persistentMindCapabilities: { schemaVersion: 5, createTasks: true, taskModelAllowlist: [{ providerId: 'example-coder', model: 'example-code' }] } };
  const thinkingRequests = { pending: null, history: [{ requestId: 'existing-attempt' }] };
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(statePath, JSON.stringify({ persistentMind: { schemaVersion: 7, thinkingRequests }, unrelated: true }));
  await migration.up({ rootDir });
  expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
    persistentMindProfile: config.persistentMindProfile,
    persistentMindCapabilities: { ...config.persistentMindCapabilities, schemaVersion: 6, chooseThinkingPreset: false, thinkingPresetAllowlist: [] },
  });
  expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual({ persistentMind: { schemaVersion: 8, thinkingRequests }, unrelated: true });
  const saved = await readFile(configPath, 'utf8');
  await migration.up({ rootDir });
  expect(await readFile(configPath, 'utf8')).toBe(saved);
});
