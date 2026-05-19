import { describe, it, expect } from 'vitest';
import {
  renderEntitiesSummary,
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

  it(`truncates over-long descriptors at ${ENTITIES_SUMMARY_DESCRIPTOR_MAX} chars with an ellipsis`, () => {
    const long = 'x'.repeat(ENTITIES_SUMMARY_DESCRIPTOR_MAX + 50);
    const out = renderEntitiesSummary({
      characters: [{ name: 'Mira', personality: long }],
    });
    // Descriptor body length stays bounded; trailing ellipsis present.
    const match = out.match(/Mira \(([^)]+)\)/);
    expect(match).toBeTruthy();
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
