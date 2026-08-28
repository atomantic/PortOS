import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import migration from './307-persistent-mind-self-wake-schedule-kind.js';
import { PERSISTENT_MIND_SCHEMA_VERSION } from '../../server/lib/persistentMind.js';

let rootDir;

afterEach(async () => {
  if (rootDir) await rm(rootDir, { recursive: true, force: true });
  rootDir = null;
});

const statePath = () => join(rootDir, 'data', 'cos', 'state.json');

describe('migration 307 — persistent mind self-wake schedule kind', () => {
  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'portos-mind-wake-kind-'));
    await mkdir(join(rootDir, 'data', 'cos'), { recursive: true });
  });

  it('conservatively classifies unmarked queued and active self-wakes as requested', async () => {
    const selfWake = {
      id: 'wake-queued',
      kind: 'self',
      reason: 'maximum quiet period elapsed',
      sourceTurnId: 'turn-1',
    };
    const activeWake = { ...selfWake, id: 'wake-active' };
    await writeFile(statePath(), JSON.stringify({
      persistentMind: {
        schemaVersion: 3,
        selfWake,
        activeTurn: { id: 'active-turn', wake: activeWake },
        futureField: 'preserve',
      },
    }));

    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 1 });
    const migrated = JSON.parse(await readFile(statePath(), 'utf8')).persistentMind;
    expect(migrated).toMatchObject({
      schemaVersion: PERSISTENT_MIND_SCHEMA_VERSION,
      selfWake: { scheduleKind: 'requested' },
      activeTurn: { wake: { scheduleKind: 'requested' } },
      futureField: 'preserve',
    });
  });

  it('preserves an explicitly classified quiet wake', async () => {
    const selfWake = { id: 'wake-quiet', kind: 'self', scheduleKind: 'quiet' };
    await writeFile(statePath(), JSON.stringify({ persistentMind: { schemaVersion: 3, selfWake } }));

    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 1 });
    expect(JSON.parse(await readFile(statePath(), 'utf8')).persistentMind.selfWake).toEqual(selfWake);
  });

  it('is idempotent once the schema and wake classifications are current', async () => {
    const current = {
      schemaVersion: PERSISTENT_MIND_SCHEMA_VERSION,
      selfWake: { id: 'wake-requested', kind: 'self', scheduleKind: 'requested' },
      activeTurn: null,
    };
    await writeFile(statePath(), JSON.stringify({ persistentMind: current }));

    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'already-applied' });
    expect(JSON.parse(await readFile(statePath(), 'utf8')).persistentMind).toEqual(current);
  });

  it('leaves missing and invalid Persistent Mind state untouched', async () => {
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'no-state' });
    await writeFile(statePath(), JSON.stringify({ config: {} }));
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'no-persistent-mind' });
    await writeFile(statePath(), '{broken');
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'invalid-state' });
  });
});
