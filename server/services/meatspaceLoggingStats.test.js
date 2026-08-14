import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the per-domain getters so we can drive getLoggingStats with fixed data.
const mockAlcohol = vi.fn();
const mockNicotine = vi.fn();
const mockWorkouts = vi.fn();
const mockBody = vi.fn();
const mockBloodPressure = vi.fn();

vi.mock('./meatspaceAlcohol.js', () => ({ getDailyAlcohol: () => mockAlcohol() }));
vi.mock('./meatspaceNicotine.js', () => ({ getDailyNicotine: () => mockNicotine() }));
vi.mock('./meatspaceHealth.js', () => ({
  getWorkouts: () => mockWorkouts(),
  getBodyHistory: () => mockBody(),
  getBloodPressureHistory: () => mockBloodPressure(),
}));

const { getLoggingStats } = await import('./meatspaceLoggingStats.js');

// Local YYYY-MM-DD for `offset` days ago (mirrors getDateString's local basis).
function daysAgo(offset) {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

beforeEach(() => {
  mockAlcohol.mockResolvedValue([]);
  mockNicotine.mockResolvedValue([]);
  mockWorkouts.mockResolvedValue([]);
  mockBody.mockResolvedValue([]);
  mockBloodPressure.mockResolvedValue([]);
});

describe('getLoggingStats', () => {
  it('returns a zeroed summary when nothing has been logged', async () => {
    const stats = await getLoggingStats();
    expect(stats.currentStreak).toBe(0);
    expect(stats.longestStreak).toBe(0);
    expect(stats.totalLogged).toBe(0);
    expect(stats.weekTotal).toBe(0);
    expect(stats.last7Days).toHaveLength(7);
    expect(stats.last7Days.every((d) => d.logged === false && d.domains === 0)).toBe(true);
    expect(stats.domains.map((d) => d.key)).toEqual([
      'alcohol', 'nicotine', 'workouts', 'body', 'bloodPressure',
    ]);
  });

  it('counts a current streak of consecutive logged days ending today', async () => {
    mockWorkouts.mockResolvedValue([
      { date: daysAgo(0) }, { date: daysAgo(1) }, { date: daysAgo(2) },
    ]);
    const stats = await getLoggingStats();
    expect(stats.currentStreak).toBe(3);
    expect(stats.longestStreak).toBe(3);
    expect(stats.totalLogged).toBe(3);
  });

  it('applies the yesterday grace when today has no log', async () => {
    mockNicotine.mockResolvedValue([{ date: daysAgo(1) }, { date: daysAgo(2) }]);
    const stats = await getLoggingStats();
    // Today empty but yesterday+ logged → streak still counts.
    expect(stats.currentStreak).toBe(2);
  });

  it('breaks the streak on a gap and reports longest historical run', async () => {
    mockAlcohol.mockResolvedValue([
      { date: daysAgo(0) },
      // gap at daysAgo(1)
      { date: daysAgo(2) }, { date: daysAgo(3) }, { date: daysAgo(4) },
    ]);
    const stats = await getLoggingStats();
    expect(stats.currentStreak).toBe(1);
    expect(stats.longestStreak).toBe(3);
  });

  it('aggregates per-domain this-week counts and de-dupes streak days across domains', async () => {
    // Alcohol + nicotine both logged today → one streak day, two domain counts.
    mockAlcohol.mockResolvedValue([{ date: daysAgo(0) }, { date: daysAgo(10) }]);
    mockNicotine.mockResolvedValue([{ date: daysAgo(0) }]);
    const stats = await getLoggingStats();

    const alcohol = stats.domains.find((d) => d.key === 'alcohol');
    const nicotine = stats.domains.find((d) => d.key === 'nicotine');
    expect(alcohol.total).toBe(2);
    expect(alcohol.thisWeek).toBe(1); // the 10-day-old entry is outside the window
    expect(nicotine.thisWeek).toBe(1);
    expect(stats.weekTotal).toBe(2);

    // Today's sparkline cell reflects both domains, but the streak counts one day.
    const today = stats.last7Days.at(-1);
    expect(today.logged).toBe(true);
    expect(today.domains).toBe(2);
    expect(stats.currentStreak).toBe(1);
  });

  describe('activeDayKeys (#4120)', () => {
    it('omits the key list unless the caller asks for it', async () => {
      // The dashboard widget polls GET /api/meatspace/logging-stats and never reads the raw
      // days; shipping an ever-growing key list to it would be pure payload bloat.
      mockWorkouts.mockResolvedValue([{ date: daysAgo(0) }]);
      expect('activeDayKeys' in (await getLoggingStats())).toBe(false);
    });

    it('returns the sorted union of stored day keys across domains', async () => {
      // Same day in two domains contributes ONE key — the union the daysActive tile needs.
      mockAlcohol.mockResolvedValue([{ date: '2026-03-14' }, { date: '2026-03-12' }]);
      mockNicotine.mockResolvedValue([{ date: '2026-03-14' }]);
      mockWorkouts.mockResolvedValue([{ date: '2026-03-13' }]);

      const stats = await getLoggingStats({ withActiveDayKeys: true });
      expect(stats.activeDayKeys).toEqual(['2026-03-12', '2026-03-13', '2026-03-14']);
      // ...while totalLogged still counts RECORDS, so the two readings stay distinct.
      expect(stats.totalLogged).toBe(4);
    });

    it('returns an empty array — not a missing key — on a fresh install', async () => {
      // Present-but-empty must stay distinguishable from "you did not ask", so a consumer can
      // tell "no activity yet" from "this shape predates the flag".
      expect((await getLoggingStats({ withActiveDayKeys: true })).activeDayKeys).toEqual([]);
    });
  });

  it('survives a domain getter that rejects', async () => {
    mockBody.mockRejectedValue(new Error('disk gone'));
    mockWorkouts.mockResolvedValue([{ date: daysAgo(0) }]);
    const stats = await getLoggingStats();
    expect(stats.currentStreak).toBe(1);
    expect(stats.domains.find((d) => d.key === 'body').total).toBe(0);
  });
});
