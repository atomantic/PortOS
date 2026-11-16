import { describe, it, expect } from 'vitest';
import {
  SPRITE_DIRECTIONS, ANCHOR_DIRECTIONS, REFERENCE_FACING, anchorIdForDirection,
  keyColorPhrase, buildMainReferencePrompt, buildAnchorPrompt, buildTurnaroundPrompt,
  buildWalkVideoPrompt, buildScannerPrompt, buildAmbientReferencePrompt, buildAmbientVideoPrompt,
  applyCorrection, viewGeometryClause, TURNAROUND_VIEWS,
} from './prompts.js';
// Namespace import so the SURFACES exhaustiveness guard below can enumerate every
// exported builder rather than trusting a hand-maintained list.
import * as allPrompts from './prompts.js';

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
    expect(p).toContain('square 1:1 canvas');
    expect(p).toContain('Treat the turnaround panels as the source of truth');
  });

  // The bug that motivated #3216. The anchor body pins accessory placement to the
  // attached reference in three separate sentences (and, from the sheet, tells the
  // model to read a specific panel first), so a correction asking to MOVE an
  // accessory contradicts the bulk of the prompt. It has to bracket those clauses
  // — framed before them, overriding after them — not merely follow them.
  // The sandwich's own wording is pinned once, in the `applyCorrection` suite.
  it('brackets the pin-to-reference clauses with an accessory-moving correction', () => {
    const NOTE = 'Hip bag should be on the other leg';
    const p = buildAnchorPrompt({
      name: 'Scout', direction: 'west', chromaKey: '#FF00FF', fromTurnaround: true,
      correctionPrompt: NOTE,
    });
    for (const pinned of ['turnaround model sheet', 'same anatomical side as the attached reference']) {
      expect(p.indexOf(NOTE), pinned).toBeLessThan(p.indexOf(pinned));
      expect(p.lastIndexOf(NOTE), pinned).toBeGreaterThan(p.indexOf(pinned));
    }
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
    expect(p).toContain('square 1:1 canvas');
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
    // The side rule governs WHICH SIDE and WHERE IN FRAME only. If it also
    // asserted visibility it would contradict the per-panel rules — placing a
    // front-worn bag "toward the viewer's right in the back panel" that Panel 3
    // erases — and the model could resolve that by drawing it through the body.
    expect(p).not.toContain('in both profiles');
    expect(p).toContain('Whether it is visible at all in a given panel is decided by that panel\'s rule below');
    TURNAROUND_VIEWS.forEach((view, i) => {
      expect(viewGeometryClause(view), view).not.toBe('');  // toContain('') is vacuously true
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
      // A mirrored front view keeps the face — say so explicitly.
      expect(c).toContain('no face');
    }
    // Absolute only head-on. At 45 degrees a near-hip item still peeks past the
    // hip, so an absolute erase there makes gear pop in and out across anchors.
    expect(viewGeometryClause('north')).toContain('must not be drawn');
    for (const d of ['north-east', 'north-west']) {
      expect(viewGeometryClause(d)).toContain('almost entirely hidden by the body');
      expect(viewGeometryClause(d)).not.toContain('must not be drawn');
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

  it('hedges the far-side occlusion on the diagonals only', () => {
    for (const d of ['east', 'west']) {
      expect(viewGeometryClause(d)).toContain('is occluded by the torso');
      expect(viewGeometryClause(d)).not.toContain('mostly occluded');
    }
    for (const d of ['south-east', 'north-east', 'north-west', 'south-west']) {
      expect(viewGeometryClause(d)).toContain('mostly occluded by the torso');
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
    expect(viewGeometryClause('south')).not.toBe('');  // toContain('') is vacuously true
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

  it('sends a diagonal facing to the two panels it sits between (#3004)', () => {
    // The sheet only has the 4 cardinals, so naming "the panel that shows a
    // three-quarter rear view" points the model at a panel that isn't there.
    const p = buildAnchorPrompt({
      name: 'Scout', direction: 'north-east', chromaKey: '#FF00FF', fromTurnaround: true,
    });
    expect(p).toContain('The sheet has no panel at this exact angle');
    expect(p).toContain(REFERENCE_FACING.north);
    expect(p).toContain(REFERENCE_FACING.east);
    expect(p).not.toContain(`Read the panel that shows the character ${REFERENCE_FACING['north-east']}`);
    // A cardinal facing still reads its own single panel.
    const cardinal = buildAnchorPrompt({
      name: 'Scout', direction: 'east', chromaKey: '#FF00FF', fromTurnaround: true,
    });
    expect(cardinal).toContain(`Read the panel that shows the character ${REFERENCE_FACING.east}`);
    expect(cardinal).not.toContain('no panel at this exact angle');
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

describe('correction prompts on every regeneration surface (#3134)', () => {
  // One table so a newly-added builder can't quietly ship without the
  // correction contract: each row is a builder plus the base params it needs, the
  // noun its clause is expected to name, and the medium it produces — the video
  // rows exist to catch a still-image "keep everything else identical" clause
  // being handed to an image-to-video render, which would freeze the clip.
  const SURFACES = [
    {
      label: 'turnaround sheet',
      fn: buildTurnaroundPrompt,
      build: (extra) => buildTurnaroundPrompt({ name: 'Scout', designPrompt: 'a wiry ranger', chromaKey: '#FF00FF', ...extra }),
      subject: 'turnaround',
      output: 'image',
    },
    {
      label: 'main reference (from the sheet)',
      fn: buildMainReferencePrompt,
      build: (extra) => buildMainReferencePrompt({ name: 'Scout', designPrompt: 'a wiry ranger', chromaKey: '#FF00FF', fromTurnaround: true, ...extra }),
      subject: 'turnaround',
      output: 'image',
    },
    {
      label: 'main reference (legacy, no sheet)',
      fn: buildMainReferencePrompt,
      build: (extra) => buildMainReferencePrompt({ name: 'Scout', designPrompt: 'a wiry ranger', chromaKey: '#FF00FF', ...extra }),
      subject: 'reference',
      output: 'image',
    },
    {
      label: 'directional anchor',
      fn: buildAnchorPrompt,
      build: (extra) => buildAnchorPrompt({ name: 'Scout', direction: 'east', chromaKey: '#FF00FF', ...extra }),
      subject: 'reference',
      output: 'image',
    },
    {
      label: 'ambient/place reference',
      fn: buildAmbientReferencePrompt,
      build: (extra) => buildAmbientReferencePrompt({ name: 'Old Willow', kind: 'place', designPrompt: 'a willow by a pond', chromaKey: '#FF00FF', ...extra }),
      subject: 'reference',
      output: 'image',
    },
    {
      label: 'walk video',
      fn: buildWalkVideoPrompt,
      build: (extra) => buildWalkVideoPrompt({ name: 'Scout', direction: 'east', chromaKey: '#FF00FF', ...extra }),
      subject: 'source image',
      output: 'animation',
    },
    {
      label: 'scanner action video',
      fn: buildScannerPrompt,
      build: (extra) => buildScannerPrompt({ name: 'Scout', direction: 'east', chromaKey: '#FF00FF', ...extra }),
      subject: 'source image',
      output: 'animation',
    },
    {
      label: 'ambient loop video',
      fn: buildAmbientVideoPrompt,
      build: (extra) => buildAmbientVideoPrompt({ name: 'Old Willow', kind: 'place', chromaKey: '#FF00FF', ...extra }),
      subject: 'source image',
      output: 'animation',
    },
  ];

  // The table above is only a contract if it is exhaustive. This set grew #2964 →
  // #3134 → #3152 → #3216 by hand, and a 9th builder that accepted
  // `correctionPrompt` without routing it through `applyCorrection` would ship
  // green — reintroducing exactly the silently-ignored-feedback bug.
  it('covers every prompt builder the module exports', () => {
    const exported = Object.entries(allPrompts)
      .filter(([name, value]) => /^build[A-Za-z]*Prompt$/.test(name) && typeof value === 'function')
      .map(([name]) => name);
    expect(exported.length).toBeGreaterThan(0); // not vacuous
    const covered = new Set(SURFACES.map((s) => s.fn.name));
    expect(exported.filter((name) => !covered.has(name))).toEqual([]);
  });

  for (const { label, build, subject, output } of SURFACES) {
    describe(label, () => {
      it('wraps the body in one trimmed correction sandwich', () => {
        const p = build({ correctionPrompt: '  the strap floats off the shoulder  ' });
        // Framed up front (before any preservation clause can forbid the change)…
        expect(p.startsWith('This is a corrected re-render')).toBe(true);
        expect(p).toContain(
          `Required fix: the strap floats off the shoulder. Make that fix in the ${output} you produce.`
          + ' It takes priority over any instruction below to match or preserve the attached'
          + ` ${subject}`,
        );
        // …and again as the closing override, which names the attachment the
        // untouched details come from.
        expect(p.trimEnd().endsWith(`stays as the attached ${subject} shows it.`)).toBe(true);
        expect(p).toContain(
          'Required fix (highest priority — this overrides any conflicting instruction above):'
          + ' the strap floats off the shoulder',
        );
        // Exactly the two halves — the note is stated twice by design (once was
        // what got ignored), never three times.
        expect(p.match(/the strap floats off the shoulder/g)).toHaveLength(2);
      });

      // A corrected re-roll must not trade the ignored-correction bug for a
      // frozen clip: on an i2v surface the sandwich may not carry the still's
      // "keep everything else identical [to the attachment]" wording, and has to
      // restate that the motion the body asks for still happens.
      it(`keeps the correction consistent with a ${output} output`, () => {
        const p = build({ correctionPrompt: 'the legs barely lift' });
        if (output === 'animation') {
          expect(p).not.toContain('keep everything else identical');
          expect(p).toContain('the motion described above still happens in full');
        } else {
          expect(p).toContain('keep everything else identical');
          expect(p).not.toContain('the motion described above');
        }
      });

      // The hard acceptance criterion: a blank note must not perturb the blind
      // regenerate by even one byte, on any surface.
      it('is byte-identical to a blind regenerate for absent/blank input', () => {
        const base = build({});
        expect(base).not.toContain('Required fix');
        expect(base).not.toContain('corrected re-render');
        for (const blank of [undefined, null, '', '   ', '\n\t ', 42, {}]) {
          expect(build({ correctionPrompt: blank }), String(blank)).toBe(base);
        }
      });
    });
  }
});

describe('applyCorrection', () => {
  // The one place the correction wording is pinned to reviewed text. Every other
  // suite asserts that its surface ROUTES through this helper, not what it says.
  it('states precedence and targets the OUTPUT, not the attachment', () => {
    const p = applyCorrection('BODY.', '  fix the arm  ', { subject: 'turnaround', output: 'image' });
    // "apply this over the attached turnaround" (the pre-#3216 wording) pointed the
    // model at a frozen, usually-correct sheet — so it concluded there was nothing
    // to do. The fix belongs in the image being produced.
    expect(p).not.toContain('apply this over the attached');
    expect(p).toBe(
      'This is a corrected re-render: a previous attempt at this exact image was rejected. '
      + 'Required fix: fix the arm. Make that fix in the image you produce. It takes priority over '
      + 'any instruction below to match or preserve the attached turnaround — change what the fix '
      + 'names, and keep everything else identical. '
      + 'BODY.'
      + ' Required fix (highest priority — this overrides any conflicting instruction above): fix '
      + 'the arm. The previous render was rejected for exactly this, so an image that does not '
      + 'visibly reflect this fix is a failed render. Change only what the fix names; everything it '
      + 'does not mention stays as the attached turnaround shows it.',
    );
  });

  // The image wording tells the model to keep everything the fix doesn't name
  // identical to the attachment. On an image-to-video render that is an
  // instruction to hold still — so the animation medium overrides the body's
  // preserve-the-source clauses while explicitly re-asserting its motion.
  it('preserves the requested motion when the output is an animation', () => {
    const p = applyCorrection('MOVE THE LEGS.', 'the legs barely lift', { subject: 'source image', output: 'animation' });
    expect(p).toBe(
      'This is a corrected re-render: a previous attempt at this exact animation was rejected. '
      + 'Required fix: the legs barely lift. Make that fix in the animation you produce. It takes '
      + 'priority over any instruction below to match or preserve the attached source image — '
      + 'change what the fix names, and leave the rest of the animation exactly as the instructions '
      + 'below describe it. '
      + 'MOVE THE LEGS.'
      + ' Required fix (highest priority — this overrides any conflicting instruction above): the '
      + 'legs barely lift. The previous render was rejected for exactly this, so an animation that '
      + 'does not visibly reflect this fix is a failed render. Change only what the fix names; the '
      + 'motion described above still happens in full, and every other detail of identity and '
      + 'appearance stays as the attached source image shows it.',
    );
    expect(p).not.toContain('keep everything else identical');
  });

  it('keeps a note that already ends in punctuation as written', () => {
    expect(applyCorrection('BODY.', 'Move it up!', { subject: 'reference', output: 'image' }))
      .toContain('Required fix: Move it up! Make');
  });

  it('returns the body untouched for anything blank or non-string', () => {
    for (const v of [undefined, null, '', '   ', '\n\t ', 0, 7, [], {}, () => {}]) {
      expect(applyCorrection('BODY.', v, { subject: 'reference', output: 'image' }), String(v)).toBe('BODY.');
    }
  });

  // Fail loudly, and on the blind path too — a builder that names no medium (or a
  // typo'd one) must not silently inherit still-image wording and only reveal it
  // once a user types a note into a video re-roll.
  it('throws on a missing or unknown output medium, even with no note', () => {
    for (const target of [undefined, {}, { subject: 'reference' }, { subject: 'reference', output: 'video' }]) {
      expect(() => applyCorrection('BODY.', 'fix the arm', target), String(target)).toThrow(/unknown output medium/);
      expect(() => applyCorrection('BODY.', '', target), String(target)).toThrow(/unknown output medium/);
    }
  });
});
