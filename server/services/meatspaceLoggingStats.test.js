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

  it('survives a domain getter that rejects', async () => {
    mockBody.mockRejectedValue(new Error('disk gone'));
    mockWorkouts.mockResolvedValue([{ date: daysAgo(0) }]);
    const stats = await getLoggingStats();
    expect(stats.currentStreak).toBe(1);
    expect(stats.domains.find((d) => d.key === 'body').total).toBe(0);
  });
});
