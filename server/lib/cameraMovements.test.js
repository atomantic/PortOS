import { describe, it, expect } from 'vitest';
import {
  CAMERA_ENERGIES, CAMERA_FAMILIES, CAMERA_FRAMINGS, CAMERA_MOVEMENTS, CAMERA_MOVEMENT_VALUES, CAMERA_SPEEDS, SNAP_CAMERA_MOVEMENTS,
  cameraMovementCatalogForPrompt, cameraMovementFromText, cameraMovementId, getCameraMovement,
  normalizeCameraMovement, shotCameraLabel, shotCameraPrompt, stillMoveForCamera,
} from './cameraMovements.js';
import { FABLELOOM_CAMERA_MOVEMENTS, normalizeFableLoomCameraMovement } from './fableLoomCameraMovements.js';

describe('camera movement catalog', () => {
  it('has unique ids and complete structured fields on every move', () => {
    expect(new Set(CAMERA_MOVEMENT_VALUES).size).toBe(CAMERA_MOVEMENTS.length);
    for (const move of CAMERA_MOVEMENTS) {
      expect(CAMERA_FAMILIES).toContain(move.family);
      expect(CAMERA_ENERGIES).toContain(move.energy);
      expect(CAMERA_SPEEDS).toContain(move.speed);
      expect(CAMERA_FRAMINGS).toContain(move.startFraming);
      expect(CAMERA_FRAMINGS).toContain(move.endFraming);
      for (const key of ['label', 'movement', 'framing', 'end', 'prompt']) expect(move[key].trim().length).toBeGreaterThan(0);
      expect(Object.isFrozen(move)).toBe(true);
    }
  });

  it('adds the scale and time moves', () => {
    for (const id of ['infinite-zoom', 'powers-of-ten', 'locked-time-lapse', 'tilt-shift-miniature', 'crash-zoom-out', 'chase-tracking']) {
      expect(getCameraMovement(id)).toBeTruthy();
    }
    expect(getCameraMovement('powers-of-ten').family).toBe('scale');
    expect(getCameraMovement('locked-time-lapse')).toMatchObject({ family: 'time', still: true });
  });

  it('marks the snap moves used on hit points', () => {
    expect([...SNAP_CAMERA_MOVEMENTS].sort()).toEqual(['crash-zoom', 'crash-zoom-out', 'dutch-roll', 'whip-pan']);
  });

  it('is the catalog FableLoom re-exports, so its stored ids still normalize unchanged', () => {
    expect(FABLELOOM_CAMERA_MOVEMENTS).toBe(CAMERA_MOVEMENTS);
    expect(normalizeFableLoomCameraMovement('Slow Dolly In')).toBe('slow-dolly-in');
    expect(normalizeFableLoomCameraMovement('my own custom move')).toBe('my own custom move');
    expect(normalizeCameraMovement('ORBIT-360')).toBe('orbit-360');
  });
});

describe('lookups', () => {
  it('resolves catalog ids only', () => {
    expect(cameraMovementId('Whip Pan')).toBe('whip-pan');
    expect(cameraMovementId('not a move')).toBe('');
    expect(getCameraMovement('nope')).toBeNull();
    expect(getCameraMovement(undefined)).toBeNull();
  });

  it('finds a move named inside free-text direction', () => {
    expect(cameraMovementFromText('Slow dolly in on the hands')).toBe('slow-dolly-in');
    expect(cameraMovementFromText('whip pan to the drummer')).toBe('whip-pan');
    expect(cameraMovementFromText('Static tripod frame')).toBe('locked-off');
    expect(cameraMovementFromText('something vague')).toBe('');
    expect(cameraMovementFromText('')).toBe('');
  });
});

describe('shotCameraPrompt', () => {
  it('composes the four-part Movement / Speed / Framing / End block', () => {
    const lines = shotCameraPrompt({ move: 'crash-zoom', onBeat: true }).split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^Camera movement: /);
    expect(lines[1]).toMatch(/^Speed: .*land the move exactly on the downbeat\.$/);
    expect(lines[2]).toMatch(/^Framing: Opens on /);
    expect(lines[3]).toMatch(/^End: .*Ends on /);
  });

  it('applies speed, end framing and reason overrides and ignores invalid ones', () => {
    const base = shotCameraPrompt({ move: 'locked-off' });
    expect(shotCameraPrompt({ move: 'locked-off', reason: 'the dancer fills the frame' })).toContain('Reason: the dancer fills the frame');
    expect(shotCameraPrompt({ move: 'locked-off', speed: 'warp', endFraming: 'huge' })).toBe(base);
    expect(shotCameraPrompt({ move: 'slow-dolly-in', endFraming: 'extreme-close' })).not.toBe(shotCameraPrompt({ move: 'slow-dolly-in' }));
  });

  it('is empty for no camera or a move outside the catalog', () => {
    expect(shotCameraPrompt(null)).toBe('');
    expect(shotCameraPrompt({ move: 'teleport' })).toBe('');
  });
});

describe('labels, prompt catalog and composed still moves', () => {
  it('labels a shot camera for the storyboard', () => {
    expect(shotCameraLabel({ move: 'whip-pan', onBeat: true })).toBe('Whip pan, on the downbeat');
    expect(shotCameraLabel({ move: 'locked-off', reason: 'the dancer fills the frame' })).toBe('Locked-off / static, because the dancer fills the frame');
    expect(shotCameraLabel({ move: 'teleport' })).toBe('');
  });

  it('lists every move in the prompt catalog', () => {
    const lines = cameraMovementCatalogForPrompt({ detail: true }).split('\n');
    expect(lines).toHaveLength(CAMERA_MOVEMENTS.length);
    expect(lines.find((line) => line.startsWith('- whip-pan '))).toContain('[rotate, high, snap]');
    expect(cameraMovementCatalogForPrompt().split('\n')).toHaveLength(CAMERA_MOVEMENTS.length);
  });

  it('maps a camera to the nearest composed still move', () => {
    expect(stillMoveForCamera({ move: 'locked-off' })).toBe('hold');
    expect(stillMoveForCamera({ move: 'slow-dolly-in' })).toBe('push');
    expect(stillMoveForCamera({ move: 'truck-left' })).toBe('pan');
    expect(stillMoveForCamera({ move: 'teleport' })).toBeNull();
    expect(stillMoveForCamera(undefined)).toBeNull();
  });
});
