import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock file I/O so submitPostSession tests stay pure. Shared by meatspacePost.js
// AND meatspacePostMemory.js (imported transitively for advanceScheduleFromSession) —
// route responses by path substring so both modules' reads/writes are covered
// without depending on call order.
vi.mock('../lib/fileUtils.js', () => ({
  atomicWrite: vi.fn().mockResolvedValue(undefined),
  // `data` is needed too — postValidation.js transitively imports
  // meatspacePostDrillCache.js, which builds a path off PATHS.data at module load.
  PATHS: { data: '/tmp/test-data', meatspace: '/tmp/test-meatspace' },
  ensureDir: vi.fn().mockResolvedValue(undefined),
  readJSONFile: vi.fn((path, defaultValue) => Promise.resolve(defaultValue)),
}));

import { readJSONFile, atomicWrite } from '../lib/fileUtils.js';
import {
  generateDoublingChain,
  generateSerialSubtraction,
  generateMultiplication,
  generatePowers,
  generateEstimation,
  scoreDrill,
  computeExpectedFromPrompt,
  computePostStreaks,
  submitPostSession,
  updatePostConfig,
  postConfigEvents,
  resolveDrillConfig,
  getMultiplicationProgress,
  getAdaptivePreview,
  getPostStats,
  deriveTaskAccuracy,
  deriveTaskCompletion,
  getCognitiveProgress,
  generateDrill,
} from './meatspacePost.js';

// =============================================================================
// DOUBLING CHAIN TESTS
// =============================================================================

describe('generateDoublingChain', () => {
  it('generates correct number of steps', () => {
    const result = generateDoublingChain(5, 6);
    expect(result.questions).toHaveLength(6);
    expect(result.type).toBe('doubling-chain');
  });

  it('each value doubles from the previous', () => {
    const result = generateDoublingChain(7, 4);
    expect(result.questions[0].expected).toBe(14);
    expect(result.questions[1].expected).toBe(28);
    expect(result.questions[2].expected).toBe(56);
    expect(result.questions[3].expected).toBe(112);
  });

  it('uses random start 3-9 when not provided', () => {
    const result = generateDoublingChain(undefined, 3);
    const start = result.config.startValue;
    expect(start).toBeGreaterThanOrEqual(3);
    expect(start).toBeLessThanOrEqual(9);
  });

  it('stores config with start value and steps', () => {
    const result = generateDoublingChain(4, 5);
    expect(result.config).toEqual({ startValue: 4, steps: 5 });
  });
});

// =============================================================================
// SERIAL SUBTRACTION TESTS
// =============================================================================

describe('generateSerialSubtraction', () => {
  it('generates correct number of steps', () => {
    const result = generateSerialSubtraction(100, 7, 5);
    expect(result.questions).toHaveLength(5);
    expect(result.type).toBe('serial-subtraction');
  });

  it('each value decreases by subtrahend', () => {
    const result = generateSerialSubtraction(100, 7, 4);
    expect(result.questions[0].expected).toBe(93);
    expect(result.questions[1].expected).toBe(86);
    expect(result.questions[2].expected).toBe(79);
    expect(result.questions[3].expected).toBe(72);
  });

  it('uses random start 100-200 when not provided', () => {
    const result = generateSerialSubtraction(undefined, 7, 3);
    const start = result.config.startValue;
    expect(start).toBeGreaterThanOrEqual(100);
    expect(start).toBeLessThanOrEqual(200);
  });

  it('samples start value from startRange when startValue is not provided', () => {
    const result = generateSerialSubtraction(undefined, 7, 3, [50, 60]);
    const start = result.config.startValue;
    expect(start).toBeGreaterThanOrEqual(50);
    expect(start).toBeLessThanOrEqual(60);
  });

  it('prefers explicit startValue over startRange', () => {
    const result = generateSerialSubtraction(150, 7, 3, [50, 60]);
    expect(result.config.startValue).toBe(150);
  });
});

// =============================================================================
// MULTIPLICATION TESTS
// =============================================================================

describe('generateMultiplication', () => {
  it('generates requested number of questions', () => {
    const result = generateMultiplication(5, 2);
    expect(result.questions).toHaveLength(5);
    expect(result.type).toBe('multiplication');
  });

  it('operands are within digit limits for 2-digit', () => {
    const result = generateMultiplication(20, 2);
    for (const q of result.questions) {
      // Parse operands from prompt "A x B"
      const [a, b] = q.prompt.split(' x ').map(Number);
      expect(a).toBeGreaterThanOrEqual(10);
      expect(a).toBeLessThanOrEqual(99);
      expect(b).toBeGreaterThanOrEqual(10);
      expect(b).toBeLessThanOrEqual(99);
      expect(q.expected).toBe(a * b);
    }
  });

  it('1-digit mode produces single digit operands', () => {
    const result = generateMultiplication(10, 1);
    for (const q of result.questions) {
      const [a, b] = q.prompt.split(' x ').map(Number);
      expect(a).toBeGreaterThanOrEqual(1);
      expect(a).toBeLessThanOrEqual(9);
      expect(b).toBeGreaterThanOrEqual(1);
      expect(b).toBeLessThanOrEqual(9);
    }
  });
});

// =============================================================================
// PROGRESSIVE MULTIPLICATION LADDER
// =============================================================================

describe('generateMultiplication — progressive factors', () => {
  it('honors an asymmetric factors array (1×2-digit)', () => {
    const result = generateMultiplication(20, 2, [1, 2], 1);
    expect(result.config.factors).toEqual([1, 2]);
    expect(result.config.level).toBe(1);
    expect(result.config.maxDigits).toBeUndefined();
    for (const q of result.questions) {
      const [a, b] = q.prompt.split(' x ').map(Number);
      expect(a).toBeGreaterThanOrEqual(1);
      expect(a).toBeLessThanOrEqual(9);
      expect(b).toBeGreaterThanOrEqual(10);
      expect(b).toBeLessThanOrEqual(99);
      expect(q.expected).toBe(a * b);
    }
  });

  it('supports three single-digit factors (1×1×1)', () => {
    const result = generateMultiplication(15, 2, [1, 1, 1], 2);
    for (const q of result.questions) {
      const nums = q.prompt.split(' x ').map(Number);
      expect(nums).toHaveLength(3);
      for (const n of nums) {
        expect(n).toBeGreaterThanOrEqual(1);
        expect(n).toBeLessThanOrEqual(9);
      }
      expect(q.expected).toBe(nums.reduce((p, n) => p * n, 1));
    }
  });

  it('falls back to symmetric maxDigits when no factors given', () => {
    const result = generateMultiplication(5, 3);
    expect(result.config.maxDigits).toBe(3);
    expect(result.config.factors).toBeUndefined();
  });
});

// =============================================================================
// POWERS TESTS
// =============================================================================

describe('generatePowers', () => {
  it('generates requested number of questions', () => {
    const result = generatePowers([2, 3], 8, 6);
    expect(result.questions).toHaveLength(6);
    expect(result.type).toBe('powers');
  });

  it('uses only specified bases', () => {
    const result = generatePowers([2, 5], 10, 20);
    for (const q of result.questions) {
      const base = parseInt(q.prompt.split('^')[0]);
      expect([2, 5]).toContain(base);
    }
  });

  it('expected values are correct', () => {
    const result = generatePowers([2], 5, 10);
    for (const q of result.questions) {
      const [base, exp] = q.prompt.split('^').map(Number);
      expect(q.expected).toBe(Math.pow(base, exp));
    }
  });

  it('exponents are at least 2', () => {
    const result = generatePowers([2, 3, 5], 10, 30);
    for (const q of result.questions) {
      const exp = parseInt(q.prompt.split('^')[1]);
      expect(exp).toBeGreaterThanOrEqual(2);
    }
  });
});

// =============================================================================
// ESTIMATION TESTS
// =============================================================================

describe('generateEstimation', () => {
  it('generates requested number of questions', () => {
    const result = generateEstimation(3);
    expect(result.questions).toHaveLength(3);
    expect(result.type).toBe('estimation');
  });

  it('expected values match the operation', () => {
    const result = generateEstimation(20);
    for (const q of result.questions) {
      if (q.prompt.includes(' + ')) {
        const [a, b] = q.prompt.split(' + ').map(Number);
        expect(q.expected).toBe(a + b);
      } else if (q.prompt.includes(' - ')) {
        const [a, b] = q.prompt.split(' - ').map(Number);
        expect(q.expected).toBe(a - b);
      } else {
        const [a, b] = q.prompt.split(' x ').map(Number);
        expect(q.expected).toBe(a * b);
      }
    }
  });

  it('operands are 3-digit numbers (100-999)', () => {
    const result = generateEstimation(20);
    for (const q of result.questions) {
      const nums = q.prompt.match(/\d+/g).map(Number);
      for (const n of nums) {
        expect(n).toBeGreaterThanOrEqual(100);
        expect(n).toBeLessThanOrEqual(999);
      }
    }
  });

  it('preserves tolerancePct in config when provided', () => {
    const result = generateEstimation(3, 25);
    expect(result.config.tolerancePct).toBe(25);
  });

  it('omits tolerancePct from config when not provided', () => {
    const result = generateEstimation(3);
    expect(result.config).not.toHaveProperty('tolerancePct');
  });
});

// =============================================================================
// computeExpectedFromPrompt TESTS
// =============================================================================

describe('computeExpectedFromPrompt', () => {
  it('parses addition', () => {
    expect(computeExpectedFromPrompt('500 + 300')).toBe(800);
  });

  it('parses subtraction', () => {
    expect(computeExpectedFromPrompt('100 - 7')).toBe(93);
  });

  it('parses multiplication', () => {
    expect(computeExpectedFromPrompt('15 x 23')).toBe(345);
  });

  it('parses chained multiplication (3+ factors)', () => {
    expect(computeExpectedFromPrompt('6 x 7 x 8')).toBe(336);
    expect(computeExpectedFromPrompt('2 x 3 x 4 x 5')).toBe(120);
  });

  it('parses powers', () => {
    expect(computeExpectedFromPrompt('2^8')).toBe(256);
  });

  it('returns null for unparseable prompts', () => {
    expect(computeExpectedFromPrompt('hello')).toBeNull();
    expect(computeExpectedFromPrompt(null)).toBeNull();
    expect(computeExpectedFromPrompt(undefined)).toBeNull();
  });
});

// =============================================================================
// SCORING TESTS
// =============================================================================

describe('scoreDrill', () => {
  it('returns 0 for empty questions', () => {
    expect(scoreDrill('multiplication', [], 60000).score).toBe(0);
    expect(scoreDrill('multiplication', null, 60000).score).toBe(0);
  });

  it('100% accuracy with fast responses gives high score', () => {
    const questions = [
      { prompt: '5 x 3', expected: 15, answered: 15, responseMs: 1000 },
      { prompt: '7 x 4', expected: 28, answered: 28, responseMs: 1500 },
      { prompt: '6 x 8', expected: 48, answered: 48, responseMs: 2000 }
    ];
    const { score, accuracy, completion, avgResponseMs, answeredCount, totalCount } = scoreDrill('multiplication', questions, 120000);
    expect(score).toBeGreaterThanOrEqual(90);
    expect(score).toBeLessThanOrEqual(100);
    // Fully-answered task: separated metrics all report cleanly.
    expect(accuracy).toBe(1);
    expect(completion).toBe(1);
    expect(answeredCount).toBe(3);
    expect(totalCount).toBe(3);
    expect(avgResponseMs).toBe(1500);
  });

  it('separates answered-only accuracy from completion; unanswered ≠ wrong', () => {
    const questions = [
      { prompt: '5 x 3', expected: 15, answered: 15, responseMs: 1000 }, // correct
      { prompt: '7 x 4', expected: 28, answered: 99, responseMs: 1200 }, // wrong
      { prompt: '6 x 8', expected: 48, answered: null, responseMs: 0 },  // unreached
      { prompt: '2 x 9', expected: 18, answered: null, responseMs: 0 }   // unreached
    ];
    const { accuracy, completion, answeredCount, totalCount, avgResponseMs } = scoreDrill('multiplication', questions, 60000);
    // 1 correct of 2 ANSWERED → 0.5 accuracy (the 2 unanswered do not count as wrong).
    expect(accuracy).toBe(0.5);
    // 2 answered of 4 → 0.5 completion.
    expect(completion).toBe(0.5);
    expect(answeredCount).toBe(2);
    expect(totalCount).toBe(4);
    expect(avgResponseMs).toBe(1100);
  });

  it('accuracy and avgResponseMs are null (never NaN) when nothing was answered', () => {
    const questions = [
      { prompt: '5 x 3', expected: 15, answered: null, responseMs: 0 },
      { prompt: '7 x 4', expected: 28, answered: null, responseMs: 0 }
    ];
    const { score, accuracy, completion, avgResponseMs, answeredCount } = scoreDrill('multiplication', questions, 60000);
    expect(accuracy).toBe(null);
    expect(avgResponseMs).toBe(null);
    expect(completion).toBe(0);
    expect(answeredCount).toBe(0);
    expect(score).toBe(0);
  });

  it('0% accuracy gives low score', () => {
    const questions = [
      { prompt: '5 x 3', expected: 15, answered: 10, responseMs: 1000 },
      { prompt: '7 x 4', expected: 28, answered: 30, responseMs: 1500 }
    ];
    const { score } = scoreDrill('multiplication', questions, 60000);
    // 0 accuracy * 0.8 = 0, plus small speed bonus
    expect(score).toBeLessThanOrEqual(20);
  });

  it('blended score still folds completion in (back-compat): 1 correct of 2 total', () => {
    const questions = [
      { prompt: '5 x 3', expected: 15, answered: 15, responseMs: 1000 },
      { prompt: '7 x 4', expected: 28, answered: null, responseMs: 0 }
    ];
    const { score, accuracy, completion } = scoreDrill('multiplication', questions, 60000);
    // The headline `score` stays correct-over-TOTAL (== accuracy × completion) so
    // existing history is unchanged: 1/2 → 40 base + speed bonus.
    expect(score).toBeGreaterThanOrEqual(40);
    expect(score).toBeLessThanOrEqual(60);
    // …but the separated metrics report the answered-only accuracy (100%) and the
    // completion (50%) independently.
    expect(accuracy).toBe(1);
    expect(completion).toBe(0.5);
  });

  it('slow responses reduce speed bonus', () => {
    const fast = [
      { prompt: '5 x 3', expected: 15, answered: 15, responseMs: 1000 }
    ];
    const slow = [
      { prompt: '5 x 3', expected: 15, answered: 15, responseMs: 55000 }
    ];
    const { score: fastScore } = scoreDrill('multiplication', fast, 60000);
    const { score: slowScore } = scoreDrill('multiplication', slow, 60000);
    expect(fastScore).toBeGreaterThan(slowScore);
  });

  it('score is clamped between 0 and 100', () => {
    const questions = [
      { prompt: '1 x 1', expected: 1, answered: 1, responseMs: 100 }
    ];
    const { score } = scoreDrill('multiplication', questions, 120000);
    expect(score).toBeLessThanOrEqual(100);
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it('recomputes correct flags server-side, ignoring client values', () => {
    const questions = [
      { prompt: '5 x 3', expected: 15, answered: 15, correct: false, responseMs: 1000 },
      { prompt: '7 x 4', expected: 28, answered: 99, correct: true, responseMs: 1000 }
    ];
    const { questions: recomputed } = scoreDrill('multiplication', questions, 60000);
    expect(recomputed[0].correct).toBe(true);   // client said false, server recomputes true
    expect(recomputed[1].correct).toBe(false);   // client said true, server recomputes false
  });

  it('recomputes expected from prompt, ignoring tampered client values', () => {
    const questions = [
      { prompt: '5 x 3', expected: 999, answered: 999, responseMs: 1000 }
    ];
    const { questions: recomputed } = scoreDrill('multiplication', questions, 60000);
    // Server derives expected=15 from "5 x 3", overriding the client's 999
    expect(recomputed[0].expected).toBe(15);
    expect(recomputed[0].correct).toBe(false); // 999 !== 15
  });

  it('estimation drill uses tolerancePct from config', () => {
    const questions = [
      { prompt: '500 + 300', expected: 800, answered: 850, responseMs: 1000 }
    ];
    // 850 is within 10% of 800 (80 tolerance), so correct
    const { questions: q10 } = scoreDrill('estimation', questions, 60000, { tolerancePct: 10 });
    expect(q10[0].correct).toBe(true);
    // 850 is NOT within 5% of 800 (40 tolerance), so incorrect
    const { questions: q5 } = scoreDrill('estimation', questions, 60000, { tolerancePct: 5 });
    expect(q5[0].correct).toBe(false);
  });

  it('coerces string answered values to numbers', () => {
    const questions = [
      { prompt: '5 x 3', answered: '15', responseMs: 1000 },
      { prompt: '7 x 4', answered: '28', responseMs: 1500 }
    ];
    const { questions: recomputed, score } = scoreDrill('multiplication', questions, 60000);
    expect(recomputed[0].correct).toBe(true);
    expect(recomputed[0].answered).toBe(15);
    expect(recomputed[1].correct).toBe(true);
    expect(recomputed[1].answered).toBe(28);
    expect(score).toBeGreaterThanOrEqual(80);
  });

  it('treats non-numeric string answered as unanswered', () => {
    const questions = [
      { prompt: '5 x 3', answered: 'abc', responseMs: 1000 },
      { prompt: '7 x 4', answered: 'xyz', responseMs: 1500 }
    ];
    const { questions: recomputed } = scoreDrill('multiplication', questions, 60000);
    expect(recomputed[0].correct).toBe(false);
    expect(recomputed[0].answered).toBe(null);
    expect(recomputed[1].correct).toBe(false);
    expect(recomputed[1].answered).toBe(null);
  });

  it('treats empty and whitespace string answered as unanswered', () => {
    const questions = [
      { prompt: '5 x 3', answered: '', responseMs: 1000 },
      { prompt: '7 x 4', answered: '  ', responseMs: 1500 }
    ];
    const { questions: recomputed } = scoreDrill('multiplication', questions, 60000);
    expect(recomputed[0].answered).toBe(null);
    expect(recomputed[0].correct).toBe(false);
    expect(recomputed[1].answered).toBe(null);
    expect(recomputed[1].correct).toBe(false);
  });
});

// =============================================================================
// STREAK TESTS
// =============================================================================

describe('computePostStreaks', () => {
  const s = (date, score = 80) => ({ date, score });

  it('returns a zeroed result when there are no sessions', () => {
    expect(computePostStreaks([], '2026-06-28')).toEqual({
      completedToday: false,
      currentStreak: 0,
      longestStreak: 0,
      lastDate: null,
      todayScore: null,
    });
  });

  it('counts a single-day streak when only today is practiced', () => {
    const r = computePostStreaks([s('2026-06-28')], '2026-06-28');
    expect(r.completedToday).toBe(true);
    expect(r.currentStreak).toBe(1);
    expect(r.longestStreak).toBe(1);
    expect(r.lastDate).toBe('2026-06-28');
  });

  it('counts consecutive days back from today', () => {
    const sessions = [s('2026-06-26'), s('2026-06-27'), s('2026-06-28')];
    const r = computePostStreaks(sessions, '2026-06-28');
    expect(r.currentStreak).toBe(3);
    expect(r.longestStreak).toBe(3);
  });

  it('keeps the streak alive on a not-yet-done today when yesterday is done', () => {
    const r = computePostStreaks([s('2026-06-26'), s('2026-06-27')], '2026-06-28');
    expect(r.completedToday).toBe(false);
    expect(r.currentStreak).toBe(2);
  });

  it('breaks the current streak after a two-day gap', () => {
    const r = computePostStreaks([s('2026-06-20'), s('2026-06-21')], '2026-06-28');
    expect(r.currentStreak).toBe(0);
    expect(r.longestStreak).toBe(2);
    expect(r.lastDate).toBe('2026-06-21');
  });

  it('reports the longest historical run independent of the current streak', () => {
    const sessions = [
      s('2026-06-01'), s('2026-06-02'), s('2026-06-03'), s('2026-06-04'), // run of 4
      s('2026-06-27'), s('2026-06-28'), // current run of 2
    ];
    const r = computePostStreaks(sessions, '2026-06-28');
    expect(r.currentStreak).toBe(2);
    expect(r.longestStreak).toBe(4);
  });

  it('dedups multiple same-day sessions and reports the best score for today', () => {
    const sessions = [s('2026-06-28', 70), s('2026-06-28', 91), s('2026-06-27', 60)];
    const r = computePostStreaks(sessions, '2026-06-28');
    expect(r.currentStreak).toBe(2);
    expect(r.todayScore).toBe(91);
  });

  it('spans a month boundary without an off-by-one (UTC day math)', () => {
    const r = computePostStreaks([s('2026-05-31'), s('2026-06-01')], '2026-06-01');
    expect(r.currentStreak).toBe(2);
  });
});

// =============================================================================
// SUBMIT SESSION — MEMORY DRILL SCHEDULE ADVANCE + MASTERY MERGE (#2010, #2016)
// =============================================================================

describe('submitPostSession — memory drill schedule advance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Route each readJSONFile call by path so both meatspacePost.js's own
    // reads (config/sessions) and meatspacePostMemory.js's read (memory items,
    // called internally by advanceScheduleFromSession) resolve sensibly
    // regardless of call order.
    readJSONFile.mockImplementation((path, defaultValue) => {
      const p = String(path);
      if (p.includes('post-memory-items')) {
        return Promise.resolve({
          items: [{
            id: 'song-1',
            title: 'Test Song',
            builtin: false,
            schedule: { ease: 2.5, intervalDays: 0, nextReview: '2026-06-01T00:00:00.000Z', lastReviewed: null },
            mastery: { overallPct: 0, chunks: {}, elements: {} },
            content: { lines: [{ text: 'a line' }], chunks: [] },
          }],
        });
      }
      if (p.includes('post-sessions')) {
        return Promise.resolve({ sessions: [] });
      }
      // post-config.json — fall through to the default (baseDefaults clone)
      return Promise.resolve(defaultValue);
    });
  });

  it('advances the schedule of the memory item a POST-supported memory task references', async () => {
    const session = await submitPostSession({
      cadence: 'daily',
      modules: ['memory'],
      tasks: [{
        module: 'memory',
        type: 'memory-sequence',
        memoryItemId: 'song-1',
        questions: [
          { prompt: 'line one', expected: 'line two', answered: 'line two', correct: true, responseMs: 500 },
          { prompt: 'line two', expected: 'line three', answered: 'line three', correct: true, responseMs: 500 },
        ],
        score: 90,
        totalMs: 2000,
      }],
      tags: {},
    });

    expect(session).toBeTruthy();
    const memoryWrite = atomicWrite.mock.calls.find(([path]) => String(path).includes('post-memory-items'));
    expect(memoryWrite).toBeTruthy();
    const updatedItem = memoryWrite[1].items.find(i => i.id === 'song-1');
    expect(updatedItem.schedule.intervalDays).toBeGreaterThan(0);
    expect(updatedItem.schedule.lastReviewed).toBeTruthy();
  });

  it('merges chunk/element mastery from per-question attribution alongside the schedule advance (issue #2016)', async () => {
    await submitPostSession({
      cadence: 'daily',
      modules: ['memory'],
      tasks: [{
        module: 'memory',
        type: 'memory-sequence',
        memoryItemId: 'song-1',
        questions: [
          { prompt: 'line one', expected: 'line two', answered: 'line two', correct: true, responseMs: 500, chunkId: 'verse-1' },
          { prompt: 'line two', expected: 'line three', answered: null, correct: false, responseMs: 500, chunkId: 'verse-1' },
        ],
        score: 50,
        totalMs: 2000,
      }],
      tags: {},
    });

    const memoryWrites = atomicWrite.mock.calls.filter(([path]) => String(path).includes('post-memory-items'));
    // Consolidated single read-modify-write (issue #2098): the one write
    // carries BOTH the schedule advance and the mastery merge.
    expect(memoryWrites.length).toBe(1);
    const masteryWrite = memoryWrites[memoryWrites.length - 1];
    const updatedItem = masteryWrite[1].items.find(i => i.id === 'song-1');
    expect(updatedItem.mastery.chunks['verse-1']).toEqual({ correct: 1, attempts: 2, lastPracticed: expect.any(String) });
  });

  it('buckets memory-element-flash answers into element mastery via the element attribution', async () => {
    await submitPostSession({
      cadence: 'daily',
      modules: ['memory'],
      tasks: [{
        module: 'memory',
        type: 'memory-element-flash',
        memoryItemId: 'song-1',
        questions: [
          { prompt: 'Hydrogen', expected: 'H', answered: 'H', correct: true, responseMs: 400, element: 'H' },
        ],
        score: 100,
        totalMs: 400,
      }],
      tags: {},
    });

    const memoryWrites = atomicWrite.mock.calls.filter(([path]) => String(path).includes('post-memory-items'));
    const masteryWrite = memoryWrites[memoryWrites.length - 1];
    const updatedItem = masteryWrite[1].items.find(i => i.id === 'song-1');
    expect(updatedItem.mastery.elements.H).toEqual({ correct: 1, attempts: 1 });
  });

  it('does not touch memory items for a session with no memory tasks', async () => {
    await submitPostSession({
      cadence: 'daily',
      modules: ['mental-math'],
      tasks: [{
        module: 'mental-math',
        type: 'doubling-chain',
        config: { startValue: 2, steps: 1 },
        questions: [{ prompt: '2 x 2', expected: 4, answered: 4, responseMs: 500 }],
        totalMs: 500,
      }],
      tags: {},
    });

    const memoryWrite = atomicWrite.mock.calls.find(([path]) => String(path).includes('post-memory-items'));
    expect(memoryWrite).toBeUndefined();
  });

  it('does not advance a schedule for a supported memory task with no memoryItemId', async () => {
    await submitPostSession({
      cadence: 'daily',
      modules: ['memory'],
      tasks: [{
        module: 'memory',
        type: 'memory-fill-blank',
        // No memoryItemId — the schedule/mastery advance loop gates on it
        // regardless of whether the type is in POST_SUPPORTED_MEMORY_TYPES.
        questions: [{ prompt: 'a ____ line', expected: 'test', answered: 'test', correct: true, responseMs: 500 }],
        totalMs: 500,
      }],
      tags: {},
    });

    const memoryWrite = atomicWrite.mock.calls.find(([path]) => String(path).includes('post-memory-items'));
    expect(memoryWrite).toBeUndefined();
  });

  // Regression (issue #2099, fix #1): memory-fill-blank used to be ABSENT from
  // POST_SUPPORTED_MEMORY_TYPES, so submitPostSession forced its score to 0
  // (treating it as an "unsupported memory drill") and the schedule/mastery
  // advance loop below skipped it entirely — any fill-blank work done inside a
  // scored session was silently unrecorded. It must now behave exactly like
  // memory-sequence/memory-element-flash: trust the client-computed score and
  // advance the drilled item's schedule + mastery.
  it('trusts the client score and advances schedule/mastery for a memory-fill-blank task (issue #2099/#2116)', async () => {
    const session = await submitPostSession({
      cadence: 'daily',
      modules: ['memory'],
      tasks: [{
        module: 'memory',
        type: 'memory-fill-blank',
        memoryItemId: 'song-1',
        questions: [
          { prompt: 'a ____ line', expected: 'test', answered: 'test', correct: true, responseMs: 500, chunkId: 'verse-1' },
        ],
        score: 85,
        totalMs: 500,
      }],
      tags: {},
    });

    // Client-computed score is trusted for this now-supported type, not forced to 0.
    expect(session.tasks[0].score).toBe(85);

    const memoryWrites = atomicWrite.mock.calls.filter(([path]) => String(path).includes('post-memory-items'));
    expect(memoryWrites.length).toBe(1); // consolidated write: schedule advance + mastery merge (issue #2098)
    const scheduleWrite = memoryWrites[0];
    const updatedItem = scheduleWrite[1].items.find(i => i.id === 'song-1');
    expect(updatedItem.schedule.intervalDays).toBeGreaterThan(0);
    const masteryWrite = memoryWrites[memoryWrites.length - 1];
    const updatedMastery = masteryWrite[1].items.find(i => i.id === 'song-1');
    expect(updatedMastery.mastery.chunks['verse-1']).toEqual({ correct: 1, attempts: 1, lastPracticed: expect.any(String) });
  });
});

// =============================================================================
// WEIGHTED SESSION SCORE — scoring.weights (issue #2099, fix #3)
//
// DEFAULT_CONFIG.scoring.weights + the postConfigUpdateSchema.scoring.weights
// slice existed but were never read anywhere — computeSessionScore was a
// plain unweighted mean. Wired here: uniform (default) weights must reproduce
// the exact old unweighted-mean score; skewed weights must shift the blend
// toward the higher-weighted module's score. LLM/memory tasks trust the
// client-supplied `score` verbatim (no server-side rescoring), which makes
// them the simplest fixture for asserting exact blended-score math.
// =============================================================================

describe('submitPostSession — weighted scoring (issue #2099)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const llmTask = (score) => ({
    module: 'llm-drills', type: 'word-association', responses: [], score, totalMs: 1000,
  });
  const memoryTask = (score) => ({
    module: 'memory', type: 'memory-sequence', questions: [], score, totalMs: 500,
  });

  it('uniform default weights reproduce the plain unweighted mean', async () => {
    readJSONFile.mockImplementation((path, defaultValue) => {
      const p = String(path);
      if (p.includes('post-sessions')) return Promise.resolve({ sessions: [] });
      return Promise.resolve(defaultValue); // post-config → baseDefaults (all weights 1.0)
    });

    const session = await submitPostSession({
      cadence: 'daily',
      modules: ['llm-drills', 'memory'],
      tasks: [llmTask(100), memoryTask(0)],
      tags: {},
    });

    expect(session.score).toBe(50); // (100 + 0) / 2
  });

  it('a configured module weight skews the blended score toward the higher-weighted module', async () => {
    readJSONFile.mockImplementation((path, defaultValue) => {
      const p = String(path);
      if (p.includes('post-sessions')) return Promise.resolve({ sessions: [] });
      if (p.includes('post-config')) {
        // De-emphasize memory (0.5) — mirrors the real 0-1 range
        // postConfigUpdateSchema.scoring.weights accepts. llm-drills is
        // absent from this patch and must fall back to the default weight
        // (1.0), not drop out.
        return Promise.resolve({ scoring: { weights: { memory: 0.5 } } });
      }
      return Promise.resolve(defaultValue);
    });

    const session = await submitPostSession({
      cadence: 'daily',
      modules: ['llm-drills', 'memory'],
      tasks: [llmTask(100), memoryTask(80)],
      tags: {},
    });

    // (100*1 + 80*0.5) / (1+0.5) = 140/1.5 = 93.33 → 93
    expect(session.score).toBe(93);
  });

  it('a zero weight excludes that module\'s task from the blend entirely', async () => {
    readJSONFile.mockImplementation((path, defaultValue) => {
      const p = String(path);
      if (p.includes('post-sessions')) return Promise.resolve({ sessions: [] });
      if (p.includes('post-config')) {
        return Promise.resolve({ scoring: { weights: { memory: 0 } } });
      }
      return Promise.resolve(defaultValue);
    });

    const session = await submitPostSession({
      cadence: 'daily',
      modules: ['llm-drills', 'memory'],
      tasks: [llmTask(80), memoryTask(0)],
      tags: {},
    });

    // memory weight 0 drops out entirely → score is just the llm-drills task's own score
    expect(session.score).toBe(80);
  });
});

// =============================================================================
// UPDATE CONFIG — postConfigEvents (issue #2015)
//
// updatePostConfig() emits `post-config:updated` on its own EventEmitter
// (postConfigEvents) after every successful write, carrying both the merged
// config and the raw `updates` patch. meatspacePostReminder.js subscribes to
// this to reschedule the daily reminder — this is what centralizes
// reschedule-on-save so ANY caller of updatePostConfig gets it for free,
// instead of each route handler having to remember to bolt one on.
// =============================================================================

describe('updatePostConfig — postConfigEvents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readJSONFile.mockImplementation((path, defaultValue) => Promise.resolve(defaultValue));
    atomicWrite.mockResolvedValue(undefined);
  });

  it('emits post-config:updated with the merged config and the raw updates patch', async () => {
    const handler = vi.fn();
    postConfigEvents.once('post-config:updated', handler);

    const merged = await updatePostConfig({ reminder: { enabled: true, time: '09:00' } });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toEqual({
      config: merged,
      updates: { reminder: { enabled: true, time: '09:00' } },
    });
    expect(merged.reminder).toMatchObject({ enabled: true, time: '09:00' });
  });

  // Regression (codex review finding on #2015): the missed-slot catch-up in
  // meatspacePostReminder.js needs to know WHEN the reminder's settings last
  // changed, so it can tell "a slot that happened under the current config"
  // apart from "a slot that happened before the user even set this up."
  it('stamps reminder.updatedAt whenever the reminder slice is part of the patch', async () => {
    const before = Date.now();
    const merged = await updatePostConfig({ reminder: { enabled: true, time: '09:00' } });
    const after = Date.now();

    expect(merged.reminder.updatedAt).toBeDefined();
    const stampedMs = new Date(merged.reminder.updatedAt).getTime();
    expect(stampedMs).toBeGreaterThanOrEqual(before);
    expect(stampedMs).toBeLessThanOrEqual(after);
  });

  it('does not stamp reminder.updatedAt for a patch that does not touch the reminder slice', async () => {
    const merged = await updatePostConfig({ adaptive: { enabled: true } });

    expect(merged.reminder.updatedAt).toBeUndefined();
  });

  it('still emits for updates unrelated to the reminder — subscribers decide what to react to', async () => {
    const handler = vi.fn();
    postConfigEvents.once('post-config:updated', handler);

    await updatePostConfig({ adaptive: { enabled: true } });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].updates).toEqual({ adaptive: { enabled: true } });
  });

  it('only emits after the config write has persisted, not before', async () => {
    let writeResolved = false;
    atomicWrite.mockImplementationOnce(async () => { writeResolved = true; });
    const handler = vi.fn(() => {
      expect(writeResolved).toBe(true);
    });
    postConfigEvents.once('post-config:updated', handler);

    await updatePostConfig({ adaptive: { enabled: true } });

    expect(handler).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// PROGRESSIVE MULTIPLICATION — resolveDrillConfig / getMultiplicationProgress
// =============================================================================

describe('resolveDrillConfig — progressive multiplication', () => {
  const today = new Date().toISOString().split('T')[0];

  // Build a session with `n` answered multiplication questions at `level`, all
  // correct and fast (so the level clears the mastery bar).
  function masteredSession(level, n = 14, responseMs = 2500, date = today) {
    return {
      date,
      tasks: [{
        module: 'mental-math',
        type: 'multiplication',
        config: { level },
        questions: Array.from({ length: n }, () => ({ answered: 1, correct: true, responseMs })),
      }],
    };
  }

  // A date well outside the mastery window (60 days ago).
  const oldDate = new Date(Date.now() - 60 * 86400000).toISOString().split('T')[0];

  function mockSessions(sessions, configOverride) {
    readJSONFile.mockImplementation((path, defaultValue) => {
      const p = String(path);
      if (p.includes('post-sessions')) return Promise.resolve({ sessions });
      if (p.includes('post-config')) return Promise.resolve(configOverride ?? defaultValue);
      return Promise.resolve(defaultValue);
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts a fresh user at level 0 (single×single) and strips maxDigits', async () => {
    mockSessions([]);
    const { config, progression } = await resolveDrillConfig('multiplication', { count: 10, maxDigits: 2 });
    expect(progression).toBeTruthy();
    expect(progression.level).toBe(0);
    expect(config.level).toBe(0);
    expect(config.factors).toEqual([1, 1]);
    expect(config.maxDigits).toBeUndefined();
    expect(config.count).toBe(10);
  });

  it('advances to the next rung once the current one is speed-mastered', async () => {
    mockSessions([masteredSession(0)]);
    const { progression, config } = await resolveDrillConfig('multiplication', { count: 10 });
    expect(progression.level).toBe(1);
    expect(config.factors).toEqual([1, 2]);
  });

  it('does not advance when the level is accurate but too slow', async () => {
    mockSessions([masteredSession(0, 14, 60000)]);
    const { progression } = await resolveDrillConfig('multiplication', { count: 10 });
    expect(progression.level).toBe(0);
  });

  it('passes config through unchanged when progressive is turned off', async () => {
    mockSessions([], { mentalMath: { drillTypes: { multiplication: { progressive: false } } } });
    const { config, progression } = await resolveDrillConfig('multiplication', { count: 10, maxDigits: 2 });
    expect(progression == null).toBe(true);
    expect(config.maxDigits).toBe(2);
    expect(config.factors).toBeUndefined();
  });

  it('does not demote to level 0 when the earned rung aged out of the window', async () => {
    // The user mastered level 2 sixty days ago and hasn't practiced since, so the
    // windowed mastery buckets are empty — but the all-time floor keeps them at 2
    // instead of snapping back to single-digit × single-digit.
    mockSessions([masteredSession(2, 14, 2500, oldDate)]);
    const { progression, config } = await resolveDrillConfig('multiplication', { count: 10 });
    expect(progression.level).toBe(2);
    expect(progression.floorLevel).toBe(2);
    expect(config.factors).toEqual([1, 1, 1]);
  });

  it('getMultiplicationProgress exposes the full ladder + thresholds', async () => {
    mockSessions([masteredSession(0)]);
    const progress = await getMultiplicationProgress();
    expect(progress.level).toBe(1);
    expect(Array.isArray(progress.levels)).toBe(true);
    expect(progress.levels[0].mastered).toBe(true);
    expect(progress.thresholds.minSamples).toBeGreaterThan(0);
    expect(progress.windowDays).toBeGreaterThan(0);
  });
});

// =============================================================================
// ADAPTIVE PREVIEW / resolveDrillConfig PARITY — multiplication (issue #2099, fix #2)
//
// getAdaptivePreview used to always build multiplication's preview off the
// generic maxDigits Adaptive knob, even though resolveDrillConfig hands
// multiplication's difficulty entirely to the progressive ladder whenever
// `progressive !== false` (the default) — so the previewed maxDigits
// adjustment could never actually apply. This locks the two functions'
// multiplication branch in parity for both progressive modes.
// =============================================================================

describe('getAdaptivePreview — multiplication parity with resolveDrillConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readJSONFile.mockImplementation((path, defaultValue) => {
      const p = String(path);
      if (p.includes('post-sessions')) return Promise.resolve({ sessions: [] });
      return Promise.resolve(defaultValue);
    });
  });

  it('previews the progressive ladder rung (not a maxDigits knob) when progressive is on (the default)', async () => {
    const preview = await getAdaptivePreview();
    const resolved = await resolveDrillConfig('multiplication', { count: 10, maxDigits: 2 });

    expect(preview.drills.multiplication.ladder).toBe(true);
    // Same rung resolveDrillConfig would actually generate a drill at.
    expect(preview.drills.multiplication.level).toBe(resolved.progression.level);
    expect(preview.drills.multiplication.factors).toEqual(resolved.progression.factors);
    // The generic Adaptive maxDigits field must NOT be present — showing it
    // would advertise an adjustment resolveDrillConfig will never apply.
    expect(preview.drills.multiplication.field).toBeUndefined();
    expect(preview.drills.multiplication.to).toBeUndefined();
  });

  it('previews the maxDigits Adaptive knob when progressive is turned off', async () => {
    readJSONFile.mockImplementation((path, defaultValue) => {
      const p = String(path);
      if (p.includes('post-sessions')) return Promise.resolve({ sessions: [] });
      if (p.includes('post-config')) {
        return Promise.resolve({ mentalMath: { drillTypes: { multiplication: { progressive: false } } } });
      }
      return Promise.resolve(defaultValue);
    });

    const preview = await getAdaptivePreview();
    const resolved = await resolveDrillConfig('multiplication', { count: 10, maxDigits: 2 });

    // No live adaptation without scored history, but the field/shape must
    // match the maxDigits knob resolveDrillConfig's Adaptive branch would use
    // — not the ladder shape.
    expect(preview.drills.multiplication.ladder).toBeUndefined();
    expect(preview.drills.multiplication.field).toBe('maxDigits');
    expect(resolved.progression == null).toBe(true);
    expect(resolved.config.maxDigits).toBe(2);
  });

  it('other math drill types are unaffected (still the generic Adaptive preview)', async () => {
    const preview = await getAdaptivePreview();
    expect(preview.drills['doubling-chain'].field).toBe('steps');
    expect(preview.drills['doubling-chain'].ladder).toBeUndefined();
  });
});

// =============================================================================
// SCORING MODEL: accuracy vs speed separation, adaptive signal, legacy fallback
// (issue #2094)
// =============================================================================

describe('deriveTaskAccuracy / deriveTaskCompletion — legacy-session fallback', () => {
  it('prefers the persisted fields when present', () => {
    const task = { accuracy: 0.75, completion: 0.5, questions: [{ answered: 1, correct: true }] };
    expect(deriveTaskAccuracy(task)).toBe(0.75);
    expect(deriveTaskCompletion(task)).toBe(0.5);
  });

  it('derives answered-only accuracy from questions[] for legacy tasks', () => {
    // 1 correct of 2 ANSWERED (a 3rd is unanswered) → 0.5 accuracy, 2/3 completion.
    const task = {
      questions: [
        { answered: 5, correct: true },
        { answered: 9, correct: false },
        { answered: null, correct: false },
      ],
    };
    expect(deriveTaskAccuracy(task)).toBe(0.5);
    expect(deriveTaskCompletion(task)).toBeCloseTo(2 / 3, 5);
  });

  it('returns null (never NaN) when there is nothing to derive from', () => {
    expect(deriveTaskAccuracy({ questions: [] })).toBe(null);
    expect(deriveTaskAccuracy({ questions: [{ answered: null }] })).toBe(null);
    expect(deriveTaskCompletion({ questions: [] })).toBe(null);
    expect(deriveTaskCompletion({})).toBe(null);
  });

  it('legacy n-back: balanced SDT derivation, not raw correct-flag averaging', () => {
    // 10-trial legacy n-back run: 2 presses (1 hit, 1 false alarm) and 8 withheld
    // trials whose stored correct:true flags mark them correct rejections. Raw
    // correct-flag averaging would report 0.9; balanced SDT tallies hit 1
    // (pressed+correct), false alarm 1 (pressed+incorrect), correct rejections 8
    // (withheld+correct) → hitRate 1, crRate 8/9 → (1 + 8/9)/2 ≈ 0.944.
    const task = {
      type: 'n-back',
      questions: [
        { answered: 'match', correct: true },   // hit (target)
        { answered: 'match', correct: false },  // false alarm (non-target)
        ...Array.from({ length: 8 }, () => ({ answered: null, correct: true })), // correct rejections
      ],
    };
    expect(deriveTaskAccuracy(task)).toBeCloseTo((1 + 8 / 9) / 2, 5);
    expect(deriveTaskCompletion(task)).toBe(1);
    expect(deriveTaskCompletion({ type: 'n-back', questions: [] })).toBe(null);
  });

  it('legacy n-back never-press run derives ~50 (not the stored raw ~70)', () => {
    // Old scorer marked withheld non-targets correct:true and missed targets
    // correct:false. 7 non-targets + 3 missed targets, no presses → raw average
    // would read 70%; balanced SDT reads (hitRate 0 + crRate 1)/2 = 0.5.
    const task = {
      type: 'n-back',
      questions: [
        ...Array.from({ length: 7 }, () => ({ answered: null, correct: true })),  // correct rejections
        ...Array.from({ length: 3 }, () => ({ answered: null, correct: false })), // misses
      ],
    };
    expect(deriveTaskAccuracy(task)).toBe(0.5);
  });
});

describe('getPostStats — accuracy/completion aggregation', () => {
  const today = new Date().toISOString().split('T')[0];
  beforeEach(() => { vi.clearAllMocks(); });

  function mockSessions(sessions) {
    readJSONFile.mockImplementation((path, defaultValue) => {
      if (String(path).includes('post-sessions')) return Promise.resolve({ sessions });
      return Promise.resolve(defaultValue);
    });
  }

  it('aggregates answered-only accuracy and completion per drill, mixing new + legacy tasks', async () => {
    mockSessions([
      {
        date: today,
        score: 50,
        tasks: [
          // New-shape task: explicit metrics.
          { module: 'mental-math', type: 'doubling-chain', score: 60, accuracy: 1, completion: 0.5, questions: [] },
          // Legacy task (no metrics): derived from questions → accuracy 0.5, completion 1.
          { module: 'mental-math', type: 'doubling-chain', score: 40, questions: [
            { answered: 1, correct: true }, { answered: 2, correct: false },
          ] },
        ],
      },
    ]);
    const stats = await getPostStats(30);
    const key = 'mental-math:doubling-chain';
    // accuracy mean of 1.0 and 0.5 = 0.75; completion mean of 0.5 and 1.0 = 0.75.
    expect(stats.byDrillAccuracy[key]).toBeCloseTo(0.75, 5);
    expect(stats.byDrillCompletion[key]).toBeCloseTo(0.75, 5);
    // Blended byDrill is unchanged (mean of the two scores).
    expect(stats.byDrill[key]).toBe(50);
    expect(stats.byDrillCount[key]).toBe(2);
  });
});

describe('adaptive signal is accuracy-driven — fast-sloppy vs slow-accurate diverge (issue #2094)', () => {
  const today = new Date().toISOString().split('T')[0];
  beforeEach(() => { vi.clearAllMocks(); });

  function mockSessions(sessions) {
    readJSONFile.mockImplementation((path, defaultValue) => {
      const p = String(path);
      if (p.includes('post-sessions')) return Promise.resolve({ sessions });
      if (p.includes('post-config')) return Promise.resolve({ adaptive: { enabled: true } });
      return Promise.resolve(defaultValue);
    });
  }

  // Three doubling-chain tasks (meets minSamples=3), fully completed, at a given
  // answered-only accuracy — the blended score is deliberately identical across
  // the two scenarios to prove the OLD blended-score signal could not tell them apart.
  function accSessions(accuracy) {
    return [{
      date: today,
      score: 55,
      tasks: Array.from({ length: 3 }, () => ({
        module: 'mental-math', type: 'doubling-chain', score: 55,
        accuracy, completion: 1, questions: [],
      })),
    }];
  }

  it('slow-but-accurate (accuracy 1.0) adapts HARDER', async () => {
    mockSessions(accSessions(1));
    const { adaptive } = await resolveDrillConfig('doubling-chain', { steps: 8 });
    expect(adaptive.reason).toBe('harder');
    expect(adaptive.direction).toBe(1);
  });

  it('fast-but-sloppy (accuracy 0.0) adapts EASIER — same blended score, opposite direction', async () => {
    mockSessions(accSessions(0));
    const { adaptive } = await resolveDrillConfig('doubling-chain', { steps: 8 });
    expect(adaptive.reason).toBe('easier');
    expect(adaptive.direction).toBe(-1);
  });

  it('low completion holds difficulty even at high accuracy', async () => {
    const sessions = [{
      date: today, score: 55,
      tasks: Array.from({ length: 3 }, () => ({
        module: 'mental-math', type: 'doubling-chain', score: 55,
        accuracy: 1, completion: 0.2, questions: [],
      })),
    }];
    mockSessions(sessions);
    const { adaptive } = await resolveDrillConfig('doubling-chain', { steps: 8 });
    expect(adaptive.reason).toBe('insufficient-completion');
    expect(adaptive.applied).toBe(false);
  });
});

// =============================================================================
// getPostStats — byModule averaging, days-window cutoff, empty-window shape,
// streak passthrough (issue #2102 gap 1)
// =============================================================================

describe('getPostStats — byModule averaging, days window cutoff, empty-window shape', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  function mockSessions(sessions) {
    readJSONFile.mockImplementation((path, defaultValue) => {
      if (String(path).includes('post-sessions')) return Promise.resolve({ sessions });
      return Promise.resolve(defaultValue);
    });
  }

  it('averages and rounds byModule scores across multiple tasks in a session', async () => {
    const today = new Date().toISOString().split('T')[0];
    // The session-level `score` is deliberately a different number from the
    // task-mean so this can't pass by mistakenly reading the session score
    // instead of averaging byModule's own per-task scores.
    mockSessions([
      {
        date: today, score: 40,
        tasks: [
          { module: 'mental-math', type: 'doubling-chain', score: 60 },
          { module: 'mental-math', type: 'multiplication', score: 75 },
        ],
      },
    ]);
    const stats = await getPostStats(30);
    // (60 + 75) / 2 = 67.5 — JS Math.round rounds .5 up to 68.
    expect(stats.byModule['mental-math']).toBe(68);
  });

  it('includes a session dated exactly at the cutoff boundary (s.date >= cutoff), excludes the day before', async () => {
    const days = 5;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().split('T')[0];
    const [y, m, d] = cutoffStr.split('-').map(Number);
    const dayBeforeStr = new Date(Date.UTC(y, m - 1, d) - 86400000).toISOString().split('T')[0];

    mockSessions([
      { date: cutoffStr, score: 100, tasks: [{ module: 'mental-math', type: 'doubling-chain', score: 100 }] },
      { date: dayBeforeStr, score: 0, tasks: [{ module: 'mental-math', type: 'doubling-chain', score: 0 }] },
    ]);
    const stats = await getPostStats(days);
    expect(stats.sessionCount).toBe(1);
    expect(stats.overall).toBe(100);
  });

  it('returns the zeroed empty-window shape when nothing falls inside the window, but streaks still pass through from all-time history', async () => {
    const oldDate = new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0];
    mockSessions([
      { date: oldDate, score: 50, tasks: [{ module: 'mental-math', type: 'doubling-chain', score: 50 }] },
    ]);
    const stats = await getPostStats(5);
    expect(stats.sessionCount).toBe(0);
    expect(stats.overall).toBeNull();
    expect(stats.byModule).toEqual({});
    expect(stats.byDrill).toEqual({});
    expect(stats.byDrillCount).toEqual({});
    expect(stats.byDrillAccuracy).toEqual({});
    expect(stats.byDrillCompletion).toEqual({});
    // Streaks are computed over ALL history, independent of the stats window —
    // the empty-window branch must still spread them onto the result.
    expect(stats.lastDate).toBe(oldDate);
    expect(stats.completedToday).toBe(false);
  });

  it('passes streak fields through unchanged alongside a non-empty window', async () => {
    const today = new Date().toISOString().split('T')[0];
    mockSessions([
      { date: today, score: 80, tasks: [{ module: 'mental-math', type: 'doubling-chain', score: 80 }] },
    ]);
    const stats = await getPostStats(30);
    expect(stats.completedToday).toBe(true);
    expect(stats.currentStreak).toBe(1);
    expect(stats.todayScore).toBe(80);
  });
});

// =============================================================================
// resolveDrillConfig / getAdaptivePreview — adaptive integration across ALL
// math drill types (issue #2102 gap 3). The pure `adaptDrillConfig` policy is
// already exhaustively covered in postAdaptive.test.js; these tests exercise
// the INTEGRATION — real scored session history flowing through getPostStats
// -> getAdaptiveSignal -> resolveDrillConfig/getAdaptivePreview — for the
// three types that previously only had multiplication/doubling-chain covered.
// =============================================================================

describe('resolveDrillConfig — adaptive integration for serial-subtraction/powers/estimation', () => {
  const today = new Date().toISOString().split('T')[0];
  beforeEach(() => { vi.clearAllMocks(); });

  function mockAdaptiveSessions(type, accuracy, count = 3) {
    readJSONFile.mockImplementation((path, defaultValue) => {
      const p = String(path);
      if (p.includes('post-sessions')) {
        return Promise.resolve({
          sessions: [{
            date: today,
            score: 55,
            tasks: Array.from({ length: count }, () => ({
              module: 'mental-math', type, score: 55, accuracy, completion: 1, questions: [],
            })),
          }],
        });
      }
      if (p.includes('post-config')) return Promise.resolve({ adaptive: { enabled: true } });
      return Promise.resolve(defaultValue);
    });
  }

  it('serial-subtraction: sustained high accuracy nudges MORE steps (harder)', async () => {
    mockAdaptiveSessions('serial-subtraction', 1);
    const { adaptive, config } = await resolveDrillConfig('serial-subtraction', { steps: 10 });
    expect(adaptive.reason).toBe('harder');
    expect(config.steps).toBeGreaterThan(10);
  });

  it('serial-subtraction: sustained low accuracy nudges FEWER steps (easier)', async () => {
    mockAdaptiveSessions('serial-subtraction', 0);
    const { adaptive, config } = await resolveDrillConfig('serial-subtraction', { steps: 10 });
    expect(adaptive.reason).toBe('easier');
    expect(config.steps).toBeLessThan(10);
  });

  it('powers: sustained high accuracy nudges a HIGHER max exponent (harder)', async () => {
    mockAdaptiveSessions('powers', 1);
    const { adaptive, config } = await resolveDrillConfig('powers', { maxExponent: 10 });
    expect(adaptive.reason).toBe('harder');
    expect(config.maxExponent).toBeGreaterThan(10);
  });

  it('powers: sustained low accuracy nudges a LOWER max exponent (easier)', async () => {
    mockAdaptiveSessions('powers', 0);
    const { adaptive, config } = await resolveDrillConfig('powers', { maxExponent: 10 });
    expect(adaptive.reason).toBe('easier');
    expect(config.maxExponent).toBeLessThan(10);
  });

  it('estimation: sustained high accuracy TIGHTENS tolerance (lower % = harder)', async () => {
    mockAdaptiveSessions('estimation', 1);
    const { adaptive, config } = await resolveDrillConfig('estimation', { tolerancePct: 10 });
    expect(adaptive.reason).toBe('harder');
    expect(config.tolerancePct).toBeLessThan(10);
  });

  it('estimation: sustained low accuracy WIDENS tolerance (higher % = easier)', async () => {
    mockAdaptiveSessions('estimation', 0);
    const { adaptive, config } = await resolveDrillConfig('estimation', { tolerancePct: 10 });
    expect(adaptive.reason).toBe('easier');
    expect(config.tolerancePct).toBeGreaterThan(10);
  });

  it('holds under the sample gate even with a perfect accuracy signal', async () => {
    mockAdaptiveSessions('serial-subtraction', 1, 2); // 2 samples, gate is minSamples=3
    const { adaptive, config } = await resolveDrillConfig('serial-subtraction', { steps: 10 });
    expect(adaptive.reason).toBe('insufficient-samples');
    expect(adaptive.applied).toBe(false);
    expect(config.steps).toBe(10);
  });
});

describe('getAdaptivePreview', () => {
  const today = new Date().toISOString().split('T')[0];
  beforeEach(() => { vi.clearAllMocks(); });

  it('reports enabled:false and leaves every drill unapplied when the Adaptive toggle is off', async () => {
    readJSONFile.mockImplementation((path, defaultValue) => {
      const p = String(path);
      if (p.includes('post-sessions')) return Promise.resolve({ sessions: [] });
      if (p.includes('post-config')) return Promise.resolve({ adaptive: { enabled: false } });
      return Promise.resolve(defaultValue);
    });
    const preview = await getAdaptivePreview();
    expect(preview.enabled).toBe(false);
    expect(preview.windowDays).toBeGreaterThan(0);
    expect(preview.thresholds.minSamples).toBeGreaterThan(0);
    expect(Object.keys(preview.drills)).toEqual(
      expect.arrayContaining(['doubling-chain', 'serial-subtraction', 'multiplication', 'powers', 'estimation'])
    );
  });

  it('previews the effective per-type nudge from recent scored performance when enabled', async () => {
    readJSONFile.mockImplementation((path, defaultValue) => {
      const p = String(path);
      if (p.includes('post-sessions')) {
        return Promise.resolve({
          sessions: [{
            date: today,
            score: 55,
            tasks: Array.from({ length: 3 }, () => ({
              module: 'mental-math', type: 'multiplication', score: 55, accuracy: 1, completion: 1, questions: [],
            })),
          }],
        });
      }
      if (p.includes('post-config')) {
        return Promise.resolve({
          adaptive: { enabled: true },
          // progressive:false exercises the generic Adaptive nudge path — with the
          // ladder on (default), the preview shows the ladder rung instead (see the
          // parity describe below, issue #2099).
          mentalMath: { drillTypes: { multiplication: { maxDigits: 2, progressive: false } } },
        });
      }
      return Promise.resolve(defaultValue);
    });
    const preview = await getAdaptivePreview();
    expect(preview.enabled).toBe(true);
    expect(preview.drills.multiplication.reason).toBe('harder');
    expect(preview.drills.multiplication.config.maxDigits).toBe(3);
    // A type with no recent samples falls back to "not enough signal yet".
    expect(preview.drills['doubling-chain'].reason).toBe('insufficient-samples');
  });
});

// =============================================================================
// submitPostSession — non-memory task types recomputed server-side, session
// score rollup, and persistence (issue #2102 gap 7). The memory-drill branch
// is already covered above; this covers math/cognitive/LLM.
// =============================================================================

describe('submitPostSession — non-memory task types', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readJSONFile.mockImplementation((path, defaultValue) => {
      const p = String(path);
      if (p.includes('post-sessions')) return Promise.resolve({ sessions: [] });
      if (p.includes('post-memory-items')) return Promise.resolve({ items: [] });
      return Promise.resolve(defaultValue); // post-config.json -> baseDefaults clone
    });
  });

  it('rescores a math task server-side, ignoring client-tampered expected/correct', async () => {
    const session = await submitPostSession({
      cadence: 'daily',
      modules: ['mental-math'],
      tasks: [{
        module: 'mental-math',
        type: 'doubling-chain',
        config: { startValue: 4, steps: 2 },
        questions: [
          { prompt: '4 x 2', expected: 999, answered: 8, correct: false, responseMs: 500 },
          { prompt: '8 x 2', expected: 999, answered: 16, correct: false, responseMs: 500 },
        ],
        totalMs: 1000,
      }],
      tags: {},
    });

    const task = session.tasks[0];
    expect(task.questions[0].expected).toBe(8);
    expect(task.questions[0].correct).toBe(true);
    expect(task.accuracy).toBe(1);
    expect(task.score).toBeGreaterThan(0);
  });

  it('rescores a cognitive task server-side via scoreCognitiveDrill, ignoring client score', async () => {
    const drillData = {
      type: 'digit-span',
      config: { direction: 'forward', maxLength: 5 },
      sequences: [{ digits: [1, 2, 3], length: 3 }],
    };
    const session = await submitPostSession({
      cadence: 'daily',
      modules: ['cognitive'],
      tasks: [{
        module: 'cognitive',
        type: 'digit-span',
        drillData,
        questions: [{ index: 0, answered: '123', responseMs: 1000 }],
        score: 0, // client-sent score must be ignored — server recomputes via the answer key
        totalMs: 1000,
      }],
      tags: {},
    });

    const task = session.tasks[0];
    expect(task.questions[0].correct).toBe(true);
    expect(task.score).toBeGreaterThan(0);
  });

  it('trusts the client-computed score for LLM drill tasks (never re-scored server-side)', async () => {
    const session = await submitPostSession({
      cadence: 'daily',
      modules: ['llm-drills'],
      tasks: [{
        module: 'llm-drills',
        type: 'word-association',
        responses: [{ questionIndex: 0, response: 'church', responseMs: 3000, llmScore: 90 }],
        score: 87,
        totalMs: 3000,
      }],
      tags: {},
    });
    expect(session.tasks[0].score).toBe(87);
  });

  it('rolls up the session score as the mean of all task scores', async () => {
    const session = await submitPostSession({
      cadence: 'daily',
      modules: ['mental-math', 'llm-drills'],
      tasks: [
        {
          module: 'mental-math', type: 'doubling-chain',
          config: { startValue: 4, steps: 1 },
          questions: [{ prompt: '4 x 2', answered: 8, responseMs: 500 }],
          totalMs: 500,
        },
        { module: 'llm-drills', type: 'word-association', responses: [], score: 50, totalMs: 1000 },
      ],
      tags: {},
    });
    const expectedMean = Math.round((session.tasks[0].score + 50) / 2);
    expect(session.score).toBe(expectedMean);
  });

  it('persists the computed session via atomicWrite with the durationMs/tags rollup', async () => {
    await submitPostSession({
      cadence: 'daily',
      modules: ['mental-math'],
      tasks: [{
        module: 'mental-math', type: 'doubling-chain',
        config: { startValue: 4, steps: 1 },
        questions: [{ prompt: '4 x 2', answered: 8, responseMs: 500 }],
        totalMs: 1234,
      }],
      tags: { mood: 'focused' },
    });

    const sessionWrite = atomicWrite.mock.calls.find(([path]) => String(path).includes('post-sessions'));
    expect(sessionWrite).toBeTruthy();
    const persisted = sessionWrite[1].sessions[0];
    expect(persisted.durationMs).toBe(1234);
    expect(persisted.tags).toEqual({ mood: 'focused' });
    expect(persisted.id).toBeTruthy();
    expect(persisted.date).toBeTruthy();
  });
});

describe('progressive cognitive drills', () => {
  const today = new Date().toISOString().split('T')[0];
  const oldDate = new Date(Date.now() - 60 * 86400000).toISOString().split('T')[0];

  // A completed cognitive drill at `level` with a given task-level accuracy —
  // the shape getCognitiveLevelStats buckets by (accuracy-only mastery).
  function cognitiveSession(type, level, accuracy, date = today, count = 20) {
    return {
      date,
      tasks: [{
        module: 'cognitive',
        type,
        config: { level },
        accuracy,
        totalCount: count,
        questions: Array.from({ length: count }, () => ({ answered: 'x' })),
      }],
    };
  }

  function mockSessions(sessions, configOverride) {
    readJSONFile.mockImplementation((path, defaultValue) => {
      const p = String(path);
      if (p.includes('post-sessions')) return Promise.resolve({ sessions });
      if (p.includes('post-config')) return Promise.resolve(configOverride ?? defaultValue);
      return Promise.resolve(defaultValue);
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts a fresh user at n-back level 0 (1-back) and stamps the rung knobs', async () => {
    mockSessions([]);
    const { config, progression } = await resolveDrillConfig('n-back', { length: 20 });
    expect(progression.level).toBe(0);
    expect(config.level).toBe(0);
    expect(config.n).toBe(1);
    expect(config.stimulusMs).toBe(2500);
  });

  it('advances a cognitive rung on sustained balanced accuracy', async () => {
    // 3 clean 1-back runs at 90% balanced accuracy → clears level 0.
    mockSessions([
      cognitiveSession('n-back', 0, 0.9),
      cognitiveSession('n-back', 0, 0.92),
      cognitiveSession('n-back', 0, 0.95),
    ]);
    const { config, progression } = await resolveDrillConfig('n-back', {});
    expect(progression.level).toBe(1);
    expect(config.n).toBe(2);
  });

  it('does not advance on high-accuracy but low-completion runs (skipped hard trials)', async () => {
    // Answered only the easy sequence (100% accuracy) but left the rest blank —
    // low completion must not bank a mastery sample (issue #2095 review).
    const lowCompletion = (level, date = today) => ({
      date,
      tasks: [{ module: 'cognitive', type: 'digit-span', config: { level }, accuracy: 1, completion: 0.25, totalCount: 4, questions: [{ answered: '1' }] }],
    });
    mockSessions([lowCompletion(0), lowCompletion(0), lowCompletion(0)]);
    const { progression } = await resolveDrillConfig('digit-span', {});
    expect(progression.level).toBe(0);
  });

  it('does not advance when accuracy is below the mastery bar', async () => {
    mockSessions([
      cognitiveSession('n-back', 0, 0.6),
      cognitiveSession('n-back', 0, 0.7),
      cognitiveSession('n-back', 0, 0.5),
    ]);
    const { progression } = await resolveDrillConfig('n-back', {});
    expect(progression.level).toBe(0);
  });

  it('never demotes below the earned floor when the window aged out', async () => {
    mockSessions([
      cognitiveSession('digit-span', 3, 0.9, oldDate),
      cognitiveSession('digit-span', 3, 0.95, oldDate),
      cognitiveSession('digit-span', 3, 0.9, oldDate),
    ]);
    const { progression, config } = await resolveDrillConfig('digit-span', {});
    expect(progression.level).toBe(3);
    expect(progression.floorLevel).toBe(3);
    expect(config.direction).toBe('backward');
  });

  it('passes config through unchanged when the drill Progressive toggle is off', async () => {
    mockSessions([], { cognitive: { drillTypes: { 'n-back': { progressive: false } } } });
    const { config, progression } = await resolveDrillConfig('n-back', { n: 3, stimulusMs: 1200 });
    expect(progression == null).toBe(true);
    expect(config).toEqual({ n: 3, stimulusMs: 1200 });
  });

  it('reaction-time has no ladder — always passes config through', async () => {
    mockSessions([]);
    const { config, progression } = await resolveDrillConfig('reaction-time', { mode: 'choice' });
    expect(progression == null).toBe(true);
    expect(config).toEqual({ mode: 'choice' });
  });

  it('generateDrill stamps the resolved level into the generated cognitive config', async () => {
    mockSessions([]);
    const { config } = await resolveDrillConfig('n-back', { length: 12 });
    const drill = generateDrill('n-back', config);
    expect(drill.config.level).toBe(0);
    expect(drill.config.n).toBe(1);
  });

  it('getCognitiveProgress separates per-level history (n=2 vs n=3 recoverable)', async () => {
    mockSessions([
      cognitiveSession('n-back', 1, 0.9),
      cognitiveSession('n-back', 1, 0.95),
      cognitiveSession('n-back', 1, 0.92),
    ]);
    const progress = await getCognitiveProgress();
    expect(progress['n-back'].level).toBe(2); // level-1 mastered → sits on level 2
    expect(progress['n-back'].levels[1].mastered).toBe(true);
    expect(progress['n-back'].levels[2].mastered).toBe(false);
    // Every laddered type reports; reaction-time is absent.
    expect(Object.keys(progress).sort()).toEqual(['digit-span', 'mental-rotation', 'n-back', 'schulte-table', 'stroop']);
  });

  it('difficulty stamp survives submitPostSession (stored task carries config.level)', async () => {
    mockSessions([]);
    const { config } = await resolveDrillConfig('schulte-table', {});
    const drill = generateDrill('schulte-table', config);
    // Client submits the served drill's config (with level) + drillData.
    const questions = drill.cells.map((_, i) => ({ index: i, answered: i + 1, responseMs: 500 }));
    const session = await submitPostSession({
      modules: ['cognitive'],
      tasks: [{ module: 'cognitive', type: 'schulte-table', config: drill.config, drillData: drill, questions, totalMs: 5000 }],
    });
    const stored = session.tasks[0];
    expect(stored.config.level).toBe(0);
    expect(Number.isFinite(stored.accuracy)).toBe(true);
  });
});

describe('submitPostSession — idempotent upsert by client id (issue #2098)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // A shared in-memory sessions store so a re-submit sees the first write.
    let sessionsStore = { sessions: [] };
    readJSONFile.mockImplementation((path, defaultValue) => {
      const p = String(path);
      if (p.includes('post-sessions')) return Promise.resolve(sessionsStore);
      return Promise.resolve(defaultValue);
    });
    atomicWrite.mockImplementation((path, data) => {
      if (String(path).includes('post-sessions')) sessionsStore = data;
      return Promise.resolve(undefined);
    });
  });

  const ID = '11111111-1111-4111-8111-111111111111';
  const buildBody = () => ({
    id: ID,
    cadence: 'daily',
    modules: ['mental-math'],
    tasks: [{
      module: 'mental-math',
      type: 'doubling-chain',
      config: { startValue: 2, steps: 1 },
      questions: [{ prompt: '2 x 2', expected: 4, answered: 4, responseMs: 500 }],
      totalMs: 500,
    }],
    tags: {},
  });

  it('re-submitting the same id upserts (no duplicate record)', async () => {
    const first = await submitPostSession(buildBody());
    const second = await submitPostSession(buildBody());
    expect(first.id).toBe(ID);
    expect(second.id).toBe(ID);
    const lastWrite = atomicWrite.mock.calls.filter(([p]) => String(p).includes('post-sessions')).pop();
    const stored = lastWrite[1].sessions.filter(s => s.id === ID);
    expect(stored.length).toBe(1);
  });

  it('preserves the original date/startedAt on an idempotent re-submit (no midnight drift)', async () => {
    const first = await submitPostSession(buildBody());
    const second = await submitPostSession(buildBody());
    // A retry keeps the original day + start timestamp so history ordering and
    // streaks can't be corrupted by a re-submit that arrives later (or next day).
    expect(second.date).toBe(first.date);
    expect(second.startedAt).toBe(first.startedAt);
  });

  it('assigns a server uuid when the client omits an id', async () => {
    const { id, ...noId } = buildBody();
    const session = await submitPostSession(noId);
    expect(session.id).toMatch(/^[0-9a-f-]{36}$/i);
  });
});

describe('submitPostSession — memory post-processing never 500s a saved session (issue #2098)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readJSONFile.mockImplementation((path, defaultValue) => {
      const p = String(path);
      if (p.includes('post-memory-items')) {
        // Malformed item (no mastery / schedule) so the mastery merge throws
        // when it dereferences item.mastery.chunks — exercising the isolation.
        return Promise.resolve({ items: [{ id: 'song-1', title: 'Broken' }] });
      }
      if (p.includes('post-sessions')) return Promise.resolve({ sessions: [] });
      return Promise.resolve(defaultValue);
    });
  });

  it('returns the saved session (does not throw) when memory post-processing fails', async () => {
    const session = await submitPostSession({
      cadence: 'daily',
      modules: ['memory'],
      tasks: [{
        module: 'memory',
        type: 'memory-sequence',
        memoryItemId: 'song-1',
        questions: [{ prompt: 'x', expected: 'y', answered: 'y', correct: true, responseMs: 500, chunkId: 'verse-1' }],
        score: 100,
        totalMs: 500,
      }],
      tags: {},
    });
    // The session itself persisted (200-equivalent) despite the memory throw.
    expect(session).toBeTruthy();
    const sessionWrite = atomicWrite.mock.calls.find(([p]) => String(p).includes('post-sessions'));
    expect(sessionWrite).toBeTruthy();
    expect(sessionWrite[1].sessions.length).toBe(1);
  });
});
