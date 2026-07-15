import { describe, it, expect } from 'vitest';
import {
  extractTaskType,
  calculateDurationETA,
  classifyUntypedTask,
  isSandboxedTaskType,
  summarizeFailureSignatures,
  appendInsight,
  buildRecurrenceInsight,
  recurrenceMilestoneReached,
  RECURRENCE_INSIGHT_MILESTONES,
  INSIGHT_CAP,
  EXTERNAL_UNTYPED_TASK_TYPE,
  appendRecentOutcome,
  computeWindowedStats,
  computeEffectiveSuccessRate,
  isSkipCandidate,
  EFFECTIVE_RATE_MIN_WINDOW_SAMPLES,
  RECENT_OUTCOMES_CAP,
  DEFAULT_WINDOW_MAX_COUNT
} from './store.js';

// These two helpers are the pure foundation every other taskLearning submodule
// builds on (duration math + task-type classification). They take no I/O, so we
// exercise every branch arm directly without mocking the persistence layer.

describe('store.extractTaskType', () => {
  it('prefers metadata.analysisType (self-improve) over everything else', () => {
    expect(extractTaskType({ metadata: { analysisType: 'ui-bugs' } })).toBe('self-improve:ui-bugs');
  });

  it('accepts the forwarded taskAnalysisType alias', () => {
    expect(extractTaskType({ metadata: { taskAnalysisType: 'console' } })).toBe('self-improve:console');
  });

  it('maps an idle reviewType to idle-review', () => {
    expect(extractTaskType({ metadata: { reviewType: 'idle' } })).toBe('idle-review');
    expect(extractTaskType({ metadata: { taskReviewType: 'idle' } })).toBe('idle-review');
  });

  it('does not treat a non-idle reviewType as idle-review', () => {
    // falls through to the sandboxed fallback since nothing else matches (#2333)
    expect(extractTaskType({ metadata: { reviewType: 'manual' } })).toBe(EXTERNAL_UNTYPED_TASK_TYPE);
  });

  it('classifies mission tasks by mission name', () => {
    expect(extractTaskType({ metadata: { missionName: 'cleanup' } })).toBe('mission:cleanup');
  });

  it('classifies app-improvement tasks only when both taskApp and selfImprovementType present', () => {
    expect(extractTaskType({ metadata: { taskApp: 'foo', selfImprovementType: 'perf' } })).toBe('app-improve:perf');
    // taskApp with a selfImprovementType but no taskApp-pairing is caught by the
    // classifier as a self-improve domain (#2333)
    expect(extractTaskType({ metadata: { selfImprovementType: 'perf' } })).toBe('self-improve:perf');
  });

  it('parses a [self-improvement] description tag with a type token', () => {
    expect(extractTaskType({ description: '[self-improvement] accessibility - fix labels' }))
      .toBe('self-improve:accessibility');
  });

  it('falls back to self-improve:general when the tag has no type token', () => {
    expect(extractTaskType({ description: '[self-improvement] !!!' })).toBe('self-improve:general');
  });

  it('matches description tags case-insensitively', () => {
    expect(extractTaskType({ description: '[IDLE REVIEW] poke around' })).toBe('idle-review');
  });

  it('recognizes the auto-fix description variants', () => {
    expect(extractTaskType({ description: '[auto-fix] retry' })).toBe('auto-fix');
    expect(extractTaskType({ description: '[auto] investigate the crash' })).toBe('auto-fix');
  });

  it('recognizes both app-improvement spellings in the description', () => {
    expect(extractTaskType({ description: '[app-improvement] thing' })).toBe('app-improvement');
    expect(extractTaskType({ description: '[app improvement] thing' })).toBe('app-improvement');
  });

  it('classifies user and internal tasks by taskType when no pattern matches', () => {
    expect(extractTaskType({ taskType: 'user', description: 'do a thing' })).toBe('user-task');
    expect(extractTaskType({ taskType: 'internal', description: 'do a thing' })).toBe('internal-task');
  });

  it('returns the sandboxed fallback (never the old unknown) for an empty/undefined task', () => {
    expect(extractTaskType()).toBe(EXTERNAL_UNTYPED_TASK_TYPE);
    expect(extractTaskType({})).toBe(EXTERNAL_UNTYPED_TASK_TYPE);
    // regression guard: the blind 'unknown' sink is gone
    expect(extractTaskType({})).not.toBe('unknown');
  });
});

describe('store.classifyUntypedTask (issue #2333)', () => {
  it('infers a self-improve domain from a bare selfImprovementType hint', () => {
    expect(classifyUntypedTask({ metadata: { selfImprovementType: 'Perf Tuning' } }))
      .toBe('self-improve:perf-tuning');
  });

  it('maps an allow-listed explicit task.taskType the primary extractor did not special-case', () => {
    // Previously these all collapsed to 'unknown'
    expect(classifyUntypedTask({ taskType: 'scheduled' })).toBe('scheduled-task');
    expect(classifyUntypedTask({ taskType: 'architect' })).toBe('architect-task');
    // an already-namespaced type keeps its colon rather than getting a -task suffix
    expect(classifyUntypedTask({ taskType: 'self-improve:ui' })).toBe('self-improve:ui');
  });

  it('does not spawn a non-sandboxed bucket for an unexpected/high-cardinality taskType', () => {
    // Not allow-listed and not namespaced → falls through to the sandboxed fallback
    // rather than a routing-influencing `whatever-task` bucket.
    expect(classifyUntypedTask({ taskType: 'whatever-9f3a2b' })).toBe(EXTERNAL_UNTYPED_TASK_TYPE);
  });

  it('is round-trip stable: re-classifying the sandboxed fallback preserves the sandboxed bucket', () => {
    // Feeding external/untyped back through must NOT slug the `/` into a
    // non-sandboxed `external-untyped-task`.
    const rt = classifyUntypedTask({ taskType: EXTERNAL_UNTYPED_TASK_TYPE });
    expect(rt).toBe(EXTERNAL_UNTYPED_TASK_TYPE);
    expect(isSandboxedTaskType(rt)).toBe(true);
  });

  it('classifies free-form descriptions by keyword when no type token is present', () => {
    expect(classifyUntypedTask({ description: 'Investigate the crash in the pipeline' })).toBe('auto-fix');
    expect(classifyUntypedTask({ description: 'Refactor and clean up the store module' })).toBe('self-improve:general');
    expect(classifyUntypedTask({ description: 'Audit the routing accuracy code' })).toBe('idle-review');
    expect(classifyUntypedTask({ description: 'Add unit test coverage for the parser' })).toBe('test-task');
  });

  it('reads a description from metadata.taskDescription when top-level description is absent', () => {
    expect(classifyUntypedTask({ metadata: { taskDescription: 'fix the broken build' } })).toBe('auto-fix');
  });

  it('does not false-positive on a substring of a trigger word', () => {
    // "testing" / "fixture" must not trip the \b-anchored keyword rules
    expect(classifyUntypedTask({ description: 'contesting the fixtures inventory' }))
      .toBe(EXTERNAL_UNTYPED_TASK_TYPE);
  });

  it('falls back to external/untyped (a sandboxed type) when nothing matches', () => {
    const t = classifyUntypedTask({ description: 'ship the quarterly widgets' });
    expect(t).toBe(EXTERNAL_UNTYPED_TASK_TYPE);
    expect(isSandboxedTaskType(t)).toBe(true);
    expect(classifyUntypedTask(null)).toBe(EXTERNAL_UNTYPED_TASK_TYPE);
    expect(classifyUntypedTask('nope')).toBe(EXTERNAL_UNTYPED_TASK_TYPE);
  });

  it('is idempotent: same input always yields the same output', () => {
    const inputs = [
      { description: 'Investigate the crash' },
      { taskType: 'scheduled' },
      { metadata: { selfImprovementType: 'perf' } },
      {}
    ];
    for (const input of inputs) {
      const first = classifyUntypedTask(input);
      expect(classifyUntypedTask(input)).toBe(first);
      // re-classifying its own output-shaped task is stable (no drift)
      expect(classifyUntypedTask({ taskType: first })).toBe(classifyUntypedTask({ taskType: first }));
    }
  });

  it('marks the fallback bucket and the legacy unknown sink as sandboxed', () => {
    expect(isSandboxedTaskType(EXTERNAL_UNTYPED_TASK_TYPE)).toBe(true);
    // legacy 'unknown' buckets (older installs / not-yet-migrated spawn key) get
    // the same routing wall so stale uncategorized data can't drive routing
    expect(isSandboxedTaskType('unknown')).toBe(true);
    expect(isSandboxedTaskType('auto-fix')).toBe(false);
  });
});

describe('store.calculateDurationETA', () => {
  it('uses success-only stats when successDurationMs is present', () => {
    const out = calculateDurationETA({
      successDurationMs: 600000, succeeded: 6, successMaxDurationMs: 200000,
      totalDurationMs: 9999999, completed: 99,
    });
    expect(out.avgDurationMs).toBe(100000); // 600000 / 6
    expect(out.maxDurationMs).toBe(200000);
    // p80 = round(min(avg*3, avg + 0.6*(max-avg))) = round(min(300000, 160000)) = 160000
    expect(out.p80DurationMs).toBe(160000);
  });

  it('falls back to total stats when there is no success data', () => {
    const out = calculateDurationETA({
      successDurationMs: 0, succeeded: 0,
      totalDurationMs: 400000, completed: 4,
    });
    expect(out.avgDurationMs).toBe(100000); // 400000 / 4
    // no success data → max defaults to avg, so p80 collapses to avg
    expect(out.maxDurationMs).toBe(100000);
    expect(out.p80DurationMs).toBe(100000);
  });

  it('returns all-zero stats when the count base is zero or missing', () => {
    expect(calculateDurationETA({ totalDurationMs: 100, completed: 0 }))
      .toEqual({ avgDurationMs: 0, maxDurationMs: 0, p80DurationMs: 0 });
    expect(calculateDurationETA({}))
      .toEqual({ avgDurationMs: 0, maxDurationMs: 0, p80DurationMs: 0 });
  });

  it('clamps p80 to at most avg*3 when the spread is very wide', () => {
    const out = calculateDurationETA({
      successDurationMs: 100000, succeeded: 1, successMaxDurationMs: 10000000,
    });
    expect(out.avgDurationMs).toBe(100000);
    // avg + 0.6*(max-avg) would be huge; the avg*3 cap wins → 300000
    expect(out.p80DurationMs).toBe(300000);
  });
});

describe('store.summarizeFailureSignatures (issue #2333)', () => {
  const sample = (over = {}) => ({
    messageSnippet: 'boom', failurePosition: 'mid', provider: 'claude', model: 'opus',
    modelTier: 'heavy', taskType: 'auto-fix', validationPassed: null, recordedAt: '2026-07-09T00:00:00Z',
    ...over
  });

  it('returns [] for a missing / non-object map', () => {
    expect(summarizeFailureSignatures(undefined)).toEqual([]);
    expect(summarizeFailureSignatures(null)).toEqual([]);
    expect(summarizeFailureSignatures('nope')).toEqual([]);
  });

  it('attributes provider/model and counts validation misses across recent samples', () => {
    const out = summarizeFailureSignatures({
      'tool-error': {
        count: 5, lastOccurred: '2026-07-09T01:00:00Z',
        recent: [
          sample({ provider: 'claude', model: 'opus', validationPassed: false }),
          sample({ provider: 'claude', model: 'opus', validationPassed: true }),
          sample({ provider: 'codex', model: 'gpt', validationPassed: false, messageSnippet: 'latest' })
        ]
      }
    });
    expect(out).toHaveLength(1);
    const sig = out[0];
    expect(sig.category).toBe('tool-error');
    expect(sig.count).toBe(5); // lifetime count preferred in the global view
    expect(sig.samples).toBe(3);
    expect(sig.validationMissed).toBe(2);
    // claude/opus is the dominant attribution (2 of 3)
    expect(sig.providers[0]).toEqual({ key: 'claude/opus', count: 2 });
    expect(sig.sampleSnippet).toBe('latest'); // most-recent sample wins
  });

  it('filters to a task type and drops categories with no matching sample', () => {
    const out = summarizeFailureSignatures({
      'tool-error': {
        count: 9,
        recent: [sample({ taskType: 'auto-fix' }), sample({ taskType: 'idle-review' })]
      },
      'rate-limit': {
        count: 4,
        recent: [sample({ taskType: 'idle-review' })]
      }
    }, { taskType: 'auto-fix' });
    expect(out).toHaveLength(1);
    expect(out[0].category).toBe('tool-error');
    expect(out[0].count).toBe(1);   // per-type view counts only matched samples
    expect(out[0].samples).toBe(1);
  });

  it('falls back to modelTier attribution when provider is absent, and ranks by count desc', () => {
    const out = summarizeFailureSignatures({
      a: { count: 1, recent: [sample({ provider: null, model: null, modelTier: 'light' })] },
      b: { count: 3, recent: [sample(), sample(), sample()] }
    });
    expect(out.map(s => s.category)).toEqual(['b', 'a']); // b (3) before a (1)
    expect(out[1].providers[0]).toEqual({ key: 'light', count: 1 });
  });

  it('respects the limit', () => {
    const map = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [`c${i}`, { count: i + 1, recent: [sample()] }])
    );
    expect(summarizeFailureSignatures(map, { limit: 3 })).toHaveLength(3);
  });
});

// -----------------------------------------------------------------------------
// Human-readable insights (issue #2443) — pure helpers exercised without I/O.
// -----------------------------------------------------------------------------

describe('store.recurrenceMilestoneReached', () => {
  it('fires exactly on the configured ascending milestones', () => {
    for (const m of RECURRENCE_INSIGHT_MILESTONES) {
      expect(recurrenceMilestoneReached(m)).toBe(true);
    }
  });

  it('does not fire on off-milestone counts (idempotency: one insight per milestone)', () => {
    expect(recurrenceMilestoneReached(1)).toBe(false);
    expect(recurrenceMilestoneReached(2)).toBe(false);
    expect(recurrenceMilestoneReached(4)).toBe(false);
    expect(recurrenceMilestoneReached(11)).toBe(false);
    expect(recurrenceMilestoneReached(0)).toBe(false);
  });
});

describe('store.appendInsight', () => {
  it('stamps recordedAt and defaults origin to user', () => {
    const data = {};
    appendInsight(data, { type: 'observation', message: 'hello' });
    expect(data.insights).toHaveLength(1);
    expect(data.insights[0].origin).toBe('user');
    expect(data.insights[0].message).toBe('hello');
    expect(typeof data.insights[0].recordedAt).toBe('string');
  });

  it('preserves an explicit origin (auto-incident) and overrides any passed recordedAt', () => {
    const data = { insights: [] };
    appendInsight(data, { origin: 'auto-incident', message: 'auto', recordedAt: 'stale' });
    expect(data.insights[0].origin).toBe('auto-incident');
    expect(data.insights[0].recordedAt).not.toBe('stale');
  });

  it('caps retained insights at INSIGHT_CAP (oldest pruned first)', () => {
    const data = { insights: [] };
    for (let i = 0; i < INSIGHT_CAP + 5; i++) {
      appendInsight(data, { message: `m${i}` });
    }
    expect(data.insights).toHaveLength(INSIGHT_CAP);
    // Oldest five pruned — newest retained.
    expect(data.insights[0].message).toBe('m5');
    expect(data.insights[INSIGHT_CAP - 1].message).toBe(`m${INSIGHT_CAP + 4}`);
  });

  it('initializes a missing/non-array insights field', () => {
    const data = { insights: 'corrupt' };
    appendInsight(data, { message: 'x' });
    expect(Array.isArray(data.insights)).toBe(true);
    expect(data.insights).toHaveLength(1);
  });
});

describe('store.buildRecurrenceInsight', () => {
  const failureSignatures = {
    timeout: {
      count: 3,
      recent: [
        { taskType: 'self-improve:ui', provider: 'claude', model: 'opus', modelTier: 'heavy', recordedAt: '2026-07-10T00:00:00.000Z' },
        { taskType: 'self-improve:ui', provider: 'claude', model: 'opus', modelTier: 'heavy', recordedAt: '2026-07-10T00:01:00.000Z' },
        { taskType: 'self-improve:ui', provider: 'codex', model: 'gpt', modelTier: 'heavy', recordedAt: '2026-07-10T00:02:00.000Z' }
      ]
    }
  };

  it('produces a provenance-stamped, auto-incident insight with provider attribution', () => {
    const insight = buildRecurrenceInsight({
      category: 'timeout',
      count: 3,
      taskType: 'self-improve:ui',
      agentId: 'agent-xyz',
      failureSignatures
    });
    expect(insight.origin).toBe('auto-incident');
    expect(insight.type).toBe('recurring-failure');
    expect(insight.category).toBe('timeout');
    expect(insight.taskType).toBe('self-improve:ui');
    expect(insight.recurrenceCount).toBe(3);
    expect(insight.originatingAgentId).toBe('agent-xyz');
    // Top provider by count (claude/opus appears twice).
    expect(insight.provider).toBe('claude/opus');
    expect(insight.message).toContain('"timeout"');
    expect(insight.message).toContain('3 times');
    expect(insight.message).toContain('claude/opus');
  });

  it('never echoes a raw error message (privacy) — message is built only from controlled fields', () => {
    const withRawMessage = {
      timeout: {
        count: 3,
        recent: [
          { taskType: 't', provider: 'claude', model: 'opus', messageSnippet: '/Users/secret/path leaked ENOENT', recordedAt: '2026-07-10T00:00:00.000Z' }
        ]
      }
    };
    const insight = buildRecurrenceInsight({ category: 'timeout', count: 3, taskType: 't', failureSignatures: withRawMessage });
    expect(insight.message).not.toContain('/Users/secret');
    expect(insight.message).not.toContain('leaked');
  });

  it('degrades gracefully when no provider attribution is available', () => {
    const insight = buildRecurrenceInsight({ category: 'unknown', count: 10, taskType: 't', failureSignatures: {} });
    expect(insight.provider).toBeNull();
    expect(insight.message).toContain('10 times');
    expect(insight.message).not.toContain('via');
  });
});

// ---------------------------------------------------------------------------
// Recent-outcomes ring (issue #2460) — pure ring append/cap + windowed-rate math.
// No I/O, so exercised directly without touching the real learning.json.
// ---------------------------------------------------------------------------

describe('store.appendRecentOutcome', () => {
  it('initializes the ring and stores the compact { t, s } shape', () => {
    const metrics = {};
    appendRecentOutcome(metrics, { success: true, at: '2026-07-10T00:00:00.000Z' });
    expect(metrics.recentOutcomes).toEqual([{ t: '2026-07-10T00:00:00.000Z', s: true }]);
  });

  it('coerces success to a boolean and defaults the timestamp when absent', () => {
    const metrics = { recentOutcomes: [] };
    appendRecentOutcome(metrics, { success: 0 });
    expect(metrics.recentOutcomes[0].s).toBe(false);
    expect(typeof metrics.recentOutcomes[0].t).toBe('string');
  });

  it('caps the ring at RECENT_OUTCOMES_CAP, dropping the oldest first', () => {
    const metrics = {};
    for (let i = 0; i < RECENT_OUTCOMES_CAP + 10; i++) {
      appendRecentOutcome(metrics, { success: true, at: `run-${i}` });
    }
    expect(metrics.recentOutcomes).toHaveLength(RECENT_OUTCOMES_CAP);
    // Oldest 10 dropped — first retained is run-10, last is the newest.
    expect(metrics.recentOutcomes[0].t).toBe('run-10');
    expect(metrics.recentOutcomes.at(-1).t).toBe(`run-${RECENT_OUTCOMES_CAP + 9}`);
  });

  it('is a no-op on a non-object metrics bucket', () => {
    expect(appendRecentOutcome(null, { success: true })).toBeNull();
  });
});

describe('store.computeWindowedStats', () => {
  const iso = (msAgo, now) => new Date(now - msAgo).toISOString();

  it('returns a null successRate sentinel (not 0) when the window is empty', () => {
    const stats = computeWindowedStats([]);
    expect(stats).toEqual({
      windowedCompleted: 0,
      windowedSucceeded: 0,
      windowedFailed: 0,
      windowedSuccessRate: null
    });
    // A missing/undefined ring behaves the same.
    expect(computeWindowedStats(undefined).windowedSuccessRate).toBeNull();
  });

  it('computes the success rate over all in-window samples', () => {
    const ring = [
      { t: '2026-07-10T00:00:00.000Z', s: true },
      { t: '2026-07-10T00:01:00.000Z', s: false },
      { t: '2026-07-10T00:02:00.000Z', s: true },
      { t: '2026-07-10T00:03:00.000Z', s: true }
    ];
    const stats = computeWindowedStats(ring, { maxAgeMs: Infinity });
    expect(stats.windowedCompleted).toBe(4);
    expect(stats.windowedSucceeded).toBe(3);
    expect(stats.windowedFailed).toBe(1);
    expect(stats.windowedSuccessRate).toBe(75);
  });

  it('keeps only the most-recent maxCount samples', () => {
    // 10 failures (older) followed by 5 successes (newer); window last 5 → 100%.
    const ring = [];
    for (let i = 0; i < 10; i++) ring.push({ t: `old-${i}`, s: false });
    for (let i = 0; i < 5; i++) ring.push({ t: `new-${i}`, s: true });
    const stats = computeWindowedStats(ring, { maxCount: 5, maxAgeMs: Infinity });
    expect(stats.windowedCompleted).toBe(5);
    expect(stats.windowedSuccessRate).toBe(100);
  });

  it('ages out samples older than maxAgeMs — a resolved failure burst self-heals', () => {
    const now = Date.parse('2026-07-12T00:00:00.000Z');
    const DAY = 24 * 60 * 60 * 1000;
    const ring = [
      // Old failure burst (40 days ago) — should age out of a 30-day window.
      { t: iso(40 * DAY, now), s: false },
      { t: iso(40 * DAY, now), s: false },
      // Recent successes (within 30 days).
      { t: iso(2 * DAY, now), s: true },
      { t: iso(1 * DAY, now), s: true }
    ];
    const stats = computeWindowedStats(ring, { maxAgeMs: 30 * DAY, now });
    expect(stats.windowedCompleted).toBe(2);
    expect(stats.windowedSuccessRate).toBe(100);
  });

  it('defaults to the exported count window when maxCount is unspecified', () => {
    const ring = Array.from({ length: DEFAULT_WINDOW_MAX_COUNT + 20 }, (_, i) => ({ t: `r-${i}`, s: true }));
    const stats = computeWindowedStats(ring, { maxAgeMs: Infinity });
    expect(stats.windowedCompleted).toBe(DEFAULT_WINDOW_MAX_COUNT);
  });
});

describe('store.computeEffectiveSuccessRate (issue #2617)', () => {
  // A recent ring of `n` outcomes ending now, oldest first.
  const ring = (results, now = Date.now()) =>
    results.map((s, i) => ({ t: new Date(now - (results.length - i) * 60000).toISOString(), s }));

  it('returns the windowed rate when the window has enough samples (the issue\'s failure scenario)', () => {
    // 40 failures during a since-fixed bug, then 15 straight successes:
    // lifetime ≈ 27%, windowed = 100%. Decisions must read the windowed rate.
    const metrics = {
      completed: 55, succeeded: 15, failed: 40, successRate: 27,
      recentOutcomes: ring(Array(15).fill(true))
    };
    expect(computeEffectiveSuccessRate(metrics)).toEqual({
      successRate: 100, source: 'windowed', windowedCompleted: 15
    });
  });

  it('falls back to the lifetime rate when the window has fewer than the minimum samples', () => {
    const metrics = {
      completed: 20, succeeded: 4, failed: 16, successRate: 20,
      recentOutcomes: ring([true, true, true, true]) // 4 < EFFECTIVE_RATE_MIN_WINDOW_SAMPLES(5)
    };
    expect(computeEffectiveSuccessRate(metrics)).toEqual({
      successRate: 20, source: 'lifetime', windowedCompleted: 4
    });
  });

  it('falls back to lifetime on an empty or missing ring (pre-migration bucket)', () => {
    expect(computeEffectiveSuccessRate({ completed: 10, successRate: 40 })).toMatchObject({
      successRate: 40, source: 'lifetime', windowedCompleted: 0
    });
    expect(computeEffectiveSuccessRate({ completed: 10, successRate: 40, recentOutcomes: [] }).successRate).toBe(40);
  });

  it('returns the null sentinel (never a fabricated 0) when no rate exists at all', () => {
    expect(computeEffectiveSuccessRate(undefined)).toEqual({
      successRate: null, source: 'lifetime', windowedCompleted: 0
    });
    expect(computeEffectiveSuccessRate({ completed: 0 }).successRate).toBeNull();
  });

  it('ages stale samples out of the window before deciding — an old burst cannot keep the window "full"', () => {
    const now = Date.parse('2026-07-12T00:00:00.000Z');
    const DAY = 24 * 60 * 60 * 1000;
    const stale = Array.from({ length: 10 }, () => ({ t: new Date(now - 40 * DAY).toISOString(), s: false }));
    const metrics = { completed: 10, succeeded: 0, failed: 10, successRate: 0, recentOutcomes: stale };
    // All 10 samples are older than the 30-day default window → lifetime fallback.
    expect(computeEffectiveSuccessRate(metrics, { now })).toEqual({
      successRate: 0, source: 'lifetime', windowedCompleted: 0
    });
  });

  it('respects a caller-supplied minWindowSamples bar', () => {
    const metrics = { successRate: 10, recentOutcomes: ring([true, true, true]) };
    expect(computeEffectiveSuccessRate(metrics).source).toBe('lifetime'); // 3 < default 5
    expect(computeEffectiveSuccessRate(metrics, { minWindowSamples: 3 })).toMatchObject({
      successRate: 100, source: 'windowed'
    });
    expect(EFFECTIVE_RATE_MIN_WINDOW_SAMPLES).toBe(5);
  });

  it('trusts a BAD recent window too — recency cuts both ways', () => {
    // Good lifetime rate but 6 recent failures → windowed 0% wins.
    const metrics = {
      completed: 100, succeeded: 90, failed: 10, successRate: 90,
      recentOutcomes: ring(Array(6).fill(false))
    };
    expect(computeEffectiveSuccessRate(metrics)).toMatchObject({ successRate: 0, source: 'windowed' });
  });
});

describe('store.isSkipCandidate (issue #2617)', () => {
  const ring = (results, now = Date.now()) =>
    results.map((s, i) => ({ t: new Date(now - (results.length - i) * 60000).toISOString(), s }));

  it('is false for a recovered type (poor lifetime, ≥5 recent successes)', () => {
    expect(isSkipCandidate({
      completed: 55, succeeded: 15, failed: 40, successRate: 27,
      recentOutcomes: ring(Array(15).fill(true))
    })).toBe(false);
  });

  it('is true for a still-failing type (poor lifetime AND poor window)', () => {
    expect(isSkipCandidate({
      completed: 20, succeeded: 2, failed: 18, successRate: 10,
      recentOutcomes: ring(Array(8).fill(false))
    })).toBe(true);
  });

  it('falls back to the lifetime rate on a thin window (acceptance criterion 2)', () => {
    expect(isSkipCandidate({
      completed: 55, succeeded: 15, failed: 40, successRate: 27,
      recentOutcomes: ring([true, true, true])
    })).toBe(true);
  });

  it('is false below the 5-completion threshold or for a missing bucket', () => {
    expect(isSkipCandidate({ completed: 4, successRate: 0 })).toBe(false);
    expect(isSkipCandidate(undefined)).toBe(false);
    expect(isSkipCandidate(null)).toBe(false);
  });
});
