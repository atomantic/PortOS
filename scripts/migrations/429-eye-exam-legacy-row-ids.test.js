import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import migration from './429-eye-exam-legacy-row-ids.js';
import { legacyRowId } from '../../server/lib/meatspaceRowIdentity.js';

let rootDir;
beforeEach(async () => { rootDir = await mkdtemp(join(tmpdir(), 'portos-eye-legacy-ids-')); });
afterEach(() => rm(rootDir, { recursive: true, force: true }));

const eyesPath = () => join(rootDir, 'data', 'meatspace', 'eyes.json');
const seed = async (doc) => {
  await mkdir(join(rootDir, 'data', 'meatspace'), { recursive: true });
  await writeFile(eyesPath(), JSON.stringify(doc));
};
const read = async () => JSON.parse(await readFile(eyesPath(), 'utf8'));

it('collapses copies of one legacy exam to its content id, stamps id-less rows, keeps every other id, and is idempotent', async () => {
  const legacy = { date: '2024-05-01', leftSphere: -1, rightSphere: -1.25 };
  const idless = { date: '2023-02-01', leftSphere: -0.5 };
  // A pre-#12432 addEyeExam row: random id, no createdAt, edited since. Its id is kept.
  const preFixEdited = { id: '22222222-0000-4000-8000-000000000002', date: '2023-09-01', leftSphere: -0.75 };
  const minted = { id: 'exam-minted', createdAt: '2026-01-01T00:00:00.000Z', date: '2026-01-01', leftSphere: -2 };
  await seed({
    exams: [
      { id: '11111111-0000-4000-8000-000000000001', ...legacy }, // stamped on this machine
      { ...idless },
      preFixEdited,
      { id: '33333333-0000-4000-8000-000000000003', ...legacy }, // the peer's stamp, appended by a sync
      minted,
    ],
    note: 'kept',
  });

  expect(await migration.up({ rootDir })).toEqual({ rekeyed: 2, collapsed: 1 });
  const doc = await read();
  expect(doc.note).toBe('kept');
  expect(doc.exams).toEqual([
    { id: legacyRowId(idless), ...idless },
    preFixEdited,
    { id: legacyRowId(legacy), ...legacy },
    minted,
  ]);

  const bytes = await readFile(eyesPath(), 'utf8');
  expect(await migration.up({ rootDir })).toEqual({ rekeyed: 0, collapsed: 0 });
  expect(await readFile(eyesPath(), 'utf8')).toBe(bytes);
});

it('does nothing without an eyes.json or with an unreadable one', async () => {
  expect(await migration.up({ rootDir })).toEqual({ rekeyed: 0, collapsed: 0 });
  await mkdir(join(rootDir, 'data', 'meatspace'), { recursive: true });
  await writeFile(eyesPath(), '{not json');
  expect(await migration.up({ rootDir })).toEqual({ rekeyed: 0, collapsed: 0 });
  expect(await readFile(eyesPath(), 'utf8')).toBe('{not json');
});
