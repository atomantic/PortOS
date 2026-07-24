import { describe, it, expect } from 'vitest';
import {
  SPRITE_DIRECTIONS, ANCHOR_DIRECTIONS, REFERENCE_FACING, anchorIdForDirection,
  keyColorPhrase, buildMainReferencePrompt, buildAnchorPrompt, buildTurnaroundPrompt,
  buildWalkVideoPrompt, viewGeometryClause, TURNAROUND_VIEWS,
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
    // Panels reuse REFERENCE_FACING so the sheet's labels and the derive
    // prompt that points into it can't drift apart.
    TURNAROUND_VIEWS.forEach((view, i) => expect(p).toContain(`${i + 1}) ${REFERENCE_FACING[view]}`));
    // The constraint the sheet exists to enforce.
    expect(p).toContain('SAME anatomical side');
    expect(p).toContain('green (#00FF00) background');
  });

  it('falls back to the attached reference when no design prompt is given', () => {
    const p = buildTurnaroundPrompt({ name: 'Scout', designPrompt: '  ', chromaKey: '#FF00FF' });
    expect(p).toContain('Use the attached visual reference as the character design.');
  });

  it('forbids mirroring and gives every panel its own occlusion rule (#3004)', () => {
    const p = buildTurnaroundPrompt({ name: 'Scout', designPrompt: 'a wiry ranger', chromaKey: '#FF00FF' });
    // Rotation, not reflection — the instruction that kills the mirrored-front bug.
    expect(p).toContain('rotated in place about a vertical axis');
    expect(p).toContain('No panel is a horizontal flip, mirror, or copy of another panel');
    // "Same anatomical side" is now paired with where that lands on screen, so
    // the rule can't be satisfied by leaving the item in the same pixels.
    expect(p).toContain('viewer\'s left in the front panel');
    expect(p).toContain('viewer\'s right in the back panel');
    // The reported failure: a front-worn hip bag surviving into the back panel.
    expect(p).toContain('hip bag or pouch worn at the front');
    expect(p).toContain('hidden by the body and must not be drawn');
    // The side rule must not claim far-side gear is visible in BOTH profiles —
    // that contradicts the per-panel occlusion rules and invites the model to
    // draw a right-hip bag straight through the torso in the west panel.
    expect(p).not.toContain('in both profiles');
    expect(p).toContain('visible only in the panels where that side of the body faces the viewer');
    TURNAROUND_VIEWS.forEach((view, i) => {
      expect(p).toContain(`Panel ${i + 1} (${REFERENCE_FACING[view]}): ${viewGeometryClause(view)}`);
    });
  });

  it('panel order matches SPRITE_DIRECTIONS\' cardinal facings', () => {
    // The sheet's four panels are the cardinal directions; the three-quarter
    // facings interpolate between adjacent ones.
    expect(TURNAROUND_VIEWS).toEqual(['south', 'east', 'north', 'west']);
    for (const v of TURNAROUND_VIEWS) expect(SPRITE_DIRECTIONS).toContain(v);
  });
});

describe('viewGeometryClause (#3004)', () => {
  it('hides front-mounted gear from every rear-ish facing', () => {
    for (const d of ['north', 'north-east', 'north-west']) {
      const c = viewGeometryClause(d);
      expect(c).toContain('behind the character');
      expect(c).toContain('hip bag or pouch worn at the front');
      expect(c).toContain('must not be drawn');
      // A mirrored front view keeps the face — say so explicitly.
      expect(c).toContain('no face');
    }
  });

  it('hides back-mounted gear from every front-ish facing', () => {
    for (const d of ['south', 'south-east', 'south-west']) {
      const c = viewGeometryClause(d);
      expect(c).toContain('in front of the character');
      expect(c).toContain('backpack');
      expect(c).not.toContain('no face');
    }
  });

  it('names the near side correctly for each profile', () => {
    // Facing due east the character looks screen-right, so the viewer stands
    // off their right shoulder (face east and south is on your right).
    for (const d of ['east', 'south-east', 'north-east']) {
      expect(viewGeometryClause(d)).toContain('character\'s right side');
    }
    for (const d of ['west', 'south-west', 'north-west']) {
      expect(viewGeometryClause(d)).toContain('character\'s left side');
    }
  });

  it('covers every sprite direction and stays silent on unknown ones', () => {
    for (const d of SPRITE_DIRECTIONS) expect(viewGeometryClause(d)).not.toBe('');
    expect(viewGeometryClause('nowhere')).toBe('');
  });
});

describe('derive prompts carry the geometry rule (#3004)', () => {
  it('appends the facing\'s occlusion rule to every anchor prompt', () => {
    for (const d of ANCHOR_DIRECTIONS) {
      const p = buildAnchorPrompt({ name: 'Scout', direction: d, chromaKey: '#FF00FF' });
      expect(p).toContain('not a mirrored copy of the reference');
      // toContain('') is vacuously true, so pin the clause is non-empty first —
      // otherwise a viewGeometryClause regressed to '' would still pass here.
      expect(viewGeometryClause(d), d).not.toBe('');
      expect(p).toContain(viewGeometryClause(d));
    }
    // Concrete anchors on each axis. north is a straight-on rear view, so it
    // carries the depth rule and no near-side clause; east carries the reverse.
    const north = buildAnchorPrompt({ name: 'Scout', direction: 'north', chromaKey: '#FF00FF' });
    expect(north).toContain('hidden by the body and must not be drawn');
    expect(north).not.toContain('occluded by the torso');
    const east = buildAnchorPrompt({ name: 'Scout', direction: 'east', chromaKey: '#FF00FF' });
    expect(east).toContain('right-side gear reads fully');
    expect(east).not.toContain('behind the character');
  });

  it('keeps the main reference free of back-mounted gear', () => {
    const p = buildMainReferencePrompt({ name: 'Scout', designPrompt: 'x', chromaKey: '#FF00FF' });
    expect(p).toContain(viewGeometryClause('south'));
  });

  it('stops the walk video from inventing gear the anchor hides', () => {
    const p = buildWalkVideoPrompt({ name: 'Scout', direction: 'north', chromaKey: '#FF00FF' });
    expect(p).toContain('do not add gear that the source image does not show');
    expect(p).toContain('stays hidden for the whole loop');
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
