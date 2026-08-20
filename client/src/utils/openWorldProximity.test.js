import { describe, it, expect } from 'vitest';
import {
  detectProximity,
  getResolvedLandmarks,
  WORLD_LANDMARKS,
} from './openWorldProximity';

describe('openWorldProximity', () => {
  it('resolves all world landmarks against plan parcels', () => {
    const list = getResolvedLandmarks();
    expect(list.length).toBe(WORLD_LANDMARKS.length);
    list.forEach((lm) => {
      expect(typeof lm.x).toBe('number');
      expect(typeof lm.z).toBe('number');
      expect(typeof lm.label).toBe('string');
      expect(typeof lm.eyebrow).toBe('string');
      expect(typeof lm.action).toBe('string');
    });
  });

  it('detects landmark when player is close', () => {
    const aiCore = getResolvedLandmarks().find((l) => l.id === 'ai-core');
    expect(aiCore).toBeDefined();

    const target = detectProximity({
      playerPos: { x: aiCore.x + 1, y: 1.6, z: aiCore.z + 1 },
      landmarks: [aiCore],
    });

    expect(target).toBeDefined();
    expect(target?.type).toBe('landmark');
    expect(target?.id).toBe('ai-core');
    expect(target?.action).toBe('INSPECT AI RUNS');
  });

  it('detects warp pad with higher priority when close to warp pad', () => {
    const warpPad = {
      id: 'downtown',
      region: { id: 'downtown', label: 'Downtown' },
      position: [10, 0, 10],
    };
    const landmark = {
      id: 'downtown-landmark',
      x: 10,
      z: 10,
      label: 'Downtown Hub',
      eyebrow: 'LANDMARK',
      action: 'VIEW',
    };

    const target = detectProximity({
      playerPos: { x: 10.5, y: 1.6, z: 10.5 },
      warpPads: [warpPad],
      landmarks: [landmark],
    });

    expect(target?.type).toBe('warpPad');
    expect(target?.id).toBe('downtown');
  });

  it('detects easter egg when near its position', () => {
    const egg = {
      id: 'leet',
      label: '1337',
      hint: 'LEET',
      position: [-45, 1.2, 40],
    };

    const target = detectProximity({
      playerPos: { x: -45.5, y: 1.6, z: 40.5 },
      easterEggs: [egg],
    });

    expect(target?.type).toBe('easterEgg');
    expect(target?.id).toBe('leet');
    expect(target?.eyebrow).toBe('EASTER EGG FOUND');
  });

  it('returns null when player is far from all targets', () => {
    const target = detectProximity({
      playerPos: { x: 999, y: 1.6, z: 999 },
      landmarks: getResolvedLandmarks(),
    });
    expect(target).toBeNull();
  });
});
