/**
 * Meatspace federation apply — blood / epigenetic / eye records (#10910).
 *
 * `date` is not a unique identity for these records (two labs on one day, a retest,
 * left/right exams entered separately), so the snapshot merge must never collapse
 * same-date rows. And because a sync apply is a read -> merge -> write cycle on the
 * same files the local writers rewrite, it must share their write queues.
 *
 * Everything here drives the real boundary — `applyRemote('meatspace', …)` against a
 * throwaway data root — so the merge, the queueing and the persisted bytes are the
 * production code. All fixture values are invented.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { readFile, writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { makeProxy, cleanup, tempRoot } = mockPathsDataRoot({ prefix: 'portos-datasync-meatspace-' });

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makeProxy(actual);
});

const dataSync = await import('./dataSync.js');
const health = await import('./meatspaceHealth.js');
const { rowIdentityKeys } = await import('../lib/meatspaceRowIdentity.js');
// The content key every machine derives for a row without createdAt.
const legacyRowId = (row) => rowIdentityKeys(row).at(-1);
const { queueConfigWrite, queueHealthWrite } = await import('./meatspaceWriteQueues.js');

const MEATSPACE_DIR = join(tempRoot, 'meatspace');
const fileOf = (name) => join(MEATSPACE_DIR, name);

afterAll(cleanup);

beforeEach(async () => {
  await rm(MEATSPACE_DIR, { recursive: true, force: true });
  await mkdir(MEATSPACE_DIR, { recursive: true });
});

const persist = (name, doc) => writeFile(fileOf(name), JSON.stringify(doc, null, 2));
const readBytes = (name) => readFile(fileOf(name), 'utf8');
const readDoc = async (name) => JSON.parse(await readBytes(name));
const apply = (name, doc) => dataSync.applyRemote('meatspace', { [name]: doc });

// One fixture family per file: two same-date local rows, a duplicate-of-local, a
// same-date-but-different remote row, and a brand-new-date remote row.
const FAMILIES = {
  'blood-tests.json': {
    arrayKey: 'tests',
    addLocal: (row) => health.addBloodTest(row),
    sameDateA: { date: '2026-03-01', glucose: 90 },
    sameDateB: { date: '2026-03-01', ldl: 110 },
    sameDateRemote: { date: '2026-03-01', hdl: 55 },
    newDate: { date: '2026-04-01', glucose: 92 },
  },
  'epigenetic-tests.json': {
    arrayKey: 'tests',
    addLocal: (row) => health.addEpigeneticTest(row),
    sameDateA: { date: '2026-03-01', biologicalAge: 40.1 },
    sameDateB: { date: '2026-03-01', biologicalAge: 40.9 },
    sameDateRemote: { date: '2026-03-01', biologicalAge: 41.5 },
    newDate: { date: '2026-04-01', biologicalAge: 41.0 },
  },
  'eyes.json': {
    arrayKey: 'exams',
    addLocal: (row) => health.addEyeExam(row),
    sameDateA: { id: 'exam-a', createdAt: '2026-03-01T10:00:00.000Z', date: '2026-03-01', leftSphere: -1.0 },
    sameDateB: { id: 'exam-b', createdAt: '2026-03-01T11:00:00.000Z', date: '2026-03-01', rightSphere: -1.25 },
    sameDateRemote: { id: 'exam-c', createdAt: '2026-03-01T12:00:00.000Z', date: '2026-03-01', rightSphere: -1.5 },
    newDate: { id: 'exam-d', createdAt: '2026-04-01T10:00:00.000Z', date: '2026-04-01', leftSphere: -1.0 },
  },
};

describe.each(Object.entries(FAMILIES))('applyRemote meatspace %s', (filename, fx) => {
  it('keeps every same-date local row, dedupes identical rows, and is a byte-level no-op when re-applied', async () => {
    await persist(filename, { [fx.arrayKey]: [fx.sameDateA, fx.sameDateB] });

    // Remote carries a copy of a local row, a different row on the same date, and a new date.
    const remote = { [fx.arrayKey]: [fx.sameDateA, fx.sameDateRemote, fx.newDate] };
    const first = await apply(filename, remote);

    expect(first.applied).toBe(true);
    const rows = (await readDoc(filename))[fx.arrayKey];
    expect(rows).toHaveLength(4);
    // Local rows survive verbatim (the pre-fix map-by-date merge kept one per date).
    expect(rows).toEqual(expect.arrayContaining([fx.sameDateA, fx.sameDateB, fx.sameDateRemote, fx.newDate]));
    expect(rows.map((r) => r.date)).toEqual(['2026-03-01', '2026-03-01', '2026-03-01', '2026-04-01']);

    const bytes = await readBytes(filename);
    const second = await apply(filename, remote);
    expect(second.applied).toBe(false);
    expect(await readBytes(filename)).toBe(bytes);
  });
});

describe('applyRemote meatspace eyes.json identity', () => {
  const minted = '2026-05-01T09:00:00.000Z';

  it('matches an id-less local exam to its stamped remote copy, but keeps distinct minted ids with identical values', async () => {
    const values = { date: '2026-03-01', leftSphere: -2, rightSphere: -2 };
    await persist('eyes.json', { exams: [values] }); // legacy row, no id yet

    const result = await apply('eyes.json', {
      exams: [
        { id: 'stamped-copy', ...values }, // the same exam after a pre-#12432 peer stamped a random id
        { id: 'twin-1', createdAt: minted, date: '2026-05-01', leftSphere: -3 },
        { id: 'twin-2', createdAt: minted, date: '2026-05-01', leftSphere: -3 }, // distinct record, identical values
      ],
    });

    expect(result.applied).toBe(true);
    const exams = (await readDoc('eyes.json')).exams;
    // The peer's stamp becomes the id; the content id this machine stamped stays an alias.
    expect(exams.map((e) => e.id)).toEqual(['stamped-copy', 'twin-1', 'twin-2']);
    expect(exams[0].aliasIds).toEqual([legacyRowId(values)]);
  });

  // #12432: each machine used to stamp a legacy row with its own random id, so the
  // second sync (after both had stamped) appended the peer's copy on both sides.
  it('does not duplicate a legacy exam when re-syncing after both machines stamped it', async () => {
    const legacy = { date: '2025-02-01', leftSphere: -1.25, rightSphere: -1 };
    await persist('eyes.json', { exams: [{ ...legacy }] });
    await health.getEyeExams(); // this machine stamps its copy on first read

    // The peer stamped the same row too — with a random id before upgrading, or
    // the content id after.
    await apply('eyes.json', { exams: [{ id: '0d9b4c1e-0000-4000-8000-000000000001', ...legacy }] });
    await apply('eyes.json', { exams: [{ id: legacyRowId(legacy), ...legacy }] });

    const exams = (await readDoc('eyes.json')).exams;
    expect(exams).toHaveLength(1);
    expect([exams[0].id, ...exams[0].aliasIds].sort())
      .toEqual(['0d9b4c1e-0000-4000-8000-000000000001', legacyRowId(legacy)].sort());
  });

  // A machine that has not yet seen the convergence edits the copy under the id
  // the merge retired; the alias still routes the edit to the one row.
  it('applies an edit addressed by an id that convergence turned into an alias', async () => {
    const legacy = { date: '2025-02-02', leftSphere: -1 };
    const edited = { id: 'stamp-z', ...legacy, leftSphere: -1.75, updatedAt: '2026-07-01T00:00:00.000Z' };
    await persist('eyes.json', { exams: [edited] });
    await apply('eyes.json', { exams: [{ id: 'stamp-b', aliasIds: ['stamp-z'], ...legacy }] });
    // The unedited copy's content key stays reachable too, for any other peer still holding it.
    expect((await readDoc('eyes.json')).exams).toEqual([
      { ...edited, id: 'stamp-b', aliasIds: [legacyRowId(legacy), 'stamp-z'] },
    ]);
  });

  // An edit replaces a legacy exam's content, but a third peer's untouched copy,
  // stamped with yet another id, still finds it through the retained content key.
  it('matches a third peer copy to a legacy exam edited after its copies converged', async () => {
    const legacy = { date: '2025-05-05', leftSphere: -1 };
    await persist('eyes.json', { exams: [{ id: 'stamp-a', aliasIds: ['stamp-b'], ...legacy }] });
    await health.updateEyeExam('stamp-a', { leftSphere: -1.5 });

    await apply('eyes.json', { exams: [{ id: 'stamp-c', ...legacy }] });
    const exams = (await readDoc('eyes.json')).exams;
    expect(exams).toHaveLength(1);
    expect(exams[0]).toMatchObject({ id: 'stamp-a', leftSphere: -1.5 });
    expect(exams[0].aliasIds).toEqual(expect.arrayContaining(['stamp-b', 'stamp-c', legacyRowId(legacy)]));
  });

  // A row whose id matches one exam and whose content matches another joins all
  // three, whichever machine runs the merge.
  it('merges a row bridging two exams to the same result in both sync directions', async () => {
    const a = { id: 'stamp-a', date: '2025-03-03', leftSphere: -1 };
    const b = { id: 'stamp-b', date: '2025-03-03', leftSphere: -2 };
    const bridge = { id: 'stamp-a', date: '2025-03-03', leftSphere: -2, updatedAt: '2026-07-01T00:00:00.000Z' };

    await persist('eyes.json', { exams: [a, b] });
    await apply('eyes.json', { exams: [bridge] });
    const forward = (await readDoc('eyes.json')).exams;

    await persist('eyes.json', { exams: [bridge] });
    await apply('eyes.json', { exams: [a, b] });
    const backward = (await readDoc('eyes.json')).exams;

    expect(forward).toEqual([{ ...bridge, aliasIds: [legacyRowId(a), 'stamp-b'] }]);
    expect(backward).toEqual(forward);
  });

  // An exam minted before #12432 has an id but no createdAt. Two machines that
  // each edited it keep one row (its id), not one per edit.
  it('keeps one row for a pre-#12432 exam edited differently on two machines', async () => {
    const mintedBeforeFix = { id: 'exam-old', date: '2025-03-01', leftSphere: -1 };
    const editedHere = { ...mintedBeforeFix, leftSphere: -1.25 };
    const editedThere = { ...mintedBeforeFix, leftSphere: -1.5 };
    await persist('eyes.json', { exams: [editedHere] });
    await apply('eyes.json', { exams: [editedThere] });
    const exams = (await readDoc('eyes.json')).exams;
    expect(exams).toHaveLength(1);
    expect(exams[0].id).toBe('exam-old');
  });

  it('keeps a legacy exam deleted before the copies converged, though the peer stamped it differently', async () => {
    const legacy = { date: '2025-04-01', rightSphere: -2 };
    await persist('eyes.json', { exams: [{ id: 'stamp-here', ...legacy }] });
    await health.removeEyeExam('stamp-here');
    expect((await apply('eyes.json', { exams: [{ id: 'stamp-there', ...legacy }] })).applied).toBe(false);
    expect((await readDoc('eyes.json')).exams).toEqual([]);
  });

  it('resolves two copies of one exam to the newer edit on either side', async () => {
    const original = { id: 'exam-x', createdAt: minted, date: '2026-05-01', leftSphere: -1 };
    const edited = { ...original, leftSphere: -1.5, updatedAt: '2026-06-01T00:00:00.000Z' };

    await persist('eyes.json', { exams: [original] });
    expect((await apply('eyes.json', { exams: [edited] })).applied).toBe(true);
    expect((await readDoc('eyes.json')).exams).toEqual([edited]);

    // The stale copy from a peer that has not seen the edit changes nothing.
    expect((await apply('eyes.json', { exams: [original] })).applied).toBe(false);
    expect((await readDoc('eyes.json')).exams).toEqual([edited]);
  });

  it('keeps a deleted exam deleted when a peer that still holds it syncs, and carries the delete to that peer', async () => {
    const kept = { id: 'exam-keep', createdAt: minted, date: '2026-05-01', leftSphere: -1 };
    const gone = { id: 'exam-gone', createdAt: minted, date: '2026-05-02', leftSphere: -2 };
    await persist('eyes.json', { exams: [kept, gone] });
    await health.removeEyeExam('exam-gone');
    const afterDelete = await readDoc('eyes.json');

    // The peer still holds the row: applying its snapshot must not bring it back.
    expect((await apply('eyes.json', { exams: [kept, gone] })).applied).toBe(false);
    expect((await readDoc('eyes.json')).exams).toEqual([kept]);

    // The other direction: a machine still holding the row drops it on receipt.
    await persist('eyes.json', { exams: [kept, gone] });
    expect((await apply('eyes.json', afterDelete)).applied).toBe(true);
    const peer = await readDoc('eyes.json');
    expect(peer.exams).toEqual([kept]);
    expect(peer.rowTombstones).toEqual(afterDelete.rowTombstones);
  });

  it('keeps a row edited after its deletion and drops the outlived tombstone', async () => {
    const row = { id: 'exam-back', createdAt: minted, date: '2026-05-01', leftSphere: -1 };
    const tombstone = { id: 'exam-back', deletedAt: '2026-05-10T00:00:00.000Z' };
    await persist('eyes.json', { exams: [], rowTombstones: [tombstone] });

    const edited = { ...row, leftSphere: -3, updatedAt: '2026-05-11T00:00:00.000Z' };
    expect((await apply('eyes.json', { exams: [edited] })).applied).toBe(true);
    const doc = await readDoc('eyes.json');
    expect(doc.exams).toEqual([edited]);
    expect(doc).not.toHaveProperty('rowTombstones');
  });
});

describe('applyRemote meatspace write queues', () => {
  // Hold the shared queue, start an apply, and prove it did not touch the file until
  // the queue drained — i.e. it is serialized with the local writers, not beside them.
  const holdQueue = async (queue, name, run) => {
    let release;
    const held = queue(() => new Promise((resolve) => { release = resolve; }));
    const before = await readBytes(name);
    const pending = run();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await readBytes(name)).toBe(before);
    release();
    await held;
    const result = await pending;
    expect(await readBytes(name)).not.toBe(before);
    return result;
  };

  it('writes config.json inside the queue the local config writers use', async () => {
    await persist('config.json', { updatedAt: '2025-01-01T00:00:00.000Z', sex: 'unspecified' });
    const result = await holdQueue(queueConfigWrite, 'config.json', () =>
      apply('config.json', { updatedAt: '2026-01-01T00:00:00.000Z', sex: 'other' }));
    expect(result.applied).toBe(true);
  });

  it.each(Object.keys(FAMILIES))('writes %s inside the queue the local health writers use', async (filename) => {
    const fx = FAMILIES[filename];
    await persist(filename, { [fx.arrayKey]: [fx.sameDateA] });
    const result = await holdQueue(queueHealthWrite, filename, () =>
      apply(filename, { [fx.arrayKey]: [fx.newDate] }));
    expect(result.applied).toBe(true);
  });

  it.each(Object.keys(FAMILIES))('does not lose a local add that races a snapshot apply of %s', async (filename) => {
    const fx = FAMILIES[filename];
    await persist(filename, { [fx.arrayKey]: [fx.sameDateA] });

    await Promise.all([
      fx.addLocal(fx.sameDateB),
      apply(filename, { [fx.arrayKey]: [fx.newDate] }),
    ]);

    const rows = (await readDoc(filename))[fx.arrayKey];
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.date === '2026-03-01')).toHaveLength(2);
    expect(rows.filter((r) => r.date === '2026-04-01')).toHaveLength(1);
  });
});

describe('health erasure survives a peer that still holds the row (#14155)', () => {
  const day = (body, extra = {}) => ({ date: '2026-04-02', ...extra, ...(body ? { body } : {}) });

  it('keeps a legacy blood panel deleted after a peer resends the id-less row', async () => {
    const row = { date: '2026-04-02', homocysteine: 7 };
    await persist('blood-tests.json', { tests: [row], referenceRanges: { homocysteine: { min: 5, max: 15 } } });
    const id = (await health.getBloodTests()).tests[0].id;
    expect(id).toMatch(/^legacy-/);
    expect(await health.removeBloodTest(id)).toMatchObject({ date: '2026-04-02', id });
    expect((await health.getBloodTests()).tests).toEqual([]);
    expect((await apply('blood-tests.json', { tests: [row] })).applied).toBe(false);
    const doc = await readDoc('blood-tests.json');
    expect(doc.tests).toEqual([]);
    expect(doc.rowTombstones.map(t => t.id)).toContain(id);
    expect(doc.referenceRanges.homocysteine).toEqual({ min: 5, max: 15 });
  });

  it('keeps a minted blood panel and an epigenetic result deleted', async () => {
    const blood = await health.addBloodTest({ date: '2026-05-01', glucose: 90 });
    expect(blood.createdAt).toEqual(expect.any(String));
    await health.removeBloodTest(blood.id);
    expect((await apply('blood-tests.json', { tests: [blood] })).applied).toBe(false);
    expect((await readDoc('blood-tests.json')).tests).toEqual([]);

    const epi = await health.addEpigeneticTest({ date: '2026-05-01', biologicalAge: 40 });
    expect(epi.createdAt).toEqual(expect.any(String));
    await health.removeEpigeneticTest(epi.id);
    expect((await apply('epigenetic-tests.json', { tests: [epi] })).applied).toBe(false);
    expect((await readDoc('epigenetic-tests.json')).tests).toEqual([]);
  });

  it('does not refill a deleted body from an older or unstamped peer copy', async () => {
    await persist('daily-log.json', {
      entries: [day({ weightLbs: 180, updatedAt: '2026-04-02T10:00:00.000Z' })],
    });
    await health.removeBodyEntry('2026-04-02');
    const deletedAt = (await readDoc('daily-log.json')).entries[0].bodyDeletedAt;
    expect((await readDoc('daily-log.json')).entries[0].body).toBeUndefined();

    expect((await apply('daily-log.json', {
      entries: [day({ weightLbs: 180, updatedAt: '2026-04-02T10:00:00.000Z' })],
    })).applied).toBe(false);
    expect((await readDoc('daily-log.json')).entries[0].body).toBeUndefined();

    await persist('daily-log.json', { entries: [day({ weightLbs: 180 })] });
    expect((await apply('daily-log.json', {
      entries: [{ date: '2026-04-02', bodyDeletedAt: deletedAt }],
    })).applied).toBe(true);
    expect((await readDoc('daily-log.json')).entries[0].body).toBeUndefined();
    expect((await readDoc('daily-log.json')).entries[0].bodyDeletedAt).toBe(deletedAt);
  });

  it('lets a re-log replace the deletion and still fills an empty body that was not deleted', async () => {
    await health.addBodyEntry({ date: '2026-04-02', weightLbs: 180 });
    await health.removeBodyEntry('2026-04-02');
    const deletedAt = (await readDoc('daily-log.json')).entries[0].bodyDeletedAt;
    const again = await health.addBodyEntry({ date: '2026-04-02', weightLbs: 170 });
    expect(Date.parse(again.updatedAt)).toBeGreaterThan(Date.parse(deletedAt));
    expect((await readDoc('daily-log.json')).entries[0].bodyDeletedAt).toBeUndefined();

    expect((await apply('daily-log.json', {
      entries: [day({ weightLbs: 180, updatedAt: '2026-04-02T10:00:00.000Z' }, { bodyDeletedAt: deletedAt })],
    })).applied).toBe(false);
    const relogged = (await readDoc('daily-log.json')).entries[0];
    expect(relogged.body.weightLbs).toBe(170);
    expect(relogged.bodyDeletedAt).toBeUndefined();

    await persist('daily-log.json', { entries: [{ date: '2026-04-03', body: {} }] });
    expect((await apply('daily-log.json', {
      entries: [{ date: '2026-04-03', body: { weightLbs: 180 } }],
    })).applied).toBe(true);
    expect((await readDoc('daily-log.json')).entries.find(e => e.date === '2026-04-03').body).toEqual({ weightLbs: 180 });
  });

  it('deletes a blood panel created by a clinical import, and a peer copy stays gone', async () => {
    const { importClinicalRecords } = await import('./appleHealthClinical.js');
    const fhir = JSON.stringify({
      resourceType: 'Observation',
      status: 'final',
      category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }] }],
      code: { coding: [{ system: 'http://loinc.org', code: '2345-7', display: 'Glucose' }], text: 'Glucose' },
      effectiveDateTime: '2026-05-01T10:30:00Z',
      valueQuantity: { value: 95, unit: 'mg/dL' },
    });
    await persist('blood-tests.json', {
      tests: [{ date: '2026-04-02', homocysteine: 7 }],
      referenceRanges: {},
      rowTombstones: [{ id: 'already-gone', deletedAt: '2026-01-01T00:00:00.000Z' }],
    });
    const summary = await importClinicalRecords([fhir]);
    expect(summary.newDates).toBe(1);
    const doc = await readDoc('blood-tests.json');
    expect(doc.rowTombstones.map(t => t.id)).toContain('already-gone');
    const imported = doc.tests.find(row => row.date === '2026-05-01');
    expect(imported.glucose).toBe(95);
    expect(imported.createdAt).toEqual(expect.any(String));
    const legacy = doc.tests.find(row => row.date === '2026-04-02');
    expect(legacy.id).toMatch(/^legacy-/);
    expect(legacy.createdAt).toBeUndefined();
    await health.removeBloodTest(imported.id);
    expect((await apply('blood-tests.json', { tests: [imported] })).applied).toBe(false);
    expect((await readDoc('blood-tests.json')).tests.map(row => row.date)).toEqual(['2026-04-02']);
  });
});
