import { describe, it, expect } from 'vitest';
import { computeRooftopKit, ROOFTOP_TYPES } from './cityRooftops';

describe('computeRooftopKit', () => {
  it('is deterministic per name', () => {
    expect(computeRooftopKit('port-os')).toEqual(computeRooftopKit('port-os'));
    expect(computeRooftopKit('another-app', 2)).toEqual(computeRooftopKit('another-app', 2));
  });

  it('returns 0–3 fixtures of known types', () => {
    for (const name of ['a', 'bb', 'ccc', 'port-os', 'my-app', 'svc-12', 'x9', 'zzz']) {
      const kit = computeRooftopKit(name);
      expect(kit.length).toBeLessThanOrEqual(3);
      for (const f of kit) {
        expect(ROOFTOP_TYPES).toContain(f.type);
        expect(f.scale).toBeGreaterThan(0);
      }
    }
  });

  it('keeps every fixture inside the roof bounds', () => {
    for (const width of [2, 3.5]) {
      for (const name of ['port-os', 'another-app', 'svc-12', 'big-roof-app']) {
        for (const f of computeRooftopKit(name, width)) {
          expect(Math.abs(f.x), name).toBeLessThanOrEqual(width / 2);
          expect(Math.abs(f.z), name).toBeLessThanOrEqual(width / 2);
        }
      }
    }
  });

  it('varies across names (not every roof identical)', () => {
    const kits = ['app-one', 'app-two', 'app-three', 'app-four', 'app-five', 'gamma', 'delta']
      .map((n) => JSON.stringify(computeRooftopKit(n)));
    expect(new Set(kits).size).toBeGreaterThan(1);
  });

  it('never stacks two fixtures on the same spot', () => {
    for (const name of ['port-os', 'another-app', 'svc-12', 'abcdefg', 'q']) {
      const kit = computeRooftopKit(name);
      const keys = kit.map((f) => `${Math.round(f.x * 10)},${Math.round(f.z * 10)}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('tolerates a missing name', () => {
    expect(() => computeRooftopKit(undefined)).not.toThrow();
    expect(() => computeRooftopKit('')).not.toThrow();
  });
});
