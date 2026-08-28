import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import migration from './298-persistent-mind-runtime-state.js';
import { PERSISTENT_MIND_SCHEMA_VERSION } from '../../server/lib/persistentMind.js';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

describe('migration 298 — persistent mind runtime state', () => {
  let rootDir;
  let statePath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-298-persistent-mind-'));
    mkdirSync(join(rootDir, 'data', 'cos'), { recursive: true });
    statePath = join(rootDir, 'data', 'cos', 'state.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('does nothing when a fresh install has no CoS state yet', async () => {
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'no-state' });
  });

  it('adds a disabled, stopped runtime slice while preserving existing state', async () => {
    writeFileSync(statePath, JSON.stringify({ running: true, config: { alwaysOn: true }, agents: { a1: { status: 'completed' } } }));
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 1 });
    expect(readJson(statePath)).toMatchObject({
      running: true,
      config: { alwaysOn: true },
      agents: { a1: { status: 'completed' } },
      persistentMind: { schemaVersion: PERSISTENT_MIND_SCHEMA_VERSION, mindId: 'cos-persistent-mind', enabled: false, started: false, status: 'disabled', pendingAttachments: [] },
    });
  });

  it('is idempotent and never overwrites an existing runtime slice', async () => {
    const existing = { enabled: true, started: true, status: 'waiting', customFutureField: 'preserve' };
    writeFileSync(statePath, JSON.stringify({ persistentMind: existing }));
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'already-applied' });
    expect(readJson(statePath).persistentMind).toEqual(existing);
  });

  it('leaves a corrupted state file for cosState recovery instead of replacing it', async () => {
    writeFileSync(statePath, '{broken');
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'invalid-state' });
    expect(readFileSync(statePath, 'utf8')).toBe('{broken');
  });
});
