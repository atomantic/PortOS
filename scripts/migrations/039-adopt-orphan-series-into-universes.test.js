import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'node:crypto';

import migration from './039-adopt-orphan-series-into-universes.js';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf-8'));
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
const derivedId = (seriesId) =>
  `uni-from-series-${createHash('sha1').update(String(seriesId)).digest('hex').slice(0, 32)}`;

describe('migration 039 — adopt orphan series into universes', () => {
  let rootDir;
  let seriesDir;
  let universesDir;

  const writeSeries = (rec) => {
    const dir = join(seriesDir, rec.id);
    mkdirSync(dir, { recursive: true });
    writeJson(join(dir, 'index.json'), rec);
  };

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-039-'));
    seriesDir = join(rootDir, 'data', 'pipeline-series');
    universesDir = join(rootDir, 'data', 'universes');
    mkdirSync(seriesDir, { recursive: true });
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('adopts an orphan series into a deterministic synthesized universe', async () => {
    writeSeries({ id: 'ser-1', name: 'Salt Run', logline: 'A heist', universeId: null, updatedAt: '2026-05-01T00:00:00Z' });

    const res = await migration.up({ rootDir });
    expect(res).toMatchObject({ ok: true, reason: 'adopted', linked: 1, created: 1 });

    const uid = derivedId('ser-1');
    const universe = readJson(join(universesDir, uid, 'index.json'));
    expect(universe.id).toBe(uid);
    expect(universe.name).toBe('Salt Run (adopted)');
    expect(universe.starterPrompt).toBe('A heist');

    const series = readJson(join(seriesDir, 'ser-1', 'index.json'));
    expect(series.universeId).toBe(uid);
    expect(series.updatedAt).not.toBe('2026-05-01T00:00:00Z'); // bumped

    // Type index stamped so the store can read it.
    expect(readJson(join(universesDir, 'index.json')).schemaVersion).toBe(5);
  });

  it('leaves already-linked series untouched', async () => {
    writeSeries({ id: 'ser-2', name: 'Linked', universeId: 'u-existing', updatedAt: '2026-05-01T00:00:00Z' });
    const res = await migration.up({ rootDir });
    expect(res.reason).toBe('no-orphans');
    expect(readJson(join(seriesDir, 'ser-2', 'index.json')).universeId).toBe('u-existing');
  });

  it('skips deleted orphan series', async () => {
    writeSeries({ id: 'ser-3', name: 'Gone', universeId: null, deleted: true, deletedAt: '2026-05-01T00:00:00Z', updatedAt: '2026-05-01T00:00:00Z' });
    const res = await migration.up({ rootDir });
    expect(res.reason).toBe('no-orphans');
    expect(existsSync(join(universesDir, derivedId('ser-3')))).toBe(false);
  });

  it('is idempotent — a second run is a no-op', async () => {
    writeSeries({ id: 'ser-4', name: 'Once', universeId: null, updatedAt: '2026-05-01T00:00:00Z' });
    await migration.up({ rootDir });
    const second = await migration.up({ rootDir });
    expect(second.reason).toBe('no-orphans');
  });

  it('reuses the deterministic universe on retry instead of duplicating', async () => {
    writeSeries({ id: 'ser-5', name: 'Retry', universeId: null, updatedAt: '2026-05-01T00:00:00Z' });
    const uid = derivedId('ser-5');
    // Simulate a prior partial run: universe exists but series link never landed.
    mkdirSync(join(universesDir, uid), { recursive: true });
    writeJson(join(universesDir, uid, 'index.json'), { id: uid, name: 'Pre-existing', schemaVersion: 4 });

    const res = await migration.up({ rootDir });
    expect(res).toMatchObject({ linked: 1, created: 0 }); // reused, not recreated
    expect(readJson(join(universesDir, uid, 'index.json')).name).toBe('Pre-existing'); // untouched
    expect(readJson(join(seriesDir, 'ser-5', 'index.json')).universeId).toBe(uid);
  });

  it('no-op on a fresh install with no series dir', async () => {
    rmSync(seriesDir, { recursive: true, force: true });
    const res = await migration.up({ rootDir });
    expect(res.reason).toBe('no-series');
  });
});
