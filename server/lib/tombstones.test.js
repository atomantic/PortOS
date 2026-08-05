import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TOMBSTONE_LIMIT,
  normalizeTombstones,
  tombstoneTimestamp,
  isTombstoned,
  recordTombstone,
  clearTombstone,
  tombstonesEqual,
  mergeTombstones,
  pruneTombstones,
  supersedingTimestamp,
} from './tombstones.js';

const OPTS = { keyField: 'filename' };
const tomb = (filename, deletedAt) => ({ filename, deletedAt });

describe('normalizeTombstones', () => {
  it('returns [] for non-arrays', () => {
    expect(normalizeTombstones(null, 'filename')).toEqual([]);
    expect(normalizeTombstones({ filename: 'a.md' }, 'filename')).toEqual([]);
  });

  it('drops entries with no key or an unparseable deletedAt', () => {
    const list = normalizeTombstones([
      tomb('a.md', '2026-01-02T00:00:00.000Z'),
      tomb('', '2026-01-02T00:00:00.000Z'),
      tomb('b.md', 'not-a-date'),
      tomb('c.md', undefined),
      'garbage',
      null,
    ], 'filename');
    expect(list.map(t => t.filename)).toEqual(['a.md']);
  });

  it('collapses duplicate keys to the newest deletion', () => {
    const list = normalizeTombstones([
      tomb('a.md', '2026-01-01T00:00:00.000Z'),
      tomb('a.md', '2026-03-01T00:00:00.000Z'),
      tomb('a.md', '2026-02-01T00:00:00.000Z'),
    ], 'filename');
    expect(list).toEqual([tomb('a.md', '2026-03-01T00:00:00.000Z')]);
  });

  it('sorts newest-first with a key tiebreak so both peers land on the same order', () => {
    const a = [tomb('b.md', '2026-01-01T00:00:00.000Z'), tomb('a.md', '2026-01-01T00:00:00.000Z'), tomb('z.md', '2026-05-01T00:00:00.000Z')];
    const b = [tomb('z.md', '2026-05-01T00:00:00.000Z'), tomb('a.md', '2026-01-01T00:00:00.000Z'), tomb('b.md', '2026-01-01T00:00:00.000Z')];
    expect(normalizeTombstones(a, 'filename')).toEqual(normalizeTombstones(b, 'filename'));
    expect(normalizeTombstones(a, 'filename').map(t => t.filename)).toEqual(['z.md', 'a.md', 'b.md']);
  });

  it('strips extra fields down to the key + deletedAt', () => {
    expect(normalizeTombstones([{ filename: 'a.md', deletedAt: '2026-01-01T00:00:00.000Z', junk: 1 }], 'filename'))
      .toEqual([tomb('a.md', '2026-01-01T00:00:00.000Z')]);
  });
});

describe('tombstoneTimestamp / isTombstoned', () => {
  const list = [tomb('a.md', '2026-02-01T00:00:00.000Z')];

  it('reports null for an untombstoned key', () => {
    expect(tombstoneTimestamp(list, 'b.md', 'filename')).toBeNull();
    expect(isTombstoned(list, 'b.md', undefined, 'filename')).toBe(false);
  });

  it('suppresses a record with no creation stamp (pre-tombstone records)', () => {
    expect(isTombstoned(list, 'a.md', undefined, 'filename')).toBe(true);
    expect(isTombstoned(list, 'a.md', 'garbage', 'filename')).toBe(true);
  });

  it('suppresses a record created before the delete, but not one created after', () => {
    expect(isTombstoned(list, 'a.md', '2026-01-01T00:00:00.000Z', 'filename')).toBe(true);
    expect(isTombstoned(list, 'a.md', '2026-02-01T00:00:00.000Z', 'filename')).toBe(true); // tie loses
    expect(isTombstoned(list, 'a.md', '2026-03-01T00:00:00.000Z', 'filename')).toBe(false);
  });
});

describe('recordTombstone / clearTombstone', () => {
  it('adds a tombstone and refreshes an existing one', () => {
    const first = recordTombstone([], 'a.md', { ...OPTS, deletedAt: '2026-01-01T00:00:00.000Z' });
    expect(first).toEqual([tomb('a.md', '2026-01-01T00:00:00.000Z')]);
    const second = recordTombstone(first, 'a.md', { ...OPTS, deletedAt: '2026-04-01T00:00:00.000Z' });
    expect(second).toEqual([tomb('a.md', '2026-04-01T00:00:00.000Z')]);
  });

  it('stamps now when no (or an invalid) deletedAt is supplied', () => {
    const before = Date.now();
    const [t] = recordTombstone([], 'a.md', { ...OPTS, deletedAt: 'nope' });
    expect(Date.parse(t.deletedAt)).toBeGreaterThanOrEqual(before);
  });

  it('caps the list at the limit, dropping the oldest deletions', () => {
    const many = Array.from({ length: 5 }, (_, i) => tomb(`f${i}.md`, `2026-01-0${i + 1}T00:00:00.000Z`));
    const capped = recordTombstone(many, 'new.md', { ...OPTS, deletedAt: '2026-06-01T00:00:00.000Z', limit: 3 });
    expect(capped.map(t => t.filename)).toEqual(['new.md', 'f4.md', 'f3.md']);
  });

  it('defaults the cap to DEFAULT_TOMBSTONE_LIMIT', () => {
    const many = Array.from({ length: DEFAULT_TOMBSTONE_LIMIT + 10 }, (_, i) =>
      tomb(`f${String(i).padStart(4, '0')}.md`, new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString()));
    expect(recordTombstone(many, 'new.md', OPTS)).toHaveLength(DEFAULT_TOMBSTONE_LIMIT);
  });

  it('ignores an empty/non-string key rather than writing a tombstone nothing can match', () => {
    const list = [tomb('a.md', '2026-01-01T00:00:00.000Z')];
    expect(recordTombstone(list, '', OPTS)).toEqual(list);
    expect(recordTombstone(list, undefined, OPTS)).toEqual(list);
  });

  it('clears a tombstone by key and leaves the rest normalized', () => {
    const list = [tomb('a.md', '2026-01-01T00:00:00.000Z'), tomb('b.md', '2026-01-02T00:00:00.000Z')];
    expect(clearTombstone(list, 'a.md', 'filename')).toEqual([tomb('b.md', '2026-01-02T00:00:00.000Z')]);
    expect(clearTombstone(undefined, 'a.md', 'filename')).toEqual([]);
  });
});

describe('mergeTombstones', () => {
  it('unions both directions so a delete on either machine survives', () => {
    const { merged, changed } = mergeTombstones(
      [tomb('a.md', '2026-01-01T00:00:00.000Z')],
      [tomb('b.md', '2026-02-01T00:00:00.000Z')],
      OPTS
    );
    expect(merged.map(t => t.filename)).toEqual(['b.md', 'a.md']);
    expect(changed).toBe(true);
  });

  it('keeps the newest deletion on a key collision', () => {
    const { merged } = mergeTombstones(
      [tomb('a.md', '2026-01-01T00:00:00.000Z')],
      [tomb('a.md', '2026-05-01T00:00:00.000Z')],
      OPTS
    );
    expect(merged).toEqual([tomb('a.md', '2026-05-01T00:00:00.000Z')]);
  });

  it('reports no change when the remote adds nothing (older peer sends no key)', () => {
    const local = [tomb('a.md', '2026-01-01T00:00:00.000Z')];
    expect(mergeTombstones(local, undefined, OPTS)).toEqual({ merged: local, changed: false });
    expect(mergeTombstones(local, [tomb('a.md', '2026-01-01T00:00:00.000Z')], OPTS).changed).toBe(false);
  });

  it('converges: merging in either direction yields the same list', () => {
    const a = [tomb('a.md', '2026-01-01T00:00:00.000Z'), tomb('c.md', '2026-03-01T00:00:00.000Z')];
    const b = [tomb('b.md', '2026-02-01T00:00:00.000Z'), tomb('c.md', '2026-01-01T00:00:00.000Z')];
    expect(mergeTombstones(a, b, OPTS).merged).toEqual(mergeTombstones(b, a, OPTS).merged);
  });
});

describe('pruneTombstones', () => {
  const list = [tomb('a.md', '2026-02-01T00:00:00.000Z')];

  it('drops a tombstone superseded by a re-created record', () => {
    const records = [{ filename: 'a.md', createdAt: '2026-03-01T00:00:00.000Z' }];
    expect(pruneTombstones(list, records, { ...OPTS, timestampField: 'createdAt' })).toEqual([]);
  });

  it('keeps a tombstone when the surviving record predates the delete', () => {
    const records = [{ filename: 'a.md', createdAt: '2026-01-01T00:00:00.000Z' }];
    expect(pruneTombstones(list, records, { ...OPTS, timestampField: 'createdAt' })).toEqual(list);
  });

  it('keeps a tombstone with no matching record', () => {
    expect(pruneTombstones(list, [{ filename: 'z.md', createdAt: '2027-01-01T00:00:00.000Z' }], OPTS)).toEqual(list);
    expect(pruneTombstones(list, null, OPTS)).toEqual(list);
  });

  it('uses the newest matching record when several share a key', () => {
    const records = [
      { filename: 'a.md', createdAt: '2026-01-01T00:00:00.000Z' },
      { filename: 'a.md', createdAt: '2026-06-01T00:00:00.000Z' },
    ];
    expect(pruneTombstones(list, records, OPTS)).toEqual([]);
  });
});

describe('supersedingTimestamp', () => {
  it('returns now when there is no prior deletion', () => {
    expect(supersedingTimestamp(null, '2026-01-01T00:00:00.000Z')).toBe('2026-01-01T00:00:00.000Z');
  });

  it('returns now when it is already past the deletion', () => {
    expect(supersedingTimestamp('2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')).toBe('2026-02-01T00:00:00.000Z');
  });

  it('steps past a same-millisecond delete so the re-create is not suppressed', () => {
    const stamp = supersedingTimestamp('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    expect(stamp).toBe('2026-01-01T00:00:00.001Z');
    expect(isTombstoned([tomb('a.md', '2026-01-01T00:00:00.000Z')], 'a.md', stamp, 'filename')).toBe(false);
  });

  it('steps past a peer clock that ran ahead of ours', () => {
    const stamp = supersedingTimestamp('2027-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    expect(stamp).toBe('2027-01-01T00:00:00.001Z');
  });
});

describe('tombstonesEqual', () => {
  it('compares key + deletedAt positionally', () => {
    const a = [tomb('a.md', '2026-01-01T00:00:00.000Z')];
    expect(tombstonesEqual(a, [tomb('a.md', '2026-01-01T00:00:00.000Z')], 'filename')).toBe(true);
    expect(tombstonesEqual(a, [tomb('a.md', '2026-01-02T00:00:00.000Z')], 'filename')).toBe(false);
    expect(tombstonesEqual(a, [], 'filename')).toBe(false);
  });

  it('returns false rather than throwing on a non-array side', () => {
    expect(tombstonesEqual(undefined, [], 'filename')).toBe(false);
    expect(tombstonesEqual([], null, 'filename')).toBe(false);
  });
});
