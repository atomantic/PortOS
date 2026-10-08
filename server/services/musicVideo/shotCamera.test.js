import { describe, it, expect } from 'vitest';
import { getCameraMovement } from '../../lib/cameraMovements.js';
import { cameraVarietyReport, isHitShot, parseShotCamera, planShotCameras, shotCameraPromptSection, shotEnergyTier } from './shotCamera.js';

const shot = (overrides = {}) => ({ sectionLabel: 'Verse', sectionIndex: 0, shotIndex: 1, shotCount: 4, sectionEnergy: 0.5, ...overrides });
const family = (camera) => getCameraMovement(camera.move).family;

describe('parseShotCamera', () => {
  it('normalizes a catalog id or label and keeps only valid fields', () => {
    expect(parseShotCamera({ move: 'Whip Pan', speed: 'snap', endFraming: 'medium', onBeat: true, extra: 1 }))
      .toEqual({ move: 'whip-pan', speed: 'snap', endFraming: 'medium', onBeat: true });
    expect(parseShotCamera('slow-dolly-in')).toEqual({ move: 'slow-dolly-in' });
    expect(parseShotCamera({ move: 'slow-dolly-in', speed: 'warp', endFraming: 'huge', onBeat: 'yes' })).toEqual({ move: 'slow-dolly-in' });
  });

  it('rejects unknown moves, placeholders and a still camera without its reason', () => {
    expect(parseShotCamera({ move: 'teleport' })).toBeNull();
    expect(parseShotCamera({ move: '<camera move id>' })).toBeNull();
    expect(parseShotCamera({ move: 'locked-off' })).toBeNull();
    expect(parseShotCamera({ move: 'locked-off', reason: '<why the camera holds, only for a static move>' })).toBeNull();
    expect(parseShotCamera({ move: 'locked-off', reason: ' the dancer fills the frame ' })).toEqual({ move: 'locked-off', reason: 'the dancer fills the frame' });
    expect(parseShotCamera(null)).toBeNull();
    expect(parseShotCamera(['whip-pan'])).toBeNull();
  });
});

describe('shot energy and hit points', () => {
  it('tiers by section energy, reading an unanalyzed chorus as high', () => {
    expect(shotEnergyTier(shot({ sectionEnergy: 0.1 }))).toBe('calm');
    expect(shotEnergyTier(shot({ sectionEnergy: 0.5 }))).toBe('medium');
    expect(shotEnergyTier(shot({ sectionEnergy: 0.9 }))).toBe('high');
    expect(shotEnergyTier(shot({ sectionEnergy: undefined, sectionLabel: 'Chorus 2' }))).toBe('high');
  });

  it('treats the opening hook and a chorus/drop first shot as hits', () => {
    expect(isHitShot(shot({ hook: true }))).toBe(true);
    expect(isHitShot(shot({ sectionLabel: 'Chorus', shotIndex: 0 }))).toBe(true);
    expect(isHitShot(shot({ sectionLabel: 'Chorus', shotIndex: 1 }))).toBe(false);
    expect(isHitShot(shot())).toBe(false);
  });
});

describe('planShotCameras', () => {
  it('gives every non-card shot a catalog move and cards none', () => {
    const cameras = planShotCameras([shot(), shot({ visualLayer: 'card' }), shot({ sectionEnergy: 0.9 })]);
    expect(cameras[1]).toBeNull();
    expect(getCameraMovement(cameras[0].move)).toBeTruthy();
    expect(getCameraMovement(cameras[2].move).energy === 'calm').toBe(false);
  });

  it('snaps on the downbeat at hit points', () => {
    const [camera] = planShotCameras([shot({ sectionLabel: 'Chorus', shotIndex: 0, sectionEnergy: 0.9 })]);
    expect(getCameraMovement(camera.move).snap).toBe(true);
    expect(camera).toMatchObject({ speed: 'snap', onBeat: true });
  });

  it('replaces a model pick that would run one family three times', () => {
    const shots = [shot(), shot(), shot()];
    const proposed = new Map([[0, { move: 'slow-dolly-in' }], [1, { move: 'fast-dolly-in' }], [2, { move: 'push-past' }]]);
    const cameras = planShotCameras(shots, proposed);
    expect(cameras[0].move).toBe('slow-dolly-in');
    expect(cameras[1].move).toBe('fast-dolly-in');
    expect(family(cameras[2])).not.toBe('push-pull');
  });

  it('never runs one family three times over a long deterministic plan', () => {
    const shots = Array.from({ length: 40 }, (_, i) => shot({ sectionEnergy: [0.1, 0.5, 0.9][i % 3], shotIndex: i % 4, sectionLabel: i % 8 < 4 ? 'Verse' : 'Chorus' }));
    const families = planShotCameras(shots).map(family);
    for (let i = 2; i < families.length; i++) expect(families[i] === families[i - 1] && families[i] === families[i - 2]).toBe(false);
  });

  it('keeps performance shots on frontal-safe moves', () => {
    const proposed = new Map([[0, { move: 'orbit-360' }], [1, { move: 'slider-parallax' }]]);
    const cameras = planShotCameras([shot({ shotMode: 'performance', hook: true }), shot({ shotMode: 'performance' })], proposed);
    for (const camera of cameras) {
      const move = getCameraMovement(camera.move);
      expect(move.snap || move.energy === 'high' || ['orbit', 'roll', 'rotate'].includes(move.family)).toBe(false);
    }
    expect(cameras[1].move).toBe('slider-parallax');
  });
});

describe('shotCameraPromptSection', () => {
  it('lists every catalog move with the variety rules', () => {
    const text = shotCameraPromptSection();
    expect(text).toContain('- locked-time-lapse (');
    expect(text).toContain('- crash-zoom-out (');
    expect(text).toMatch(/Hit points .* snap move/);
  });
});

describe('cameraVarietyReport', () => {
  const row = (label, move, sectionLabel = 'Verse', sectionKey = 0, startSec = 0) => ({ label, move, sectionLabel, sectionKey, startSec });

  it('flags three or more static shots in a row', () => {
    const report = cameraVarietyReport([row('A', 'locked-off'), row('B', 'locked-time-lapse'), row('C', 'locked-off'), row('D', 'slow-dolly-in'), row('E', 'locked-off'), row('F', 'locked-off')]);
    expect(report.staticRuns).toEqual([['A', 'B', 'C']]);
    expect(report.notes[0]).toMatch(/^3 static shots in a row \(A – C\)/);
  });

  it('flags a chorus with no snap move and passes one that has it', () => {
    const report = cameraVarietyReport([
      row('V', 'slow-dolly-in'),
      row('C1', 'truck-left', 'Chorus', 1, 45), row('C2', 'orbit-180', 'Chorus', 1, 50),
      row('B', 'pan-left', 'Bridge', 2, 60),
      row('C3', 'whip-pan', 'Chorus', 3, 75), row('C4', '', 'Chorus', 3, 80),
    ]);
    expect(report.snaplessChoruses).toEqual([{ label: 'Chorus', startSec: 45 }]);
    expect(report.notes).toEqual([expect.stringContaining('Chorus at 0:45 has no snap move')]);
  });

  it('reports nothing for a varied storyboard', () => {
    expect(cameraVarietyReport([row('A', 'locked-off'), row('B', 'whip-pan', 'Chorus', 1)]).notes).toEqual([]);
  });
});
