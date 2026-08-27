import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import migration from './299-persistent-mind-identity.js';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

describe('migration 299 — persistent mind identity', () => {
  let rootDir;
  let statePath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-299-persistent-mind-'));
    mkdirSync(join(rootDir, 'data', 'cos'), { recursive: true });
    statePath = join(rootDir, 'data', 'cos', 'state.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('upgrades an existing slice without losing future fields', async () => {
    writeFileSync(statePath, JSON.stringify({
      running: true,
      persistentMind: { schemaVersion: 1, enabled: true, customFutureField: 'preserve' },
    }));

    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 1 });
    expect(readJson(statePath)).toMatchObject({
      running: true,
      persistentMind: {
        schemaVersion: 2,
        mindId: 'cos-persistent-mind',
        enabled: true,
        customFutureField: 'preserve',
      },
    });
  });

  it('is idempotent', async () => {
    writeFileSync(statePath, JSON.stringify({
      persistentMind: { schemaVersion: 2, mindId: 'cos-persistent-mind' },
    }));
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'already-applied' });
  });

  it('leaves corrupt state untouched', async () => {
    writeFileSync(statePath, '{broken');
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'invalid-state' });
    expect(readFileSync(statePath, 'utf8')).toBe('{broken');
  });
});
