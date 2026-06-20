import { describe, it, expect } from 'vitest';
import {
  sanitizeTransition,
  sanitizeCharacterArc,
  sanitizeCharacterArcList,
  renderCharacterArcsForPrompt,
  CHARACTER_ARC_LIMITS,
  TRANSITION_KINDS,
} from './seriesCharacterArc.js';

describe('sanitizeTransition', () => {
  it('keeps a well-formed transition and mints an id', () => {
    const t = sanitizeTransition({ kind: 'decision', label: 'Chooses to fight', note: 'turns down the deal' });
    expect(t).toMatchObject({ kind: 'decision', label: 'Chooses to fight', note: 'turns down the deal' });
    expect(t.id).toMatch(/^trn-/);
    expect(t.atIssue).toBeNull();
    expect(t.atSceneAnchor).toBe('');
  });

  it('preserves a valid trn- id', () => {
    const t = sanitizeTransition({ id: 'trn-abc-123', kind: 'realization', label: 'sees the truth' });
    expect(t.id).toBe('trn-abc-123');
  });

  it('drops a transition with an unknown kind', () => {
    expect(sanitizeTransition({ kind: 'nope', label: 'x' })).toBeNull();
  });

  it('drops a transition with a kind but no label and no note', () => {
    expect(sanitizeTransition({ kind: 'decision' })).toBeNull();
  });

  it('clamps atIssue and rejects non-finite', () => {
    expect(sanitizeTransition({ kind: 'decision', label: 'x', atIssue: -5 }).atIssue).toBe(0);
    expect(sanitizeTransition({ kind: 'decision', label: 'x', atIssue: 99999 }).atIssue)
      .toBe(CHARACTER_ARC_LIMITS.ISSUE_MAX);
    expect(sanitizeTransition({ kind: 'decision', label: 'x', atIssue: 'foo' }).atIssue).toBeNull();
  });

  it('exposes the full kind taxonomy', () => {
    expect(TRANSITION_KINDS).toContain('point-of-no-return');
    expect(TRANSITION_KINDS).toContain('sacrifice');
  });
});

describe('sanitizeCharacterArc', () => {
  it('keeps a name-only arc with no canon pointer when it has authored fields', () => {
    const arc = sanitizeCharacterArc({ characterName: 'Mara', want: 'revenge' });
    expect(arc).toMatchObject({ characterId: '', characterName: 'Mara', want: 'revenge', status: 'draft' });
  });

  it('preserves a valid chr- pointer and drops an opaque one', () => {
    expect(sanitizeCharacterArc({ characterId: 'chr-xyz', want: 'w' }).characterId).toBe('chr-xyz');
    expect(sanitizeCharacterArc({ characterId: 'bogus', characterName: 'A', want: 'w' }).characterId).toBe('');
  });

  it('returns null when there is no character identity', () => {
    expect(sanitizeCharacterArc({ want: 'something' })).toBeNull();
  });

  it('returns null when there is identity but no authored content', () => {
    expect(sanitizeCharacterArc({ characterName: 'Ghost' })).toBeNull();
  });

  it('survives on transitions alone', () => {
    const arc = sanitizeCharacterArc({
      characterName: 'Lee',
      transitions: [{ kind: 'sacrifice', label: 'gives up the throne' }],
    });
    expect(arc.transitions).toHaveLength(1);
  });

  it('drops malformed transitions and caps the list', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ kind: 'decision', label: `beat ${i}` }));
    const arc = sanitizeCharacterArc({ characterName: 'Lee', transitions: [...many, { kind: 'bad' }] });
    expect(arc.transitions).toHaveLength(CHARACTER_ARC_LIMITS.TRANSITIONS_PER_ARC_MAX);
  });

  it('coerces an unknown status to draft', () => {
    expect(sanitizeCharacterArc({ characterName: 'A', want: 'w', status: 'final' }).status).toBe('draft');
    expect(sanitizeCharacterArc({ characterName: 'A', want: 'w', status: 'verified' }).status).toBe('verified');
  });
});

describe('sanitizeCharacterArcList', () => {
  it('returns [] for a non-array', () => {
    expect(sanitizeCharacterArcList(null)).toEqual([]);
    expect(sanitizeCharacterArcList('x')).toEqual([]);
  });

  it('drops empty arcs and preserves order', () => {
    const list = sanitizeCharacterArcList([
      { characterName: 'A', want: 'w' },
      { characterName: 'Ghost' }, // dropped: no content
      { characterName: 'B', need: 'n' },
    ]);
    expect(list.map((a) => a.characterName)).toEqual(['A', 'B']);
  });

  it('dedupes by canon pointer last-write-wins', () => {
    const list = sanitizeCharacterArcList([
      { characterId: 'chr-1', characterName: 'Old', want: 'w1' },
      { characterId: 'chr-1', characterName: 'New', want: 'w2' },
    ]);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ characterName: 'New', want: 'w2' });
  });

  it('dedupes by case-folded name when no pointer', () => {
    const list = sanitizeCharacterArcList([
      { characterName: 'mara', want: 'w1' },
      { characterName: 'Mara', want: 'w2' },
    ]);
    expect(list).toHaveLength(1);
    expect(list[0].want).toBe('w2');
  });

  it('caps the arc list', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ characterName: `C${i}`, want: 'w' }));
    expect(sanitizeCharacterArcList(many)).toHaveLength(CHARACTER_ARC_LIMITS.ARCS_PER_SERIES_MAX);
  });
});

describe('renderCharacterArcsForPrompt', () => {
  it('returns null for no arcs', () => {
    expect(renderCharacterArcsForPrompt([])).toBeNull();
    expect(renderCharacterArcsForPrompt(null)).toBeNull();
  });

  it('renders arcs + transition beats', () => {
    const block = renderCharacterArcsForPrompt([
      {
        characterName: 'Mara',
        want: 'revenge',
        need: 'to forgive',
        transitions: [{ kind: 'realization', atIssue: 3, label: 'sees the cost' }],
      },
    ]);
    expect(block).toContain('- Mara');
    expect(block).toContain('wants: revenge');
    expect(block).toContain('needs: to forgive');
    expect(block).toContain('realization (issue 3): sees the cost');
  });
});
