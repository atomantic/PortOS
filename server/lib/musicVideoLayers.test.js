import { describe, it, expect } from 'vitest';
import { isLayeredComposition, sceneRenderReady, sceneVisualLayer } from './musicVideoLayers.js';

describe('musicVideoLayers', () => {
  it('treats composed renders and composition documents as layered, concat and code as footage-only', () => {
    expect(isLayeredComposition({ composition: { mode: 'composed' } })).toBe(true);
    expect(isLayeredComposition({ composition: { mode: 'document' } })).toBe(true);
    expect(isLayeredComposition({ composition: { mode: 'concat' } })).toBe(false);
    expect(isLayeredComposition({ composition: { mode: 'code' } })).toBe(false);
    expect(isLayeredComposition({})).toBe(false);
    expect(isLayeredComposition(null)).toBe(false);
  });

  it('keeps a still or card layer only in a layered composition', () => {
    const card = { visualLayer: 'card', startSec: 0, endSec: 2 };
    expect(sceneVisualLayer(card, { layered: true })).toBe('card');
    expect(sceneVisualLayer(card, { layered: false })).toBe('footage');
    expect(sceneRenderReady(card, { layered: true })).toBe(true);
    expect(sceneRenderReady({ visualLayer: 'still', startSec: 0, endSec: 2 }, { layered: true })).toBe(false);
  });

  it('a code shot needs only an authored span — never a frame or clip', () => {
    const code = { visualLayer: 'code', startSec: 0, endSec: 2 };
    expect(sceneVisualLayer(code, { layered: true })).toBe('code');
    expect(sceneVisualLayer(code, { layered: false })).toBe('footage');
    expect(sceneRenderReady(code, { layered: true })).toBe(true);
    expect(sceneRenderReady({ visualLayer: 'code' }, { layered: true })).toBe(false);
  });
});
