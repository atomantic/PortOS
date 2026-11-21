import { describe, expect, it } from 'vitest';
import { localPromptCharLimit, localPromptCharsForTokens } from './persistentMindPromptBudget.js';

describe('persistent mind local prompt budget', () => {
  it('derives the char limit from the window so large windows are not capped', () => {
    expect(localPromptCharsForTokens(1000)).toBe(3600);
    expect(localPromptCharLimit(131072)).toBe(localPromptCharsForTokens(131072 - 8192));
    expect(localPromptCharLimit(1048576)).toBeGreaterThan(3_000_000);
  });
  it('answers null for an unknown window', () => {
    expect(localPromptCharLimit(null)).toBeNull();
    expect(localPromptCharLimit(0)).toBeNull();
  });
});
