import { describe, it, expect } from 'vitest';
import {
  SPRITE_DIRECTIONS, ANCHOR_DIRECTIONS, REFERENCE_FACING, anchorIdForDirection,
  keyColorPhrase, buildMainReferencePrompt, buildAnchorPrompt,
} from './prompts.js';

describe('sprite direction contracts', () => {
  it('exposes the canonical 8-direction order starting at south', () => {
    expect(SPRITE_DIRECTIONS).toHaveLength(8);
    expect(SPRITE_DIRECTIONS[0]).toBe('south');
    expect(new Set(SPRITE_DIRECTIONS).size).toBe(8);
  });

  it('anchors exclude south (the frozen main IS the south anchor)', () => {
    expect(ANCHOR_DIRECTIONS).toHaveLength(7);
    expect(ANCHOR_DIRECTIONS).not.toContain('south');
  });

  it('has a facing clause for every direction', () => {
    for (const d of SPRITE_DIRECTIONS) {
      expect(REFERENCE_FACING[d], d).toBeTruthy();
    }
  });

  it('rear-facing clauses forbid a face', () => {
    for (const d of ['north', 'north-east', 'north-west']) {
      expect(REFERENCE_FACING[d]).toContain('no face');
    }
  });

  it('derives anchor ids', () => {
    expect(anchorIdForDirection('north-west')).toBe('walk-north-west');
  });
});

describe('keyColorPhrase', () => {
  it('names the three standard keys', () => {
    expect(keyColorPhrase('#FF00FF')).toBe('magenta (#FF00FF)');
    expect(keyColorPhrase('#00ff00')).toBe('green (#00FF00)');
    expect(keyColorPhrase('#0000FF')).toBe('blue (#0000FF)');
  });

  it('falls back to magenta when unset', () => {
    expect(keyColorPhrase(null)).toBe('magenta (#FF00FF)');
  });
});

describe('buildMainReferencePrompt', () => {
  it('embeds name, design prompt, and the key color', () => {
    const p = buildMainReferencePrompt({ name: 'Scout', designPrompt: 'a wiry ranger in a mossy cloak', chromaKey: '#00FF00' });
    expect(p).toContain('named Scout');
    expect(p).toContain('a wiry ranger in a mossy cloak');
    expect(p).toContain('green (#00FF00) background');
    expect(p).toContain('walk-south identity reference');
    expect(p).toContain('Return exactly one PNG.');
  });

  it('falls back to the attached-reference instruction without a design prompt', () => {
    const p = buildMainReferencePrompt({ name: 'Scout', designPrompt: '  ', chromaKey: '#FF00FF' });
    expect(p).toContain('Use the attached visual reference as the character design.');
  });
});

describe('buildAnchorPrompt', () => {
  it('embeds the facing clause and key color', () => {
    const p = buildAnchorPrompt({ name: 'Scout', direction: 'east', chromaKey: '#FF00FF' });
    expect(p).toContain('facing due east, a strict right-facing side profile');
    expect(p).toContain('magenta (#FF00FF) background');
    expect(p).toContain('attached Scout character');
  });
});
