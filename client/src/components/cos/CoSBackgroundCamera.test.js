import { describe, it, expect } from 'vitest';
import {
  computeCameraDistance,
  COMPACT_FRAME_HEIGHT,
  DESKTOP_FRAME_HEIGHT,
} from './CoSBackgroundCamera.jsx';

describe('computeCameraDistance', () => {
  const z = 3.7;

  it('pulls the camera back proportionally on a tall desktop frame', () => {
    // A 460px-tall background panel on a wide viewport keeps the avatar the
    // same apparent size as the original ~230px framed tile by moving the
    // camera ~2x further away.
    const expected = z * (460 / DESKTOP_FRAME_HEIGHT);
    expect(computeCameraDistance({ width: 1280, height: 460 }, z)).toBeCloseTo(expected, 5);
  });

  it('uses the compact reference height below the 1024px breakpoint', () => {
    const expected = z * (320 / COMPACT_FRAME_HEIGHT);
    expect(computeCameraDistance({ width: 800, height: 320 }, z)).toBeCloseTo(expected, 5);
  });

  it('floors the distance at the base z (never zooms in past the framed tile)', () => {
    // A frame shorter than the reference must NOT pull the camera closer than
    // the base z, otherwise the avatar would appear zoomed in.
    expect(computeCameraDistance({ width: 1280, height: 100 }, z)).toBe(z);
  });

  // Regression: the "avatar zooms way in overnight" bug. A transient zero /
  // pre-layout / hidden measurement (panel collapse-expand, EventLog mounting
  // on the working-on-task transition, tab occlusion ResizeObserver reports)
  // must NOT move the camera. Previously it collapsed distanceScale to the
  // floor and slammed the camera to its closest (zoomed-in) position, which
  // OrbitControls then latched with no reliable correction.
  it('returns null for a zero-height (degenerate) measurement so the camera is left alone', () => {
    expect(computeCameraDistance({ width: 1280, height: 0 }, z)).toBeNull();
  });

  it('returns null for a sub-pixel / zero-width measurement', () => {
    expect(computeCameraDistance({ width: 0, height: 460 }, z)).toBeNull();
    expect(computeCameraDistance({ width: 1280, height: 0.4 }, z)).toBeNull();
  });

  it('returns null for non-finite measurements', () => {
    expect(computeCameraDistance({ width: NaN, height: 460 }, z)).toBeNull();
    expect(computeCameraDistance({ width: 1280, height: undefined }, z)).toBeNull();
  });
});
