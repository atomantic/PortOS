import { describe, expect, it } from 'vitest';
import { makeGardenShot } from './garden.js';
import { walkPose } from '../kit/walk.js';
import { DEG } from '../kit/core.js';

describe('cel garden contact plane', () => {
  // Uniquely catches the floor being painted on a distant parallax plane, making planted feet skate.
  it('moves paving by exactly the same camera displacement as a held planted foot', () => {
    const planes = new Map();
    const H = 540, scale = H * 0.36;
    const stage = {
      W: 960, H,
      cached: (key) => ({ key }),
      layer: (_g, image, { cameraX, parallax }) => planes.set(image.key, -cameraX * parallax),
    };
    const garden = makeGardenShot({ stage, song: {}, cel: {}, fps: 24 });
    const heldBeat = 0.4;
    const a = walkPose(heldBeat, heldBeat, { heading: 90 * DEG });
    const b = walkPose(heldBeat + 0.04, heldBeat, { heading: 90 * DEG });
    const cameraA = a.ground[0] * scale, cameraB = b.ground[0] * scale;
    garden.backdrop({ drawImage() {} }, cameraA);
    const floorA = planes.get('garden-ground');
    garden.backdrop({ drawImage() {} }, cameraB);
    const floorB = planes.get('garden-ground');
    const footA = a.pose.legL.foot[0] * scale - cameraA;
    const footB = b.pose.legL.foot[0] * scale - cameraB;
    expect(footB - footA).not.toBe(0);
    expect(footB - footA).toBeCloseTo(floorB - floorA);
  });
});
