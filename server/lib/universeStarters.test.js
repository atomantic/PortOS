import { expect, it } from 'vitest';
import { universeStarterPatch, REALITY_STARTER_ID } from './universeStarters.js';
import { sanitizeTemplate } from '../services/universeBuilder/sanitize.js';
import { universeStylePreset, universeVisualStyleTokens } from './universeVisualStyle.js';

it('round trips shipped text and positive/negative style through the real universe schema and renderer', () => {
  const starter = universeStarterPatch(REALITY_STARTER_ID);
  const stored = sanitizeTemplate({ id: REALITY_STARTER_ID, name: 'Reality', factual: true, ...starter });
  expect(stored).toMatchObject(starter);
  const style = universeStylePreset(stored);
  const tokens = universeVisualStyleTokens(starter);
  expect(style.prompt).toBe(tokens.embrace.join(', '));
  expect(style.negativePrompt).toBe(tokens.avoid.join(', '));
  expect(stored.visualProfile.finishing.mode).toBe('preview');
  expect(stored.characters).toEqual([]);
  expect(stored.places).toEqual([]);
  expect(stored.objects).toEqual([]);
  expect(stored.styleImageRefs).toEqual([]);
});
