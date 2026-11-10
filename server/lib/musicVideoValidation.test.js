import { describe, it, expect } from 'vitest';
import { musicVideoPublishPrepareSchema, musicVideoSceneCreateSchema, musicVideoSceneUpdateSchema } from './musicVideoValidation.js';

describe('musicVideoPublishPrepareSchema (DistroKid release answers)', () => {
  const parse = (body) => musicVideoPublishPrepareSchema.safeParse(body);

  it('accepts the release answers the publish panel sends', () => {
    expect(parse({ genre: 'Electronic', secondaryGenre: 'Pop', language: 'English', songwriterRole: 'both', newArtistProfile: false, preserveCaps: true, performerName: 'Alice Example', performerRole: 'Vocals', producerName: 'Alice Example', previewStartSec: 42 }).success).toBe(true);
  });

  it('refuses an unknown songwriter role, an out-of-range preview start, and unknown keys', () => {
    expect(parse({ songwriterRole: 'producer' }).success).toBe(false);
    expect(parse({ previewStartSec: -1 }).success).toBe(false);
    expect(parse({ previewStartSec: 3601 }).success).toBe(false);
    expect(parse({ stores: ['spotify'] }).success).toBe(false);
  });
});

describe('source take (#15588)', () => {
  const sourceTake = { sceneId: 'mvs-source', offsetSec: 1.5 };

  it('accepts a source take on create and update, and clears it with null', () => {
    expect(musicVideoSceneCreateSchema.safeParse({ sourceTake }).data?.sourceTake).toEqual(sourceTake);
    expect(musicVideoSceneCreateSchema.safeParse({ sourceTake: { sceneId: 'mvs-source' } }).success).toBe(true);
    expect(musicVideoSceneUpdateSchema.safeParse({ sourceTake: null }).data).toEqual({ sourceTake: null });
  });

  it('refuses a blank scene, a negative offset, and extra keys', () => {
    expect(musicVideoSceneUpdateSchema.safeParse({ sourceTake: { sceneId: '' } }).success).toBe(false);
    expect(musicVideoSceneUpdateSchema.safeParse({ sourceTake: { sceneId: 'mvs-source', offsetSec: -1 } }).success).toBe(false);
    expect(musicVideoSceneUpdateSchema.safeParse({ sourceTake: { sceneId: 'mvs-source', clip: 'a' } }).success).toBe(false);
    expect(musicVideoSceneCreateSchema.safeParse({ sourceTake, extra: true }).success).toBe(false);
  });
});

describe('scene camera (#10589)', () => {
  it('accepts a catalog camera on create and update, and clears it with null', () => {
    const camera = { move: 'whip-pan', speed: 'snap', endFraming: 'medium', onBeat: true };
    expect(musicVideoSceneCreateSchema.safeParse({ label: 'Hook', camera }).data?.camera).toEqual(camera);
    expect(musicVideoSceneUpdateSchema.safeParse({ camera }).success).toBe(true);
    expect(musicVideoSceneUpdateSchema.safeParse({ camera: null }).data).toEqual({ camera: null });
    expect(musicVideoSceneUpdateSchema.safeParse({ camera: { move: 'locked-off', reason: 'the dancer fills the frame' } }).success).toBe(true);
  });

  it('refuses an unknown move, speed or framing and extra keys', () => {
    for (const camera of [{ move: 'teleport' }, { move: 'whip-pan', speed: 'warp' }, { move: 'whip-pan', endFraming: 'huge' }, { move: 'whip-pan', lens: '35mm' }, { speed: 'snap' }]) {
      expect(musicVideoSceneUpdateSchema.safeParse({ camera }).success).toBe(false);
    }
  });
});
