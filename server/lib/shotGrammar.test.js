import { describe, it, expect } from 'vitest';
import {
  SHOT_TYPES,
  SCREEN_DIRECTIONS,
  normalizeShotType,
  normalizeScreenDirection,
} from './shotGrammar.js';

describe('shotGrammar vocabularies', () => {
  it('exposes frozen, non-empty controlled vocabularies', () => {
    expect(Object.isFrozen(SHOT_TYPES)).toBe(true);
    expect(Object.isFrozen(SCREEN_DIRECTIONS)).toBe(true);
    expect(SHOT_TYPES.length).toBeGreaterThan(0);
    expect(SCREEN_DIRECTIONS).toEqual(['left', 'right', 'neutral']);
  });
});

describe('normalizeShotType', () => {
  it('passes canonical tokens through, case- and whitespace-insensitively', () => {
    expect(normalizeShotType('wide')).toBe('wide');
    expect(normalizeShotType('  MEDIUM ')).toBe('medium');
    expect(normalizeShotType('Over-The-Shoulder')).toBe('over-the-shoulder');
  });

  it('maps common synonyms onto canonical tokens', () => {
    expect(normalizeShotType('CU')).toBe('close');
    expect(normalizeShotType('close-up')).toBe('close');
    expect(normalizeShotType('establishing')).toBe('wide');
    expect(normalizeShotType('OTS')).toBe('over-the-shoulder');
    expect(normalizeShotType('insert')).toBe('extreme-close');
    expect(normalizeShotType('point of view')).toBe('pov');
  });

  it('returns null for unknown / non-string / empty', () => {
    expect(normalizeShotType('banana')).toBe(null);
    expect(normalizeShotType('')).toBe(null);
    expect(normalizeShotType('   ')).toBe(null);
    expect(normalizeShotType(42)).toBe(null);
    expect(normalizeShotType(null)).toBe(null);
    expect(normalizeShotType(undefined)).toBe(null);
    expect(normalizeShotType({})).toBe(null);
  });
});

describe('normalizeScreenDirection', () => {
  it('passes canonical tokens through, case- and whitespace-insensitively', () => {
    expect(normalizeScreenDirection('left')).toBe('left');
    expect(normalizeScreenDirection(' RIGHT ')).toBe('right');
    expect(normalizeScreenDirection('Neutral')).toBe('neutral');
  });

  it('collapses head-on synonyms to neutral', () => {
    for (const v of ['center', 'centre', 'front', 'head-on', 'facing']) {
      expect(normalizeScreenDirection(v)).toBe('neutral');
    }
  });

  it('returns null for unknown / non-string / empty', () => {
    expect(normalizeScreenDirection('sideways')).toBe(null);
    expect(normalizeScreenDirection('')).toBe(null);
    expect(normalizeScreenDirection(0)).toBe(null);
    expect(normalizeScreenDirection(null)).toBe(null);
    expect(normalizeScreenDirection(undefined)).toBe(null);
  });
});
