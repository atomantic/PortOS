import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the DB layer so the SQL builders and row mappers can be tested without a
// live Postgres — the route test mocks the whole service away, so this is the
// only coverage for the contract-dense SQL↔JS mapping code.
vi.mock('../lib/db.js', () => ({
  ensureSchema: vi.fn().mockResolvedValue(undefined),
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

import { query } from '../lib/db.js';
import {
  listPeople,
  createPerson,
  normalizeTags,
  isoDate,
  isoDateTime,
  rowToPerson,
  rowToTouchpoint,
  personCadenceStatus,
  getCareSummary,
  DEFAULT_RING_CADENCE,
} from './tribe.js';

// ISO date (YYYY-MM-DD) `n` whole days before local today.
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

describe('tribe service — pure helpers', () => {
  describe('normalizeTags', () => {
    it('splits a comma string, trimming and dropping empties', () => {
      expect(normalizeTags('a, b , ,c')).toEqual(['a', 'b', 'c']);
    });

    it('maps and trims an array, dropping empties', () => {
      expect(normalizeTags([' a ', '', 'b'])).toEqual(['a', 'b']);
    });

    it('returns [] for nullish input', () => {
      expect(normalizeTags(null)).toEqual([]);
      expect(normalizeTags(undefined)).toEqual([]);
    });
  });

  describe('isoDate / isoDateTime', () => {
    it('isoDate slices a Date to YYYY-MM-DD', () => {
      expect(isoDate(new Date('2026-06-18T15:00:00.000Z'))).toBe('2026-06-18');
    });

    it('isoDate keeps the date head of a string', () => {
      expect(isoDate('2026-06-18')).toBe('2026-06-18');
    });

    it('isoDate returns null for empty', () => {
      expect(isoDate(null)).toBeNull();
    });

    it('isoDateTime returns null for an unparseable string instead of throwing', () => {
      expect(isoDateTime('not-a-date')).toBeNull();
    });

    it('isoDateTime renders a valid Date', () => {
      expect(isoDateTime(new Date('2026-06-18T15:00:00.000Z'))).toBe('2026-06-18T15:00:00.000Z');
    });
  });

  describe('rowToPerson', () => {
    it('maps a full DB row to the API shape and coerces counts to numbers', () => {
      const row = {
        id: 'p1',
        name: 'Ada',
        relationship: 'mentor',
        ring: 'core',
        cadence_days: 21,
        last_contact_on: '2026-06-01',
        channel: 'sms',
        energy: 'steady',
        tags: ['x'],
        next_move: 'call',
        notes: 'n',
        touchpoint_count: '3',
        linked_memory_count: '2',
        created_at: '2026-05-01T00:00:00.000Z',
        updated_at: '2026-05-02T00:00:00.000Z',
      };
      expect(rowToPerson(row)).toMatchObject({
        id: 'p1',
        name: 'Ada',
        ring: 'core',
        cadenceDays: 21,
        lastContact: '2026-06-01',
        tags: ['x'],
        touchpointCount: 3,
        linkedMemoryCount: 2,
      });
    });

    it('defaults absent optional columns', () => {
      const r = rowToPerson({ id: 'p2', name: 'B', ring: 'tribe', cadence_days: 45 });
      expect(r.relationship).toBe('');
      expect(r.tags).toEqual([]);
      expect(r.touchpointCount).toBe(0);
      expect(r.lastContact).toBeNull();
    });
  });

  describe('rowToTouchpoint', () => {
    it('maps a touchpoint row and defaults nullable calendar fields', () => {
      const r = rowToTouchpoint({
        id: 't1',
        person_id: 'p1',
        happened_at: new Date('2026-06-18T15:00:00.000Z'),
        summary: 'Walk',
      });
      expect(r).toMatchObject({
        id: 't1',
        personId: 'p1',
        happenedAt: '2026-06-18T15:00:00.000Z',
        summary: 'Walk',
        calendarAccountId: null,
        calendarEventId: null,
        metadata: {},
      });
    });
  });
});

describe('tribe service — listPeople query builder', () => {
  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue({ rows: [] });
  });

  it('filters by ring with a single $1 parameter', async () => {
    await listPeople({ ring: 'core' });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('ring = $1');
    expect(params).toEqual(['core']);
  });

  it('does not add a ring filter when ring is "all"', async () => {
    await listPeople({ ring: 'all' });
    const [sql, params] = query.mock.calls[0];
    expect(sql).not.toContain('ring = $');
    expect(params).toEqual([]);
  });

  it('reuses one parameter across every search column, wrapped in %%', async () => {
    await listPeople({ search: 'ada' });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('ILIKE $1');
    expect(params).toEqual(['%ada%']);
  });

  it('assigns sequential parameter indices for ring + search together', async () => {
    await listPeople({ ring: 'core', search: 'ada' });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('ring = $1');
    expect(sql).toContain('ILIKE $2');
    expect(params).toEqual(['core', '%ada%']);
  });
});

describe('tribe service — personCadenceStatus', () => {
  it('external people are never overdue', () => {
    expect(personCadenceStatus({ ring: 'external', lastContact: daysAgo(999), cadenceDays: 7 }))
      .toMatchObject({ state: 'external', daysOverdue: 0 });
  });

  it('no touchpoint → missing with null daysOverdue', () => {
    const s = personCadenceStatus({ ring: 'core', lastContact: null, cadenceDays: 21 });
    expect(s.state).toBe('missing');
    expect(s.daysOverdue).toBeNull();
  });

  it('elapsed beyond cadence → overdue with positive daysOverdue', () => {
    const s = personCadenceStatus({ ring: 'support', lastContact: daysAgo(10), cadenceDays: 7 });
    expect(s.state).toBe('overdue');
    expect(s.daysOverdue).toBe(3);
  });

  it('within a week of cadence → soon', () => {
    expect(personCadenceStatus({ ring: 'core', lastContact: daysAgo(18), cadenceDays: 21 }).state).toBe('soon');
  });

  it('comfortably inside cadence → steady', () => {
    expect(personCadenceStatus({ ring: 'village', lastContact: daysAgo(2), cadenceDays: 90 }).state).toBe('steady');
  });
});

describe('tribe service — getCareSummary', () => {
  beforeEach(() => {
    query.mockReset();
  });

  // listPeople maps DB rows via rowToPerson, so mock rows use snake_case columns.
  const row = (over) => ({
    id: over.id, name: over.name, ring: over.ring,
    cadence_days: over.cadence_days, last_contact_on: over.last_contact_on ?? null,
    channel: '', tags: [], touchpoint_count: '0', linked_memory_count: '0',
  });

  it('excludes external people and sorts missing first, then most-overdue', async () => {
    query.mockResolvedValue({ rows: [
      row({ id: 'a', name: 'Overdue Small', ring: 'support', cadence_days: 7, last_contact_on: daysAgo(10) }), // 3d overdue
      row({ id: 'b', name: 'Never', ring: 'core', cadence_days: 21, last_contact_on: null }),                  // missing
      row({ id: 'c', name: 'Overdue Big', ring: 'core', cadence_days: 21, last_contact_on: daysAgo(60) }),     // 39d overdue
      row({ id: 'd', name: 'Steady', ring: 'village', cadence_days: 90, last_contact_on: daysAgo(1) }),        // steady
      row({ id: 'e', name: 'Nemesis', ring: 'external', cadence_days: 7, last_contact_on: daysAgo(999) }),     // excluded
    ] });

    const summary = await getCareSummary();
    expect(summary.hasPeople).toBe(true);
    expect(summary.peopleCount).toBe(4); // external excluded
    expect(summary.overdueCount).toBe(3); // missing + 2 overdue
    expect(summary.overdue.map((p) => p.id)).toEqual(['b', 'c', 'a']);
  });

  it('respects the limit while still reporting the full overdueCount', async () => {
    query.mockResolvedValue({ rows: [
      row({ id: 'a', name: 'A', ring: 'core', cadence_days: 21, last_contact_on: daysAgo(60) }),
      row({ id: 'b', name: 'B', ring: 'core', cadence_days: 21, last_contact_on: daysAgo(50) }),
    ] });
    const summary = await getCareSummary(1);
    expect(summary.overdueCount).toBe(2);
    expect(summary.overdue).toHaveLength(1);
  });

  it('reports hasPeople false for an empty tribe', async () => {
    query.mockResolvedValue({ rows: [] });
    const summary = await getCareSummary();
    expect(summary.hasPeople).toBe(false);
    expect(summary.overdueCount).toBe(0);
  });
});

describe('tribe service — createPerson', () => {
  beforeEach(() => {
    query.mockReset();
  });

  it('resolves the ring-aware default cadence and normalizes a tag string', async () => {
    query.mockResolvedValue({
      rows: [{ id: 'p1', name: 'Ada', ring: 'core', cadence_days: 21, tags: ['a', 'b'] }],
    });
    await createPerson({ name: 'Ada', ring: 'core', tags: 'a, b' });

    const [, params] = query.mock.calls[0];
    // INSERT param order: id,name,relationship,ring,cadence_days,last_contact,
    // channel,energy,tags,next_move,notes
    expect(params[3]).toBe('core');
    expect(params[4]).toBe(DEFAULT_RING_CADENCE.core); // 21, not the flat SQL default
    expect(params[8]).toEqual(['a', 'b']);
  });
});
