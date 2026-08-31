import { describe, expect, it } from 'vitest';
import { buildFalH3MaxPrompt } from './falVideoHandoff.js';

describe('fal H3 Max free-tool handoff', () => {
  it('preserves the shot and appends a non-empty avoid list', () => {
    expect(buildFalH3MaxPrompt('  One continuous tracking shot.  ', ' cuts, logos '))
      .toBe('One continuous tracking shot.\n\nAvoid: cuts, logos');
    expect(buildFalH3MaxPrompt('A quiet room.', '  ')).toBe('A quiet room.');
  });
});
