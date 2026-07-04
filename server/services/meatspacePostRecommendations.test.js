import { describe, it, expect, vi, beforeEach } from 'vitest';

// Recommendation composition (issue #2100). The pure functions
// (composePostRecommendations / weakestSkillFromStats / stalledProgressions)
// need no mocks; getPostRecommendations is exercised through the same
// mocked-fileUtils harness the other POST service tests use.
const state = { sessions: [], memoryItems: [], reviewSchedule: { skills: {} }, morse: { kochLevel: null, settings: null, rounds: [] } };

vi.mock('../lib/fileUtils.js', () => ({
  atomicWrite: vi.fn().mockResolvedValue(undefined),
  PATHS: { data: '/tmp/test-data', meatspace: '/tmp/test-meatspace' },
  ensureDir: vi.fn().mockResolvedValue(undefined),
  readJSONFile: vi.fn((path, defaultValue) => {
    if (typeof path === 'string') {
      if (path.includes('post-sessions')) return Promise.resolve({ sessions: state.sessions });
      if (path.includes('post-training-log')) return Promise.resolve({ entries: [] });
      if (path.includes('memory-items')) return Promise.resolve({ items: state.memoryItems });
      if (path.includes('post-review-schedule')) return Promise.resolve(state.reviewSchedule);
      if (path.includes('post-morse')) return Promise.resolve(state.morse);
      if (path.includes('post-config')) return Promise.resolve({});
    }
    return Promise.resolve(defaultValue);
  }),
}));

import {
  composePostRecommendations,
  weakestSkillFromStats,
  stalledProgressions,
  getPostRecommendations,
} from './meatspacePost.js';

beforeEach(() => {
  state.sessions = [];
  state.memoryItems = [];
  state.reviewSchedule = { skills: {} };
  state.morse = { kochLevel: null, settings: null, rounds: [] };
});

describe('weakestSkillFromStats', () => {
  it('returns the lowest-accuracy drill with samples', () => {
    const stats = {
      byDrillAccuracy: { 'mental-math:multiplication': 0.9, 'cognitive:n-back': 0.5 },
      byDrillCount: { 'mental-math:multiplication': 4, 'cognitive:n-back': 3 },
    };
    const w = weakestSkillFromStats(stats);
    expect(w.type).toBe('n-back');
    expect(w.module).toBe('cognitive');
    expect(w.accuracy).toBe(0.5);
  });

  it('ignores drills with zero samples', () => {
    const stats = {
      byDrillAccuracy: { 'cognitive:n-back': 0.2, 'mental-math:powers': 0.8 },
      byDrillCount: { 'cognitive:n-back': 0, 'mental-math:powers': 5 },
    };
    expect(weakestSkillFromStats(stats).type).toBe('powers');
  });

  it('returns null when there is no accuracy signal', () => {
    expect(weakestSkillFromStats({ byDrillAccuracy: {}, byDrillCount: {} })).toBeNull();
    expect(weakestSkillFromStats(null)).toBeNull();
  });
});

describe('stalledProgressions', () => {
  const stalledLadder = { level: 1, atHardest: false, currentMastered: false, thresholds: { minSamples: 12 }, levels: [
    { level: 0, label: '1×1-digit', samples: 20, mastered: true },
    { level: 1, label: '1×2-digit', samples: 4, mastered: false },
    { level: 2, label: '1×1×1-digit', samples: 0, mastered: false },
  ] };

  it('reports remaining reps to the next multiplication rung', () => {
    const out = stalledProgressions(stalledLadder, {}, {});
    expect(out).toHaveLength(1);
    expect(out[0].drillType).toBe('multiplication');
    expect(out[0].remaining).toBe(8); // 12 - 4
    expect(out[0].nextLabel).toBe('1×1×1-digit');
  });

  it('omits a ladder that is mastered-and-advancing or at its hardest rung', () => {
    expect(stalledProgressions({ ...stalledLadder, currentMastered: true }, {}, {})).toHaveLength(0);
    expect(stalledProgressions({ ...stalledLadder, atHardest: true }, {}, {})).toHaveLength(0);
  });

  it('includes cognitive ladders and a Morse Koch step once level is set', () => {
    const cog = { 'n-back': { level: 0, atHardest: false, currentMastered: false, thresholds: { minSamples: 3 }, levels: [
      { level: 0, label: '1-back @ 2500ms', samples: 1, mastered: false },
      { level: 1, label: '2-back @ 2500ms', samples: 0, mastered: false },
    ] } };
    const out = stalledProgressions(null, cog, { kochLevel: 5, kochLevelSet: true, maxKochLevel: 41 });
    const nback = out.find(o => o.drillType === 'n-back');
    expect(nback.remaining).toBe(2); // 3 - 1
    const morse = out.find(o => o.drillType === 'morse-copy');
    expect(morse.deepLink).toBe('/post/morse/copy');
    expect(morse.nextLabel).toBe('Koch level 6');
  });

  it('does not surface Morse for a fresh install (level not set)', () => {
    const out = stalledProgressions(null, {}, { kochLevel: 2, kochLevelSet: false, maxKochLevel: 41 });
    expect(out.find(o => o.drillType === 'morse-copy')).toBeUndefined();
  });
});

describe('composePostRecommendations priority + composition', () => {
  it('orders due memory items ahead of weak skills and stalled progressions', () => {
    const recs = composePostRecommendations({
      dueMemoryItems: [{ id: 'song', title: 'Elements' }],
      weakestSkill: { key: 'cognitive:n-back', type: 'n-back', accuracy: 0.5 },
      stalled: [{ drillType: 'multiplication', label: 'Multiplication', remaining: 5, nextLabel: '2×2-digit', deepLink: '/post/launcher' }],
      hasHistory: true,
    });
    expect(recs.map(r => r.kind)).toEqual(['memory-due', 'weak-skill', 'stalled-progression']);
    expect(recs[0].deepLink).toBe('/post/memory');
    expect(recs.map(r => r.priority)).toEqual([0, 1, 2]);
  });

  it('places due skill re-verifications above weak skills', () => {
    const recs = composePostRecommendations({
      dueReviews: [{ skillId: 'multiplication:L1', label: 'Multiplication 1×2', drillType: 'multiplication', status: 'due' }],
      weakestSkill: { key: 'cognitive:n-back', type: 'n-back', accuracy: 0.5 },
      hasHistory: true,
    });
    expect(recs[0].kind).toBe('skill-review');
    expect(recs[1].kind).toBe('weak-skill');
  });

  it('returns a sensible default for an empty (fresh) history', () => {
    const recs = composePostRecommendations({ hasHistory: false });
    expect(recs).toHaveLength(1);
    expect(recs[0].kind).toBe('default');
    expect(recs[0].deepLink).toBe('/post/launcher');
    expect(recs[0].title).toMatch(/first POST/i);
  });

  it('defaults to a keep-sharp prompt when history exists but nothing is actionable', () => {
    const recs = composePostRecommendations({ hasHistory: true });
    expect(recs[0].kind).toBe('default');
    expect(recs[0].title).toMatch(/streak/i);
  });

  it('caps the list at the limit', () => {
    const recs = composePostRecommendations({
      dueMemoryItems: Array.from({ length: 8 }, (_, i) => ({ id: `m${i}`, title: `Item ${i}` })),
      limit: 3,
    });
    expect(recs).toHaveLength(3);
  });
});

describe('getPostRecommendations (integration)', () => {
  it('surfaces a due memory item as the top recommendation', async () => {
    // A memory item overdue for review: nextReview in the past.
    state.memoryItems = [{
      id: 'song', title: 'Elements', type: 'song', content: { chunks: [] },
      schedule: { ease: 2.5, intervalDays: 1, nextReview: new Date(Date.now() - 86400000).toISOString() },
      mastery: { overallPct: 40, chunks: {} },
    }];
    const { recommendations } = await getPostRecommendations();
    expect(recommendations[0].kind).toBe('memory-due');
    expect(recommendations[0].deepLink).toBe('/post/memory');
  });

  it('never returns an empty list on a fresh install', async () => {
    // A fresh install still has the built-in Elements Song memory item (which
    // may be due) so the list is never empty; every entry carries a deep link.
    const { recommendations } = await getPostRecommendations();
    expect(recommendations.length).toBeGreaterThanOrEqual(1);
    for (const rec of recommendations) {
      expect(typeof rec.deepLink).toBe('string');
      expect(rec.deepLink.startsWith('/post')).toBe(true);
    }
  });
});
