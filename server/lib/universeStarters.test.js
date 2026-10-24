import { expect, it } from 'vitest';
import { universeStarterPatch, REALITY_STARTER_ID } from './universeStarters.js';
import { sanitizeTemplate } from '../services/universeBuilder/sanitize.js';
import { universeStylePreset } from './universeVisualStyle.js';

it('round trips shipped text and positive/negative style through the real universe schema and renderer', () => {
  const starter = universeStarterPatch(REALITY_STARTER_ID);
  const stored = sanitizeTemplate({ id: REALITY_STARTER_ID, name: 'Reality', factual: true, ...starter });
  expect(stored).toMatchObject(starter);
  const style = universeStylePreset(stored);
  expect(style.prompt).toBe(starter.influences.embrace.join(', '));
  expect(style.negativePrompt).toBe(starter.influences.avoid.join(', '));
  expect(stored.characters).toEqual([]);
  expect(stored.places).toEqual([]);
  expect(stored.objects).toEqual([]);
  expect(stored.styleImageRefs).toEqual([]);
});
