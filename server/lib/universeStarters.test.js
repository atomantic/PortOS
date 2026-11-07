import { expect, it } from 'vitest';
import { universeStarterPatch, REALITY_STARTER_ID, STARTER_UNIVERSE_IDS } from './universeStarters.js';
import { sanitizeTemplate } from '../services/universeBuilder/sanitize.js';
import {
  assembleUniverseStyleText,
  STYLE_SNAPSHOT_MAX,
  universeStylePreset,
  universeStyleRefusal,
  universeVisualStyleTokens,
} from './universeVisualStyle.js';
import { universeStyleSnapshot } from '../services/musicVideo/styleSnapshots.js';

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

it('ensures every starter universe snapshot fits within STYLE_SNAPSHOT_MAX', () => {
  expect(STARTER_UNIVERSE_IDS.length).toBeGreaterThan(0);
  for (const id of STARTER_UNIVERSE_IDS) {
    const starter = universeStarterPatch(id);
    const universe = { id, name: 'Reality', ...starter };
    const text = assembleUniverseStyleText(universe);
    expect(text.length).toBeLessThanOrEqual(STYLE_SNAPSHOT_MAX);
    expect(universeStyleRefusal(universe)).toBeNull();
    const snapshot = universeStyleSnapshot(universe);
    expect(snapshot.length).toBeLessThanOrEqual(STYLE_SNAPSHOT_MAX);
    expect(snapshot).toBe(text.slice(0, STYLE_SNAPSHOT_MAX));
  }
});
