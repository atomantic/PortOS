import { describe, it, expect } from 'vitest';
import { composeStyledPrompt } from './composeStyledPrompt.js';

describe('composeStyledPrompt', () => {
  it('returns the bare prompt + negative when no preset is supplied', () => {
    expect(composeStyledPrompt(' a vault ', ' blur ', null)).toEqual({
      prompt: 'a vault',
      negativePrompt: 'blur',
    });
    expect(composeStyledPrompt('a vault', '', undefined)).toEqual({
      prompt: 'a vault', negativePrompt: '',
    });
  });

  it('prefixes the preset prompt with `. ` separator (deterministic)', () => {
    const r = composeStyledPrompt('a vault', '', { prompt: 'cinematic noir' });
    expect(r.prompt).toBe('cinematic noir. a vault');
  });

  it('appends preset negative after user negative with `, ` separator', () => {
    const r = composeStyledPrompt('x', 'blur', { prompt: '', negativePrompt: 'text, watermark' });
    expect(r.negativePrompt).toBe('blur, text, watermark');
  });

  it('handles missing user prompt — returns just the style part (no trailing `. `)', () => {
    expect(composeStyledPrompt('', '', { prompt: 'cinematic noir' }))
      .toEqual({ prompt: 'cinematic noir', negativePrompt: '' });
  });

  it('handles missing style part — returns just the user prompt', () => {
    expect(composeStyledPrompt('a vault', '', { prompt: '' }))
      .toEqual({ prompt: 'a vault', negativePrompt: '' });
  });

  it('drops empty negatives so the join never produces a leading or trailing `, `', () => {
    expect(composeStyledPrompt('x', '', { prompt: 's', negativePrompt: '' })).toEqual({
      prompt: 's. x', negativePrompt: '',
    });
    expect(composeStyledPrompt('x', '', { prompt: 's', negativePrompt: 'bad' })).toEqual({
      prompt: 's. x', negativePrompt: 'bad',
    });
  });
});
