import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests for usage.js — streak calculation logic and getUsageSummary shape.
 *
 * Strategy: mock fs/promises + fileUtils so usageData is controlled by each test.
 * This lets us assert EXACT streak values rather than typeof checks.
 */

vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../lib/fileUtils.js', () => ({
  ensureDir: vi.fn().mockResolvedValue(undefined),
  PATHS: { data: '/fake/data' },
  readJSONFile: vi.fn()
}));

import { readJSONFile } from '../lib/fileUtils.js';
import { loadUsage, getUsageSummary, getUsage } from './usage.js';

// Helper: produce a date string N days ago (relative to today)
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

function makeUsage(dailyActivity = {}, extras = {}) {
  return {
    totalSessions: Object.values(dailyActivity).reduce((acc, v) => acc + (v.sessions || 0), 0),
    totalMessages: 0,
    totalToolCalls: 0,
    totalTokens: { input: 0, output: 0 },
    byProvider: {},
    byModel: {},
    dailyActivity,
    hourlyActivity: Array(24).fill(0),
    lastUpdated: null,
    ...extras
  };
}

// Fixed reference date: noon UTC on a Wednesday to avoid midnight edge cases.
const FIXED_DATE = new Date('2025-06-11T12:00:00.000Z');

describe('usage.js — streak calculations', () => {
  beforeEach(async () => {
    // Freeze time so daysAgo() and usage.js internal new Date() agree,
    // preventing flakiness when a test run crosses UTC midnight.
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_DATE);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('currentStreak', () => {
    it('returns 0 when dailyActivity is empty', async () => {
      readJSONFile.mockResolvedValueOnce(makeUsage({}));
      await loadUsage();
      const summary = getUsageSummary();
      expect(summary.currentStreak).toBe(0);
    });

    it('returns 3 for 3 consecutive days ending today', async () => {
      const activity = {
        [daysAgo(0)]: { sessions: 2, messages: 5, tokens: 100 },
        [daysAgo(1)]: { sessions: 1, messages: 3, tokens: 50 },
        [daysAgo(2)]: { sessions: 3, messages: 7, tokens: 200 }
      };
      readJSONFile.mockResolvedValueOnce(makeUsage(activity));
      await loadUsage();
      const summary = getUsageSummary();
      expect(summary.currentStreak).toBe(3);
    });

    it('returns 1 when only today has activity', async () => {
      const activity = {
        [daysAgo(0)]: { sessions: 1, messages: 1, tokens: 10 }
      };
      readJSONFile.mockResolvedValueOnce(makeUsage(activity));
      await loadUsage();
      const summary = getUsageSummary();
      expect(summary.currentStreak).toBe(1);
    });

    it('returns 1 when today has activity but yesterday does not (gap breaks streak)', async () => {
      const activity = {
        [daysAgo(0)]: { sessions: 1, messages: 1, tokens: 10 },
        [daysAgo(2)]: { sessions: 2, messages: 2, tokens: 20 }  // gap at day 1
      };
      readJSONFile.mockResolvedValueOnce(makeUsage(activity));
      await loadUsage();
      const summary = getUsageSummary();
      expect(summary.currentStreak).toBe(1);
    });

    it('counts streak from yesterday when today has no activity', async () => {
      // Yesterday + day before: streak of 2 from yesterday
      const activity = {
        [daysAgo(1)]: { sessions: 2, messages: 4, tokens: 80 },
        [daysAgo(2)]: { sessions: 1, messages: 2, tokens: 40 }
      };
      readJSONFile.mockResolvedValueOnce(makeUsage(activity));
      await loadUsage();
      const summary = getUsageSummary();
      expect(summary.currentStreak).toBe(2);
    });

    it('returns 0 when there is a day with sessions:0 in the record', async () => {
      const activity = {
        [daysAgo(0)]: { sessions: 0, messages: 0, tokens: 0 }
      };
      readJSONFile.mockResolvedValueOnce(makeUsage(activity));
      await loadUsage();
      const summary = getUsageSummary();
      expect(summary.currentStreak).toBe(0);
    });
  });

  describe('longestStreak', () => {
    it('returns 0 for empty data', async () => {
      readJSONFile.mockResolvedValueOnce(makeUsage({}));
      await loadUsage();
      const summary = getUsageSummary();
      expect(summary.longestStreak).toBe(0);
    });

    it('returns 5 for 5 consecutive days even when current streak is shorter', async () => {
      // 5-day run ending 10 days ago, then a new 1-day run today
      const activity = {
        [daysAgo(14)]: { sessions: 1, messages: 1, tokens: 10 },
        [daysAgo(13)]: { sessions: 1, messages: 1, tokens: 10 },
        [daysAgo(12)]: { sessions: 1, messages: 1, tokens: 10 },
        [daysAgo(11)]: { sessions: 1, messages: 1, tokens: 10 },
        [daysAgo(10)]: { sessions: 1, messages: 1, tokens: 10 },
        // gap
        [daysAgo(0)]:  { sessions: 1, messages: 1, tokens: 10 }
      };
      readJSONFile.mockResolvedValueOnce(makeUsage(activity));
      await loadUsage();
      const summary = getUsageSummary();
      expect(summary.longestStreak).toBe(5);
      expect(summary.currentStreak).toBe(1);
    });

    it('currentStreak equals longestStreak when all recent days active', async () => {
      const activity = {
        [daysAgo(0)]: { sessions: 1, messages: 1, tokens: 10 },
        [daysAgo(1)]: { sessions: 1, messages: 1, tokens: 10 },
        [daysAgo(2)]: { sessions: 1, messages: 1, tokens: 10 }
      };
      readJSONFile.mockResolvedValueOnce(makeUsage(activity));
      await loadUsage();
      const summary = getUsageSummary();
      expect(summary.currentStreak).toBe(3);
      expect(summary.longestStreak).toBe(3);
    });
  });

  describe('summary structure', () => {
    it('returns all expected fields with correct types', async () => {
      readJSONFile.mockResolvedValueOnce(makeUsage({}, {
        totalSessions: 10,
        totalMessages: 42,
        totalToolCalls: 7,
        totalTokens: { input: 1000, output: 500 }
      }));
      await loadUsage();
      const summary = getUsageSummary();

      expect(summary.totalSessions).toBe(10);
      expect(summary.totalMessages).toBe(42);
      expect(summary.totalToolCalls).toBe(7);
      expect(Array.isArray(summary.hourlyActivity)).toBe(true);
      expect(summary.hourlyActivity).toHaveLength(24);
      expect(Array.isArray(summary.last7Days)).toBe(true);
      expect(summary.last7Days).toHaveLength(7);
      expect(Array.isArray(summary.topProviders)).toBe(true);
      expect(Array.isArray(summary.topModels)).toBe(true);
    });

    it('last7Days entries are in chronological order (oldest first)', async () => {
      readJSONFile.mockResolvedValueOnce(makeUsage({}));
      await loadUsage();
      const summary = getUsageSummary();
      const dates = summary.last7Days.map(d => d.date);
      const sorted = [...dates].sort();
      expect(dates).toEqual(sorted);
    });

    it('last7Days entries have required fields', async () => {
      readJSONFile.mockResolvedValueOnce(makeUsage({
        [daysAgo(0)]: { sessions: 3, messages: 10, tokens: 200 }
      }));
      await loadUsage();
      const summary = getUsageSummary();
      const today = summary.last7Days[6]; // last entry = today
      expect(today.sessions).toBe(3);
      expect(today.messages).toBe(10);
      expect(today.tokens).toBe(200);
      expect(typeof today.label).toBe('string');
    });

    it('estimatedCost is a number >= 0', async () => {
      readJSONFile.mockResolvedValueOnce(makeUsage({}, {
        totalTokens: { input: 1_000_000, output: 500_000 }
      }));
      await loadUsage();
      const summary = getUsageSummary();
      expect(typeof summary.estimatedCost).toBe('number');
      expect(summary.estimatedCost).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getUsage', () => {
    it('returns the loaded data object', async () => {
      readJSONFile.mockResolvedValueOnce(makeUsage({}, { totalSessions: 99 }));
      await loadUsage();
      const usage = getUsage();
      expect(usage.totalSessions).toBe(99);
    });
  });
});
