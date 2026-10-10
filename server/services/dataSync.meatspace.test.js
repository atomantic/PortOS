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
    sameDateA: { id: 'exam-a', date: '2026-03-01', leftSphere: -1.0 },
    sameDateB: { id: 'exam-b', date: '2026-03-01', rightSphere: -1.25 },
    sameDateRemote: { id: 'exam-c', date: '2026-03-01', rightSphere: -1.5 },
    newDate: { id: 'exam-d', date: '2026-04-01', leftSphere: -1.0 },
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
  it('matches an id-less local exam to its stamped remote copy, but keeps distinct ids with identical values', async () => {
    const values = { date: '2026-03-01', leftSphere: -2, rightSphere: -2 };
    await persist('eyes.json', { exams: [values] }); // legacy row, no id yet

    const result = await apply('eyes.json', {
      exams: [
        { id: 'stamped-copy', ...values }, // the same exam after the peer stamped an id
        { id: 'twin-1', date: '2026-05-01', leftSphere: -3 },
        { id: 'twin-2', date: '2026-05-01', leftSphere: -3 }, // distinct record, identical values
      ],
    });

    expect(result.applied).toBe(true);
    const exams = (await readDoc('eyes.json')).exams;
    expect(exams.map((e) => e.id ?? null)).toEqual([null, 'twin-1', 'twin-2']);
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
