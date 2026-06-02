import { describe, it, expect } from 'vitest';
import { composeStyledPrompt, composeCanonStyledPrompt } from './composeStyledPrompt.js';
import { universeStylePreset } from './universeStylePreset.js';

describe('composeStyledPrompt', () => {
  it('returns trimmed prompt/negative with no preset', () => {
    expect(composeStyledPrompt('  hero  ', '  blur ', null))
      .toEqual({ prompt: 'hero', negativePrompt: 'blur' });
  });

  it('prefixes the preset style and appends the preset negative', () => {
    const out = composeStyledPrompt('a hero', 'lowres', { prompt: 'noir comic', negativePrompt: 'blur' });
    expect(out.prompt).toBe('noir comic. a hero');
    expect(out.negativePrompt).toBe('lowres, blur');
  });

  it('avoids a trailing ". " when only one part is present', () => {
    expect(composeStyledPrompt('', 'lowres', { prompt: 'noir comic', negativePrompt: '' }).prompt)
      .toBe('noir comic');
    expect(composeStyledPrompt('a hero', '', { prompt: '', negativePrompt: '' }).prompt)
      .toBe('a hero');
  });
});

describe('composeCanonStyledPrompt', () => {
  // A universe with embrace/avoid influences yields a non-empty style preset
  // via universeStylePreset; assert the canon composer threads name+description
  // through composeStyledPrompt with the universe preset layered on.
  const universe = { influences: { embrace: ['noir', 'rain'], avoid: ['cartoon'] } };

  it('joins "<name>: <description>" as the user prompt', () => {
    const out = composeCanonStyledPrompt({ name: 'Vale', description: 'a tall detective', universe, baseNegative: '' });
    expect(out.prompt).toContain('Vale: a tall detective');
  });

  it('seeds the user negative from baseNegative and keeps the preset avoids', () => {
    const out = composeCanonStyledPrompt({ name: 'Vale', description: 'detective', universe, baseNegative: 'extra fingers' });
    expect(out.negativePrompt).toContain('extra fingers');
    expect(out.negativePrompt).toContain('cartoon');
  });

  it('produces the same result as the inline routine it replaced', () => {
    const baseNegative = 'lowres';
    const viaHelper = composeCanonStyledPrompt({ name: 'Vale', description: 'detective', universe, baseNegative });
    // Mirror the pre-extraction call shape used by UniverseCanonSection / StepCharacters.
    const inline = composeStyledPrompt(
      'Vale: detective',
      baseNegative,
      universeStylePreset(universe),
    );
    expect(viaHelper).toEqual(inline);
  });

  it('passes null preset when universe is absent', () => {
    const out = composeCanonStyledPrompt({ name: 'Vale', description: 'detective', universe: null, baseNegative: 'lowres' });
    expect(out).toEqual({ prompt: 'Vale: detective', negativePrompt: 'lowres' });
  });
});
