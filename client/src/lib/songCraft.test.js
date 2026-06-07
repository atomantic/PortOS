import { describe, it, expect } from 'vitest';
import {
  RHYTHM_SHAPES,
  DIRGE_RHYTHM_SHAPES,
  VOICE_LAYERS,
  LEARNING_STEPS,
  NOTATION_HELP,
  SOLFEGE_DEGREES,
  solfegeForDegree,
} from './songCraft.js';

describe('songCraft reference data', () => {
  it('every rhythm shape carries id, label, bpm band, feel, count and a boolean dirge flag', () => {
    const ids = new Set();
    for (const s of RHYTHM_SHAPES) {
      expect(typeof s.id).toBe('string');
      expect(s.id.length).toBeGreaterThan(0);
      expect(ids.has(s.id)).toBe(false);
      ids.add(s.id);
      expect(typeof s.label).toBe('string');
      expect(typeof s.feel).toBe('string');
      expect(typeof s.count).toBe('string');
      expect(typeof s.bpm.label).toBe('string');
      expect(typeof s.dirge).toBe('boolean');
    }
  });

  it('exposes the dirge family as a subset of all rhythm shapes', () => {
    expect(DIRGE_RHYTHM_SHAPES.length).toBeGreaterThan(0);
    expect(DIRGE_RHYTHM_SHAPES.length).toBeLessThan(RHYTHM_SHAPES.length);
    for (const s of DIRGE_RHYTHM_SHAPES) {
      expect(s.dirge).toBe(true);
    }
    // The slow 4/4 ballad ("500 Miles") must be a dirge-family shape.
    expect(DIRGE_RHYTHM_SHAPES.some((s) => s.id === 'slow-4-4')).toBe(true);
  });

  it('orders voice layers foundation-first with unique sequential order numbers', () => {
    const orders = VOICE_LAYERS.map((l) => l.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(new Set(orders).size).toBe(orders.length);
    // Lead melody is always the first layer learned.
    expect(VOICE_LAYERS[0].id).toBe('lead');
    for (const l of VOICE_LAYERS) {
      expect(typeof l.label).toBe('string');
      expect(typeof l.role).toBe('string');
      expect(typeof l.advice).toBe('string');
    }
  });

  it('every learning step and notation group has the documented shape', () => {
    for (const step of LEARNING_STEPS) {
      expect(typeof step.id).toBe('string');
      expect(typeof step.label).toBe('string');
      expect(typeof step.detail).toBe('string');
    }
    for (const g of NOTATION_HELP) {
      expect(typeof g.title).toBe('string');
      expect(typeof g.summary).toBe('string');
      expect(Array.isArray(g.points)).toBe(true);
      expect(g.points.length).toBeGreaterThan(0);
    }
  });

  it('maps scale degrees to solfège syllables, wrapping octaves', () => {
    expect(SOLFEGE_DEGREES).toHaveLength(7);
    expect(solfegeForDegree(1)).toBe('Do');
    expect(solfegeForDegree(3)).toBe('Mi');
    expect(solfegeForDegree(5)).toBe('Sol');
    // Octave wrap: 8 → Do, 9 → Re.
    expect(solfegeForDegree(8)).toBe('Do');
    expect(solfegeForDegree(9)).toBe('Re');
    expect(solfegeForDegree(null)).toBeNull();
    expect(solfegeForDegree('x')).toBeNull();
  });
});
