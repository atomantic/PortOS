import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import migration from './342-persistent-mind-accepted-routes.js';
import thinkingPresetsMigration from './342-persistent-mind-thinking-presets.js';

let rootDir;
afterEach(async () => {
  if (rootDir) await rm(rootDir, { recursive: true, force: true });
  rootDir = null;
});

describe('migration 342-persistent-mind-accepted-routes', () => {
  it('preserves messages, attachments, pause and unknown fields without inventing temporary authority', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'portos-mind-accepted-routes-'));
    const dir = join(rootDir, 'data', 'cos');
    await mkdir(dir, { recursive: true });
    const statePath = join(dir, 'state.json');
    const configPath = join(dir, 'config.json');
    const ordinary = { id: 'ordinary', text: 'Keep me', images: [{ attachmentId: 'example-image' }] };
    const temporary = { id: 'temporary', text: 'Keep this too', thinkingPresetId: 'deep', custom: 'preserved' };
    const state = {
      config: { persistentMindProfile: { enabled: false, providerId: 'example', model: 'example-model' } },
      unknown: { keep: true },
      persistentMind: {
        schemaVersion: 6, enabled: true, started: true, status: 'paused', futureField: 'keep',
        queuedMessages: [ordinary, temporary],
        activeTurn: { id: 'interrupted', wake: { kind: 'message', message: { ...temporary, id: 'active' } } },
        recentMessageFingerprints: [{ id: 'completed', fingerprint: 'a'.repeat(64) }],
      },
    };
    await writeFile(statePath, JSON.stringify(state));
    const config = JSON.stringify({ persistentMindProfile: state.config.persistentMindProfile, persistentMindThinkingPresets: { presets: [] } });
    await writeFile(configPath, config);

    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 1 });
    const migrated = JSON.parse(await readFile(statePath, 'utf8'));
    expect(migrated).toEqual({
      ...state,
      persistentMind: {
        ...state.persistentMind, schemaVersion: 7,
        queuedMessages: [ordinary, { ...temporary, thinkingPreset: null }],
        activeTurn: { ...state.persistentMind.activeTurn, wake: { kind: 'message', message: { ...temporary, id: 'active', thinkingPreset: null } } },
      },
    });
    expect(await readFile(configPath, 'utf8')).toBe(config);
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'already-applied' });
  });

  it('still marks unverified messages when the thinking-presets migration runs in the same pass', async () => {
    // Filename sort ('accepted-routes' < 'thinking-presets') must put this
    // migration's schemaVersion=7 stamp BEFORE 342-persistent-mind-thinking-
    // presets bumps straight to PERSISTENT_MIND_SCHEMA_VERSION (8). If the
    // thinking-presets migration ran first, it would stamp 8 immediately and
    // this migration's `schemaVersion > 7` gate would then skip — silently
    // leaving stale queued messages without their missing-route sentinel on
    // any install that applies both migrations in one multi-version pass.
    rootDir = await mkdtemp(join(tmpdir(), 'portos-mind-migration-order-'));
    const dir = join(rootDir, 'data', 'cos');
    await mkdir(dir, { recursive: true });
    const temporary = { id: 'temporary', text: 'Keep this too', thinkingPresetId: 'deep' };
    const state = {
      persistentMind: {
        schemaVersion: 6, enabled: true,
        queuedMessages: [temporary],
      },
    };
    await writeFile(join(dir, 'state.json'), JSON.stringify(state));
    await writeFile(join(dir, 'config.json'), JSON.stringify({ persistentMindThinkingPresets: { presets: [] } }));

    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 1 });
    await expect(thinkingPresetsMigration.up({ rootDir })).resolves.toEqual({ updated: 1 });

    const migrated = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
    expect(migrated.persistentMind.schemaVersion).toBe(8);
    expect(migrated.persistentMind.queuedMessages).toEqual([{ ...temporary, thinkingPreset: null }]);
  });

  it('does not create a state file or replace invalid input or newer state', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'portos-mind-route-missing-'));
    await expect(migration.up({ rootDir })).resolves.toMatchObject({ updated: 0 });
    const dir = join(rootDir, 'data', 'cos');
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'state.json');
    for (const raw of ['{broken', JSON.stringify({ persistentMind: { schemaVersion: 100, queuedMessages: [{ thinkingPresetId: 'future' }] } })]) {
      await writeFile(path, raw);
      await expect(migration.up({ rootDir })).resolves.toMatchObject({ updated: 0 });
      expect(await readFile(path, 'utf8')).toBe(raw);
    }
  });
});
