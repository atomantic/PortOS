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
tryReadFile: vi.fn().mockResolvedValue(null),
  ensureDir: vi.fn().mockResolvedValue(undefined),
  atomicWrite: vi.fn().mockResolvedValue(undefined),
  PATHS: { data: '/fake/data' },
  readJSONFile: vi.fn()
}));

import { readJSONFile } from '../lib/fileUtils.js';
import { loadUsage, getUsageSummary, getUsage, recordSession, recordMessages, buildUsageReport, rollupOldDailyActivity } from './usage.js';

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

    it('estimatedCost keeps its all-time legacy-blended semantics ($3/$15 per 1M)', async () => {
      readJSONFile.mockResolvedValueOnce(makeUsage({}, {
        totalTokens: { input: 1_000_000, output: 500_000 }
      }));
      await loadUsage();
      const summary = getUsageSummary();
      expect(summary.estimatedCost).toBeCloseTo(10.5); // 1M×$3 + 0.5M×$15
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

  describe('time-dimensioned capture', () => {
    it('recordSession creates per-provider/per-model day buckets', async () => {
      readJSONFile.mockResolvedValueOnce(makeUsage({}));
      await loadUsage();
      await recordSession('claude-code', 'Claude Code', 'opus');

      const day = getUsage().dailyActivity[daysAgo(0)];
      expect(day.sessions).toBe(1);
      expect(day.byProvider['claude-code']).toMatchObject({ name: 'Claude Code', sessions: 1 });
      expect(day.byProvider['claude-code'].byModel.opus.sessions).toBe(1);
    });

    it('recordMessages attributes input and output tokens to provider, model, and day', async () => {
      readJSONFile.mockResolvedValueOnce(makeUsage({}));
      await loadUsage();
      await recordSession('claude-code', 'Claude Code', 'opus');
      await recordMessages('claude-code', 'opus', 1, 400, 1200);

      const usage = getUsage();
      expect(usage.totalTokens).toEqual({ input: 1200, output: 400 });
      // Legacy all-time entries keep their output-only `tokens` shape — the
      // in/out split lives only in the day buckets the report aggregates.
      expect(usage.byProvider['claude-code']).toMatchObject({ tokens: 400 });
      expect(usage.byModel.opus).toMatchObject({ tokens: 400 });
      const modelDay = usage.dailyActivity[daysAgo(0)].byProvider['claude-code'].byModel.opus;
      expect(modelDay).toMatchObject({ messages: 1, tokensIn: 1200, tokensOut: 400 });
    });

    it('recordMessages accumulates onto legacy all-time entries without reshaping them', async () => {
      readJSONFile.mockResolvedValueOnce(makeUsage({}, {
        byProvider: { codex: { name: 'Codex', sessions: 5, messages: 5, tokens: 100 } },
        byModel: { 'gpt-5.3-codex': { sessions: 5, messages: 5, tokens: 100 } }
      }));
      await loadUsage();
      await recordMessages('codex', 'gpt-5.3-codex', 1, 50, 200);

      const usage = getUsage();
      expect(usage.byProvider.codex).toMatchObject({ messages: 6, tokens: 150 });
      expect(usage.byModel['gpt-5.3-codex']).toMatchObject({ messages: 6, tokens: 150 });
      // ...while the day bucket carries the full in/out split
      const modelDay = usage.dailyActivity[daysAgo(0)].byProvider.codex.byModel['gpt-5.3-codex'];
      expect(modelDay).toMatchObject({ tokensIn: 200, tokensOut: 50 });
    });
  });

  describe('buildUsageReport', () => {
    const nestedDay = (pid, name, model, { sessions = 1, messages = 1, tokensIn = 0, tokensOut = 0 } = {}) => ({
      sessions,
      messages,
      tokens: tokensOut,
      byProvider: {
        [pid]: {
          name, sessions, messages, tokensIn, tokensOut,
          byModel: { [model]: { sessions, messages, tokensIn, tokensOut } }
        }
      }
    });

    it('aggregates per-provider and per-model over the range with per-model costs', () => {
      const daily = {
        [daysAgo(1)]: nestedDay('claude-code', 'Claude Code', 'claude-opus-4-8', { tokensIn: 1_000_000, tokensOut: 1_000_000 }),
        [daysAgo(0)]: nestedDay('claude-code', 'Claude Code', 'claude-opus-4-8', { tokensIn: 1_000_000, tokensOut: 0 })
      };
      const report = buildUsageReport(daily, {});
      expect(report.providers).toHaveLength(1);
      const row = report.providers[0];
      expect(row).toMatchObject({ id: 'claude-code', free: false, tokensIn: 2_000_000, tokensOut: 1_000_000 });
      // opus 4.8: $5/1M in, $25/1M out → 2*5 + 1*25 = $35
      expect(row.estimatedCost).toBeCloseTo(35);
      expect(row.models[0]).toMatchObject({ model: 'claude-opus-4-8', rateMatch: 'exact', estimatedCost: 35 });
      expect(report.totals.estimatedCost).toBeCloseTo(35);
    });

    it('filters by from/to (inclusive)', () => {
      const daily = {
        '2025-06-01': nestedDay('codex', 'Codex', 'gpt-5.3-codex', { tokensOut: 100 }),
        '2025-06-05': nestedDay('codex', 'Codex', 'gpt-5.3-codex', { tokensOut: 200 }),
        '2025-06-10': nestedDay('codex', 'Codex', 'gpt-5.3-codex', { tokensOut: 400 })
      };
      const report = buildUsageReport(daily, { from: '2025-06-02', to: '2025-06-09' });
      expect(report.providers[0].tokensOut).toBe(200);
      expect(report.range).toEqual({ from: '2025-06-02', to: '2025-06-09' });
    });

    it('marks free providers with zero cost (config and id-heuristic paths)', () => {
      const daily = {
        [daysAgo(0)]: {
          sessions: 2, messages: 2, tokens: 500,
          byProvider: {
            ollama: { name: 'Ollama', sessions: 1, messages: 1, tokensIn: 1_000_000, tokensOut: 1_000_000, byModel: { 'qwen3:32b': { sessions: 1, messages: 1, tokensIn: 1_000_000, tokensOut: 1_000_000 } } },
            'my-local': { name: 'My Local', sessions: 1, messages: 1, tokensIn: 1_000_000, tokensOut: 1_000_000, byModel: { llm: { sessions: 1, messages: 1, tokensIn: 1_000_000, tokensOut: 1_000_000 } } }
          }
        }
      };
      const providers = [{ id: 'my-local', type: 'api', endpoint: 'http://localhost:1234/v1' }];
      const report = buildUsageReport(daily, { providers });
      const ollama = report.providers.find(p => p.id === 'ollama');
      const local = report.providers.find(p => p.id === 'my-local');
      expect(ollama).toMatchObject({ free: true, estimatedCost: 0 });
      expect(ollama.models[0].rateMatch).toBe('free');
      expect(local).toMatchObject({ free: true, estimatedCost: 0 });
      expect(report.totals.estimatedCost).toBe(0);
    });

    it('reports breakdownSince as the earliest day with a provider split, ignoring legacy days', () => {
      const daily = {
        '2025-05-01': { sessions: 3, messages: 3, tokens: 100 }, // legacy — no byProvider
        '2025-06-03': nestedDay('codex', 'Codex', 'gpt-5.3-codex', { tokensOut: 10 }),
        '2025-06-01': nestedDay('codex', 'Codex', 'gpt-5.3-codex', { tokensOut: 10 })
      };
      const report = buildUsageReport(daily, {});
      expect(report.breakdownSince).toBe('2025-06-01');
      // legacy day contributes nothing to the breakdown
      expect(report.totals.sessions).toBe(2);
    });

    it('prices provider-level tokens missing a model split at the provider default', () => {
      const daily = {
        [daysAgo(0)]: {
          sessions: 1, messages: 1, tokens: 0,
          byProvider: {
            'claude-code': { name: 'Claude Code', sessions: 1, messages: 1, tokensIn: 1_000_000, tokensOut: 0, byModel: {} }
          }
        }
      };
      const report = buildUsageReport(daily, {});
      // provider default for claude-* is sonnet-4.5 ($3/1M in)
      expect(report.providers[0].estimatedCost).toBeCloseTo(3);
    });

    it('returns an empty report for empty activity', () => {
      const report = buildUsageReport({}, { from: null, to: null });
      expect(report.providers).toEqual([]);
      expect(report.totals).toMatchObject({ sessions: 0, estimatedCost: 0 });
      expect(report.breakdownSince).toBeNull();
    });

    it('folds rolled-up monthly buckets into an all-time report', () => {
      // Old cost lives in a monthly bucket (same nested shape as a day bucket);
      // recent cost lives in daily. An unbounded report must sum both.
      const monthlyActivity = {
        '2024-01': nestedDay('codex', 'Codex', 'gpt-5.3-codex', { tokensOut: 1000 })
      };
      const daily = {
        [daysAgo(0)]: nestedDay('codex', 'Codex', 'gpt-5.3-codex', { tokensOut: 500 })
      };
      const report = buildUsageReport(daily, { monthlyActivity });
      expect(report.providers).toHaveLength(1);
      expect(report.providers[0].tokensOut).toBe(1500); // 1000 monthly + 500 daily
      // breakdown now reaches back to the earliest rolled-up month
      expect(report.breakdownSince).toBe('2024-01-01');
    });

    it('includes a monthly bucket only when its month overlaps the from/to range', () => {
      const monthlyActivity = {
        '2024-01': nestedDay('codex', 'Codex', 'gpt-5.3-codex', { tokensOut: 100 }),
        '2024-06': nestedDay('codex', 'Codex', 'gpt-5.3-codex', { tokensOut: 200 })
      };
      const report = buildUsageReport({}, { from: '2024-05-01', to: '2024-07-31', monthlyActivity });
      // Only 2024-06 overlaps the window; 2024-01 is excluded.
      expect(report.providers[0].tokensOut).toBe(200);
    });

    it('preserves grand totals whether old data sits in daily or monthly buckets', () => {
      // Same underlying activity, split across the rollup boundary two ways —
      // the all-time report totals must be identical.
      const allDaily = buildUsageReport({
        '2024-01-05': nestedDay('codex', 'Codex', 'gpt-5.3-codex', { tokensOut: 300 }),
        '2024-01-06': nestedDay('codex', 'Codex', 'gpt-5.3-codex', { tokensOut: 400 })
      }, {});
      const rolledUp = buildUsageReport({}, {
        monthlyActivity: { '2024-01': nestedDay('codex', 'Codex', 'gpt-5.3-codex', { sessions: 2, messages: 2, tokensOut: 700 }) }
      });
      expect(rolledUp.totals.tokensOut).toBe(allDaily.totals.tokensOut);
      expect(rolledUp.totals.estimatedCost).toBeCloseTo(allDaily.totals.estimatedCost);
    });
  });
});

describe('usage.js — rollupOldDailyActivity (bounded growth)', () => {
  const NOW = new Date('2026-07-12T12:00:00.000Z');

  // A day key exactly `n` days before NOW.
  function dayKey(n) {
    const d = new Date(NOW);
    d.setDate(d.getDate() - n);
    return d.toISOString().split('T')[0];
  }

  it('moves day buckets older than retention into monthly buckets', () => {
    const oldKey = dayKey(500); // > 400 days old
    const daily = { [oldKey]: { sessions: 2, messages: 5, tokens: 100 } };
    const monthly = {};

    const changed = rollupOldDailyActivity(daily, monthly, { now: NOW });

    expect(changed).toBe(true);
    expect(daily[oldKey]).toBeUndefined();
    const monthKey = oldKey.slice(0, 7);
    expect(monthly[monthKey]).toEqual({ sessions: 2, messages: 5, tokens: 100 });
  });

  it('leaves recent day buckets (within retention) untouched', () => {
    const recent = dayKey(30);
    const daily = { [recent]: { sessions: 1, messages: 1, tokens: 10 } };
    const monthly = {};

    const changed = rollupOldDailyActivity(daily, monthly, { now: NOW });

    expect(changed).toBe(false);
    expect(daily[recent]).toEqual({ sessions: 1, messages: 1, tokens: 10 });
    expect(monthly).toEqual({});
  });

  it('sums multiple old days in the same month into one monthly bucket', () => {
    // Two days in the same old month.
    const daily = {
      '2024-01-05': { sessions: 1, messages: 2, tokens: 30 },
      '2024-01-20': { sessions: 3, messages: 4, tokens: 70 }
    };
    const monthly = {};

    rollupOldDailyActivity(daily, monthly, { now: NOW });

    expect(monthly['2024-01']).toEqual({ sessions: 4, messages: 6, tokens: 100 });
    expect(Object.keys(daily)).toHaveLength(0);
  });

  it('deep-sums nested per-provider/per-model splits (shape tolerance)', () => {
    // Forward-compatible with the #2484 nested day-bucket shape.
    const daily = {
      '2024-01-05': {
        sessions: 1,
        tokens: 100,
        byProvider: { claude: { tokens: 60, byModel: { opus: { tokens: 60 } } } }
      },
      '2024-01-06': {
        sessions: 2,
        tokens: 40,
        byProvider: { claude: { tokens: 40, byModel: { opus: { tokens: 40 } } } }
      }
    };
    const monthly = {};

    rollupOldDailyActivity(daily, monthly, { now: NOW });

    expect(monthly['2024-01']).toEqual({
      sessions: 3,
      tokens: 140,
      byProvider: { claude: { tokens: 100, byModel: { opus: { tokens: 100 } } } }
    });
  });

  it('drops non-numeric labels while summing counts', () => {
    const daily = {
      '2024-01-05': { sessions: 1, tokens: 10, name: 'Claude Code CLI' }
    };
    const monthly = {};

    rollupOldDailyActivity(daily, monthly, { now: NOW });

    expect(monthly['2024-01']).toEqual({ sessions: 1, tokens: 10 });
  });

  it('is idempotent — a second pass is a no-op and never re-processes monthly keys', () => {
    const oldKey = dayKey(500);
    const daily = { [oldKey]: { sessions: 2, tokens: 100 } };
    const monthly = {};

    rollupOldDailyActivity(daily, monthly, { now: NOW });
    const afterFirst = JSON.parse(JSON.stringify(monthly));

    const changedAgain = rollupOldDailyActivity(daily, monthly, { now: NOW });

    expect(changedAgain).toBe(false);
    expect(monthly).toEqual(afterFirst); // no double-counting
  });

  it('preserves grand totals across the rollup boundary', () => {
    const daily = {
      '2024-01-05': { sessions: 5, messages: 10, tokens: 500 }, // old → monthly
      [dayKey(10)]: { sessions: 2, messages: 4, tokens: 200 }   // recent → daily
    };
    const monthly = {};

    rollupOldDailyActivity(daily, monthly, { now: NOW });

    const sumField = (field) =>
      Object.values(daily).reduce((a, v) => a + (v[field] || 0), 0) +
      Object.values(monthly).reduce((a, v) => a + (v[field] || 0), 0);

    expect(sumField('sessions')).toBe(7);
    expect(sumField('messages')).toBe(14);
    expect(sumField('tokens')).toBe(700);
  });
});

describe('usage.js — loadUsage rollup integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('backfills monthlyActivity for pre-rollup files and rolls up old days', async () => {
    const old = new Date();
    old.setDate(old.getDate() - 500);
    const oldKey = old.toISOString().split('T')[0];
    const recent = new Date();
    recent.setDate(recent.getDate() - 5);
    const recentKey = recent.toISOString().split('T')[0];

    // Legacy file with no monthlyActivity key at all.
    const legacy = {
      totalSessions: 7,
      totalMessages: 0,
      totalToolCalls: 0,
      totalTokens: { input: 0, output: 0 },
      byProvider: {},
      byModel: {},
      dailyActivity: {
        [oldKey]: { sessions: 5, messages: 0, tokens: 500 },
        [recentKey]: { sessions: 2, messages: 0, tokens: 200 }
      },
      hourlyActivity: Array(24).fill(0),
      lastUpdated: null
    };
    readJSONFile.mockResolvedValueOnce(legacy);

    await loadUsage();
    const data = getUsage();

    expect(data.monthlyActivity).toBeDefined();
    expect(data.dailyActivity[oldKey]).toBeUndefined(); // rolled up
    expect(data.dailyActivity[recentKey]).toBeDefined(); // retained
    expect(data.monthlyActivity[oldKey.slice(0, 7)].tokens).toBe(500);
    // Top-level totals are independent of bucket rollup — unchanged.
    expect(data.totalSessions).toBe(7);
  });
});
