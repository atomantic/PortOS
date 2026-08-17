// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
  CAMERA_FIT_PADDING,
  LABEL_MAX_CHARS,
  MIN_BOUNDS_RADIUS,
  MIN_FIT_DISTANCE,
  computeGraphBounds,
  fitCameraToBounds,
  goalLabelColor,
  goalLabelFontSize,
  goalLabelOffsetY,
  goalLabelText,
  goalNodeRadius,
  labelFadeRange,
  labelOpacityForDistance,
  orbitDistanceLimits
} from './goalTreeScene';

const node = (over = {}) => ({ id: 'g1', title: 'Ship the thing', x: 0, y: 0, z: 0, ...over });

describe('goalNodeRadius', () => {
  it('sizes apex and sub-apex above standard goals', () => {
    expect(goalNodeRadius(node({ goalType: 'apex' }))).toBeGreaterThan(goalNodeRadius(node({ goalType: 'sub-apex' })));
    expect(goalNodeRadius(node({ goalType: 'sub-apex' }))).toBeGreaterThan(goalNodeRadius(node()));
  });

  it('scales a standard goal with urgency and falls back for a missing one', () => {
    expect(goalNodeRadius(node({ urgency: 1 }))).toBeGreaterThan(goalNodeRadius(node({ urgency: 0 })));
    // `?? 0.3`, not `|| 0.3` — a legitimately zero urgency must stay zero.
    expect(goalNodeRadius(node({ urgency: 0 }))).toBe(0.5);
    expect(goalNodeRadius(node())).toBe(goalNodeRadius(node({ urgency: 0.3 })));
  });
});

describe('goalLabelText', () => {
  it('passes a short title through untouched', () => {
    expect(goalLabelText('Learn to sail')).toBe('Learn to sail');
  });

  it('clips a long title to a readable stem with an ellipsis', () => {
    const long = 'Build an entirely self-sufficient off-grid workshop by the lake';
    const clipped = goalLabelText(long);
    expect(clipped.length).toBeLessThanOrEqual(LABEL_MAX_CHARS);
    expect(clipped.endsWith('…')).toBe(true);
    expect(long.startsWith(clipped.slice(0, -1).trimEnd())).toBe(true);
  });

  it('trims surrounding whitespace and returns empty for a missing title', () => {
    expect(goalLabelText('  Run a marathon  ')).toBe('Run a marathon');
    expect(goalLabelText(undefined)).toBe('');
    expect(goalLabelText(null)).toBe('');
    expect(goalLabelText(42)).toBe('');
  });
});

describe('label sizing', () => {
  it('reads apex and sub-apex larger than a standard goal', () => {
    expect(goalLabelFontSize(node({ goalType: 'apex' }))).toBeGreaterThan(goalLabelFontSize(node({ goalType: 'sub-apex' })));
    expect(goalLabelFontSize(node({ goalType: 'sub-apex' }))).toBeGreaterThan(goalLabelFontSize(node()));
    expect(goalLabelFontSize(node({ goalType: 'nonsense' }))).toBe(goalLabelFontSize(node()));
  });

  it('lifts every label clear of the sphere it names', () => {
    for (const goalType of ['apex', 'sub-apex', 'standard', undefined]) {
      const n = node({ goalType, urgency: 1 });
      expect(goalLabelOffsetY(n)).toBeGreaterThan(goalNodeRadius(n));
    }
  });

  it('gives apex and sub-apex their own colours', () => {
    const colors = new Set(['apex', 'sub-apex', 'standard'].map(t => goalLabelColor(node({ goalType: t }))));
    expect(colors.size).toBe(3);
    expect(goalLabelColor(node({ goalType: 'nonsense' }))).toBe(goalLabelColor(node()));
  });
});

describe('computeGraphBounds', () => {
  it('returns null when there is nothing to frame', () => {
    expect(computeGraphBounds([])).toBeNull();
    expect(computeGraphBounds(undefined)).toBeNull();
    expect(computeGraphBounds([null])).toBeNull();
  });

  it('centres on the extents and covers every node radius', () => {
    const bounds = computeGraphBounds([
      node({ id: 'a', x: -10, y: 0, z: 0 }),
      node({ id: 'b', x: 10, y: 4, z: -6 })
    ]);
    expect(bounds.center[0]).toBeCloseTo(0);
    expect(bounds.center[1]).toBeCloseTo(2);
    expect(bounds.center[2]).toBeCloseTo(-3);
    // Width spans the two nodes PLUS both radii, not just centre-to-centre.
    expect(bounds.size[0]).toBeGreaterThan(20);
  });

  it('floors the radius so a single node does not slam the camera into it', () => {
    expect(computeGraphBounds([node()]).radius).toBe(MIN_BOUNDS_RADIUS);
  });

  it('treats a non-finite coordinate as the origin instead of poisoning the fit', () => {
    const bounds = computeGraphBounds([node({ x: Number.NaN }), node({ id: 'b', x: 20 })]);
    expect(bounds.center.every(Number.isFinite)).toBe(true);
    expect(bounds.radius).toBeGreaterThan(0);
  });
});

// Camera-space projection of a world point, mirroring what three.js does: build
// the camera basis from the look direction and world up, then check the point
// against the frustum half-angles. This is the actual "no node starts off-screen"
// assertion — jsdom can't render, so the geometry is verified here instead.
const sub = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a); return a.map(v => v / l); };

function isVisible(point, fit, { fov, aspect }) {
  const forward = norm(sub(fit.target, fit.position));
  const right = norm(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  const v = sub(point, fit.position);
  const depth = dot(v, forward);
  if (depth <= 0) return false;
  const verticalHalf = (fov * Math.PI) / 360;
  const horizontalHalf = Math.atan(Math.tan(verticalHalf) * aspect);
  return Math.abs(dot(v, up)) <= depth * Math.tan(verticalHalf)
    && Math.abs(dot(v, right)) <= depth * Math.tan(horizontalHalf);
}

describe('fitCameraToBounds', () => {
  const spread = [
    node({ id: 'apex', goalType: 'apex', x: 0, y: 0, z: 0 }),
    node({ id: 'n', x: 0, y: 2, z: -32 }),
    node({ id: 's', x: 0, y: -2, z: 32 }),
    node({ id: 'e', x: 40, y: 1, z: 0 }),
    node({ id: 'w', x: -40, y: -1, z: 0 })
  ];

  it('returns null when there are no bounds', () => {
    expect(fitCameraToBounds(null, { fov: 60, aspect: 1.6 })).toBeNull();
  });

  it('frames every node inside the frustum on a landscape viewport', () => {
    const view = { fov: 60, aspect: 1600 / 900 };
    const bounds = computeGraphBounds(spread);
    const fit = fitCameraToBounds(bounds, view);
    for (const n of spread) {
      expect(isVisible([n.x, n.y, n.z], fit, view)).toBe(true);
    }
  });

  it('frames every node inside the frustum on a portrait phone', () => {
    // The regression this guards: solving only the VERTICAL half-angle. A phone's
    // horizontal FOV is much narrower, so the graph's east/west nodes clip off the
    // sides of the screen even though the fit "succeeded".
    const view = { fov: 60, aspect: 375 / 812 };
    const bounds = computeGraphBounds(spread);
    const fit = fitCameraToBounds(bounds, view);
    for (const n of spread) {
      expect(isVisible([n.x, n.y, n.z], fit, view)).toBe(true);
    }
  });

  it('pulls further back as the viewport narrows', () => {
    const bounds = computeGraphBounds(spread);
    const wide = fitCameraToBounds(bounds, { fov: 60, aspect: 2 });
    const narrow = fitCameraToBounds(bounds, { fov: 60, aspect: 0.5 });
    expect(narrow.distance).toBeGreaterThan(wide.distance);
  });

  it('aims at the graph centre and sits `distance` away from it', () => {
    const bounds = computeGraphBounds([node({ x: 100, y: 20, z: -50 })]);
    const fit = fitCameraToBounds(bounds, { fov: 60, aspect: 1 });
    expect(fit.target).toEqual(bounds.center);
    expect(Math.hypot(...sub(fit.position, fit.target))).toBeCloseTo(fit.distance);
    // Framed from above and in front, matching the previous fixed camera angle.
    expect(fit.position[1]).toBeGreaterThan(fit.target[1]);
    expect(fit.position[2]).toBeGreaterThan(fit.target[2]);
  });

  it('keeps a floor distance for a tiny graph', () => {
    const fit = fitCameraToBounds({ center: [0, 0, 0], size: [0, 0, 0], radius: 0.1 }, { fov: 60, aspect: 1 });
    expect(fit.distance).toBeCloseTo(MIN_FIT_DISTANCE * CAMERA_FIT_PADDING);
  });

  it('falls back to sane optics rather than returning NaN', () => {
    const bounds = computeGraphBounds(spread);
    for (const view of [{ fov: 0, aspect: 0 }, { fov: Number.NaN, aspect: Number.NaN }, { fov: 200, aspect: -3 }]) {
      const fit = fitCameraToBounds(bounds, { ...view, padding: Number.NaN });
      expect(Number.isFinite(fit.distance)).toBe(true);
      expect(fit.position.every(Number.isFinite)).toBe(true);
    }
    expect(Number.isFinite(fitCameraToBounds(bounds).distance)).toBe(true);
  });
});

describe('orbitDistanceLimits', () => {
  it('never clamps a graph that needs more than the old fixed 150 ceiling', () => {
    const bounds = computeGraphBounds([node({ x: -400 }), node({ id: 'b', x: 400 })]);
    const fit = fitCameraToBounds(bounds, { fov: 60, aspect: 1 });
    expect(orbitDistanceLimits(bounds).max).toBeGreaterThan(fit.distance);
  });

  it('keeps a usable zoom-in floor for a small graph', () => {
    const limits = orbitDistanceLimits(computeGraphBounds([node()]));
    expect(limits.min).toBeGreaterThan(0);
    expect(limits.min).toBeLessThanOrEqual(5);
    expect(limits.max).toBe(150);
  });

  it('degrades to defaults with no bounds', () => {
    expect(orbitDistanceLimits(null).max).toBe(150);
  });
});

describe('labelOpacityForDistance', () => {
  const range = labelFadeRange(100);

  it('is fully opaque at and inside the framed distance', () => {
    expect(labelOpacityForDistance(0, range)).toBe(1);
    expect(labelOpacityForDistance(100, range)).toBe(1);
    expect(labelOpacityForDistance(range.near, range)).toBe(1);
  });

  it('fades to nothing as the camera pulls back past the far threshold', () => {
    expect(labelOpacityForDistance(range.far, range)).toBe(0);
    expect(labelOpacityForDistance(range.far + 500, range)).toBe(0);
    const mid = labelOpacityForDistance((range.near + range.far) / 2, range);
    expect(mid).toBeCloseTo(0.5);
  });

  it('decreases monotonically across the fade band', () => {
    const step = (range.far - range.near) / 8;
    let previous = 1;
    for (let d = range.near; d <= range.far; d += step) {
      const opacity = labelOpacityForDistance(d, range);
      expect(opacity).toBeLessThanOrEqual(previous);
      previous = opacity;
    }
  });

  it('stays legible rather than blank for a bad distance or range', () => {
    expect(labelOpacityForDistance(Number.NaN, range)).toBe(1);
    expect(labelOpacityForDistance(1, undefined)).toBe(1);
    // Degenerate band (near === far) must not divide by zero.
    expect(labelOpacityForDistance(10, { near: 5, far: 5 })).toBe(0);
  });

  it('scales the fade band with the framed distance, not a fixed world size', () => {
    expect(labelFadeRange(500).near).toBeGreaterThan(labelFadeRange(50).near);
    expect(labelFadeRange(0).near).toBeGreaterThan(0);
    expect(labelFadeRange(undefined).far).toBeGreaterThan(labelFadeRange(undefined).near);
  });
});
