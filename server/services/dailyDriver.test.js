import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory stand-ins for the persistence + timezone deps so the service tests
// exercise the visit/handled state machine without touching disk or settings.
let fileStore = null;
vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { data: '/tmp/portos-test' },
  ensureDir: vi.fn(async () => {}),
  atomicWrite: vi.fn(async (_path, data) => { fileStore = data; }),
  readJSONFile: vi.fn(async () => fileStore),
}));

let mockToday = '2026-07-16';
vi.mock('../lib/timezone.js', () => ({
  getUserTimezone: vi.fn(async () => 'UTC'),
  todayInTimezone: vi.fn(() => mockToday),
}));

import {
  computeDriverState,
  getAndRecordVisit,
  getDriverState,
  markDriverHandled,
} from './dailyDriver.js';

beforeEach(() => {
  fileStore = null;
  mockToday = '2026-07-16';
});

describe('computeDriverState (pure gate)', () => {
  it('reports firstVisitToday for a never-visited install', () => {
    expect(computeDriverState(null, '2026-07-16')).toEqual({
      today: '2026-07-16', firstVisitToday: true, handledToday: false,
    });
  });

  it('reports firstVisitToday when the last visit was a prior day', () => {
    const s = computeDriverState({ lastVisitDay: '2026-07-15', handledDay: '2026-07-15' }, '2026-07-16');
    expect(s.firstVisitToday).toBe(true);
    expect(s.handledToday).toBe(false);
  });

  it('clears firstVisitToday once today has been visited', () => {
    expect(computeDriverState({ lastVisitDay: '2026-07-16' }, '2026-07-16').firstVisitToday).toBe(false);
  });

  it('reports handledToday only when handled on the current day', () => {
    expect(computeDriverState({ handledDay: '2026-07-16' }, '2026-07-16').handledToday).toBe(true);
    expect(computeDriverState({ handledDay: '2026-07-15' }, '2026-07-16').handledToday).toBe(false);
  });
});

describe('dailyDriver service (visit / handled lifecycle)', () => {
  it('first GET reports firstVisitToday, then records the visit so the next GET does not', async () => {
    const first = await getAndRecordVisit();
    expect(first).toEqual({ today: '2026-07-16', firstVisitToday: true, handledToday: false });

    const second = await getAndRecordVisit();
    expect(second.firstVisitToday).toBe(false);
    expect(second.handledToday).toBe(false);
  });

  it('markDriverHandled sets handledToday and survives a same-day peek', async () => {
    await getAndRecordVisit();
    const handled = await markDriverHandled();
    expect(handled.handledToday).toBe(true);
    expect((await getDriverState()).handledToday).toBe(true);
  });

  it('a new local day resets both flags', async () => {
    await getAndRecordVisit();
    await markDriverHandled();
    expect((await getDriverState()).handledToday).toBe(true);

    mockToday = '2026-07-17';
    const nextDay = await getDriverState();
    expect(nextDay.firstVisitToday).toBe(true);
    expect(nextDay.handledToday).toBe(false);
  });
});
