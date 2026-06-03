import { describe, it, expect } from 'vitest';
import {
  AGENT_MOTION,
  computeAgentOrbit,
  resolveTrailSamples,
  computeAgentTrailPoints,
  computeTrailColors,
} from './cityAgentMotion';

describe('computeAgentOrbit', () => {
  it('places the agent on a circle of the configured radius (ignoring bob)', () => {
    const { x, z } = computeAgentOrbit(0, { radius: 2, bobAmp: 0 });
    expect(Math.hypot(x, z)).toBeCloseTo(2, 6);
  });

  it('at t=0 with no bob sits at angle 0 (x=radius, z=0)', () => {
    const p = computeAgentOrbit(0, { radius: 1, bobAmp: 0 });
    expect(p.x).toBeCloseTo(1, 6);
    expect(p.z).toBeCloseTo(0, 6);
    expect(p.y).toBeCloseTo(0, 6);
  });

  it('advances around the circle as time progresses', () => {
    const a = computeAgentOrbit(0, { radius: 1, orbitSpeed: 1, bobAmp: 0 });
    const b = computeAgentOrbit(Math.PI / 2, { radius: 1, orbitSpeed: 1, bobAmp: 0 });
    // quarter turn: x→0, z→1
    expect(b.x).toBeCloseTo(0, 6);
    expect(b.z).toBeCloseTo(1, 6);
    expect(a.x).not.toBeCloseTo(b.x, 3);
  });

  it('fans agents on the same building into distinct phases by index', () => {
    const a0 = computeAgentOrbit(0, { radius: 1, bobAmp: 0, index: 0 });
    const a1 = computeAgentOrbit(0, { radius: 1, bobAmp: 0, index: 1 });
    expect(a0.x).not.toBeCloseTo(a1.x, 3);
  });

  it('applies vertical bob within the configured amplitude', () => {
    let maxY = 0;
    for (let t = 0; t < 20; t += 0.05) {
      maxY = Math.max(maxY, Math.abs(computeAgentOrbit(t, { bobAmp: 0.3 }).y));
    }
    expect(maxY).toBeGreaterThan(0.25);
    expect(maxY).toBeLessThanOrEqual(0.3 + 1e-9);
  });

  it('falls back to AGENT_MOTION defaults when opts are omitted', () => {
    const { x, z } = computeAgentOrbit(0);
    expect(Math.hypot(x, z)).toBeCloseTo(AGENT_MOTION.orbitRadius, 6);
  });
});

describe('resolveTrailSamples', () => {
  it('drops the trail entirely below the low-quality floor', () => {
    expect(resolveTrailSamples(0)).toBe(0);
    expect(resolveTrailSamples(0.4)).toBe(0);
  });

  it('renders a short trail at the low preset (0.5)', () => {
    expect(resolveTrailSamples(0.5, 24)).toBe(8);
  });

  it('scales up to the full sample count at ultra (1.5)', () => {
    expect(resolveTrailSamples(1.5, 24)).toBe(24);
    expect(resolveTrailSamples(1.0, 24)).toBe(16);
  });

  it('clamps densities above ultra to the max sample count', () => {
    expect(resolveTrailSamples(5, 24)).toBe(24);
  });

  it('never returns fewer than 2 points for a renderable trail', () => {
    expect(resolveTrailSamples(0.5, 2)).toBe(2);
  });
});

describe('computeAgentTrailPoints', () => {
  it('returns samples*3 flat coordinates', () => {
    const pts = computeAgentTrailPoints(1, {}, 10);
    expect(pts).toHaveLength(30);
  });

  it('head (first point) matches the current orbit position', () => {
    const t = 3.21;
    const opts = { index: 2 };
    const head = computeAgentOrbit(t, opts);
    const pts = computeAgentTrailPoints(t, opts, 12);
    expect(pts[0]).toBeCloseTo(head.x, 6);
    expect(pts[1]).toBeCloseTo(head.y, 6);
    expect(pts[2]).toBeCloseTo(head.z, 6);
  });

  it('tail (last point) matches the orbit position trailSeconds in the past', () => {
    const t = 3.21;
    const opts = { index: 0 };
    const tail = computeAgentOrbit(t - AGENT_MOTION.trailSeconds, opts);
    const pts = computeAgentTrailPoints(t, opts, 8, AGENT_MOTION.trailSeconds);
    const last = pts.length - 3;
    expect(pts[last]).toBeCloseTo(tail.x, 6);
    expect(pts[last + 1]).toBeCloseTo(tail.y, 6);
    expect(pts[last + 2]).toBeCloseTo(tail.z, 6);
  });

  it('clamps to a minimum of 2 points', () => {
    expect(computeAgentTrailPoints(0, {}, 1)).toHaveLength(6);
  });

  it('fills a pre-allocated out buffer in place and returns it (no allocation)', () => {
    const out = new Float32Array(8 * 3);
    const ret = computeAgentTrailPoints(2.5, { index: 1 }, 8, AGENT_MOTION.trailSeconds, out);
    expect(ret).toBe(out);
    const fresh = computeAgentTrailPoints(2.5, { index: 1 }, 8);
    for (let i = 0; i < fresh.length; i++) {
      expect(out[i]).toBeCloseTo(fresh[i], 5);
    }
  });
});

describe('computeTrailColors', () => {
  it('returns samples*3 channel values', () => {
    expect(computeTrailColors([1, 0.5, 0.25], 10)).toHaveLength(30);
  });

  it('is full color at the head and black at the tail', () => {
    const rgb = [0.2, 0.4, 0.8];
    const colors = computeTrailColors(rgb, 5);
    expect(colors[0]).toBeCloseTo(rgb[0], 6);
    expect(colors[1]).toBeCloseTo(rgb[1], 6);
    expect(colors[2]).toBeCloseTo(rgb[2], 6);
    const last = colors.length - 3;
    expect(colors[last]).toBeCloseTo(0, 6);
    expect(colors[last + 1]).toBeCloseTo(0, 6);
    expect(colors[last + 2]).toBeCloseTo(0, 6);
  });

  it('fades monotonically from head to tail', () => {
    const colors = computeTrailColors([1, 1, 1], 6);
    const reds = [];
    for (let i = 0; i < colors.length; i += 3) reds.push(colors[i]);
    for (let i = 1; i < reds.length; i++) {
      expect(reds[i]).toBeLessThan(reds[i - 1]);
    }
  });
});
