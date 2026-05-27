import { describe, it, expect } from 'vitest';
import { buildStyleProbePrompt, hasStyleForProbe } from './StyleProbeImage';

describe('StyleProbeImage — buildStyleProbePrompt', () => {
  it('fuses styleNotes (style guide) + embrace into positive, avoid into negative', () => {
    const u = {
      styleNotes: 'inky noir, heavy rain',
      influences: { embrace: ['high contrast', 'cinematic'], avoid: ['bright', 'pastel'] },
    };
    const { prompt, negativePrompt } = buildStyleProbePrompt(u);
    expect(prompt).toContain('inky noir');
    expect(prompt).toContain('high contrast');
    expect(prompt).toContain('cinematic');
    expect(negativePrompt).toContain('bright');
    expect(negativePrompt).toContain('pastel');
  });

  it('works with only influences (no styleNotes) and only styleNotes (no influences)', () => {
    expect(buildStyleProbePrompt({ influences: { embrace: ['noir'], avoid: [] } }).prompt).toContain('noir');
    expect(buildStyleProbePrompt({ styleNotes: 'watercolor' }).prompt).toContain('watercolor');
  });

  it('returns empty for a null / style-less universe', () => {
    expect(buildStyleProbePrompt(null)).toEqual({ prompt: '', negativePrompt: '' });
    expect(buildStyleProbePrompt({ influences: { embrace: [], avoid: [] } }).prompt).toBe('');
  });
});

describe('StyleProbeImage — hasStyleForProbe', () => {
  it('is true when there is any style guide or embrace influence', () => {
    expect(hasStyleForProbe({ styleNotes: 'x' })).toBe(true);
    expect(hasStyleForProbe({ influences: { embrace: ['noir'] } })).toBe(true);
  });
  it('is false with no style at all', () => {
    expect(hasStyleForProbe(null)).toBe(false);
    expect(hasStyleForProbe({ influences: { embrace: [], avoid: ['bright'] } })).toBe(false);
  });
});
