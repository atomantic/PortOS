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

// getPostStats (via getPostRecommendations) derives the local day through
// getUserTimezone → getSettings (issue #2681). Pin it to UTC so the day boundary
// is the UTC day regardless of the runner's own system timezone.
vi.mock('../services/settings.js', () => ({
  getSettings: () => Promise.resolve({ timezone: 'UTC' }),
}));

import {
  composePostRecommendations,
  weakestSkillFromStats,
  stalledProgressions,
  getPostRecommendations,
  updatePostConfig,
  isRecDrillRunnable,
  memoryPracticeDeepLink,
  memoryItemIdFromReview,
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
    const out = stalledProgressions(stalledLadder, null, {}, {});
    expect(out).toHaveLength(1);
    expect(out[0].drillType).toBe('multiplication');
    expect(out[0].remaining).toBe(8); // 12 - 4
    expect(out[0].nextLabel).toBe('1×1×1-digit');
  });

  it('omits a ladder that is mastered-and-advancing or at its hardest rung', () => {
    expect(stalledProgressions({ ...stalledLadder, currentMastered: true }, null, {}, {})).toHaveLength(0);
    expect(stalledProgressions({ ...stalledLadder, atHardest: true }, null, {}, {})).toHaveLength(0);
  });

  it('reports an engaged Powers technique that still needs mastery reps', () => {
    const powers = {
      ...stalledLadder,
      levels: stalledLadder.levels.map(rung => ({ ...rung, label: `Technique ${rung.level}` })),
    };
    const out = stalledProgressions(null, powers, {}, {});
    expect(out).toEqual([expect.objectContaining({
      drillType: 'powers',
      label: 'Powers',
      remaining: 8,
      nextLabel: 'Technique 2',
    })]);
  });

  it('includes cognitive ladders and a Morse Koch step once level is set', () => {
    const cog = { 'n-back': { level: 0, atHardest: false, currentMastered: false, thresholds: { minSamples: 3 }, levels: [
      { level: 0, label: '1-back @ 2500ms', samples: 1, mastered: false },
      { level: 1, label: '2-back @ 2500ms', samples: 0, mastered: false },
    ] } };
    const out = stalledProgressions(null, null, cog, { kochLevel: 5, kochLevelSet: true, maxKochLevel: 41 });
    const nback = out.find(o => o.drillType === 'n-back');
    expect(nback.remaining).toBe(2); // 3 - 1
    const morse = out.find(o => o.drillType === 'morse-copy');
    expect(morse.deepLink).toBe('/post/morse/copy');
    expect(morse.nextLabel).toBe('Koch level 6');
  });

  it('does not surface Morse for a fresh install (level not set)', () => {
    const out = stalledProgressions(null, null, {}, { kochLevel: 2, kochLevelSet: false, maxKochLevel: 41 });
    expect(out.find(o => o.drillType === 'morse-copy')).toBeUndefined();
  });

  it('skips an untouched ladder (fresh install: level 0, no samples, no floor)', () => {
    const fresh = { level: 0, floorLevel: 0, atHardest: false, currentMastered: false, thresholds: { minSamples: 12 }, levels: [
      { level: 0, label: '1×1-digit', samples: 0, mastered: false },
      { level: 1, label: '1×2-digit', samples: 0, mastered: false },
    ] };
    expect(stalledProgressions(fresh, null, { 'n-back': fresh }, {})).toHaveLength(0);
  });

  it('surfaces a ladder once the user has earned a higher floor even with no windowed samples', () => {
    const earned = { level: 1, floorLevel: 1, atHardest: false, currentMastered: false, thresholds: { minSamples: 12 }, levels: [
      { level: 0, label: '1×1-digit', samples: 0, mastered: true },
      { level: 1, label: '1×2-digit', samples: 0, mastered: false },
      { level: 2, label: '1×1×1-digit', samples: 0, mastered: false },
    ] };
    const out = stalledProgressions(earned, null, {}, {});
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

describe('isRecDrillRunnable topic/standalone gating (issue #3252)', () => {
  it('a disabled TOPIC blocks its drills even when the module is allowed', () => {
    const config = { sessionModules: ['cognitive'], topics: { cognitive: { enabled: false } } };
    expect(isRecDrillRunnable(config, 'cognitive', 'n-back')).toBe(false);
  });

  it('topic granularity splits the three llm-drills topics apart', () => {
    // wordplay / verbal / imagination all collapse into `llm-drills`, so only a
    // topic-level gate can express "wordplay only".
    const config = { sessionModules: ['llm-drills'], topics: { verbal: { enabled: false }, imagination: { enabled: false } } };
    expect(isRecDrillRunnable(config, 'llm-drills', 'bridge-word')).toBe(true);
    expect(isRecDrillRunnable(config, 'llm-drills', 'wit-comeback')).toBe(false);
    expect(isRecDrillRunnable(config, 'llm-drills', 'what-if')).toBe(false);
  });

  it('morse is gated by its own block, never by sessionModules (it is not a POST module)', () => {
    expect(isRecDrillRunnable({ sessionModules: ['mental-math'] }, 'morse', 'morse-copy')).toBe(true);
    expect(isRecDrillRunnable({ morse: { enabled: false } }, 'morse', 'morse-copy')).toBe(false);
    expect(isRecDrillRunnable({ topics: { morse: { enabled: false } } }, 'morse', 'morse-copy')).toBe(false);
  });

  it('memory honors the module block, the drill type, and the per-ITEM toggle', () => {
    expect(isRecDrillRunnable({ memory: { enabled: false } }, 'memory', 'memory-sequence')).toBe(false);
    expect(isRecDrillRunnable({ memory: { drillTypes: { 'memory-sequence': { enabled: false } } } }, 'memory', 'memory-sequence')).toBe(false);
    const perItem = { memory: { items: { 'elements-song': { enabled: false } } } };
    expect(isRecDrillRunnable(perItem, 'memory', 'memory-sequence', 'elements-song')).toBe(false);
    expect(isRecDrillRunnable(perItem, 'memory', 'memory-sequence', 'raven')).toBe(true);
    // No item id supplied → nothing to filter on.
    expect(isRecDrillRunnable(perItem, 'memory', 'memory-sequence')).toBe(true);
  });

  it('a legacy config with no topics/memory/morse keys runs everything (no migration)', () => {
    const legacy = { sessionModules: ['mental-math', 'cognitive', 'llm-drills', 'memory'] };
    expect(isRecDrillRunnable(legacy, 'memory', 'memory-sequence', 'elements-song')).toBe(true);
    expect(isRecDrillRunnable(legacy, 'morse', 'morse-copy')).toBe(true);
    expect(isRecDrillRunnable(legacy, 'llm-drills', 'wit-comeback')).toBe(true);
    expect(isRecDrillRunnable(legacy, 'cognitive', 'n-back')).toBe(true);
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

describe('getPostRecommendations topic/item filtering (issue #3252)', () => {
  const dueItem = (id, title) => ({
    id, title, type: 'song', content: { chunks: [] },
    schedule: { ease: 2.5, intervalDays: 1, nextReview: new Date(Date.now() - 86400000).toISOString() },
    mastery: { overallPct: 40, chunks: {} },
  });

  it('drops a due memory item the user switched off, keeping its siblings', async () => {
    state.memoryItems = [dueItem('elements-song', 'The Elements'), dueItem('raven', 'The Raven')];
    state.config = { memory: { items: { 'elements-song': { enabled: false } } } };

    const { recommendations } = await getPostRecommendations();
    const dueIds = recommendations.filter(r => r.kind === 'memory-due').map(r => r.id);
    expect(dueIds).toContain('memory-due:raven');
    expect(dueIds).not.toContain('memory-due:elements-song');
  });

  it('a disabled memory TOPIC drops every due item', async () => {
    state.memoryItems = [dueItem('elements-song', 'The Elements'), dueItem('raven', 'The Raven')];
    state.config = { topics: { memory: { enabled: false } } };

    const { recommendations } = await getPostRecommendations();
    expect(recommendations.some(r => r.kind === 'memory-due')).toBe(false);
  });

  it('keeps every due item under a legacy config with no memory block', async () => {
    state.memoryItems = [dueItem('elements-song', 'The Elements'), dueItem('raven', 'The Raven')];
    state.config = {};

    const { recommendations } = await getPostRecommendations();
    const dueIds = recommendations.filter(r => r.kind === 'memory-due').map(r => r.id);
    expect(dueIds).toEqual(expect.arrayContaining(['memory-due:elements-song', 'memory-due:raven']));
  });

  // Regression: the due-item filter used to probe isRecDrillRunnable with a
  // hardcoded 'memory-sequence', so switching off that ONE practice mode blanked
  // the entire spaced-repetition feed — including items whose recs deep-link to
  // `spaced` / `element-flash` and never run memory-sequence at all.
  it('keeps due items when a single memory DRILL TYPE is switched off', async () => {
    state.memoryItems = [dueItem('elements-song', 'The Elements'), dueItem('raven', 'The Raven')];
    state.config = { memory: { drillTypes: { 'memory-sequence': { enabled: false } } } };

    const { recommendations } = await getPostRecommendations();
    const dueIds = recommendations.filter(r => r.kind === 'memory-due').map(r => r.id);
    expect(dueIds).toEqual(expect.arrayContaining(['memory-due:elements-song', 'memory-due:raven']));
  });

  it('drops every due item when the memory MODULE is switched off', async () => {
    state.memoryItems = [dueItem('elements-song', 'The Elements'), dueItem('raven', 'The Raven')];
    state.config = { memory: { enabled: false } };

    const { recommendations } = await getPostRecommendations();
    expect(recommendations.some(r => r.kind === 'memory-due')).toBe(false);
  });

  // Due re-verifications are config-dependent recs like weakest-skill and
  // stalled-progression, so they get the same gate — they used to pass through
  // ungated, surfacing "Re-verify N-Back" for a topic the user had switched off
  // while the stalled rec for that same ladder was correctly dropped.
  it('drops a ladder re-verification whose topic is switched off', async () => {
    state.reviewSchedule = {
      skills: {
        'n-back:L2': {
          skillId: 'n-back:L2', kind: 'cognitive', drillType: 'n-back', label: 'N-Back level 2',
          nextReview: new Date(Date.now() - 86400000).toISOString(), status: 'due',
        },
      },
    };
    state.config = {};
    const before = await getPostRecommendations();
    expect(before.recommendations.some(r => r.kind === 'skill-review')).toBe(true);

    state.config = { topics: { cognitive: { enabled: false } } };
    const after = await getPostRecommendations();
    expect(after.recommendations.some(r => r.kind === 'skill-review')).toBe(false);
  });

  it('suppresses the morse-copy stalled rec when Morse is switched off', async () => {
    // Mid-Koch progression: the stalled-progression rec fires for a user who has
    // engaged with Morse and isn't at the final level.
    state.morse = { kochLevel: 5, kochLevelSet: true, settings: null, rounds: [] };
    state.config = {};
    const before = await getPostRecommendations();
    expect(before.recommendations.some(r => r.drillType === 'morse-copy')).toBe(true);

    state.config = { morse: { enabled: false } };
    const after = await getPostRecommendations();
    expect(after.recommendations.some(r => r.drillType === 'morse-copy')).toBe(false);
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
    expect(recs[0].deepLink).toBe('/post/memory/song/spaced');
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

  it('routes a memory-chunk re-verification into a practice mode, not the launcher', () => {
    const recs = composePostRecommendations({
      dueReviews: [{ skillId: 'memory:song:c1', label: 'Elements — Chorus', kind: 'memory', status: 'due' }],
      hasHistory: true,
    });
    expect(recs[0].kind).toBe('skill-review');
    expect(recs[0].deepLink).toBe('/post/memory/song/spaced');
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
    // The built-in Elements Song is seeded (and also due), so address this
    // item's rec by id rather than assuming it sorts first.
    const songRec = recommendations.find(r => r.id === 'memory-due:song');
    expect(songRec.deepLink).toBe('/post/memory/song/spaced');
    // Every due-memory rec lands INSIDE a practice mode, not on the item list.
    for (const rec of recommendations.filter(r => r.kind === 'memory-due')) {
      expect(rec.deepLink).not.toBe('/post/memory');
      expect(rec.deepLink.split('/').length).toBeGreaterThan(3);
    }
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

// An "Up next" rec should START the practice, not open a page the user still
// has to navigate — memory recs used to point at the bare item list, which cost
// 4 clicks to reach an actual drill (issue #3249).
describe('memoryPracticeDeepLink', () => {
  it('routes the built-in Elements Song to its own recall test', () => {
    expect(memoryPracticeDeepLink('elements-song')).toBe('/post/memory/elements/element-flash');
  });

  it('routes any other item to spaced repetition, which targets its weakest chunks', () => {
    expect(memoryPracticeDeepLink('raven')).toBe('/post/memory/raven/spaced');
  });

  it('degrades to the item list when there is no id to route to', () => {
    expect(memoryPracticeDeepLink(null)).toBe('/post/memory');
    expect(memoryPracticeDeepLink(undefined)).toBe('/post/memory');
    expect(memoryPracticeDeepLink('')).toBe('/post/memory');
  });
});

describe('memoryItemIdFromReview', () => {
  it('prefers the explicit memoryItemId field', () => {
    expect(memoryItemIdFromReview({ memoryItemId: 'raven', skillId: 'memory:other:c1' })).toBe('raven');
  });

  it('falls back to parsing the memory:<itemId>:<chunkId> skillId', () => {
    expect(memoryItemIdFromReview({ skillId: 'memory:raven:v1' })).toBe('raven');
  });

  it('splits on the LAST colon so an item id containing one still resolves', () => {
    expect(memoryItemIdFromReview({ skillId: 'memory:poe:raven:v1' })).toBe('poe:raven');
  });

  it('returns null for a non-memory or unparseable entry', () => {
    expect(memoryItemIdFromReview({ skillId: 'multiplication:L1' })).toBeNull();
    expect(memoryItemIdFromReview({ skillId: 'memory:' })).toBeNull();
    expect(memoryItemIdFromReview({})).toBeNull();
    expect(memoryItemIdFromReview(null)).toBeNull();
  });
});
