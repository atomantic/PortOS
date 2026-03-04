import { describe, it, expect } from 'vitest';
import {
  generateDoublingChain,
  generateSerialSubtraction,
  generateMultiplication,
  generatePowers,
  generateEstimation,
  scoreDrill,
  computeExpectedFromPrompt,
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
    const { score } = scoreDrill('multiplication', questions, 120000);
    expect(score).toBeGreaterThanOrEqual(90);
    expect(score).toBeLessThanOrEqual(100);
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

  it('unanswered questions count against accuracy', () => {
    const questions = [
      { prompt: '5 x 3', expected: 15, answered: 15, responseMs: 1000 },
      { prompt: '7 x 4', expected: 28, answered: null, responseMs: 0 }
    ];
    const { score } = scoreDrill('multiplication', questions, 60000);
    // 50% accuracy = 40 base, plus speed bonus
    expect(score).toBeGreaterThanOrEqual(40);
    expect(score).toBeLessThanOrEqual(60);
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
});
