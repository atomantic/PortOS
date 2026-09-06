import { describe, it, expect } from 'vitest';
import {
  renderEntitiesSummary,
  renderCharacterNarrativeContext,
  renderStoryCanonDigest,
  CANON_PROMPT_ENTRIES_PER_KIND_MAX,
  CHARACTER_NARRATIVE_FIELD_MAX,
  ENTITIES_SUMMARY_MAX_PER_KIND,
  ENTITIES_SUMMARY_DESCRIPTOR_MAX,
} from './universePromptRenderers.js';

describe('renderEntitiesSummary', () => {
  it('returns empty string for missing/invalid worlds', () => {
    expect(renderEntitiesSummary(null)).toBe('');
    expect(renderEntitiesSummary(undefined)).toBe('');
    expect(renderEntitiesSummary('not an object')).toBe('');
    expect(renderEntitiesSummary({})).toBe('');
  });

  it('renders one line per non-empty kind, joined with newlines', () => {
    const out = renderEntitiesSummary({
      characters: [{ name: 'Mira', role: 'surveyor', physicalDescription: 'short, broad-shouldered' }],
      places: [{ name: 'The Foundry', description: 'industrial district' }],
      objects: [{ name: 'Salt Crystal', significance: 'signal-decoder relic' }],
    });
    expect(out).toContain('Characters: Mira (surveyor — short, broad-shouldered)');
    expect(out).toContain('Places: The Foundry (industrial district)');
    expect(out).toContain('Objects: Salt Crystal (signal-decoder relic)');
    expect(out.split('\n')).toHaveLength(3);
  });

  it('excludes characters already in the bible (excludeCharacterNames), keeping places/objects', () => {
    const world = {
      characters: [
        { name: 'Mira', role: 'surveyor' },
        { name: 'ASTER-9 CHANDELIER', role: 'fixture' },
        { name: 'Off-canon Extra', role: 'walk-on' },
      ],
      places: [{ name: 'The Foundry', description: 'industrial district' }],
    };
    const out = renderEntitiesSummary(world, {
      excludeCharacterNames: new Set(['mira', 'aster-9 chandelier']),
    });
    // Bible characters dropped from the roster; the non-canon one survives.
    expect(out).not.toContain('Mira');
    expect(out).not.toContain('ASTER-9 CHANDELIER');
    expect(out).toContain('Off-canon Extra');
    // Places are never excluded.
    expect(out).toContain('Places: The Foundry');
  });

  it('drops the whole characters line + corrects the +N more count when excluded', () => {
    const chars = Array.from({ length: ENTITIES_SUMMARY_MAX_PER_KIND + 5 }, (_, i) => ({ name: `C${i + 1}`, role: 'r' }));
    // Exclude the first 5 → remaining exactly ENTITIES_SUMMARY_MAX_PER_KIND, no "+N more".
    const exclude = new Set(['c1', 'c2', 'c3', 'c4', 'c5']);
    const out = renderEntitiesSummary({ characters: chars }, { excludeCharacterNames: exclude });
    expect(out).not.toContain('C1 (');
    expect(out).not.toContain('(+'); // exactly maxPerKind remain after exclusion
  });

  it('omits kinds with zero entries', () => {
    const out = renderEntitiesSummary({
      characters: [{ name: 'Mira', role: 'surveyor' }],
      places: [],
    });
    expect(out).toContain('Characters: Mira (surveyor)');
    expect(out).not.toContain('Places');
    expect(out).not.toContain('Objects');
  });

  it('falls back from physicalDescription → personality → description → background', () => {
    const out = renderEntitiesSummary({
      characters: [
        { name: 'Only personality', personality: 'cunning and quiet' },
        { name: 'Only background', background: 'born in the foundry' },
        { name: 'Bare' },
      ],
    });
    expect(out).toContain('Only personality (cunning and quiet)');
    expect(out).toContain('Only background (born in the foundry)');
    expect(out).toContain('Bare');
    // Bare character with no descriptors shouldn't render parens
    expect(out).not.toContain('Bare ()');
  });

  it(`caps at ${ENTITIES_SUMMARY_MAX_PER_KIND} entries per kind with a (+N more) tag`, () => {
    const extra = Array.from({ length: ENTITIES_SUMMARY_MAX_PER_KIND + 3 }, (_, i) => ({
      name: `C${i + 1}`,
      role: 'role',
    }));
    const out = renderEntitiesSummary({ characters: extra });
    expect(out).toContain('C1 (role)');
    expect(out).toContain(`C${ENTITIES_SUMMARY_MAX_PER_KIND} (role)`);
    expect(out).not.toContain(`C${ENTITIES_SUMMARY_MAX_PER_KIND + 1}`);
    expect(out).toContain('(+3 more)');
  });

  it('honors a custom maxPerKind option', () => {
    const out = renderEntitiesSummary(
      { characters: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] },
      { maxPerKind: 1 },
    );
    expect(out).toContain('A');
    expect(out).not.toContain('B');
    expect(out).toContain('(+2 more)');
  });

  it('honors a per-kind maxPerKind map, lifting one kind while defaulting the rest', () => {
    const characters = Array.from({ length: ENTITIES_SUMMARY_MAX_PER_KIND + 5 }, (_, i) => ({ name: `C${i + 1}`, role: 'role' }));
    const places = Array.from({ length: ENTITIES_SUMMARY_MAX_PER_KIND + 2 }, (_, i) => ({ name: `P${i + 1}` }));
    const out = renderEntitiesSummary({ characters, places }, { maxPerKind: { characters: Infinity } });
    // characters uncapped — every one listed, no "(+N more)" on the Characters line
    expect(out).toContain(`C${ENTITIES_SUMMARY_MAX_PER_KIND + 5} (role)`);
    expect(out).not.toMatch(/Characters:.*\(\+\d+ more\)/);
    // places fall back to the default cap with a "(+2 more)" tag
    expect(out).not.toContain(`P${ENTITIES_SUMMARY_MAX_PER_KIND + 1}`);
    expect(out).toMatch(/Places:.*\(\+2 more\)/);
  });

  it(`truncates over-long descriptors at ${ENTITIES_SUMMARY_DESCRIPTOR_MAX} chars with an ellipsis`, () => {
    const long = 'x'.repeat(ENTITIES_SUMMARY_DESCRIPTOR_MAX + 50);
    const out = renderEntitiesSummary({
      characters: [{ name: 'Mira', personality: long }],
    });
    // Descriptor body length stays bounded; trailing ellipsis present.
    const match = out.match(/Mira \(([^)]+)\)/);
    expect(match, 'renderEntitiesSummary should produce a "Mira (...)" descriptor').not.toBeNull();
    expect(match[1].length).toBeLessThanOrEqual(ENTITIES_SUMMARY_DESCRIPTOR_MAX);
    expect(match[1]).toMatch(/…$/);
  });

  it('uses place slugline as label when name is absent', () => {
    const out = renderEntitiesSummary({
      places: [{ slugline: 'INT. FOUNDRY - NIGHT', description: 'the heart' }],
    });
    expect(out).toContain('INT. FOUNDRY - NIGHT (the heart)');
  });

  it('flattens multi-line descriptors to a single line', () => {
    const out = renderEntitiesSummary({
      characters: [{ name: 'Jonas', personality: 'fierce\n\nrelentless' }],
    });
    expect(out).toContain('Jonas (fierce relentless)');
  });
});

describe('renderCharacterNarrativeContext (#6416)', () => {
  const authored = {
    id: 'char-1',
    name: 'Example Character',
    role: 'protagonist',
    ghost: 'Left a crew behind in the collapse.',
    wound: 'Trusts no one with a shared route.',
    lie: 'Needing anyone is what gets people killed.',
    want: 'Buy the solo charter and run the deep line alone.',
    need: 'Let a partner carry half the risk.',
    motivations: 'Pay off the debt before the season closes.',
    relationships: 'Owes the harbourmaster more than money.',
    arcType: 'positive',
  };

  it('renders the authored causal chain a descriptive canon line drops', () => {
    const out = renderCharacterNarrativeContext([authored]);
    expect(out).toContain('lie=Needing anyone is what gets people killed.');
    expect(out).toContain('want=Buy the solo charter and run the deep line alone.');
    expect(out).toContain('need=Let a partner carry half the risk.');
    expect(out).toContain('motives=Pay off the debt before the season closes.');
    expect(out).toContain('relationships=Owes the harbourmaster more than money.');
    expect(out).toContain('arc intent=positive');
  });

  it('marks a name-only character rather than emitting a bare bullet', () => {
    expect(renderCharacterNarrativeContext([{ name: 'Walk-on' }]))
      .toBe('- Walk-on: (framework not authored)');
    expect(renderCharacterNarrativeContext([])).toBe('');
    expect(renderCharacterNarrativeContext(null)).toBe('');
  });

  it('pins the caller-bound character ahead of the cap and reports what it withheld', () => {
    const filler = Array.from({ length: 30 }, (_, i) => ({
      id: `filler-${i}`, name: `Filler ${i}`, want: 'a thing', need: 'another thing',
    }));
    const out = renderCharacterNarrativeContext([...filler, authored], {
      max: 3, priorityIds: ['char-1'], reportOmitted: true,
    });
    expect(out.split('\n')[0]).toContain('Example Character');
    expect(out).toContain('+ 28 more characters not shown');
    expect(out).toContain('do not treat this cast list as complete');
  });

  it('withholds authored psychology for a reveal-gated character when asked to', () => {
    const gated = { ...authored, id: 'char-2', name: 'Masked', spoiler: true };
    const guarded = renderCharacterNarrativeContext([gated], { respectRevealGates: true });
    expect(guarded).toBe('- Masked: (reveal-gated — authored psychology withheld until the story earns it)');
    expect(guarded).not.toContain('Needing anyone');
    // A numeric reveal gate counts too, and author-side planning surfaces that
    // reason over the whole bible still opt out.
    expect(renderCharacterNarrativeContext([{ ...gated, spoiler: false, revealIssue: 4 }], { respectRevealGates: true }))
      .toContain('reveal-gated');
    expect(renderCharacterNarrativeContext([gated])).toContain('Needing anyone');
  });

  it('compacts a runaway field instead of letting one character own the prompt', () => {
    const out = renderCharacterNarrativeContext([{ name: 'Verbose', lie: `x${'y'.repeat(5000)}` }]);
    expect(out.length).toBeLessThan(CHARACTER_NARRATIVE_FIELD_MAX + 60);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('renderStoryCanonDigest (#6416)', () => {
  const universe = (over = {}) => ({
    characters: [{
      id: 'char-lead', name: 'Example Lead', role: 'protagonist',
      physicalDescription: 'weather-burned', lie: 'Asking for help is surrender.',
      want: 'Finish the crossing alone.', need: 'Accept the escort.',
    }],
    places: [{ name: 'Example Harbour' }],
    objects: [],
    ...over,
  });

  it('carries both the descriptive canon and the authored engines', () => {
    const digest = renderStoryCanonDigest(universe(), { protagonistCharacterId: 'char-lead' });
    expect(digest).toContain('Verified Universe protagonist: id=char-lead; name=Example Lead.');
    expect(digest).toContain('characters:\n  - Example Lead [protagonist]: weather-burned');
    expect(digest).toContain('character engines (author-only canon');
    expect(digest).toContain('lie=Asking for help is surrender.');
    expect(digest).toContain('do not have characters recite them as exposition');
  });

  it('keeps a bound protagonist in the descriptive canon past the per-kind cap', () => {
    const filler = Array.from({ length: CANON_PROMPT_ENTRIES_PER_KIND_MAX + 5 }, (_, i) => ({
      id: `extra-${i}`, name: `Extra ${i}`, physicalDescription: 'a face in the crowd',
    }));
    const digest = renderStoryCanonDigest(
      universe({ characters: [...filler, universe().characters[0]] }),
      { protagonistCharacterId: 'char-lead' },
    );
    expect(digest).toContain('- Example Lead [protagonist]');
    expect(digest).toContain('not shown — prompt budget reached');
  });

  it('returns empty for a missing universe', () => {
    expect(renderStoryCanonDigest(null)).toBe('');
    expect(renderStoryCanonDigest('nope')).toBe('');
  });
});
