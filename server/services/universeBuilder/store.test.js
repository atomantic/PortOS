/**
 * Universe store facade — file-backend dispatcher behavior (#1014).
 *
 * NODE_ENV=test selects the file backend (collectionStore over a real tmpdir),
 * so this exercises the facade WITHOUT a database: the read/write/delete surface
 * the service uses, the local-only runs API + 200 cap, cascade-remove, and the
 * mutation epoch that record writes bump (and runs deliberately do NOT) — the
 * signal dataSync folds into its fingerprint so the storage swap stays invisible
 * to federation.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { vi } from 'vitest';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'universe-store-test-'));

vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, PATHS: { ...actual.PATHS, data: TEST_DATA_ROOT } };
});

const { getUniverseStore, _resetUniverseStore, getUniverseMutationEpoch } = await import('./store.js');

// Minimal sanitizer that just passes the record through — the facade's sanitize
// hook is the service's sanitizeTemplate in production; here we only assert the
// hook is applied (loadOne runs it, loadOneRaw does not).
const passthroughSanitize = (r) => (r ? { ...r, _sanitized: true } : r);

describe('universe store facade — file backend', () => {
  beforeEach(() => {
    rmSync(join(TEST_DATA_ROOT, 'universes'), { recursive: true, force: true });
    _resetUniverseStore();
  });
  afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

  it('selects the file backend under NODE_ENV=test', async () => {
    const s = getUniverseStore(passthroughSanitize);
    await s.listIds();
    expect(s.getBackendName()).toBe('file');
  });

  it('writeRecord persists, loadOneRaw returns verbatim, loadOne sanitizes', async () => {
    const s = getUniverseStore(passthroughSanitize);
    await s.writeRecord('u-1', { id: 'u-1', name: 'Aurora' });
    expect(await s.loadOneRaw('u-1')).toEqual({ id: 'u-1', name: 'Aurora' });
    expect(await s.loadOne('u-1')).toEqual({ id: 'u-1', name: 'Aurora', _sanitized: true });
    expect((await s.listIds())).toEqual(['u-1']);
  });

  it('listRaw returns every record verbatim (no sanitize) in one bulk read', async () => {
    const s = getUniverseStore(passthroughSanitize);
    await s.writeRecord('u-1', { id: 'u-1', name: 'A' });
    await s.writeRecord('u-2', { id: 'u-2', name: 'B' });
    const all = await s.listRaw();
    expect(all.map((r) => r.id).sort()).toEqual(['u-1', 'u-2']);
    expect(all.every((r) => !('_sanitized' in r))).toBe(true); // raw, not sanitized
  });

  it('deleteRecord removes the record', async () => {
    const s = getUniverseStore(passthroughSanitize);
    await s.writeRecord('u-1', { id: 'u-1', name: 'X' });
    await s.deleteRecord('u-1');
    expect(await s.loadOneRaw('u-1')).toBeNull();
    expect(await s.listIds()).toEqual([]);
  });

  it('record writes AND deletes bump the mutation epoch; reads do not', async () => {
    const s = getUniverseStore(passthroughSanitize);
    const e0 = getUniverseMutationEpoch();
    await s.writeRecord('u-1', { id: 'u-1', name: 'X' });
    const e1 = getUniverseMutationEpoch();
    expect(e1).toBeGreaterThan(e0);
    await s.loadOne('u-1');
    await s.listIds();
    expect(getUniverseMutationEpoch()).toBe(e1); // reads don't bump
    await s.deleteRecord('u-1');
    expect(getUniverseMutationEpoch()).toBeGreaterThan(e1);
  });

  it('runs API stores/loads, caps at 200, and does NOT bump the epoch', async () => {
    const s = getUniverseStore(passthroughSanitize);
    const before = getUniverseMutationEpoch();
    for (let i = 0; i < 205; i += 1) {
      await s.appendRun({ id: `run-${i}`, universeId: 'u-1', jobIds: [], promptCount: i, createdAt: new Date(1700000000000 + i).toISOString() });
    }
    const all = await s.loadRuns();
    expect(all.length).toBe(200);
    expect(getUniverseMutationEpoch()).toBe(before); // runs are local-only
  });

  it('loadRuns scopes by universeId; removeRunsForUniverses drops only those', async () => {
    const s = getUniverseStore(passthroughSanitize);
    await s.appendRun({ id: 'r-a', universeId: 'u-A', jobIds: [], promptCount: 1, createdAt: '2026-01-01T00:00:00.000Z' });
    await s.appendRun({ id: 'r-b', universeId: 'u-B', jobIds: [], promptCount: 1, createdAt: '2026-01-01T00:00:01.000Z' });
    expect((await s.loadRuns('u-A')).map((r) => r.id)).toEqual(['r-a']);
    await s.removeRunsForUniverses(['u-A']);
    expect((await s.loadRuns()).map((r) => r.universeId)).toEqual(['u-B']);
  });

  it('loadRuns returns newest-first (created_at DESC, id DESC) to match the PG backend', async () => {
    const s = getUniverseStore(passthroughSanitize);
    await s.appendRun({ id: 'r-old', universeId: 'u-1', jobIds: [], promptCount: 1, createdAt: '2026-01-01T00:00:00.000Z' });
    await s.appendRun({ id: 'r-new', universeId: 'u-1', jobIds: [], promptCount: 1, createdAt: '2026-01-02T00:00:00.000Z' });
    expect((await s.loadRuns()).map((r) => r.id)).toEqual(['r-new', 'r-old']);
  });

  it('rejects ids outside the collectionStore allowlist on writeRecord/deleteRecord (backend parity)', async () => {
    const s = getUniverseStore(passthroughSanitize);
    await expect(s.writeRecord('bad/id', { id: 'bad/id', name: 'X' })).rejects.toThrow(/invalid record id/);
    await expect(s.writeRecord('a'.repeat(129), { id: 'a'.repeat(129), name: 'X' })).rejects.toThrow(/invalid record id/);
    await expect(s.deleteRecord('bad/id')).rejects.toThrow(/invalid record id/);
    // A valid id still works.
    await s.writeRecord('ok-1', { id: 'ok-1', name: 'X' });
    expect(await s.loadOneRaw('ok-1')).toEqual({ id: 'ok-1', name: 'X' });
  });

  it('queueRecordWrite throws on a bad id so mergeUniversesFromSync .catch skips it (parity)', async () => {
    const s = getUniverseStore(passthroughSanitize);
    // Throws synchronously, exactly like collectionStore.queueRecordWrite — the
    // merge path wraps each write in a try/.catch so the bad record is skipped.
    expect(() => s.queueRecordWrite('bad/id', async () => 'never')).toThrow(/invalid record id/);
  });

  it('verifySchemaVersion reports the file collection version', async () => {
    const s = getUniverseStore(passthroughSanitize);
    await s.writeRecord('u-1', { id: 'u-1', name: 'X' });
    const status = await s.verifySchemaVersion();
    expect(status.ok).toBe(true);
    expect(status.type).toBe('universes');
  });
});
