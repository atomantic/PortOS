import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  usableInputTokens,
  planManuscriptPass,
  CHARS_PER_TOKEN,
  FALLBACK_CONTEXT_WINDOW,
} from './contextBudget.js';

const section = (n, chars) => ({ number: n, text: 'x'.repeat(chars) });

describe('contextBudget', () => {
  describe('estimateTokens', () => {
    it('estimates chars/4, rounding up, and tolerates null', () => {
      expect(estimateTokens('')).toBe(0);
      expect(estimateTokens('abcd')).toBe(1);
      expect(estimateTokens('abcde')).toBe(2);
      expect(estimateTokens(null)).toBe(0);
      expect(estimateTokens(undefined)).toBe(0);
    });
  });

  describe('usableInputTokens', () => {
    it('subtracts margin, output reserve, and overhead', () => {
      // 100k window, 10% margin -> 90k; minus 8k reserve minus 2k overhead = 80k
      expect(usableInputTokens({ contextWindow: 100_000, overheadTokens: 2_000 })).toBe(80_000);
    });
    it('falls back to the conservative window when none is declared', () => {
      const u = usableInputTokens({ contextWindow: null, outputReserveTokens: 0, safetyMargin: 0 });
      expect(u).toBe(FALLBACK_CONTEXT_WINDOW);
    });
    it('never goes negative when reserves exceed the window', () => {
      expect(usableInputTokens({ contextWindow: 4_000, outputReserveTokens: 8_000 })).toBe(0);
    });
    it('clamps a nonsensical margin back to the default', () => {
      // margin 2 (>1) is invalid -> default 0.1; 100k -> 90k - 8k = 82k
      expect(usableInputTokens({ contextWindow: 100_000, safetyMargin: 2 })).toBe(82_000);
    });
  });

  describe('planManuscriptPass', () => {
    it('returns whole when the corpus fits the window', () => {
      const plan = planManuscriptPass({
        contextWindow: 1_000_000,
        sections: [section(1, 4_000), section(2, 4_000)],
        outputReserveTokens: 0,
        safetyMargin: 0,
      });
      expect(plan.mode).toBe('whole');
      expect(plan.totalTokens).toBe(2_000);
      expect(plan.usableChars).toBe(plan.usableTokens * CHARS_PER_TOKEN);
    });

    it('returns whole for a single section even if it exceeds the window', () => {
      const plan = planManuscriptPass({
        contextWindow: 8_192,
        sections: [section(1, 1_000_000)],
      });
      expect(plan.mode).toBe('whole');
    });

    it('chunks an over-budget multi-section corpus, preserving order and dropping nothing', () => {
      // window 8192, margin 0, reserve 0 -> usable 8192 tokens = 32768 chars.
      // four 5000-tok sections (20000 chars each) -> packs 1 per chunk (2 would be 10000 > 8192).
      const sections = [section(1, 20_000), section(2, 20_000), section(3, 20_000), section(4, 20_000)];
      const plan = planManuscriptPass({ contextWindow: 8_192, sections, outputReserveTokens: 0, safetyMargin: 0 });
      expect(plan.mode).toBe('chunked');
      const order = plan.chunks.flatMap((c) => c.sections.map((s) => s.number));
      expect(order).toEqual([1, 2, 3, 4]);
      expect(plan.chunks.length).toBe(4);
    });

    it('packs multiple small sections into one chunk up to the budget', () => {
      // usable 8192 tokens; sections of 1000 tokens (4000 chars) each -> 8 fit per chunk
      const sections = Array.from({ length: 10 }, (_, i) => section(i + 1, 4_000));
      const plan = planManuscriptPass({ contextWindow: 8_192, sections, outputReserveTokens: 0, safetyMargin: 0 });
      expect(plan.mode).toBe('chunked');
      expect(plan.chunks[0].sections.length).toBe(8); // 8 * 1000 = 8000 <= 8192
      expect(plan.chunks[1].sections.length).toBe(2);
      const total = plan.chunks.reduce((n, c) => n + c.sections.length, 0);
      expect(total).toBe(10);
    });
  });
});
