/**
 * Sprites file-backend round-trip (#2895). Runs against a tmpdir in the normal
 * (non-DB) suite — covers create/list/get/update/delete + the importer upsert,
 * without touching real `data/` or needing Postgres. The PG backend shares the
 * same recordsLogic decisions, so its row I/O mirrors this.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'sprite-records-file-test-'));

vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, PATHS: { ...actual.PATHS, data: TEST_DATA_ROOT } };
});

const file = await import('./recordsFile.js');

beforeEach(() => rmSync(join(TEST_DATA_ROOT, 'sprite-records.json'), { force: true }));
afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

describe('recordsFile backend', () => {
  it('creates, lists, gets, updates, soft-deletes', async () => {
    const created = await file.createRecord({ kind: 'character', name: 'Hero' }, 'hero');
    expect(created.id).toBe('hero');
    expect(await file.listRecords()).toHaveLength(1);

    const updated = await file.updateRecord('hero', { notes: 'n1' });
    expect(updated.notes).toBe('n1');

    await file.deleteRecord('hero');
    expect(await file.listRecords()).toHaveLength(0);
    expect(await file.getRecord('hero')).toBeNull();
    expect((await file.getRecord('hero', { includeDeleted: true })).deleted).toBe(true);
  });

  it('refuses a duplicate live id', async () => {
    await file.createRecord({ name: 'Hero' }, 'hero');
    await expect(file.createRecord({ name: 'Hero 2' }, 'hero')).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
  });

  it('upsertImportedRecord creates then refreshes while preserving user fields', async () => {
    const first = await file.upsertImportedRecord('hero', { kind: 'character', name: 'Hero', status: 'imported' });
    expect(first.status).toBe('imported');
    await file.updateRecord('hero', { notes: 'keep me' });

    const second = await file.upsertImportedRecord('hero', {
      kind: 'character', name: 'Hero v2', status: 'imported', spec: { v: 2 },
    });
    expect(second.name).toBe('Hero v2');
    expect(second.spec).toEqual({ v: 2 });
    expect(second.notes).toBe('keep me');
    expect(await file.listRecords()).toHaveLength(1);
  });
});
