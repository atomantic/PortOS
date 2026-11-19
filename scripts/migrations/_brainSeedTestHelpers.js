/**
 * Shared test scaffolding for `makeBrainSeedMigration`-based seed migrations.
 * Companion to `./_lib.js`'s brain seed-record family,. The runner skips
 * `_`-prefixed files, so this is never imported as a migration.
 *
 * Every member of the family shares the same contract — write the per-record
 * file on a split install, never overwrite an existing id (edited copy, peer
 * copy, or tombstone), stay idempotent, top up a still-present legacy monolith
 * without ever creating one, and never write over unreadable data. Asserting
 * that once per migration is what makes a config typo (wrong `entityType`, wrong
 * `seedIds`) fail loudly, so the shared cases live here and each migration's
 * `*.test.js` collapses to a `describe` + one `runBrainSeedMigrationTests(…)`
 * call plus its own assertions about the record it actually ships.
 *
 * Fixtures are built in an `mkdtempSync` sandbox with an INVENTED seed record
 * (privacy convention) — the install's real `data/` tree is never touched.
 */

import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Run the shared contract for one brain seed migration.
 *
 *   - `migration`  — the module's default export (`{ up }`)
 *   - `number`     — migration number, for the sandbox dir name
 *   - `entityType` — brain entity type the migration seeds (e.g. `'songs'`)
 *   - `seedId`     — the id it owns
 *   - `record`     — an invented stand-in for the shipped record
 *   - `otherId`    — an unrelated seed id it must NOT touch
 */
export function runBrainSeedMigrationTests({ migration, number, entityType, seedId, record, otherId }) {
  let rootDir;
  let seedDir;
  let perRecordDir;
  let legacyPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), `migration-${number}-`));
    seedDir = join(rootDir, 'data.reference', 'brain');
    perRecordDir = join(rootDir, 'data', 'brain', entityType);
    legacyPath = join(rootDir, 'data', 'brain', `${entityType}.json`);
    mkdirSync(seedDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  const seeds = { records: { [seedId]: record, [otherId]: { title: 'Other Seed', attachments: [] } } };
  const writeSeed = (obj = seeds) => writeFileSync(join(seedDir, `${entityType}.json`), JSON.stringify(obj, null, 2));
  const recordPath = (id = seedId) => join(perRecordDir, id, 'index.json');
  const writeRecord = (obj, id = seedId) => {
    mkdirSync(join(perRecordDir, id), { recursive: true });
    writeFileSync(recordPath(id), JSON.stringify(obj, null, 2));
  };
  const readRecord = (id = seedId) => JSON.parse(readFileSync(recordPath(id), 'utf-8'));
  const writeLegacy = (obj) => {
    mkdirSync(join(rootDir, 'data', 'brain'), { recursive: true });
    writeFileSync(legacyPath, JSON.stringify(obj, null, 2));
  };
  const readLegacy = () => JSON.parse(readFileSync(legacyPath, 'utf-8'));

  it('writes the per-record file (with parent dirs) on a split install', async () => {
    writeSeed();
    const result = await migration.up({ rootDir });
    expect(result).toMatchObject({ ok: true, reason: 'seeded', added: 1, legacyAdded: 0 });
    expect(readRecord()).toEqual(record);
    // It owns exactly its own id — the other seed is another migration's business.
    expect(existsSync(recordPath(otherId))).toBe(false);
  });

  it('never overwrites an existing id — an edited copy survives', async () => {
    writeSeed();
    writeRecord({ title: 'My Customized Copy', updatedAt: '2026-08-01T00:00:00.000Z' });
    const result = await migration.up({ rootDir });
    expect(result.reason).toBe('already-present');
    expect(readRecord().title).toBe('My Customized Copy');
  });

  it('never resurrects a tombstoned (deliberately deleted) seed', async () => {
    writeSeed();
    writeRecord({ _deleted: true, updatedAt: '2026-08-01T00:00:00.000Z', deletedAt: '2026-08-01T00:00:00.000Z', originInstanceId: 'x' });
    const result = await migration.up({ rootDir });
    expect(result.reason).toBe('already-present');
    expect(readRecord()._deleted).toBe(true);
  });

  it('is idempotent — a second run adds nothing', async () => {
    writeSeed();
    await migration.up({ rootDir });
    const second = await migration.up({ rootDir });
    expect(second).toMatchObject({ reason: 'already-present', added: 0 });
  });

  it('tops up a still-present legacy monolithic file too', async () => {
    writeSeed();
    writeLegacy({ records: { 'user-record-1': { title: 'User Record' } } });
    const result = await migration.up({ rootDir });
    expect(result).toMatchObject({ added: 1, legacyAdded: 1 });
    const live = readLegacy();
    expect(live.records[seedId]).toEqual(record);
    expect(live.records['user-record-1'].title).toBe('User Record');
    expect(live.records[otherId]).toBeUndefined();
  });

  it('never CREATES a legacy file on a split install', async () => {
    writeSeed();
    await migration.up({ rootDir });
    expect(existsSync(legacyPath)).toBe(false);
  });

  it('leaves an existing legacy id alone', async () => {
    writeSeed();
    writeLegacy({ records: { [seedId]: { title: 'Kept' } } });
    const result = await migration.up({ rootDir });
    expect(result.legacyAdded).toBe(0);
    expect(readLegacy().records[seedId].title).toBe('Kept');
  });

  it('NEVER writes over an unreadable record or legacy file', async () => {
    writeSeed();
    mkdirSync(join(perRecordDir, seedId), { recursive: true });
    writeFileSync(recordPath(), '{not json');
    writeLegacy({ records: {} });
    writeFileSync(legacyPath, '{also not json');
    const result = await migration.up({ rootDir });
    expect(result.reason).toBe('already-present');
    // Both corrupt files are byte-for-byte untouched (recoverable by the user).
    expect(readFileSync(recordPath(), 'utf-8')).toBe('{not json');
    expect(readFileSync(legacyPath, 'utf-8')).toBe('{also not json');
  });

  it('no-ops when the seed file is missing or lacks this migration’s id', async () => {
    const missing = await migration.up({ rootDir });
    expect(missing).toMatchObject({ ok: true, reason: 'no-seeds' });
    expect(existsSync(recordPath())).toBe(false);

    writeSeed({ records: { [otherId]: { title: 'Other' } } });
    expect(await migration.up({ rootDir })).toMatchObject({ reason: 'no-seeds' });
  });
}
