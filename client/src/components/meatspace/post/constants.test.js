import { describe, it, expect } from 'vitest';
import {
  computeDomainAverages, domainLabel, computeGoalProgress, hasGoals,
  POST_TOPICS, DOMAINS, DRILL_TO_DOMAIN, composedSessionDrillTypes,
  isTopicEnabled, isMemoryItemEnabled, resolveTopicForDrillType,
} from './constants';

describe('domainLabel', () => {
  it('maps known domain keys to their human label', () => {
    expect(domainLabel('math')).toBe('Mental Math');
    expect(domainLabel('verbal')).toBe('Verbal Agility');
  });

  it('labels the catch-all bucket "Other"', () => {
    expect(domainLabel('other')).toBe('Other');
  });

  it('falls back to the raw key for unknown domains', () => {
    expect(domainLabel('mystery')).toBe('mystery');
  });
});

describe('computeDomainAverages', () => {
  it('derives the domain from the drill TYPE, not the coarse module segment', () => {
    // pun-wordplay lives under the `wordplay` domain even though its coarse
    // module is `llm-drills`; multiplication is `math`.
    const result = computeDomainAverages({
      'mental-math:multiplication': 90,
      'llm-drills:pun-wordplay': 60,
    });
    const byKey = Object.fromEntries(result.map(d => [d.key, d]));
    expect(byKey.math.score).toBe(90);
    expect(byKey.math.label).toBe('Mental Math');
    expect(byKey.wordplay.score).toBe(60);
    expect(byKey.wordplay.label).toBe('Wordplay');
  });

  it('averages multiple drills within the same domain (rounded)', () => {
    // pun-wordplay + word-association are both `wordplay`: mean(60, 71) = 65.5 → 66
    const result = computeDomainAverages({
      'llm-drills:pun-wordplay': 60,
      'llm-drills:word-association': 71,
    });
    expect(result).toEqual([{ key: 'wordplay', label: 'Wordplay', score: 66 }]);
  });

  it('sorts strongest domain first', () => {
    const result = computeDomainAverages({
      'mental-math:multiplication': 40,
      'llm-drills:pun-wordplay': 90,
      'llm-drills:story-recall': 70,
    });
    expect(result.map(d => d.key)).toEqual(['wordplay', 'verbal', 'math']);
  });

  it('buckets unmapped drill types under "other"', () => {
    const result = computeDomainAverages({ 'legacy:removed-drill': 50 });
    expect(result).toEqual([{ key: 'other', label: 'Other', score: 50 }]);
  });

  it('returns an empty list for empty stats', () => {
    expect(computeDomainAverages({})).toEqual([]);
    expect(computeDomainAverages()).toEqual([]);
  });
});

describe('hasGoals (issue #2100)', () => {
  it('is false for absent/empty/legacy goals', () => {
    expect(hasGoals(undefined)).toBe(false);
    expect(hasGoals(null)).toBe(false);
    expect(hasGoals({})).toBe(false);
    expect(hasGoals({ dailyMinutes: 0 })).toBe(false);
  });

  it('is true once any positive target is set', () => {
    expect(hasGoals({ streakTarget: 10 })).toBe(true);
  });
});

describe('computeGoalProgress (issue #2100)', () => {
  it('reports progress for each set goal whose metric is known', () => {
    const rows = computeGoalProgress(
      { dailyMinutes: 20, weeklySessions: 5, streakTarget: 10 },
      { todayMinutes: 14, weekSessions: 5, currentStreak: 6 },
    );
    const byKey = Object.fromEntries(rows.map(r => [r.key, r]));
    expect(byKey.dailyMinutes.pct).toBe(70);
    expect(byKey.dailyMinutes.met).toBe(false);
    expect(byKey.weeklySessions.met).toBe(true);
    expect(byKey.weeklySessions.pct).toBe(100);
    expect(byKey.streakTarget.current).toBe(6);
  });

  it('skips goals whose metric is unavailable (e.g. Morse WPM with no data)', () => {
    const rows = computeGoalProgress(
      { morseWpmTarget: 15, streakTarget: 5 },
      { currentStreak: 3 }, // no morseWpm
    );
    expect(rows.map(r => r.key)).toEqual(['streakTarget']);
  });

  it('clamps pct to 100 when the target is exceeded', () => {
    const rows = computeGoalProgress({ streakTarget: 5 }, { currentStreak: 12 });
    expect(rows[0].pct).toBe(100);
    expect(rows[0].met).toBe(true);
  });

  it('returns no rows for absent goals', () => {
    expect(computeGoalProgress({}, { currentStreak: 5 })).toEqual([]);
    expect(computeGoalProgress(undefined, {})).toEqual([]);
  });
});

// Practice-topic registry (issue #3252). DOMAINS is now DERIVED from POST_TOPICS
// rather than hand-maintained, so these lock in that the derivation reproduces
// exactly what the launcher has always composed from.
describe('POST_TOPICS → DOMAINS derivation (issue #3252)', () => {
  it('derives exactly the six scored domains, in order — Morse is not a domain', () => {
    expect(Object.keys(DOMAINS)).toEqual(['math', 'memory', 'wordplay', 'verbal', 'imagination', 'cognitive']);
    expect(DOMAINS.morse).toBeUndefined();
  });

  it('keeps each domain\'s presentation fields', () => {
    for (const [key, domain] of Object.entries(DOMAINS)) {
      expect(domain.label, key).toBeTruthy();
      expect(domain.icon, key).toBeTruthy();
      expect(domain.color, key).toMatch(/^text-/);
      expect(domain.timeBudgetSec, key).toBeGreaterThan(0);
    }
  });

  it('excludes drill types the session picker cannot run', () => {
    // memory-fill-blank belongs to the memory TOPIC (it has a config block) but
    // is not offered by the session picker — DOMAINS must not gain it.
    expect(POST_TOPICS.find(t => t.id === 'memory').drillTypes).toContain('memory-fill-blank');
    expect(DOMAINS.memory.drillTypes).toEqual(['memory-sequence', 'memory-element-flash']);
    expect(DRILL_TO_DOMAIN['memory-fill-blank']).toBeUndefined();
  });

  it('maps every domain drill type back to its domain', () => {
    for (const [key, domain] of Object.entries(DOMAINS)) {
      for (const type of domain.drillTypes) expect(DRILL_TO_DOMAIN[type]).toBe(key);
    }
  });
});

describe('composedSessionDrillTypes (issue #3252)', () => {
  const config = {
    mentalMath: { enabled: true, drillTypes: { multiplication: { enabled: true }, powers: { enabled: false } } },
    llmDrills: { enabled: true, drillTypes: { 'pun-wordplay': { enabled: true }, 'wit-comeback': {} } },
    cognitive: { enabled: true, drillTypes: { 'n-back': { enabled: true } } },
  };

  it('groups the drills a composed session would run, by topic', () => {
    expect(composedSessionDrillTypes(config)).toEqual({
      math: ['multiplication'],
      // `wit-comeback` has no `enabled` field — LLM drills are opt-OUT, so it runs.
      wordplay: ['pun-wordplay'],
      verbal: ['wit-comeback'],
      cognitive: ['n-back'],
    });
  });

  it('math drills are opt-IN: an entry with no `enabled` field does not run', () => {
    const out = composedSessionDrillTypes({ mentalMath: { drillTypes: { multiplication: {} } } });
    expect(out.math).toBeUndefined();
  });

  it('drops a topic the user switched off, keeping its module siblings', () => {
    const out = composedSessionDrillTypes({ ...config, topics: { verbal: { enabled: false } } });
    expect(out.wordplay).toEqual(['pun-wordplay']);
    expect(out.verbal).toBeUndefined();
  });

  it('still honors the coarse sessionModules filter', () => {
    const out = composedSessionDrillTypes({ ...config, sessionModules: ['mental-math'] });
    expect(Object.keys(out)).toEqual(['math']);
  });

  it('includes session-enabled memory but never standalone Morse', () => {
    const out = composedSessionDrillTypes({
      ...config,
      memory: { enabled: true, drillTypes: { 'memory-sequence': { enabled: true } } },
      morse: { enabled: true },
    });
    expect(out.memory).toEqual(['memory-sequence']);
    expect(out.morse).toBeUndefined();
  });

  it('previews only memory drills runnable with the enabled item pool', () => {
    const memoryConfig = {
      memory: {
        enabled: true,
        drillTypes: {
          'memory-fill-blank': { enabled: true },
          'memory-sequence': { enabled: true },
          'memory-element-flash': { enabled: true },
        },
        items: { 'elements-song': { enabled: false } },
      },
    };

    expect(composedSessionDrillTypes(memoryConfig, [
      { id: 'elements-song', content: { lines: [{ text: 'Hydrogen' }, { text: 'Helium' }] } },
      { id: 'example-memory', content: { lines: [{ text: 'First' }, { text: 'Second' }] } },
    ])).toEqual({ memory: ['memory-sequence'] });
    expect(composedSessionDrillTypes(memoryConfig, [])).toEqual({});
  });

  it('omits Sequence Recall when enabled items have fewer than two usable lines', () => {
    const config = {
      memory: { enabled: true, drillTypes: { 'memory-sequence': { enabled: true } } },
    };
    expect(composedSessionDrillTypes(config, [
      { id: 'one-line', content: { lines: [{ text: 'Only line' }] } },
    ])).toEqual({});
  });
});

describe('isTopicEnabled / isMemoryItemEnabled client mirrors', () => {
  it('absent = enabled, so a legacy config runs everything', () => {
    expect(isTopicEnabled({}, 'wordplay')).toBe(true);
    expect(isMemoryItemEnabled({}, 'elements-song')).toBe(true);
  });

  it('only an explicit false disables', () => {
    expect(isTopicEnabled({ topics: { wordplay: { enabled: false } } }, 'wordplay')).toBe(false);
    expect(isMemoryItemEnabled({ memory: { items: { 'elements-song': { enabled: false } } } }, 'elements-song')).toBe(false);
  });

  it('a disabled memory topic disables every item under it', () => {
    expect(isMemoryItemEnabled({ topics: { memory: { enabled: false } } }, 'raven')).toBe(false);
  });
});

describe('resolveTopicForDrillType client mirror', () => {
  it('splits the llm-drills module into its three topics', () => {
    expect(resolveTopicForDrillType('bridge-word').id).toBe('wordplay');
    expect(resolveTopicForDrillType('story-recall').id).toBe('verbal');
    expect(resolveTopicForDrillType('reframe').id).toBe('imagination');
  });

  it('returns null for an unmapped type', () => {
    expect(resolveTopicForDrillType('nope')).toBeNull();
  });
});
