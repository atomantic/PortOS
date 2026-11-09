import { describe, expect, it, vi } from 'vitest';
import { _collectColorMatchMeasurements } from './shotColorMatch.js';

const stats = { lumaP5: 0.1, lumaP50: 0.4, lumaP95: 0.8, lumaMean: 0.4, chromaU: 0, chromaV: 0 };

describe('_collectColorMatchMeasurements', () => {
  it('measures an image take and materializes a selected still that has no take row', async () => {
    const project = {
      cameras: [{ id: 'cam', name: 'Observer', kind: 'observer' }],
      scenes: [{
        sceneId: 's1',
        referenceImageId: 'img-1',
        visualLayer: 'still',
        shotSheet: { cameraId: 'cam', location: 'Lawn', timeOfDay: 'Night' },
      }],
    };
    const { project: ready, measurements } = await _collectColorMatchMeasurements(project, {
      resolveImage: () => '/tmp/fake.png',
      readImage: async () => stats,
    });
    const take = ready.scenes[0].takes.find((entry) => entry.kind === 'image' && entry.assetId === 'img-1');
    expect(take?.takeId).toBeTruthy();
    expect(measurements[take.takeId]).toEqual(stats);
  });

  it('skips a shot that has no location or time of day', async () => {
    const readImage = vi.fn(async () => stats);
    const { measurements } = await _collectColorMatchMeasurements({
      cameras: [{ id: 'cam', name: 'Observer', kind: 'observer' }],
      scenes: [{ sceneId: 's1', referenceImageId: 'img-1', shotSheet: { cameraId: 'cam' } }],
    }, { resolveImage: () => '/tmp/fake.png', readImage });
    expect(measurements).toEqual({});
    expect(readImage).not.toHaveBeenCalled();
  });
});
