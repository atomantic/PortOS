/**
 * Writers Room sync logic (#1565) — pure transforms, no DB / no disk.
 *
 * Mirrors creativeDirector/projectsLogic's sanitize + LWW-merge coverage: the
 * "drop on the floor" contract for malformed payloads, the soft-delete trio
 * normalization, last-writer-wins on `updatedAt` (tombstone-aware), and the
 * draft-version → file-body asset entry extraction (with path-segment validation).
 */

import { describe, it, expect } from 'vitest';
import {
  sanitizeWorkForSync, mergeWorkRecord, draftAssetEntries,
  WRITERS_ROOM_WORK_KIND, WRITERS_ROOM_DRAFT_ASSET_KIND,
  WRITERS_ROOM_FOLDER_KIND, WRITERS_ROOM_EXERCISE_KIND,
  sanitizeFolderForSync, mergeFolderRecord,
  sanitizeExerciseForSync, mergeExerciseRecord,
} from './syncLogic.js';
import { sanitizeRecordForWire } from '../../lib/syncWire.js';

const WORK = 'wr-work-11111111-1111-1111-1111-111111111111';
const DRAFT = 'wr-draft-22222222-2222-2222-2222-222222222222';
const FOLDER = 'wr-folder-44444444-4444-4444-4444-444444444444';
const EXERCISE = 'wr-ex-55555555-5555-5555-5555-555555555555';

const work = (extra = {}) => ({
  id: WORK,
  title: 'A Tale',
  kind: 'short-story',
  status: 'drafting',
  activeDraftVersionId: DRAFT,
  drafts: [{ id: DRAFT, label: 'Draft 1', contentFile: `drafts/${DRAFT}.md`, contentHash: 'h', wordCount: 3, segmentIndex: [], createdAt: '2026-01-01T00:00:00.000Z' }],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  ...extra,
});

describe('sanitizeWorkForSync', () => {
  it('drops non-objects, missing ids, and ids that are not valid work ids', () => {
    expect(sanitizeWorkForSync(null)).toBeNull();
    expect(sanitizeWorkForSync([])).toBeNull();
    expect(sanitizeWorkForSync({ title: 'no id' })).toBeNull();
    expect(sanitizeWorkForSync({ id: '' })).toBeNull();
    // Unstorable id (not WORK_ID_RE) — would throw in the path layer / plant an
    // unaddressable row, so it's dropped before merge.
    expect(sanitizeWorkForSync({ id: 'not-a-work' })).toBeNull();
    expect(sanitizeWorkForSync({ id: '../etc/passwd' })).toBeNull();
    // A real work id passes.
    expect(sanitizeWorkForSync(work())?.id).toBe(WORK);
  });

  it('normalizes the soft-delete trio and preserves the body verbatim', () => {
    const s = sanitizeWorkForSync(work());
    expect(s.deleted).toBe(false);
    expect(s.deletedAt).toBeNull();
    expect(s.title).toBe('A Tale');
    expect(s.drafts).toHaveLength(1);
  });

  it('clears a stray deletedAt when deleted is false, keeps it when true', () => {
    expect(sanitizeWorkForSync(work({ deleted: false, deletedAt: '2026-02-01T00:00:00.000Z' })).deletedAt).toBeNull();
    const tomb = sanitizeWorkForSync(work({ deleted: true, deletedAt: '2026-02-01T00:00:00.000Z' }));
    expect(tomb.deleted).toBe(true);
    expect(tomb.deletedAt).toBe('2026-02-01T00:00:00.000Z');
  });

  it('defaults missing updatedAt to createdAt', () => {
    const s = sanitizeWorkForSync({ id: WORK, createdAt: '2026-03-01T00:00:00.000Z' });
    expect(s.updatedAt).toBe('2026-03-01T00:00:00.000Z');
  });

  it('drops drafts with a malformed id and clamps the active pointer', () => {
    const DRAFT2 = 'wr-draft-33333333-3333-3333-3333-333333333333';
    const s = sanitizeWorkForSync(work({
      activeDraftVersionId: '../etc/passwd',
      drafts: [
        { id: '../evil', label: 'bad' },
        { id: DRAFT, label: 'Draft 1', contentFile: `drafts/${DRAFT}.md` },
        { id: DRAFT2, label: 'Draft 2', contentFile: `drafts/${DRAFT2}.md` },
      ],
    }));
    expect(s.drafts.map((d) => d.id)).toEqual([DRAFT, DRAFT2]); // malformed dropped
    expect(s.activeDraftVersionId).toBe(DRAFT); // bad pointer clamped to first survivor
  });

  it('preserves a valid active pointer and nulls it when no drafts survive', () => {
    expect(sanitizeWorkForSync(work()).activeDraftVersionId).toBe(DRAFT);
    const empty = sanitizeWorkForSync(work({ drafts: [{ id: 'bad' }], activeDraftVersionId: 'bad' }));
    expect(empty.drafts).toEqual([]);
    expect(empty.activeDraftVersionId).toBeNull();
  });

  it('coerces a missing/non-array drafts field to [] (malformed payload)', () => {
    const noDrafts = sanitizeWorkForSync({ id: WORK, createdAt: '2026-03-01T00:00:00.000Z', activeDraftVersionId: '../x' });
    expect(noDrafts.drafts).toEqual([]);
    expect(noDrafts.activeDraftVersionId).toBeNull();
    expect(sanitizeWorkForSync(work({ drafts: 'not-an-array' })).drafts).toEqual([]);
  });
});

describe('mergeWorkRecord', () => {
  it('inserts a remote with no local counterpart', () => {
    const { next, inserted, remoteWins, changed } = mergeWorkRecord(null, work());
    expect(inserted).toBe(true);
    expect(remoteWins).toBe(true);
    expect(changed).toBe(true);
    expect(next.id).toBe(WORK);
  });

  it('drops a malformed remote (next: null)', () => {
    expect(mergeWorkRecord(work(), { title: 'no id' }).next).toBeNull();
  });

  it('newer remote updatedAt wins; older loses', () => {
    const local = sanitizeWorkForSync(work({ updatedAt: '2026-01-02T00:00:00.000Z', title: 'Local' }));
    const newer = mergeWorkRecord(local, work({ updatedAt: '2026-01-03T00:00:00.000Z', title: 'Remote' }));
    expect(newer.remoteWins).toBe(true);
    expect(newer.next.title).toBe('Remote');
    const older = mergeWorkRecord(local, work({ updatedAt: '2026-01-01T00:00:00.000Z', title: 'Remote' }));
    expect(older.remoteWins).toBe(false);
    expect(older.next.title).toBe('Local');
  });

  it('a newer tombstone overwrites a live local', () => {
    const local = sanitizeWorkForSync(work({ updatedAt: '2026-01-02T00:00:00.000Z' }));
    const { next, remoteWins } = mergeWorkRecord(local, work({ updatedAt: '2026-01-05T00:00:00.000Z', deleted: true, deletedAt: '2026-01-05T00:00:00.000Z' }));
    expect(remoteWins).toBe(true);
    expect(next.deleted).toBe(true);
  });

  it('a byte-identical remote win is not "changed"', () => {
    const local = sanitizeWorkForSync(work());
    const { remoteWins, changed } = mergeWorkRecord(local, work());
    // equal updatedAt → tie → local wins (remoteWins false), and no change
    expect(remoteWins).toBe(false);
    expect(changed).toBe(false);
  });
});

describe('live-mode counters stay local', () => {
  const live = (extra) => ({ enabled: true, debounceMs: 2500, dailyCallBudget: 100, dailyRenderBudget: 20, ...extra });

  it('sanitizeRecordForWire strips liveMode usage/renderUsage but keeps the user knobs', () => {
    const wire = sanitizeRecordForWire('writersRoomWork', work({
      liveMode: live({ usage: { date: '2026-01-02', count: 9 }, renderUsage: { date: '2026-01-02', count: 2 } }),
    }));
    expect(wire.liveMode).toEqual(live());
    expect(wire.liveMode.usage).toBeUndefined();
    expect(wire.liveMode.renderUsage).toBeUndefined();
  });

  it('mergeWorkRecord carries the receiver local counters onto a winning (wire-stripped) remote', () => {
    const local = sanitizeWorkForSync(work({
      updatedAt: '2026-01-02T00:00:00.000Z',
      liveMode: live({ usage: { date: '2026-01-02', count: 7 }, renderUsage: { date: '2026-01-02', count: 3 } }),
    }));
    // Remote arrives wire-stripped (no counters) and is newer → wins.
    const remote = work({ updatedAt: '2026-01-05T00:00:00.000Z', title: 'Edited', liveMode: live() });
    const { next, remoteWins } = mergeWorkRecord(local, remote);
    expect(remoteWins).toBe(true);
    expect(next.title).toBe('Edited');
    expect(next.liveMode.usage).toEqual({ date: '2026-01-02', count: 7 });
    expect(next.liveMode.renderUsage).toEqual({ date: '2026-01-02', count: 3 });
  });

  it('mergeWorkRecord does not crash when neither side has counters', () => {
    const local = sanitizeWorkForSync(work({ updatedAt: '2026-01-02T00:00:00.000Z' }));
    const { next, remoteWins } = mergeWorkRecord(local, work({ updatedAt: '2026-01-05T00:00:00.000Z', title: 'E' }));
    expect(remoteWins).toBe(true);
    expect(next.title).toBe('E');
  });
});

describe('draftAssetEntries', () => {
  it('returns one entry per valid draft with the work id', () => {
    const entries = draftAssetEntries(work());
    expect(entries).toEqual([{ workId: WORK, draftId: DRAFT }]);
  });

  it('skips drafts with a malformed id (path-traversal guard)', () => {
    const entries = draftAssetEntries(work({ drafts: [{ id: '../etc/passwd' }, { id: DRAFT }] }));
    expect(entries).toEqual([{ workId: WORK, draftId: DRAFT }]);
  });

  it('returns [] for a work with a malformed id or no drafts', () => {
    expect(draftAssetEntries({ id: 'bogus', drafts: [{ id: DRAFT }] })).toEqual([]);
    expect(draftAssetEntries(work({ drafts: undefined }))).toEqual([]);
  });
});

// ---------- folders + exercises (body-less records, #1645) ----------

const folder = (extra = {}) => ({
  id: FOLDER,
  name: 'Drafts',
  parentId: null,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  ...extra,
});

describe('sanitizeFolderForSync', () => {
  it('drops non-objects, missing ids, and ids that are not valid folder ids', () => {
    expect(sanitizeFolderForSync(null)).toBeNull();
    expect(sanitizeFolderForSync([])).toBeNull();
    expect(sanitizeFolderForSync({ name: 'no id' })).toBeNull();
    expect(sanitizeFolderForSync({ id: 'wr-work-11111111-1111-1111-1111-111111111111' })).toBeNull();
    expect(sanitizeFolderForSync({ id: '../etc/passwd' })).toBeNull();
    expect(sanitizeFolderForSync(folder())?.id).toBe(FOLDER);
  });

  it('normalizes the soft-delete trio and preserves the body verbatim', () => {
    const s = sanitizeFolderForSync(folder());
    expect(s.deleted).toBe(false);
    expect(s.deletedAt).toBeNull();
    expect(s.name).toBe('Drafts');
    expect(s.sortOrder).toBe(0);
  });

  it('keeps a tombstone deletedAt and defaults missing updatedAt to createdAt', () => {
    const tomb = sanitizeFolderForSync(folder({ deleted: true, deletedAt: '2026-02-01T00:00:00.000Z' }));
    expect(tomb.deleted).toBe(true);
    expect(tomb.deletedAt).toBe('2026-02-01T00:00:00.000Z');
    expect(sanitizeFolderForSync({ id: FOLDER, createdAt: '2026-03-01T00:00:00.000Z' }).updatedAt).toBe('2026-03-01T00:00:00.000Z');
  });
});

describe('mergeFolderRecord', () => {
  it('inserts a remote with no local counterpart and drops a malformed remote', () => {
    const ins = mergeFolderRecord(null, folder());
    expect(ins.inserted).toBe(true);
    expect(ins.next.id).toBe(FOLDER);
    expect(mergeFolderRecord(folder(), { name: 'no id' }).next).toBeNull();
  });

  it('newer remote updatedAt wins; older loses; tie keeps local', () => {
    const local = sanitizeFolderForSync(folder({ updatedAt: '2026-01-02T00:00:00.000Z', name: 'Local' }));
    expect(mergeFolderRecord(local, folder({ updatedAt: '2026-01-03T00:00:00.000Z', name: 'Remote' })).next.name).toBe('Remote');
    expect(mergeFolderRecord(local, folder({ updatedAt: '2026-01-01T00:00:00.000Z', name: 'Remote' })).next.name).toBe('Local');
    expect(mergeFolderRecord(local, folder({ name: 'Local' })).changed).toBe(false);
  });

  it('a newer tombstone overwrites a live local folder', () => {
    const local = sanitizeFolderForSync(folder({ updatedAt: '2026-01-02T00:00:00.000Z' }));
    const { next, remoteWins } = mergeFolderRecord(local, folder({ updatedAt: '2026-01-05T00:00:00.000Z', deleted: true, deletedAt: '2026-01-05T00:00:00.000Z' }));
    expect(remoteWins).toBe(true);
    expect(next.deleted).toBe(true);
  });
});

const exercise = (extra = {}) => ({
  id: EXERCISE,
  workId: null,
  prompt: 'Write fast',
  durationSeconds: 600,
  startingWords: 0,
  endingWords: null,
  wordsAdded: null,
  appendedText: null,
  status: 'running',
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: null,
  ...extra,
});

describe('sanitizeExerciseForSync', () => {
  it('drops non-objects and ids that are not valid exercise ids', () => {
    expect(sanitizeExerciseForSync(null)).toBeNull();
    expect(sanitizeExerciseForSync({ id: 'wr-folder-44444444-4444-4444-4444-444444444444' })).toBeNull();
    expect(sanitizeExerciseForSync(exercise())?.id).toBe(EXERCISE);
  });

  it('derives the LWW key from startedAt / finishedAt when updatedAt/createdAt are absent', () => {
    // Pre-federation exercise: no createdAt/updatedAt — both derive from the
    // sprint timestamps so an OLD record still gets a stable LWW key.
    const running = sanitizeExerciseForSync(exercise());
    expect(running.createdAt).toBe('2026-01-01T00:00:00.000Z'); // startedAt
    expect(running.updatedAt).toBe('2026-01-01T00:00:00.000Z'); // finishedAt ?? startedAt
    const finished = sanitizeExerciseForSync(exercise({ finishedAt: '2026-01-01T00:10:00.000Z', status: 'finished' }));
    expect(finished.updatedAt).toBe('2026-01-01T00:10:00.000Z'); // finishedAt advances the key
  });

  it('prefers an explicit stored updatedAt over the derived key', () => {
    const restored = sanitizeExerciseForSync(exercise({ updatedAt: '2026-02-02T00:00:00.000Z' }));
    expect(restored.updatedAt).toBe('2026-02-02T00:00:00.000Z');
  });
});

describe('mergeExerciseRecord', () => {
  it('the finish transition (finishedAt advances) wins LWW over the running local', () => {
    const local = sanitizeExerciseForSync(exercise());
    const { next, remoteWins } = mergeExerciseRecord(local, exercise({ status: 'finished', finishedAt: '2026-01-01T00:10:00.000Z', wordsAdded: 42, endingWords: 42 }));
    expect(remoteWins).toBe(true);
    expect(next.status).toBe('finished');
    expect(next.wordsAdded).toBe(42);
  });

  it('inserts a remote with no local counterpart and drops a malformed remote', () => {
    expect(mergeExerciseRecord(null, exercise()).inserted).toBe(true);
    expect(mergeExerciseRecord(exercise(), { id: 'bogus' }).next).toBeNull();
  });

  it('a legacy local with NO stored updatedAt is not clobbered by a stale remote (symmetric LWW key)', () => {
    // Regression: the local key must be derived through the same sanitizer as the
    // remote. A finished local (no updatedAt, finishedAt=00:10) must beat a stale
    // running remote (no updatedAt, derived key = startedAt=00:00) — without the
    // symmetric derivation the raw `local.updatedAt` is undefined and the stale
    // remote would win unconditionally.
    const localFinished = { ...exercise(), status: 'finished', finishedAt: '2026-01-01T00:10:00.000Z' };
    delete localFinished.updatedAt;
    const staleRunning = { ...exercise(), status: 'running', finishedAt: null };
    const { remoteWins, next } = mergeExerciseRecord(localFinished, staleRunning);
    expect(remoteWins).toBe(false);
    expect(next.status).toBe('finished');
  });
});

describe('body-less wire form', () => {
  it('sanitizeRecordForWire round-trips folder + exercise with a tail-canonical soft-delete pair', () => {
    const wf = sanitizeRecordForWire('writersRoomFolder', sanitizeFolderForSync(folder()));
    expect(wf.deleted).toBe(false);
    expect(wf.deletedAt).toBeNull();
    expect(wf.name).toBe('Drafts');
    const we = sanitizeRecordForWire('writersRoomExercise', sanitizeExerciseForSync(exercise()));
    expect(we.deleted).toBe(false);
    expect(we.prompt).toBe('Write fast');
  });
});

describe('exported kind constants', () => {
  it('match the federation record + asset kinds', () => {
    expect(WRITERS_ROOM_WORK_KIND).toBe('writersRoomWork');
    expect(WRITERS_ROOM_DRAFT_ASSET_KIND).toBe('writers-room-draft');
    expect(WRITERS_ROOM_FOLDER_KIND).toBe('writersRoomFolder');
    expect(WRITERS_ROOM_EXERCISE_KIND).toBe('writersRoomExercise');
  });
});
