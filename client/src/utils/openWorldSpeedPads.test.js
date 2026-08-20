import { describe, it, expect } from 'vitest';
import {
  SPEED_PADS,
  getSpeedPadsList,
  checkSpeedPadOverlap,
  PAD_TRIGGER_RADIUS,
} from './openWorldSpeedPads';

describe('openWorldSpeedPads', () => {
  it('defines a valid set of speed pads with positions and angles', () => {
    expect(SPEED_PADS.length).toBeGreaterThanOrEqual(4);
    const ids = new Set();
    SPEED_PADS.forEach((pad) => {
      expect(typeof pad.id).toBe('string');
      expect(typeof pad.x).toBe('number');
      expect(typeof pad.z).toBe('number');
      expect(typeof pad.angle).toBe('number');
      expect(typeof pad.width).toBe('number');
      expect(typeof pad.length).toBe('number');
      expect(pad.boostSpeed).toBeGreaterThan(30);
      expect(ids.has(pad.id)).toBe(false);
      ids.add(pad.id);
    });
  });

  it('getSpeedPadsList returns pads with half dimensions', () => {
    const list = getSpeedPadsList();
    list.forEach((pad) => {
      expect(pad.halfWidth).toBe(pad.width / 2);
      expect(pad.halfLength).toBe(pad.length / 2);
    });
  });

  it('checkSpeedPadOverlap returns pad when player is directly on it', () => {
    const pad = SPEED_PADS[0];
    const playerPos = { x: pad.x + 0.2, z: pad.z + 0.2 };
    const matched = checkSpeedPadOverlap(playerPos, SPEED_PADS, PAD_TRIGGER_RADIUS);
    expect(matched).toBeDefined();
    expect(matched?.id).toBe(pad.id);
  });

  it('checkSpeedPadOverlap returns pad when player is on the rectangular edge', () => {
    // Pad 0 has length 5.5 (half 2.75). Point at pad.z - 2.5 along the facing direction (-Z)
    const pad = SPEED_PADS[0]; // angle: -Math.PI / 2 (length extends along -Z / +Z in world space)
    const playerPos = { x: pad.x, z: pad.z - 2.5 };
    const matched = checkSpeedPadOverlap(playerPos, SPEED_PADS);
    expect(matched).toBeDefined();
    expect(matched?.id).toBe(pad.id);
  });

  it('checkSpeedPadOverlap returns null when player is far away or invalid', () => {
    expect(checkSpeedPadOverlap(null)).toBeNull();
    expect(checkSpeedPadOverlap({ x: 999, z: 999 })).toBeNull();
    expect(checkSpeedPadOverlap({ x: 'invalid', z: 0 })).toBeNull();
  });
});
