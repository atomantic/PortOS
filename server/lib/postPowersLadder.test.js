import { describe, expect, it } from 'vitest';
import { powersBreakdown } from '../../client/src/lib/powersBreakdown.js';
import {
  ALL_POWERS_PAIRS,
  MAX_POWERS_LEVEL,
  POWERS_TECHNIQUES,
  powersPoolForLevel,
  powersTechniqueForPair,
  resolvePowersLevel,
} from './postPowersLadder.js';

describe('powers ladder', () => {
  it('builds cumulative pools in technique order', () => {
    expect(powersPoolForLevel(0)).toEqual(
      ALL_POWERS_PAIRS.filter(pair => pair.technique === 'recall-2')
    );
    for (let level = 1; level <= MAX_POWERS_LEVEL; level += 1) {
      const previous = powersPoolForLevel(level - 1);
      const current = powersPoolForLevel(level);
      expect(current.length).toBeGreaterThan(previous.length);
      expect(current.slice(0, previous.length)).toEqual(previous);
    }
  });

  it('maps every generatable pair to exactly one named technique', () => {
    const keys = ALL_POWERS_PAIRS.map(pair => `${pair.base}^${pair.exponent}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const pair of ALL_POWERS_PAIRS) {
      expect(powersTechniqueForPair(pair.base, pair.exponent)?.technique).toBe(pair.technique);
    }
  });

  it('starts fresh at recall and advances without demoting below the earned floor', () => {
    expect(resolvePowersLevel({}).level).toBe(0);
    const mastered = { samples: 20, accuracy: 1, avgResponseMs: 1000 };
    expect(resolvePowersLevel({ 0: mastered, 1: mastered }).level).toBe(2);
    expect(resolvePowersLevel({}, {}, 3).level).toBe(3);
  });

  it('has a multi-step client teaching breakdown for every generated pair', () => {
    expect(POWERS_TECHNIQUES).toHaveLength(MAX_POWERS_LEVEL + 1);
    for (const pair of ALL_POWERS_PAIRS) {
      const breakdown = powersBreakdown(pair.base, pair.exponent);
      expect(breakdown.technique).toBe(pair.technique);
      expect(breakdown.steps.length).toBeGreaterThanOrEqual(2);
      expect(breakdown.fallback).toBe(false);
    }
  });
});
