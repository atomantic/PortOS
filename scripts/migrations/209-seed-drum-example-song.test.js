import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './209-seed-drum-example-song.js';
import { parseDrumChart } from '../../client/src/lib/drumNotation.js';

const SEED_ID = 'song-seed-example-rock-beat';

let rootDir;
let seedDir;
let perRecordDir;
let legacyPath;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'migration-209-'));
  seedDir = join(rootDir, 'data.reference', 'brain');
  perRecordDir = join(rootDir, 'data', 'brain', 'songs');
  legacyPath = join(rootDir, 'data', 'brain', 'songs.json');
  mkdirSync(seedDir, { recursive: true });
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

// Invented seed fixture (privacy convention) — mirrors the shipped shape.
const SEEDS = {
  records: {
    [SEED_ID]: {
      title: 'Example Rock Beat',
      artist: 'The Placeholders',
      instrument: 'drums',
      content: { format: 'drum', text: 'HH: xxxx\nK: o---' },
      attachments: [],
      createdAt: '2026-07-26T00:00:00.000Z',
      updatedAt: '2026-07-26T00:00:00.000Z',
      originInstanceId: 'seed',
    },
    // An unrelated seed the migration must NOT touch (it owns one id only).
    'song-seed-other': { title: 'Other Seed', attachments: [] },
  },
};

const writeSeed = (obj = SEEDS) => writeFileSync(join(seedDir, 'songs.json'), JSON.stringify(obj, null, 2));
const recordPath = (id = SEED_ID) => join(perRecordDir, id, 'index.json');
const writeRecord = (obj, id = SEED_ID) => {
  mkdirSync(join(perRecordDir, id), { recursive: true });
  writeFileSync(recordPath(id), JSON.stringify(obj, null, 2));
};
const readRecord = (id = SEED_ID) => JSON.parse(readFileSync(recordPath(id), 'utf-8'));
const writeLegacy = (obj) => {
  mkdirSync(join(rootDir, 'data', 'brain'), { recursive: true });
  writeFileSync(legacyPath, JSON.stringify(obj, null, 2));
};
const readLegacy = () => JSON.parse(readFileSync(legacyPath, 'utf-8'));

describe('migration 209 — seed the drum example song', () => {
  it('writes the per-record file (with parent dirs) on a split install', async () => {
    writeSeed();
    const result = await migration.up({ rootDir });
    expect(result).toMatchObject({ ok: true, reason: 'seeded', added: 1, legacyAdded: 0 });
    expect(readRecord().title).toBe('Example Rock Beat');
    expect(readRecord().instrument).toBe('drums');
    // It owns exactly one id — the other seed is another migration's business.
    expect(existsSync(recordPath('song-seed-other'))).toBe(false);
  });

  it('never overwrites an existing id — an edited copy survives', async () => {
    writeSeed();
    writeRecord({ title: 'My Customized Groove', updatedAt: '2026-08-01T00:00:00.000Z' });
    const result = await migration.up({ rootDir });
    expect(result.reason).toBe('already-present');
    expect(readRecord().title).toBe('My Customized Groove');
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
    writeLegacy({ records: { 'user-song-1': { title: 'User Song' } } });
    const result = await migration.up({ rootDir });
    expect(result).toMatchObject({ added: 1, legacyAdded: 1 });
    const live = readLegacy();
    expect(live.records[SEED_ID].title).toBe('Example Rock Beat');
    expect(live.records['user-song-1'].title).toBe('User Song');
    expect(live.records['song-seed-other']).toBeUndefined();
  });

  it('never CREATES a legacy file on a split install', async () => {
    writeSeed();
    await migration.up({ rootDir });
    expect(existsSync(legacyPath)).toBe(false);
  });

  it('leaves an existing legacy id alone', async () => {
    writeSeed();
    writeLegacy({ records: { [SEED_ID]: { title: 'Kept' } } });
    const result = await migration.up({ rootDir });
    expect(result.legacyAdded).toBe(0);
    expect(readLegacy().records[SEED_ID].title).toBe('Kept');
  });

  it('NEVER writes over an unreadable record or legacy file', async () => {
    writeSeed();
    mkdirSync(join(perRecordDir, SEED_ID), { recursive: true });
    writeFileSync(recordPath(), '{not json');
    writeLegacy({ records: {} });
    writeFileSync(legacyPath, '{also not json');
    const result = await migration.up({ rootDir });
    expect(result.reason).toBe('already-present');
    // Both corrupt files are byte-for-byte untouched (recoverable by the user).
    expect(readFileSync(recordPath(), 'utf-8')).toBe('{not json');
    expect(readFileSync(legacyPath, 'utf-8')).toBe('{also not json');
  });

  it('no-ops when the seed file is missing or lacks the drum record', async () => {
    const missing = await migration.up({ rootDir });
    expect(missing).toMatchObject({ ok: true, reason: 'no-seeds' });
    expect(existsSync(recordPath())).toBe(false);

    writeSeed({ records: { 'song-seed-other': { title: 'Other' } } });
    expect(await migration.up({ rootDir })).toMatchObject({ reason: 'no-seeds' });
  });

  it('ships a parseable drum chart in the real reference file', async () => {
    const shipped = JSON.parse(readFileSync(new URL('../../data.reference/brain/songs.json', import.meta.url), 'utf-8'));
    const rec = shipped.records[SEED_ID];
    expect(rec).toBeDefined();
    expect(rec.title).toBe('Example Rock Beat');
    expect(rec.artist).toBe('The Placeholders');
    expect(rec.instrument).toBe('drums');
    expect(rec.content.format).toBe('drum');
    expect(rec.attachments).toEqual([]);
    // A fixed originInstanceId keeps the record byte-identical on every install,
    // so the brain reconcile checksum converges (see migration 190's note).
    expect(rec.originInstanceId).toBe('seed');
    // The worked example must actually parse clean — a seed with errors would
    // teach the format wrong.
    const chart = parseDrumChart(rec.content.text);
    expect(chart.errors).toEqual([]);
    expect(chart.bars.length).toBeGreaterThan(1);
    expect(chart.pieces).toContain('K');
    expect(chart.pieces).toContain('S');
    expect(chart.pieces).toContain('HH');
    expect(chart.tempo).toBeGreaterThan(0);
    // …and it must exercise the repeat + glyph range it's demonstrating.
    expect(chart.bars.some((b) => b.repeat > 1)).toBe(true);
    const glyphs = new Set(chart.bars.flatMap((b) => b.rows.flatMap((r) => r.cells.map((c) => c.id))));
    for (const id of ['normal', 'accent', 'open', 'ghost', 'rest']) expect(glyphs).toContain(id);
  });
});
