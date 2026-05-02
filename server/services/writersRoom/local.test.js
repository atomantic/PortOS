import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let tempRoot;

vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return new Proxy(actual, {
    get(target, prop) {
      if (prop === 'PATHS') {
        return { ...actual.PATHS, data: tempRoot };
      }
      return target[prop];
    },
  });
});

const local = await import('./local.js');
const {
  countWords, contentHash, buildSegmentIndex,
  listFolders, createFolder, deleteFolder,
  listWorks, createWork, getWork, getWorkWithBody, updateWork, deleteWork,
  saveDraftBody, snapshotDraft, setActiveDraft, getDraftBody,
  listExercises, createExercise, finishExercise, discardExercise,
} = local;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'wr-test-'));
});

afterEach(() => {
  if (tempRoot && existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
  // Always restore real timers — without this, a thrown assertion inside a
  // useFakeTimers() block could leave subsequent tests running under fake
  // timers and silently flake (timeouts/Date.now stuck at the system time).
  vi.useRealTimers();
});

describe('text utilities', () => {
  it('countWords ignores leading/trailing whitespace and collapses runs', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   ')).toBe(0);
    expect(countWords('one')).toBe(1);
    expect(countWords('one two\nthree\tfour')).toBe(4);
    expect(countWords('  hello   world  ')).toBe(2);
  });

  it('contentHash is deterministic and changes when content changes', () => {
    const a = contentHash('hello');
    const b = contentHash('hello');
    const c = contentHash('hello!');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('buildSegmentIndex returns single segment for body with no headings', () => {
    const idx = buildSegmentIndex('Some prose with no headings.');
    expect(idx).toHaveLength(1);
    expect(idx[0]).toMatchObject({ kind: 'paragraph', wordCount: 5 });
  });

  it('buildSegmentIndex splits on # / ## / ### (### collapses to scene)', () => {
    const text = '# Chapter 1\nProse here.\n## Scene A\nMore prose.\n### Beat 1\nA beat.';
    const idx = buildSegmentIndex(text);
    expect(idx.map((s) => s.kind)).toEqual(['chapter', 'scene', 'scene']);
    expect(idx.map((s) => s.heading)).toEqual(['Chapter 1', 'Scene A', 'Beat 1']);
    expect(idx.map((s) => s.id)).toEqual(['seg-001', 'seg-002', 'seg-003']);
  });

  it('buildSegmentIndex emits a preamble segment for content before the first heading', () => {
    const text = 'Preamble text.\n# Chapter 1\nBody.';
    const idx = buildSegmentIndex(text);
    expect(idx[0].heading).toBe('(preamble)');
    expect(idx[1].heading).toBe('Chapter 1');
  });
});

describe('folder CRUD', () => {
  it('creates and lists folders', async () => {
    const folder = await createFolder({ name: 'Novels' });
    expect(folder.id).toMatch(/^wr-folder-/);
    expect(folder.name).toBe('Novels');

    const all = await listFolders();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('Novels');
  });

  it('rejects creating a folder with a missing parent', async () => {
    await expect(createFolder({ name: 'Child', parentId: 'wr-folder-missing' }))
      .rejects.toThrow(/not found/i);
  });

  it('refuses to delete a folder containing works', async () => {
    const folder = await createFolder({ name: 'Drafts' });
    await createWork({ folderId: folder.id, title: 'Story 1' });
    await expect(deleteFolder(folder.id)).rejects.toThrow(/not empty/i);
  });

  it('deletes an empty folder', async () => {
    const folder = await createFolder({ name: 'Empty' });
    const result = await deleteFolder(folder.id);
    expect(result.ok).toBe(true);
    expect(await listFolders()).toHaveLength(0);
  });
});

describe('work CRUD', () => {
  it('creates a work with an empty active draft', async () => {
    const work = await createWork({ title: 'My Novel', kind: 'novel' });
    expect(work.id).toMatch(/^wr-work-/);
    expect(work.activeDraftVersionId).toMatch(/^wr-draft-/);
    expect(work.drafts).toHaveLength(1);
    expect(work.drafts[0].wordCount).toBe(0);
    expect(work.kind).toBe('novel');
    expect(work.status).toBe('drafting');
  });

  it('rejects unknown kinds', async () => {
    await expect(createWork({ title: 'Bad', kind: 'manifesto' }))
      .rejects.toThrow(/Invalid kind/i);
  });

  it('lists works ordered by updatedAt descending', async () => {
    // Drive nowIso() deterministically — the previous version slept 5ms between
    // creates which can collapse to the same timestamp on slow/coarse-clock CI.
    // Vitest's setSystemTime advances `new Date()` (which nowIso uses).
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const a = await createWork({ title: 'First' });
    vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'));
    const b = await createWork({ title: 'Second' });
    vi.setSystemTime(new Date('2026-01-01T00:00:02.000Z'));
    await updateWork(a.id, { title: 'First Updated' });

    const list = await listWorks();
    expect(list[0].id).toBe(a.id); // most recently touched
    expect(list[1].id).toBe(b.id);
    // Note: afterEach() also calls useRealTimers() as a safety net.
  });

  it('updateWork patches allowed fields and rejects invalid status', async () => {
    const work = await createWork({ title: 'Test' });
    const updated = await updateWork(work.id, { status: 'revision', title: 'Renamed' });
    expect(updated.status).toBe('revision');
    expect(updated.title).toBe('Renamed');
    await expect(updateWork(work.id, { status: 'invalid-status' }))
      .rejects.toThrow(/Invalid status/i);
  });

  it('updateWork rejects whitespace-only titles', async () => {
    const work = await createWork({ title: 'Keep' });
    await expect(updateWork(work.id, { title: '   ' })).rejects.toThrow(/title required/i);
    // Original title preserved on the persisted manifest
    const reloaded = await getWork(work.id);
    expect(reloaded.title).toBe('Keep');
  });

  it('updateWork rejects unknown folderId and accepts null', async () => {
    const work = await createWork({ title: 'Filed' });
    await expect(updateWork(work.id, { folderId: 'wr-folder-does-not-exist' }))
      .rejects.toThrow(/Folder not found/i);
    // null is valid — it unfiles the work from any folder
    const unfiled = await updateWork(work.id, { folderId: null });
    expect(unfiled.folderId).toBeNull();
  });

  it('deleteWork removes the work directory', async () => {
    const work = await createWork({ title: 'To Delete' });
    await deleteWork(work.id);
    await expect(getWork(work.id)).rejects.toThrow(/not found/i);
    expect(await listWorks()).toHaveLength(0);
  });
});

describe('draft body and versioning', () => {
  it('saveDraftBody persists text and updates word count + segment index', async () => {
    const work = await createWork({ title: 'Story' });
    const text = '# Chapter 1\nOnce upon a time, a cat learned to fly.';
    const { manifest, body } = await saveDraftBody(work.id, text);
    expect(body).toBe(text);
    const active = manifest.drafts.find((d) => d.id === manifest.activeDraftVersionId);
    expect(active.wordCount).toBe(countWords(text));
    expect(active.segmentIndex).toHaveLength(1);
    expect(active.segmentIndex[0].heading).toBe('Chapter 1');
    expect(active.contentHash).toBe(contentHash(text));
  });

  it('saveDraftBody round-trips through getWorkWithBody', async () => {
    const work = await createWork({ title: 'Round Trip' });
    await saveDraftBody(work.id, 'Body text v1.');
    const { body } = await getWorkWithBody(work.id);
    expect(body).toBe('Body text v1.');
  });

  it('snapshotDraft creates a new version that mirrors the current body', async () => {
    const work = await createWork({ title: 'Versioned' });
    await saveDraftBody(work.id, 'First pass.');
    const after = await snapshotDraft(work.id);
    expect(after.drafts).toHaveLength(2);
    expect(after.activeDraftVersionId).toBe(after.drafts[1].id);
    expect(after.drafts[1].wordCount).toBe(2);
    expect(after.drafts[1].createdFromVersionId).toBe(after.drafts[0].id);
  });

  it('setActiveDraft switches the pointer; subsequent saves write the new version', async () => {
    const work = await createWork({ title: 'Switch' });
    const firstId = work.activeDraftVersionId;
    await saveDraftBody(work.id, 'Version 1.');
    const snapped = await snapshotDraft(work.id);
    const secondId = snapped.activeDraftVersionId;
    await saveDraftBody(work.id, 'Version 2.');
    // Switching back should not erase v1
    const switched = await setActiveDraft(work.id, firstId);
    expect(switched.activeDraftVersionId).toBe(firstId);
    const v1 = await getDraftBody(work.id, firstId);
    const v2 = await getDraftBody(work.id, secondId);
    expect(v1).toBe('Version 1.');
    expect(v2).toBe('Version 2.');
  });

  it('writes the active draft body to disk on the expected path', async () => {
    const work = await createWork({ title: 'On Disk' });
    const draftFilePath = join(tempRoot, 'writers-room', 'works', work.id, 'drafts', `${work.activeDraftVersionId}.md`);
    expect(existsSync(draftFilePath)).toBe(true);
    expect(readFileSync(draftFilePath, 'utf-8')).toBe('');

    await saveDraftBody(work.id, 'persisted prose');
    expect(readFileSync(draftFilePath, 'utf-8')).toBe('persisted prose');
  });

  it('snapshotDraft uses the explicit label argument when provided', async () => {
    const work = await createWork({ title: 'Labeled' });
    await saveDraftBody(work.id, 'first.');
    const after = await snapshotDraft(work.id, { label: 'Pre-edit' });
    const newest = after.drafts[after.drafts.length - 1];
    expect(newest.label).toBe('Pre-edit');
  });

  it('snapshotDraft preserves prior versions on disk after multiple snapshots', async () => {
    const work = await createWork({ title: 'Round Trip' });
    await saveDraftBody(work.id, 'V1 text.');
    const afterV2 = await snapshotDraft(work.id);
    await saveDraftBody(work.id, 'V2 text.');
    const afterV3 = await snapshotDraft(work.id);
    await saveDraftBody(work.id, 'V3 text.');

    const v1Id = afterV2.drafts[0].id;
    const v2Id = afterV3.drafts[1].id;
    const v3Id = afterV3.activeDraftVersionId;
    expect(await getDraftBody(work.id, v1Id)).toBe('V1 text.');
    expect(await getDraftBody(work.id, v2Id)).toBe('V2 text.');
    expect(await getDraftBody(work.id, v3Id)).toBe('V3 text.');
  });
});

describe('exercise sessions', () => {
  it('creates a running exercise tied to a work', async () => {
    const work = await createWork({ title: 'Exercise Target' });
    const ex = await createExercise({ workId: work.id, prompt: 'free-write', startingWords: 100 });
    expect(ex.id).toMatch(/^wr-ex-/);
    expect(ex.status).toBe('running');
    expect(ex.workId).toBe(work.id);
    expect(ex.durationSeconds).toBe(600);
  });

  it('clamps duration to [60, 3600] seconds', async () => {
    const tooShort = await createExercise({ durationSeconds: 10 });
    expect(tooShort.durationSeconds).toBe(60);
    const tooLong = await createExercise({ durationSeconds: 99999 });
    expect(tooLong.durationSeconds).toBe(3600);
  });

  it('rejects creating an exercise tied to a missing work', async () => {
    await expect(createExercise({ workId: 'wr-work-deadbeef-1234-5678-aaaa-bbbbccccdddd' }))
      .rejects.toThrow(/not found/i);
  });

  it('finishExercise computes wordsAdded delta and seals the session', async () => {
    const start = Date.now();
    const ex = await createExercise({ startingWords: 50 });
    const finished = await finishExercise(ex.id, { endingWords: 175 });
    expect(finished.status).toBe('finished');
    expect(finished.wordsAdded).toBe(125);
    const finishedAtMs = Date.parse(finished.finishedAt);
    expect(finishedAtMs).toBeGreaterThanOrEqual(start);
    expect(finishedAtMs).toBeLessThanOrEqual(Date.now() + 1);

    // Finishing or discarding a settled session should be rejected.
    await expect(finishExercise(ex.id, { endingWords: 200 }))
      .rejects.toThrow(/already settled/i);
    await expect(discardExercise(ex.id))
      .rejects.toThrow(/already settled/i);
  });

  it('finishExercise clamps wordsAdded at 0 and defaults missing endingWords', async () => {
    // User backspaced past the starting word count → delta should not go negative.
    const ex1 = await createExercise({ startingWords: 200 });
    const finished1 = await finishExercise(ex1.id, { endingWords: 150 });
    expect(finished1.wordsAdded).toBe(0);
    expect(finished1.endingWords).toBe(150);

    // Caller forgot to send endingWords → fall back to startingWords (delta 0),
    // not 0 (which would have produced a -200 delta on the previous version).
    const ex2 = await createExercise({ startingWords: 200 });
    const finished2 = await finishExercise(ex2.id, {});
    expect(finished2.wordsAdded).toBe(0);
    expect(finished2.endingWords).toBe(200);
  });

  it('discardExercise marks the session as discarded', async () => {
    const ex = await createExercise({});
    const discarded = await discardExercise(ex.id);
    expect(discarded.status).toBe('discarded');
  });

  it('listExercises filters by workId', async () => {
    const w1 = await createWork({ title: 'W1' });
    const w2 = await createWork({ title: 'W2' });
    await createExercise({ workId: w1.id });
    await createExercise({ workId: w2.id });
    await createExercise({});

    expect(await listExercises({ workId: w1.id })).toHaveLength(1);
    expect(await listExercises({ workId: w2.id })).toHaveLength(1);
    expect(await listExercises()).toHaveLength(3);
  });
});
