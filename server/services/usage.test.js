import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests for usage.js — getUsageSummary shape and usage persistence.
 *
 * Strategy: mock fs/promises + fileUtils so usageData is controlled by each test.
 * This lets us assert exact summary values.
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

import { atomicWrite, readJSONFile } from '../lib/fileUtils.js';
import {
  applyHistoricalUsageCorrections,
  buildUsageReport,
  getFirstActivityDay,
  getUsage,
  getUsageSummary,
  loadUsage,
  recordMessages,
  recordRunUsage,
  recordSession,
  recordTokens,
  rollupOldDailyActivity
} from './usage.js';

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

describe('usage.js — summary', () => {
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

    it('estimatedCost agrees with the unbounded report total', async () => {
      readJSONFile.mockResolvedValueOnce(makeUsage({
        '2025-05-01': { sessions: 1, messages: 1, tokens: 500_000 },
        '2025-06-01': {
          sessions: 1,
          messages: 1,
          tokens: 1_000_000,
          byProvider: {
            codex: {
              name: 'Codex',
              sessions: 1,
              messages: 1,
              tokensIn: 1_000_000,
              tokensOut: 1_000_000,
              byModel: {}
            }
          }
        }
      }));
      await loadUsage();
      const summary = getUsageSummary();
      expect(summary.estimatedCost).toBe(summary.report.totals.estimatedCost);
      expect(summary.estimatedCost).toBeCloseTo(23.25);
    });

    it('keeps estimatedCost all-time when the visible report is range-filtered', async () => {
      readJSONFile.mockResolvedValueOnce(makeUsage({
        '2025-05-01': { sessions: 1, messages: 1, tokens: 1_000_000 },
        '2025-06-01': {
          sessions: 1,
          messages: 1,
          tokens: 500_000,
          byProvider: {
            codex: {
              name: 'Codex',
              sessions: 1,
              messages: 1,
              tokensIn: 0,
              tokensOut: 500_000,
              byModel: {
                'gpt-5.3-codex': {
                  sessions: 1,
                  messages: 1,
                  tokensIn: 0,
                  tokensOut: 500_000
                }
              }
            }
          }
        }
      }));
      await loadUsage();

      const summary = getUsageSummary({ from: '2025-06-01', to: '2025-06-01' });
      expect(summary.report.totals.estimatedCost).toBe(7);
      expect(summary.estimatedCost).toBe(22);
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

  describe('getFirstActivityDay', () => {
    it('returns the earliest recorded day', async () => {
      readJSONFile.mockResolvedValueOnce(makeUsage({ [daysAgo(2)]: { sessions: 1 }, [daysAgo(9)]: { sessions: 1 } }));
      await loadUsage();
      expect(getFirstActivityDay()).toBe(daysAgo(9));
    });

    // A rolled-up month only knows its month, so it contributes its first day —
    // the subscription-savings window would otherwise start after usage that
    // predates the daily retention boundary.
    it('falls back to a rolled-up month when it predates every day bucket', async () => {
      readJSONFile.mockResolvedValueOnce(
        makeUsage({ [daysAgo(1)]: { sessions: 1 } }, { monthlyActivity: { '2024-03': { sessions: 5 } } })
      );
      await loadUsage();
      expect(getFirstActivityDay()).toBe('2024-03-01');
    });

    it('is null with no recorded history', async () => {
      readJSONFile.mockResolvedValueOnce(makeUsage({}));
      await loadUsage();
      expect(getFirstActivityDay()).toBeNull();
    });

    it('backfills a stale cached value during load and persists it', async () => {
      readJSONFile.mockResolvedValueOnce(makeUsage(
        { '2025-06-08': { sessions: 1 } },
        { earliestActivityDay: '2025-06-10', monthlyActivity: { '2024-03': { sessions: 5 } } }
      ));

      await loadUsage();

      expect(getFirstActivityDay()).toBe('2024-03-01');
      expect(atomicWrite).toHaveBeenCalled();
    });

    it('updates the cached value when the first day bucket is recorded', async () => {
      readJSONFile.mockResolvedValueOnce(makeUsage({}));
      await loadUsage();

      await recordSession('codex', 'Codex', 'gpt-5.6');

      expect(getFirstActivityDay()).toBe(daysAgo(0));
    });
  });

  describe('summary memoization', () => {
    it('reuses a summary until usage changes', async () => {
      readJSONFile.mockResolvedValueOnce(makeUsage({ [daysAgo(0)]: { sessions: 1 } }));
      await loadUsage();

      const first = getUsageSummary();
      const cached = getUsageSummary();
      await recordSession('codex', 'Codex', 'gpt-5.6');
      const updated = getUsageSummary();

      expect(cached).toBe(first);
      expect(updated).not.toBe(first);
      expect(updated.totalSessions).toBe(2);
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

    it('attributes missing provider ids to a named unknown bucket', async () => {
      readJSONFile.mockResolvedValueOnce(makeUsage({}));
      await loadUsage();
      await recordSession(undefined, undefined, null);
      await recordMessages(undefined, null, 1, 40, 10);

      const usage = getUsage();
      expect(usage.byProvider.undefined).toBeUndefined();
      expect(usage.byProvider.unknown).toMatchObject({
        name: 'Unknown provider',
        sessions: 1,
        messages: 1,
        tokens: 40
      });
      const day = usage.dailyActivity[daysAgo(0)];
      expect(day.byProvider.unknown).toMatchObject({
        name: 'Unknown provider',
        sessions: 1,
        messages: 1,
        tokensIn: 10,
        tokensOut: 40
      });
    });

    it('normalizes a persisted string "undefined" provider in reports', () => {
      const report = buildUsageReport({
        [daysAgo(0)]: {
          sessions: 1,
          messages: 1,
          tokens: 20,
          byProvider: {
            undefined: {
              sessions: 1,
              messages: 1,
              tokensIn: 10,
              tokensOut: 20,
              byModel: {}
            }
          }
        }
      });
      expect(report.providers).toEqual([
        expect.objectContaining({
          id: 'unknown',
          name: 'Unknown provider',
          sessions: 1
        })
      ]);
    });

    it('normalizes persisted undefined provider buckets while loading', async () => {
      readJSONFile.mockResolvedValueOnce(makeUsage({
        [daysAgo(0)]: {
          sessions: 1,
          messages: 1,
          tokens: 20,
          byProvider: {
            undefined: { sessions: 1, messages: 1, tokensIn: 10, tokensOut: 20, byModel: {} }
          }
        }
      }, {
        byProvider: {
          undefined: { sessions: 1, messages: 1, tokens: 20 }
        }
      }));

      await loadUsage();

      expect(getUsage().byProvider.undefined).toBeUndefined();
      expect(getUsage().byProvider.unknown.name).toBe('Unknown provider');
      expect(getUsage().dailyActivity[daysAgo(0)].byProvider.undefined).toBeUndefined();
      expect(atomicWrite).toHaveBeenCalled();
    });

    it('deep-merges model usage while normalizing undefined provider buckets', async () => {
      readJSONFile.mockResolvedValueOnce(makeUsage({
        [daysAgo(0)]: {
          byProvider: {
            unknown: { byModel: { current: { sessions: 2, tokensOut: 20 } } },
            undefined: { byModel: { legacy: { sessions: 1, tokensOut: 10 } } }
          }
        }
      }));

      await loadUsage();

      expect(getUsage().dailyActivity[daysAgo(0)].byProvider.unknown.byModel).toEqual({
        current: { sessions: 2, tokensOut: 20 },
        legacy: { sessions: 1, tokensOut: 10 }
      });
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

    it('attributes directly recorded tokens to reportable unknown usage', async () => {
      readJSONFile.mockResolvedValueOnce(makeUsage({}));
      await loadUsage();
      await recordTokens(1_000_000, 500_000);

      const report = getUsageSummary().report;
      expect(report.providers).toEqual([
        expect.objectContaining({
          id: 'unknown',
          tokensIn: 1_000_000,
          tokensOut: 500_000
        })
      ]);
      expect(report.totals.estimatedCost).toBeGreaterThan(0);
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

    it('includes legacy days in a fallback-priced row without changing breakdownSince', () => {
      const daily = {
        '2025-05-01': { sessions: 3, messages: 3, tokens: 1_000_000 }, // legacy — no byProvider
        '2025-06-03': nestedDay('codex', 'Codex', 'gpt-5.3-codex', { tokensOut: 10 }),
        '2025-06-01': nestedDay('codex', 'Codex', 'gpt-5.3-codex', { tokensOut: 10 })
      };
      const report = buildUsageReport(daily, {});
      expect(report.breakdownSince).toBe('2025-06-01');
      expect(report.totals.sessions).toBe(5);
      expect(report.totals.tokensOut).toBe(1_000_020);
      expect(report.providers.find((provider) => provider.id === 'legacy')).toMatchObject({
        name: 'Pre-breakdown (legacy)',
        sessions: 3,
        tokensOut: 1_000_000,
        estimatedCost: 15,
        rateMatch: 'fallback'
      });
    });

    it('reports the actual breakdown start even when the visible range begins later', () => {
      const report = buildUsageReport({
        '2025-06-01': nestedDay('codex', 'Codex', 'gpt-5.3-codex'),
        '2025-07-01': nestedDay('codex', 'Codex', 'gpt-5.3-codex')
      }, {
        from: '2025-07-01',
        to: '2025-07-31'
      });

      expect(report.breakdownSince).toBe('2025-06-01');
      expect(report.totals.sessions).toBe(1);
    });

    it('folds legacy monthly buckets into the requested range', () => {
      const report = buildUsageReport({}, {
        from: '2024-05-01',
        to: '2024-07-31',
        monthlyActivity: {
          '2024-01': { sessions: 1, messages: 1, tokens: 10 },
          '2024-06': { sessions: 2, messages: 3, tokens: 500 }
        }
      });
      expect(report.providers).toEqual([
        expect.objectContaining({
          id: 'legacy',
          sessions: 2,
          messages: 3,
          tokensOut: 500
        })
      ]);
    });

    it('keeps flat legacy residuals in a mixed-shape monthly bucket', () => {
      const report = buildUsageReport({}, {
        monthlyActivity: {
          '2025-06': {
            sessions: 3,
            messages: 3,
            tokens: 300,
            byProvider: {
              codex: {
                sessions: 1,
                messages: 1,
                tokensIn: 10,
                tokensOut: 100,
                byModel: {}
              }
            }
          }
        }
      });

      expect(report.providers.find((provider) => provider.id === 'codex')).toMatchObject({
        sessions: 1,
        tokensOut: 100
      });
      expect(report.providers.find((provider) => provider.id === 'legacy')).toMatchObject({
        sessions: 2,
        messages: 2,
        tokensOut: 200
      });
      expect(report.totals).toMatchObject({
        sessions: 3,
        messages: 3,
        tokensOut: 300
      });
    });

    it('allocates historical direct-token residuals without double-counting buckets', () => {
      const report = buildUsageReport({
        '2025-06-01': {
          tokens: 500_000,
          byProvider: {
            codex: {
              tokensIn: 100_000,
              tokensOut: 500_000,
              byModel: {}
            }
          }
        }
      }, {
        totalTokens: { input: 1_000_000, output: 1_500_000 }
      });

      expect(report.totals.tokensIn).toBe(1_000_000);
      expect(report.totals.tokensOut).toBe(1_500_000);
      expect(report.providers.find((provider) => provider.id === 'legacy')).toMatchObject({
        tokensIn: 900_000,
        tokensOut: 1_000_000
      });
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

describe('usage.js — cache tiers and measured/estimate provenance (#3124 Phase 2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_DATE);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const today = '2025-06-11';

  it('records cache tokens and a measured source through recordRunUsage', async () => {
    readJSONFile.mockResolvedValueOnce(makeUsage({}));
    await loadUsage();
    await recordSession('claude-code', 'Claude Code', 'claude-opus-5');
    await recordRunUsage({
      providerId: 'claude-code',
      model: 'claude-opus-5',
      messages: 3,
      tokensIn: 1500,
      tokensOut: 800,
      cacheReadTokens: 3_500_000,
      cacheWriteTokens: 280_000,
      source: 'measured'
    });

    const providerDay = getUsage().dailyActivity[today].byProvider['claude-code'];
    expect(providerDay).toMatchObject({
      messages: 3,
      tokensIn: 1500,
      tokensOut: 800,
      cacheReadTokens: 3_500_000,
      cacheWriteTokens: 280_000,
      source: 'measured'
    });
    expect(providerDay.byModel['claude-opus-5']).toMatchObject({
      cacheReadTokens: 3_500_000,
      source: 'measured'
    });
  });

  it('counts every billable input tier in the all-time input total', () => {
    // A cache read is an input token the user was charged for — the headline
    // "Tokens" figure must not omit it (that was the #3124 understatement).
    expect(getUsage().totalTokens.input).toBe(1500 + 3_500_000 + 280_000);
  });

  it('records a multi-model run with one atomic write', async () => {
    readJSONFile.mockResolvedValueOnce(makeUsage({}, {
      byModel: {
        'claude-opus-5': { sessions: 1, messages: 0, tokens: 0 },
        'claude-sonnet-5': { sessions: 1, messages: 0, tokens: 0 }
      }
    }));
    await loadUsage();
    vi.clearAllMocks();

    await recordRunUsage([
      {
        providerId: 'claude-code',
        model: 'claude-opus-5',
        messages: 2,
        tokensIn: 100,
        tokensOut: 20,
        source: 'measured'
      },
      {
        providerId: 'claude-code',
        model: 'claude-sonnet-5',
        messages: 3,
        tokensIn: 200,
        tokensOut: 30,
        cacheReadTokens: 400,
        source: 'estimate'
      }
    ]);

    expect(atomicWrite).toHaveBeenCalledTimes(1);
    expect(getUsage()).toMatchObject({
      totalMessages: 5,
      totalTokens: { input: 700, output: 50 },
      byProvider: {
        'claude-code': { messages: 5, tokens: 50 }
      },
      byModel: {
        'claude-opus-5': { messages: 2, tokens: 20 },
        'claude-sonnet-5': { messages: 3, tokens: 30 }
      }
    });
    expect(getUsage().dailyActivity[today].byProvider['claude-code']).toMatchObject({
      messages: 5,
      tokensIn: 300,
      tokensOut: 50,
      cacheReadTokens: 400,
      source: 'mixed'
    });
  });

  it('defaults recordMessages to an estimate source with no cache tokens', async () => {
    readJSONFile.mockResolvedValueOnce(makeUsage({}));
    await loadUsage();
    await recordMessages('codex', 'gpt-5.3-codex', 1, 400, 30);

    expect(getUsage().dailyActivity[today].byProvider.codex).toMatchObject({
      tokensIn: 30,
      tokensOut: 400,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      source: 'estimate'
    });
  });

  it('downgrades a bucket to mixed when measured and estimated counts land together', async () => {
    readJSONFile.mockResolvedValueOnce(makeUsage({}));
    await loadUsage();
    await recordRunUsage({ providerId: 'claude-code', model: 'claude-opus-5', tokensOut: 10, source: 'measured' });
    await recordRunUsage({ providerId: 'claude-code', model: 'claude-opus-5', tokensOut: 10, source: 'estimate' });

    expect(getUsage().dailyActivity[today].byProvider['claude-code'].source).toBe('mixed');
  });

  it('accumulates cache tokens onto a legacy bucket that predates the fields', async () => {
    readJSONFile.mockResolvedValueOnce(makeUsage({
      [today]: {
        sessions: 1,
        messages: 1,
        tokens: 100,
        // Pre-#3124 shape: no cacheReadTokens/cacheWriteTokens/source at all.
        byProvider: { 'claude-code': { name: 'Claude Code', sessions: 1, messages: 1, tokensIn: 20, tokensOut: 100, byModel: {} } }
      }
    }));
    await loadUsage();
    await recordRunUsage({
      providerId: 'claude-code',
      model: null,
      tokensOut: 50,
      cacheReadTokens: 900,
      source: 'measured'
    });

    const bucket = getUsage().dailyActivity[today].byProvider['claude-code'];
    expect(bucket.cacheReadTokens).toBe(900);
    expect(bucket.tokensOut).toBe(150);
    // The pre-existing 100 output tokens were estimates, so the merged bucket
    // must not claim to be purely measured.
    expect(bucket.source).toBe('mixed');
  });
});

describe('buildUsageReport — cache pricing and source reporting', () => {
  const providers = [{ id: 'claude-code', name: 'Claude Code', type: 'cli', command: 'claude' }];

  it('prices cache read and write tiers into the estimated cost', () => {
    const daily = {
      '2026-07-01': {
        sessions: 1,
        messages: 1,
        byProvider: {
          'claude-code': {
            name: 'Claude Code',
            sessions: 1,
            messages: 1,
            tokensIn: 0,
            tokensOut: 0,
            cacheReadTokens: 1_000_000,
            cacheWriteTokens: 1_000_000,
            source: 'measured',
            byModel: {
              'claude-opus-5': {
                sessions: 1, messages: 1, tokensIn: 0, tokensOut: 0,
                cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000, source: 'measured'
              }
            }
          }
        }
      }
    };

    const report = buildUsageReport(daily, { providers });
    // claude-opus-5: $5/MTok input → $0.50 cache read + $6.25 cache write.
    expect(report.totals.estimatedCost).toBeCloseTo(6.75, 2);
    expect(report.totals.cacheReadTokens).toBe(1_000_000);
    expect(report.totals.cacheWriteTokens).toBe(1_000_000);
    expect(report.totals.source).toBe('measured');
    expect(report.providers[0].source).toBe('measured');
    expect(report.providers[0].models[0]).toMatchObject({
      cacheReadTokens: 1_000_000,
      cacheWritePer1M: 6.25,
      cacheReadPer1M: 0.5
    });
  });

  it('reports legacy buckets with no source field as estimates', () => {
    const daily = {
      '2026-07-01': {
        sessions: 1,
        messages: 1,
        byProvider: {
          'claude-code': {
            name: 'Claude Code', sessions: 1, messages: 1, tokensIn: 10, tokensOut: 100, byModel: {}
          }
        }
      }
    };

    const report = buildUsageReport(daily, { providers });
    expect(report.providers[0].source).toBe('estimate');
    expect(report.providers[0].cacheReadTokens).toBe(0);
    expect(report.totals.source).toBe('estimate');
  });

  it('marks a range spanning legacy and measured buckets as mixed', () => {
    const daily = {
      '2026-07-01': {
        sessions: 1, messages: 1,
        byProvider: { 'claude-code': { name: 'Claude Code', sessions: 1, messages: 1, tokensIn: 10, tokensOut: 100, byModel: {} } }
      },
      '2026-07-02': {
        sessions: 1, messages: 1,
        byProvider: { 'claude-code': { name: 'Claude Code', sessions: 1, messages: 1, tokensIn: 10, tokensOut: 100, cacheReadTokens: 500, source: 'measured', byModel: {} } }
      }
    };

    const report = buildUsageReport(daily, { providers });
    expect(report.providers[0].source).toBe('mixed');
  });

  it('never charges a free local provider for cache tokens', () => {
    const daily = {
      '2026-07-01': {
        sessions: 1, messages: 1,
        byProvider: { ollama: { name: 'Ollama', sessions: 1, messages: 1, tokensIn: 100, tokensOut: 100, cacheReadTokens: 5_000_000, source: 'measured', byModel: {} } }
      }
    };

    const report = buildUsageReport(daily, { providers: [{ id: 'ollama', name: 'Ollama' }] });
    expect(report.totals.estimatedCost).toBe(0);
  });

  it('does not re-add measured cache tokens as a legacy residual', () => {
    // totalTokens.input includes the cache tiers, so the residual reconciliation
    // must count them as represented or it double-bills them as legacy.
    const daily = {
      '2026-07-01': {
        sessions: 1, messages: 1,
        byProvider: {
          'claude-code': {
            name: 'Claude Code', sessions: 1, messages: 1,
            tokensIn: 1000, tokensOut: 500,
            cacheReadTokens: 2_000_000, cacheWriteTokens: 100_000,
            source: 'measured', byModel: {}
          }
        }
      }
    };

    const report = buildUsageReport(daily, {
      providers,
      totalTokens: { input: 1000 + 2_000_000 + 100_000, output: 500 }
    });

    expect(report.providers.find((p) => p.id === 'legacy')).toBeUndefined();
  });
});

describe('usage.js — historical transcript corrections (#3156)', () => {
  const dayKey = '2026-07-01';
  const providerId = 'claude-code-tui';
  const model = 'claude-opus-5';

  beforeEach(async () => {
    vi.clearAllMocks();
    readJSONFile.mockResolvedValueOnce(makeUsage({
      [dayKey]: {
        sessions: 1,
        messages: 1,
        tokens: 50,
        byProvider: {
          [providerId]: {
            name: 'Claude Code TUI',
            sessions: 1,
            messages: 1,
            tokensIn: 20,
            tokensOut: 50,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            source: 'estimate',
            byModel: {
              [model]: {
                sessions: 1,
                messages: 1,
                tokensIn: 20,
                tokensOut: 50,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                source: 'estimate'
              }
            }
          }
        }
      }
    }, {
      totalSessions: 1,
      totalMessages: 1,
      totalTokens: { input: 20, output: 50 },
      byProvider: { [providerId]: { name: 'Claude Code TUI', sessions: 1, messages: 1, tokens: 50 } },
      byModel: { [model]: { sessions: 1, messages: 1, tokens: 50 } }
    }));
    await loadUsage();
  });

  it('replaces the configured-provider estimate, rebuilds flat totals, and is idempotent', async () => {
    const correction = {
      runId: 'run-example-1',
      day: dayKey,
      providerId,
      model,
      estimate: { messages: 1, tokensIn: 20, tokensOut: 50 },
      measured: [{
        providerId,
        model,
        messages: 2,
        tokensIn: 100,
        tokensOut: 200,
        cacheReadTokens: 1000,
        cacheWriteTokens: 10,
        source: 'measured'
      }]
    };

    expect(await applyHistoricalUsageCorrections([correction])).toMatchObject({ corrected: 1 });
    const afterFirst = structuredClone(getUsage());
    expect(await applyHistoricalUsageCorrections([correction])).toMatchObject({ corrected: 0 });
    expect(getUsage()).toEqual(afterFirst);

    const day = getUsage().dailyActivity[dayKey];
    expect(day).toMatchObject({ sessions: 1, messages: 2, tokens: 200, tokensIn: 100, tokensOut: 200 });
    expect(day.byProvider[providerId]).toMatchObject({
      messages: 2,
      tokensIn: 100,
      tokensOut: 200,
      cacheReadTokens: 1000,
      cacheWriteTokens: 10,
      source: 'measured'
    });
    expect(day.byProvider['claude-code']).toBeUndefined();

    const report = buildUsageReport(getUsage().dailyActivity, {
      providers: [{ id: providerId, name: 'Claude Code TUI' }],
      totalTokens: getUsage().totalTokens
    });
    expect(report.providers.find((provider) => provider.id === providerId)?.models[0]).toMatchObject({
      tokensIn: 100,
      tokensOut: 200
    });
    expect(report.providers.some((provider) => provider.id === 'legacy')).toBe(false);
  });

  // #5831 — a nested `--review-with grok` pass inside this Claude run. The
  // tokens belong to grok, and the run's own measured Claude counts must not
  // move a single token.
  it('routes a sibling record to its own provider without touching the parent', async () => {
    const parentCorrection = {
      runId: 'run-example-1',
      day: dayKey,
      providerId,
      model,
      estimate: { messages: 1, tokensIn: 20, tokensOut: 50 },
      measured: [{ providerId, model, messages: 2, tokensIn: 100, tokensOut: 200, cacheReadTokens: 1000, cacheWriteTokens: 10, source: 'measured' }],
      siblings: [{
        providerId: 'grok-cli',
        role: 'sibling',
        model: 'example-grok-model',
        messages: 1,
        tokensIn: 3000,
        tokensOut: 700,
        cacheReadTokens: 6000,
        cacheWriteTokens: 0,
        source: 'measured'
      }],
      siblingScanned: true
    };

    expect(await applyHistoricalUsageCorrections([parentCorrection])).toMatchObject({ corrected: 1 });
    const day = getUsage().dailyActivity[dayKey];
    expect(day.byProvider[providerId]).toMatchObject({ tokensIn: 100, tokensOut: 200, cacheReadTokens: 1000 });
    expect(day.byProvider['grok-cli']).toMatchObject({
      messages: 1,
      tokensIn: 3000,
      tokensOut: 700,
      cacheReadTokens: 6000,
      source: 'measured'
    });
    expect(day.byProvider['grok-cli'].byModel['example-grok-model']).toMatchObject({ tokensOut: 700 });
    // Both halves are idempotent, under their own independent markers.
    const afterFirst = structuredClone(getUsage());
    expect(await applyHistoricalUsageCorrections([parentCorrection])).toMatchObject({ corrected: 0 });
    expect(getUsage()).toEqual(afterFirst);
  });

  // The parent pass ran long ago, so there is no estimate left to remove and no
  // reason to require a bucket for the parent provider on the target day.
  it('applies a sibling-only correction on a day with no parent bucket', async () => {
    const correction = {
      runId: 'run-example-2',
      day: '2026-07-05',
      providerId,
      model,
      estimate: null,
      measured: null,
      siblings: [{
        providerId: 'antigravity-cli',
        role: 'sibling',
        model: 'example-agy-model',
        messages: 1,
        tokensIn: 100,
        tokensOut: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        source: 'estimate'
      }],
      siblingScanned: true
    };

    expect(await applyHistoricalUsageCorrections([correction])).toMatchObject({ corrected: 1 });
    const day = getUsage().dailyActivity['2026-07-05'];
    expect(day.byProvider[providerId]).toBeUndefined();
    expect(day.byProvider['antigravity-cli']).toMatchObject({ tokensIn: 100, tokensOut: 50, source: 'estimate' });
    expect(day).toMatchObject({ messages: 1, tokensOut: 50, tokens: 50 });
  });
});



describe('buildUsageReport — local models under a paid provider', () => {
  // A Claude-Code-flavored CLI can be pointed at a local Ollama backend. Its
  // provider id stays `claude-*` (correctly PAID to isFreeProvider) while the
  // model is `qwen3.6:35b`. Before the per-model check, that row resolved
  // through the `claude` provider default and invented ~$131 of cost for a day
  // of free local inference. This test bills through the REPORT, not the
  // predicate, so it fails if the wiring is ever dropped.
  const paidClaudeProvider = [{ id: 'claude-code-tui', name: 'Claude Code TUI', type: 'cli', command: 'claude' }];
  const dayWith = (model) => ({
    '2026-07-01': {
      sessions: 1, messages: 1,
      byProvider: {
        'claude-code-tui': {
          name: 'Claude Code TUI', sessions: 1, messages: 1,
          tokensIn: 5000, tokensOut: 100_000,
          cacheReadTokens: 370_000_000, cacheWriteTokens: 5_000_000,
          source: 'measured',
          byModel: {
            [model]: {
              sessions: 1, messages: 1, tokensIn: 5000, tokensOut: 100_000,
              cacheReadTokens: 370_000_000, cacheWriteTokens: 5_000_000, source: 'measured'
            }
          }
        }
      }
    }
  });

  it('prices a local model at zero even under a paid provider id', () => {
    const report = buildUsageReport(dayWith('qwen3.6:35b'), { providers: paidClaudeProvider });
    expect(report.totals.estimatedCost).toBe(0);
    expect(report.providers[0].models[0].rateMatch).toBe('free');
    // The tokens are still reported — only the cost is zero.
    expect(report.totals.cacheReadTokens).toBe(370_000_000);
  });

  it('still bills a hosted model on the same provider', () => {
    const report = buildUsageReport(dayWith('claude-opus-5'), { providers: paidClaudeProvider });
    expect(report.totals.estimatedCost).toBeGreaterThan(100);
    expect(report.providers[0].models[0].rateMatch).toBe('exact');
  });

  it('bills only the hosted half of a mixed local/hosted day', () => {
    const daily = {
      '2026-07-01': {
        sessions: 2, messages: 2,
        byProvider: {
          'claude-code-tui': {
            name: 'Claude Code TUI', sessions: 2, messages: 2,
            tokensIn: 0, tokensOut: 2_000_000, cacheReadTokens: 0, cacheWriteTokens: 0,
            source: 'measured',
            byModel: {
              'qwen3.6:35b': { sessions: 1, messages: 1, tokensIn: 0, tokensOut: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, source: 'measured' },
              'claude-opus-5': { sessions: 1, messages: 1, tokensIn: 0, tokensOut: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, source: 'measured' }
            }
          }
        }
      }
    };
    const report = buildUsageReport(daily, { providers: paidClaudeProvider });
    // 1M output on claude-opus-5 = $25; the local million is free.
    expect(report.totals.estimatedCost).toBeCloseTo(25, 2);
  });
});
