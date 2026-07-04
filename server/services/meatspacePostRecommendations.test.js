import { describe, it, expect, vi, beforeEach } from 'vitest';

// Recommendation composition (issue #2100). The pure functions
// (composePostRecommendations / weakestSkillFromStats / stalledProgressions)
// need no mocks; getPostRecommendations is exercised through the same
// mocked-fileUtils harness the other POST service tests use.
const state = { sessions: [], memoryItems: [], reviewSchedule: { skills: {} }, morse: { kochLevel: null, settings: null, rounds: [] }, config: {} };

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
      if (path.includes('post-config')) return Promise.resolve(state.config);
    }
    return Promise.resolve(defaultValue);
  }),
}));

import {
  composePostRecommendations,
  weakestSkillFromStats,
  stalledProgressions,
  getPostRecommendations,
  updatePostConfig,
  isRecDrillRunnable,
} from './meatspacePost.js';
import { atomicWrite } from '../lib/fileUtils.js';

beforeEach(() => {
  state.sessions = [];
  state.memoryItems = [];
  state.reviewSchedule = { skills: {} };
  state.morse = { kochLevel: null, settings: null, rounds: [] };
  state.config = {};
  atomicWrite.mockClear();
});

// Read back the config object written to post-config.json by the most recent
// updatePostConfig call (atomicWrite is the mocked writer).
function lastWrittenConfig() {
  const call = [...atomicWrite.mock.calls].reverse().find(([p]) => typeof p === 'string' && p.includes('post-config'));
  return call?.[1];
}

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

  it('skips an untouched ladder (fresh install: level 0, no samples, no floor)', () => {
    const fresh = { level: 0, floorLevel: 0, atHardest: false, currentMastered: false, thresholds: { minSamples: 12 }, levels: [
      { level: 0, label: '1×1-digit', samples: 0, mastered: false },
      { level: 1, label: '1×2-digit', samples: 0, mastered: false },
    ] };
    expect(stalledProgressions(fresh, { 'n-back': fresh }, {})).toHaveLength(0);
  });

  it('surfaces a ladder once the user has earned a higher floor even with no windowed samples', () => {
    const earned = { level: 1, floorLevel: 1, atHardest: false, currentMastered: false, thresholds: { minSamples: 12 }, levels: [
      { level: 0, label: '1×1-digit', samples: 0, mastered: true },
      { level: 1, label: '1×2-digit', samples: 0, mastered: false },
      { level: 2, label: '1×1×1-digit', samples: 0, mastered: false },
    ] };
    const out = stalledProgressions(earned, {}, {});
    expect(out).toHaveLength(1);
    expect(out[0].remaining).toBe(12);
  });
});

describe('isRecDrillRunnable (issue #2100)', () => {
  it('memory is always runnable (its own tab)', () => {
    expect(isRecDrillRunnable({ sessionModules: [] }, 'memory', 'memory-sequence')).toBe(true);
  });

  it('false when the module is excluded from session composition', () => {
    expect(isRecDrillRunnable({ sessionModules: ['mental-math'] }, 'cognitive', 'n-back')).toBe(false);
  });

  it('null/absent sessionModules means all modules allowed', () => {
    expect(isRecDrillRunnable({}, 'cognitive', 'n-back')).toBe(true);
  });

  it('false when the module or the specific drill is disabled', () => {
    expect(isRecDrillRunnable({ cognitive: { enabled: false } }, 'cognitive', 'n-back')).toBe(false);
    expect(isRecDrillRunnable({ cognitive: { enabled: true, drillTypes: { 'n-back': { enabled: false } } } }, 'cognitive', 'n-back')).toBe(false);
  });

  it('true when the module and drill are both enabled and allowed', () => {
    expect(isRecDrillRunnable({ sessionModules: ['cognitive'], cognitive: { enabled: true, drillTypes: { 'n-back': { enabled: true } } } }, 'cognitive', 'n-back')).toBe(true);
  });
});

describe('getPostRecommendations config filtering (issue #2100)', () => {
  it('drops a weakest-skill rec for a drill excluded from session composition', async () => {
    // History makes n-back the weakest skill, but the config excludes cognitive
    // from composition — so it must not surface as a runnable recommendation.
    state.config = { sessionModules: ['mental-math'] };
    state.sessions = [{
      date: new Date().toISOString().split('T')[0], durationMs: 60000, score: 40,
      tasks: [{ module: 'cognitive', type: 'n-back', score: 40, accuracy: 0.4, completion: 1, questions: [{ answered: 'match', correct: false }] }],
    }];
    const { recommendations } = await getPostRecommendations();
    expect(recommendations.some(r => r.kind === 'weak-skill')).toBe(false);
  });
});

describe('updatePostConfig goals (issue #2100)', () => {
  it('replaces the goals block wholesale so a goal can be cleared', async () => {
    state.config = { goals: { streakTarget: 5, dailyMinutes: 20 } };
    // A partial goals patch replaces (not deep-merges) — dailyMinutes drops.
    await updatePostConfig({ goals: { streakTarget: 10 } });
    expect(lastWrittenConfig().goals).toEqual({ streakTarget: 10 });
  });

  it('clears all goals when sent an empty goals object', async () => {
    state.config = { goals: { streakTarget: 5 } };
    await updatePostConfig({ goals: {} });
    expect(lastWrittenConfig().goals).toEqual({});
  });

  it('leaves goals untouched when the patch omits them', async () => {
    state.config = { goals: { streakTarget: 5 } };
    await updatePostConfig({ adaptive: { enabled: true } });
    expect(lastWrittenConfig().goals).toEqual({ streakTarget: 5 });
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
      dueReviews: [{ skillId: 'multiplication:L1', label: 'Multiplication 1×2', drillType: 'multiplication', kind: 'multiplication', status: 'due' }],
      weakestSkill: { key: 'cognitive:n-back', type: 'n-back', accuracy: 0.5 },
      hasHistory: true,
    });
    expect(recs[0].kind).toBe('skill-review');
    expect(recs[0].deepLink).toBe('/post/launcher');
    expect(recs[1].kind).toBe('weak-skill');
  });

  it('routes a memory-chunk re-verification to the memory tab, not the launcher', () => {
    const recs = composePostRecommendations({
      dueReviews: [{ skillId: 'memory:song:c1', label: 'Elements — Chorus', kind: 'memory', status: 'due' }],
      hasHistory: true,
    });
    expect(recs[0].kind).toBe('skill-review');
    expect(recs[0].deepLink).toBe('/post/memory');
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
