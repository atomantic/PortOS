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
} from './syncLogic.js';

const WORK = 'wr-work-11111111-1111-1111-1111-111111111111';
const DRAFT = 'wr-draft-22222222-2222-2222-2222-222222222222';

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
  it('drops non-objects and records without a usable id', () => {
    expect(sanitizeWorkForSync(null)).toBeNull();
    expect(sanitizeWorkForSync([])).toBeNull();
    expect(sanitizeWorkForSync({ title: 'no id' })).toBeNull();
    expect(sanitizeWorkForSync({ id: '' })).toBeNull();
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

describe('exported kind constants', () => {
  it('match the federation record + asset kinds', () => {
    expect(WRITERS_ROOM_WORK_KIND).toBe('writersRoomWork');
    expect(WRITERS_ROOM_DRAFT_ASSET_KIND).toBe('writers-room-draft');
  });
});
