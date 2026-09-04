import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import migration from './342-persistent-mind-thinking-presets.js';
import { PERSISTENT_MIND_SCHEMA_VERSION } from '../../server/lib/persistentMind.js';

let rootDir;

afterEach(async () => {
  if (rootDir) await rm(rootDir, { recursive: true, force: true });
  rootDir = null;
});

const configPath = () => join(rootDir, 'data', 'cos', 'config.json');
const statePath = () => join(rootDir, 'data', 'cos', 'state.json');
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

describe('migration 342 — persistent mind thinking presets', () => {
  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'portos-mind-thinking-presets-'));
    await mkdir(join(rootDir, 'data', 'cos'), { recursive: true });
  });

  it('adds an empty preset list without touching the pinned home profile', async () => {
    await writeFile(configPath(), JSON.stringify({
      maxConcurrentAgents: 3,
      persistentMindProfile: { enabled: true, providerId: 'example-provider', model: 'example-model', effort: 'high' },
    }));
    await writeFile(statePath(), JSON.stringify({
      persistentMind: { schemaVersion: 5, enabled: true, futureField: 'preserve' },
    }));

    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 2 });
    expect(await readJson(configPath())).toMatchObject({
      maxConcurrentAgents: 3,
      persistentMindProfile: { enabled: true, providerId: 'example-provider', model: 'example-model', effort: 'high' },
      persistentMindThinkingPresets: { schemaVersion: 1, presets: [] },
    });
    expect(await readJson(statePath())).toMatchObject({
      persistentMind: { schemaVersion: PERSISTENT_MIND_SCHEMA_VERSION, enabled: true, futureField: 'preserve' },
    });
  });

  it('never replaces presets a user already saved', async () => {
    const presets = { schemaVersion: 1, presets: [{ id: 'deep', label: 'Deep', providerId: 'example-provider', model: 'example-model', effort: 'max' }] };
    await writeFile(configPath(), JSON.stringify({ persistentMindThinkingPresets: presets }));
    await writeFile(statePath(), JSON.stringify({ persistentMind: { schemaVersion: PERSISTENT_MIND_SCHEMA_VERSION } }));

    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'already-applied' });
    expect((await readJson(configPath())).persistentMindThinkingPresets).toEqual(presets);
  });

  it('leaves missing, invalid, or mind-less files untouched', async () => {
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'already-applied' });

    await writeFile(configPath(), '{broken');
    await writeFile(statePath(), JSON.stringify({ agents: {} }));
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'already-applied' });
    expect(await readFile(configPath(), 'utf8')).toBe('{broken');
  });
});
