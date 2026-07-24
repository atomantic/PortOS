import { describe, it, expect } from 'vitest';
import {
  SPRITE_DIRECTIONS, ANCHOR_DIRECTIONS, REFERENCE_FACING, anchorIdForDirection,
  keyColorPhrase, buildMainReferencePrompt, buildAnchorPrompt, buildTurnaroundPrompt,
  TURNAROUND_VIEWS,
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

  it('appends a trimmed correction clause when provided', () => {
    const p = buildAnchorPrompt({
      name: 'Scout', direction: 'north-east', chromaKey: '#FF00FF',
      correctionPrompt: '  no pocket on the right sleeve  ',
    });
    expect(p).toContain('Important correction — apply this over the attached reference: no pocket on the right sleeve');
    // The correction rides at the end so it reads as an override, not a base clause.
    expect(p.trimEnd().endsWith('no pocket on the right sleeve')).toBe(true);
  });

  it('omits the correction clause for blank/absent input', () => {
    const base = buildAnchorPrompt({ name: 'Scout', direction: 'east', chromaKey: '#FF00FF' });
    const blank = buildAnchorPrompt({ name: 'Scout', direction: 'east', chromaKey: '#FF00FF', correctionPrompt: '   ' });
    expect(base).not.toContain('Important correction');
    expect(blank).toBe(base);
  });
});

describe('buildTurnaroundPrompt (#2979)', () => {
  it('names every panel in TURNAROUND_VIEWS order and pins accessory sides', () => {
    const p = buildTurnaroundPrompt({ name: 'Scout', designPrompt: 'a wiry ranger', chromaKey: '#00FF00' });
    expect(p).toContain('named Scout');
    expect(p).toContain('a wiry ranger');
    expect(p).toContain(`exactly ${TURNAROUND_VIEWS.length} full-body figures`);
    expect(p).toContain('1) front view, facing the viewer');
    expect(p).toContain('2) right-side profile');
    expect(p).toContain('3) back view');
    expect(p).toContain('4) left-side profile');
    // The constraint the sheet exists to enforce.
    expect(p).toContain('SAME anatomical side');
    expect(p).toContain('green (#00FF00) background');
  });

  it('falls back to the attached reference when no design prompt is given', () => {
    const p = buildTurnaroundPrompt({ name: 'Scout', designPrompt: '  ', chromaKey: '#FF00FF' });
    expect(p).toContain('Use the attached visual reference as the character design.');
  });

  it('panel order matches SPRITE_DIRECTIONS\' cardinal facings', () => {
    // The sheet's four panels are the cardinal directions; the three-quarter
    // facings interpolate between adjacent ones.
    expect(TURNAROUND_VIEWS).toEqual(['south', 'east', 'north', 'west']);
    for (const v of TURNAROUND_VIEWS) expect(SPRITE_DIRECTIONS).toContain(v);
  });
});

describe('fromTurnaround prompt variants (#2979)', () => {
  it('tells an anchor to read one panel and emit one figure', () => {
    const p = buildAnchorPrompt({
      name: 'Scout', direction: 'north', chromaKey: '#FF00FF', fromTurnaround: true,
    });
    expect(p).toContain('turnaround model sheet');
    expect(p).toContain(REFERENCE_FACING.north);
    expect(p).toContain('not multiple figures and not panels');
    // Still carries the base anchor contract.
    expect(p).toContain('magenta (#FF00FF) background');
  });

  it('keeps the correction clause last, after the turnaround preamble', () => {
    const p = buildAnchorPrompt({
      name: 'Scout', direction: 'west', chromaKey: '#FF00FF', fromTurnaround: true,
      correctionPrompt: 'satchel on the left hip',
    });
    expect(p.indexOf('turnaround model sheet')).toBeLessThan(p.indexOf('Important correction'));
    expect(p.trimEnd().endsWith('satchel on the left hip')).toBe(true);
  });

  it('is opt-in — the default stays the legacy single-reference copy', () => {
    const legacy = buildAnchorPrompt({ name: 'Scout', direction: 'east', chromaKey: '#FF00FF' });
    expect(legacy).not.toContain('turnaround model sheet');
    const legacyMain = buildMainReferencePrompt({ name: 'Scout', designPrompt: 'x', chromaKey: '#FF00FF' });
    expect(legacyMain).not.toContain('turnaround model sheet');
  });

  it('points the main at the sheet\'s front panel', () => {
    const p = buildMainReferencePrompt({
      name: 'Scout', designPrompt: 'a wiry ranger', chromaKey: '#FF00FF', fromTurnaround: true,
    });
    expect(p).toContain('turnaround model sheet');
    expect(p).toContain(REFERENCE_FACING.south);
    expect(p).toContain('a wiry ranger');
  });
});
