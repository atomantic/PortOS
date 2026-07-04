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
  getPostStats,
  deriveTaskAccuracy,
  deriveTaskCompletion,
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
    // One write for the schedule advance, one for the mastery merge.
    expect(memoryWrites.length).toBe(2);
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

  it('does not advance a schedule for an unsupported memory drill type with no memoryItemId', async () => {
    await submitPostSession({
      cadence: 'daily',
      modules: ['memory'],
      tasks: [{
        module: 'memory',
        type: 'memory-fill-blank',
        questions: [{ prompt: 'a ____ line', expected: 'test', answered: 'test', correct: true, responseMs: 500 }],
        totalMs: 500,
      }],
      tags: {},
    });

    const memoryWrite = atomicWrite.mock.calls.find(([path]) => String(path).includes('post-memory-items'));
    expect(memoryWrite).toBeUndefined();
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
