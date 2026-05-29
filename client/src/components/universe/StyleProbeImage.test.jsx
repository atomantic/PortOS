import { describe, it, expect } from 'vitest';
import { buildStyleProbePrompt, hasStyleForProbe } from './StyleProbeImage';

describe('StyleProbeImage — buildStyleProbePrompt', () => {
  it('uses embrace tokens as positive and avoid tokens as negative', () => {
    const u = {
      styleNotes: 'inky noir, heavy rain',
      influences: { embrace: ['high contrast', 'cinematic'], avoid: ['bright', 'pastel'] },
    };
    const { prompt, negativePrompt } = buildStyleProbePrompt(u);
    expect(prompt).toContain('high contrast');
    expect(prompt).toContain('cinematic');
    expect(negativePrompt).toContain('bright');
    expect(negativePrompt).toContain('pastel');
  });

  it('omits styleNotes — downstream image prompts do not include them, so the probe must not either', () => {
    const u = {
      styleNotes: 'inky noir, heavy rain',
      influences: { embrace: ['high contrast'], avoid: [] },
    };
    expect(buildStyleProbePrompt(u).prompt).not.toContain('inky noir');
    expect(buildStyleProbePrompt(u).prompt).not.toContain('heavy rain');
  });

  it('produces an empty prompt when only styleNotes is present (no embrace influences)', () => {
    expect(buildStyleProbePrompt({ styleNotes: 'watercolor' }).prompt).toBe('');
  });

  it('returns empty for a null / style-less universe', () => {
    expect(buildStyleProbePrompt(null)).toEqual({ prompt: '', negativePrompt: '' });
    expect(buildStyleProbePrompt({ influences: { embrace: [], avoid: [] } }).prompt).toBe('');
  });
});

describe('StyleProbeImage — hasStyleForProbe', () => {
  it('is true when there is any embrace influence', () => {
    expect(hasStyleForProbe({ influences: { embrace: ['noir'] } })).toBe(true);
  });
  it('is false with only styleNotes — those do not reach the image model', () => {
    expect(hasStyleForProbe({ styleNotes: 'x' })).toBe(false);
  });
  it('is false with no style at all', () => {
    expect(hasStyleForProbe(null)).toBe(false);
    expect(hasStyleForProbe({ influences: { embrace: [], avoid: ['bright'] } })).toBe(false);
  });
});
