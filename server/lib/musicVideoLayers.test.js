import { describe, it, expect } from 'vitest';
import { documentSceneVisualLayer, isLayeredComposition, isSelfDrawnLayer, sceneRenderReady, sceneVisualLayer } from './musicVideoLayers.js';

describe('musicVideoLayers', () => {
  it('treats composed, document and Blender renders as layered, concat and code as footage-only', () => {
    expect(isLayeredComposition({ composition: { mode: 'composed' } })).toBe(true);
    expect(isLayeredComposition({ composition: { mode: 'document' } })).toBe(true);
    expect(isLayeredComposition({ composition: { mode: 'blender' } })).toBe(true);
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

  it('groups cards and code shots as drawn by the composition: no frame or clip to generate', () => {
    expect(['footage', 'still', 'card', 'code', undefined].map(isSelfDrawnLayer)).toEqual([false, false, true, true, false]);
  });

  it('hands a generated code-first document a code shot as code, and an unlayered procedural span as a card', () => {
    const project = { productionPolicy: { strategy: 'code-first' }, treatment: { shotDirections: [
      { sceneId: 'code', medium: 'procedural' }, { sceneId: 'plain', medium: 'procedural' },
    ] } };
    expect(documentSceneVisualLayer(project, { sceneId: 'code', visualLayer: 'code' }, { generated: true })).toBe('code');
    expect(documentSceneVisualLayer(project, { sceneId: 'plain', visualLayer: 'footage' }, { generated: true })).toBe('card');
    // An imported document is handed the director's layer as it is.
    expect(documentSceneVisualLayer(project, { sceneId: 'code', visualLayer: 'code' })).toBe('code');
  });
});

describe('sharedTakeExtraSec', () => {
  const piece = (sceneId, startSec, endSec, extra = {}) => ({ sceneId, startSec, endSec, videoHistoryId: 'take-1', ...extra });

  it('asks the first piece of a shared take to cover the furthest offset among the pieces', async () => {
    const { sharedTakeExtraSec } = await import('./musicVideoLayers.js');
    const first = piece('a', 0, 1.75);
    const later = piece('b', 5, 7, { offsetFrames: 180 }); // starts 7.5 s into the take, plays 2 s -> 9.5 s
    expect(sharedTakeExtraSec(first, [first, later])).toBeCloseTo(9.5 - 1.75, 5);
    expect(sharedTakeExtraSec(later, [first, later])).toBe(0);
  });

  it('is zero for an unshared take', async () => {
    const { sharedTakeExtraSec } = await import('./musicVideoLayers.js');
    const first = piece('a', 0, 1.75);
    expect(sharedTakeExtraSec(first, [first, piece('b', 5, 9, { videoHistoryId: 'other' })])).toBe(0);
  });
});
