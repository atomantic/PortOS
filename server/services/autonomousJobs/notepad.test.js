/**
 * Autonomous job notepad on the file backend (the dev/test hatch): cap atomicity, concurrent writers,
 * prompt injection through generateTaskFromJob, and the deleteJob cascade. The SQL path is covered by
 * notepad.db.test.js.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

vi.mock('../../lib/fileUtils.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-job-notepad-') }));
const { store } = vi.hoisted(() => ({ store: { jobs: [] } }));
vi.mock('./store.js', () => ({ loadJobs: vi.fn(async () => store), saveJobs: vi.fn(async (data) => { store.jobs = data.jobs; }) }));
vi.mock('./scheduler.js', () => ({ getNextDueJob: vi.fn() }));
vi.mock('../apps.js', () => ({ getAppById: vi.fn() }));

const { listJobNotes, getJobNotepad, setJobNote, deleteJobNote, clearJobNotes, resetJobNotepadStore } = await import('./notepad.js');
const { generateTaskFromJob } = await import('./skillTemplates.js');
const { deleteJob } = await import('./crud.js');
const { MAX_JOB_TOTAL_BYTES, MAX_VALUE_BYTES } = await import('../../lib/autonomousJobNotepad.js');

const JOB = { id: 'job-notepad-1', name: 'Notepad job', promptTemplate: 'Do the recurring thing.\nSecond line.', priority: 'LOW', autonomyLevel: 'standby' };

beforeEach(async () => {
  resetJobNotepadStore();
  await clearJobNotes(JOB.id);
  await clearJobNotes('job-other');
  store.jobs = [{ ...JOB }];
});
afterAll(() => cleanupTempDataRoots());

describe('job notepad caps', () => {
  it('rejects an overflowing write with 400 and leaves every key untouched', async () => {
    for (let i = 0; i < 3; i += 1) await setJobNote(JOB.id, `k${i}`, 'v'.repeat(MAX_VALUE_BYTES - 2));
    const before = await listJobNotes(JOB.id);
    await expect(setJobNote(JOB.id, 'k3', 'v'.repeat(MAX_VALUE_BYTES - 2 + 100))).rejects.toMatchObject({ status: 400 });
    await expect(listJobNotes(JOB.id)).resolves.toEqual(before);
    const { usedBytes, remainingBytes } = await getJobNotepad(JOB.id);
    expect(usedBytes + remainingBytes).toBe(MAX_JOB_TOTAL_BYTES);
  });

  it('never lets concurrent writers jointly exceed the budget', async () => {
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => setJobNote(JOB.id, `c${i}`, 'v'.repeat(MAX_VALUE_BYTES - 2))));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(4);
    expect((await getJobNotepad(JOB.id)).usedBytes).toBeLessThanOrEqual(MAX_JOB_TOTAL_BYTES);
  });

  it('upserts, deletes one key, reports absence, and scopes notes per job', async () => {
    await setJobNote(JOB.id, 'cursor', '1');
    await setJobNote(JOB.id, 'cursor', '2');
    await setJobNote('job-other', 'cursor', 'other');
    expect((await listJobNotes(JOB.id)).map(({ key, value }) => ({ key, value }))).toEqual([{ key: 'cursor', value: '2' }]);
    expect(await deleteJobNote(JOB.id, 'cursor')).toBe(true);
    expect(await deleteJobNote(JOB.id, 'cursor')).toBe(false);
    expect(await listJobNotes('job-other')).toHaveLength(1);
  });
});

describe('prompt injection and delete cascade', () => {
  it('leaves the prompt byte-identical when empty and injects sorted notes when present', async () => {
    const empty = await generateTaskFromJob(JOB);
    expect(empty.metadata.prompt).toBe(JOB.promptTemplate);
    await setJobNote(JOB.id, 'b-key', 'second');
    await setJobNote(JOB.id, 'a-key', 'first');
    const task = await generateTaskFromJob(JOB);
    expect(task.metadata.prompt.startsWith(JOB.promptTemplate)).toBe(true);
    expect(task.metadata.prompt).toContain('## Job Notepad (persistent across runs)');
    expect(task.metadata.prompt.indexOf('### a-key')).toBeLessThan(task.metadata.prompt.indexOf('### b-key'));
    expect(task.description).toBe('Do the recurring thing.');
  });

  it('clears a job notepad when the job is deleted', async () => {
    await setJobNote(JOB.id, 'cursor', '1');
    await setJobNote('job-other', 'cursor', '1');
    expect(await deleteJob(JOB.id)).toBe(true);
    expect(await listJobNotes(JOB.id)).toEqual([]);
    expect(await listJobNotes('job-other')).toHaveLength(1);
  });
});
