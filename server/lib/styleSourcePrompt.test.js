import { describe, expect, it } from 'vitest';
import { moodBoardSection } from './styleSourcePrompt.js';

describe('moodBoardSection', () => {
  it('leads with the composite style prompt when the board has one', () => {
    const text = moodBoardSection({
      name: 'Foundry',
      description: 'Dusty.',
      stylePrompt: 'granular ink wash, dusty ochre light',
      styleNegative: 'gloss, neon',
      items: [{ analyzedPrompt: 'one pin' }],
    });
    expect(text.indexOf('Composite board style')).toBeLessThan(text.indexOf('one pin'));
    expect(text).toContain('granular ink wash');
    expect(text).toContain('gloss, neon');
  });
});
