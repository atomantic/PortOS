import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import migration from './320-persistent-mind-eidoverse-capability.js';

let rootDir;

afterEach(async () => {
  if (rootDir) await rm(rootDir, { recursive: true, force: true });
  rootDir = null;
});

const statePath = () => join(rootDir, 'data', 'cos', 'state.json');
const readCapabilities = async () => JSON.parse(await readFile(statePath(), 'utf8')).config.persistentMindCapabilities;

describe('migration 320 — Persistent Mind Eidoverse capability', () => {
  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'portos-eidoverse-capability-'));
    await mkdir(join(rootDir, 'data', 'cos'), { recursive: true });
  });

  it('adds the dedicated grant as disabled without changing prior authority', async () => {
    await writeFile(statePath(), JSON.stringify({
      config: {
        persistentMindCapabilities: {
          schemaVersion: 4,
          createTasks: true,
          writePortos: true,
          futureField: 'preserve',
        },
      },
    }));

    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 1 });
    expect(await readCapabilities()).toMatchObject({
      schemaVersion: 5,
      createTasks: true,
      writePortos: true,
      manageEidoverse: false,
      futureField: 'preserve',
    });
  });

  it('does not treat a pre-schema hand edit as an authority grant', async () => {
    await writeFile(statePath(), JSON.stringify({
      config: { persistentMindCapabilities: { schemaVersion: 4, manageEidoverse: true } },
    }));

    await migration.up({ rootDir });
    expect((await readCapabilities()).manageEidoverse).toBe(false);
  });

  it('is idempotent after the current schema has an explicit value', async () => {
    const current = {
      schemaVersion: 5,
      manageEidoverse: true,
    };
    await writeFile(statePath(), JSON.stringify({ config: { persistentMindCapabilities: current } }));

    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'already-applied' });
    expect(await readCapabilities()).toEqual(current);
  });

  it('does not downgrade or revoke a grant from a future schema during replay', async () => {
    const future = {
      schemaVersion: 6,
      manageEidoverse: true,
      futureField: 'preserve',
    };
    await writeFile(statePath(), JSON.stringify({ config: { persistentMindCapabilities: future } }));

    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'already-applied' });
    expect(await readCapabilities()).toEqual(future);
  });

  it('leaves missing and invalid state untouched', async () => {
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'no-state' });
    await writeFile(statePath(), '{broken');
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'invalid-state' });
  });
});
