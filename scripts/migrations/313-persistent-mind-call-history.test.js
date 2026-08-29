import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import migration from './313-persistent-mind-call-history.js';
import { PERSISTENT_MIND_SCHEMA_VERSION } from '../../server/lib/persistentMind.js';

let rootDir;

afterEach(async () => {
  if (rootDir) await rm(rootDir, { recursive: true, force: true });
  rootDir = null;
});

const statePath = () => join(rootDir, 'data', 'cos', 'state.json');
const readMind = async () => JSON.parse(await readFile(statePath(), 'utf8')).persistentMind;

describe('migration 313 — persistent mind call ledger', () => {
  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'portos-mind-call-ledger-'));
    await mkdir(join(rootDir, 'data', 'cos'), { recursive: true });
  });

  it('seeds an empty ledger without disturbing the rest of the mind state', async () => {
    await writeFile(statePath(), JSON.stringify({
      persistentMind: { schemaVersion: 4, enabled: true, started: true, futureField: 'preserve' },
    }));

    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 1 });
    expect(await readMind()).toMatchObject({
      schemaVersion: PERSISTENT_MIND_SCHEMA_VERSION,
      callHistory: [],
      enabled: true,
      futureField: 'preserve',
    });
  });

  it('never resets an existing ledger', async () => {
    // The caps this list backs must survive an upgrade the same way they
    // survive a restart — re-running the migration cannot hand back a fresh
    // allowance to a mind that has already used it.
    const callHistory = [{ at: '2026-08-28T09:00:00.000Z', reason: 'Backups failing', source: 'mind' }];
    await writeFile(statePath(), JSON.stringify({ persistentMind: { schemaVersion: 4, callHistory } }));

    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 1 });
    expect((await readMind()).callHistory).toEqual(callHistory);
  });

  it('is idempotent once the schema and ledger are current', async () => {
    const current = { schemaVersion: PERSISTENT_MIND_SCHEMA_VERSION, callHistory: [] };
    await writeFile(statePath(), JSON.stringify({ persistentMind: current }));

    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'already-applied' });
    expect(await readMind()).toEqual(current);
  });

  it('leaves missing and invalid Persistent Mind state untouched', async () => {
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'no-state' });
    await writeFile(statePath(), JSON.stringify({ config: {} }));
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'no-persistent-mind' });
    await writeFile(statePath(), '{broken');
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'invalid-state' });
  });
});
