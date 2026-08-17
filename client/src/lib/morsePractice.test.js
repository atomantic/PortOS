// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { canAdvanceMorseLevel, selectMorsePrompt } from './morsePractice.js';

const pool = ['K', 'M', 'U', 'R', 'E', 'S', 'N', 'A', 'T'];

describe('selectMorsePrompt', () => {
  it('is deterministic for a seed, pool, and progress snapshot', () => {
    const input = { seed: 'round-1', pool, materialMode: 'groups', groupLength: 5, progress: { charAccuracy: [{ char: 'M', attempts: 8, accuracy: 25 }], confusionPairs: [{ sent: 'M', guessed: 'R', count: 4 }] } };
    expect(selectMorsePrompt(input)).toEqual(selectMorsePrompt(input));
  });

  it('targets weak/confused characters while preserving a non-zero exploration floor', () => {
    const progress = { charAccuracy: [{ char: 'M', attempts: 10, accuracy: 0 }], confusionPairs: [{ sent: 'M', guessed: 'R', count: 10 }] };
    const prompts = Array.from({ length: 100 }, (_, index) => selectMorsePrompt({ seed: index, pool, progress, groupLength: 1 }).text);
    expect(prompts.filter((char) => char === 'M').length).toBeGreaterThan(prompts.filter((char) => char === 'K').length);
    expect(prompts).toContain('K');
  });

  it('falls back to balanced groups when history is sparse or a transfer corpus exceeds the Koch pool', () => {
    const prompt = selectMorsePrompt({ seed: 'fresh', pool: ['K', 'M'], materialMode: 'qso', progress: { charAccuracy: [{ char: 'M', attempts: 1, accuracy: 0 }] } });
    expect(prompt.materialMode).toBe('groups');
    expect([...prompt.text].every((char) => ['K', 'M'].includes(char))).toBe(true);
  });

  it('does not overreact to an early miss and cools recent targets', () => {
    const sparse = { charAccuracy: [{ char: 'M', attempts: 1, accuracy: 0 }], confusionPairs: [] };
    const base = selectMorsePrompt({ seed: 'guard', pool, progress: sparse, groupLength: 1 });
    const cooled = selectMorsePrompt({ seed: 'guard', pool, progress: { charAccuracy: [{ char: 'M', attempts: 10, accuracy: 0 }], confusionPairs: [] }, recentChars: ['M'], groupLength: 1 });
    expect(base.reason).toContain('Balanced coverage');
    expect(cooled.text).not.toBe('M');
  });

  it.each(['words', 'callsigns', 'qso'])('uses bounded %s material within the Koch pool', (materialMode) => {
    const transferPool = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,?/= '.trim().split('');
    const prompt = selectMorsePrompt({ seed: materialMode, pool: transferPool, materialMode });
    expect(prompt.materialMode).toBe(materialMode);
    expect([...prompt.text].every((char) => char === ' ' || transferPool.includes(char))).toBe(true);
  });
});

describe('canAdvanceMorseLevel', () => {
  it('requires enough samples, high accuracy, and a real effective speed', () => {
    expect(canAdvanceMorseLevel({ items: Array.from({ length: 9 }, () => ({ sent: 'K' })), accuracy: 100, effectiveWpm: 18 })).toBe(false);
    expect(canAdvanceMorseLevel({ items: Array.from({ length: 10 }, () => ({ sent: 'K' })), accuracy: 100, effectiveWpm: 5 })).toBe(false);
    expect(canAdvanceMorseLevel({ items: Array.from({ length: 10 }, () => ({ sent: 'K' })), accuracy: 90, effectiveWpm: 18 })).toBe(true);
  });
});
