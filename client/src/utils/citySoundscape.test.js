import { describe, it, expect } from 'vitest';
import {
  CHORD_SETS,
  classifyMood,
  computeActivityEnergy,
  computeSoundscape,
} from './citySoundscape';

describe('CHORD_SETS', () => {
  it('has bright and tense tables of equal length', () => {
    expect(CHORD_SETS.bright).toHaveLength(CHORD_SETS.tense.length);
    for (const set of [...CHORD_SETS.bright, ...CHORD_SETS.tense]) {
      expect(set).toHaveLength(3);
    }
  });
});

describe('classifyMood', () => {
  it('is bright for a healthy, quiet system', () => {
    expect(classifyMood({ overallHealth: 'healthy', system: { cpu: { usagePercent: 10 }, memory: { usagePercent: 20 } } })).toBe('bright');
  });
  it('is tense for a critical/unhealthy verdict', () => {
    expect(classifyMood({ overallHealth: 'critical' })).toBe('tense');
    expect(classifyMood({ overallHealth: 'unhealthy' })).toBe('tense');
  });
  it('tenses on very high CPU/memory even without a warning verdict', () => {
    expect(classifyMood({ system: { cpu: { usagePercent: 90 } } })).toBe('tense');
    expect(classifyMood({ system: { memory: { usagePercent: 95 } } })).toBe('tense');
  });
  it('is neutral when degraded or moderately loaded', () => {
    expect(classifyMood({ overallHealth: 'degraded' })).toBe('neutral');
    expect(classifyMood({ system: { cpu: { usagePercent: 70 } } })).toBe('neutral');
  });
  it('defaults to bright with no health data', () => {
    expect(classifyMood(null)).toBe('bright');
    expect(classifyMood(undefined)).toBe('bright');
    expect(classifyMood({})).toBe('bright');
  });
});

describe('computeActivityEnergy', () => {
  it('has a non-zero floor with no agents', () => {
    expect(computeActivityEnergy(0)).toBeCloseTo(0.15, 5);
    expect(computeActivityEnergy(undefined)).toBeCloseTo(0.15, 5);
  });
  it('rises monotonically with agent count and saturates below 1', () => {
    const e1 = computeActivityEnergy(1);
    const e3 = computeActivityEnergy(3);
    const e10 = computeActivityEnergy(10);
    expect(e3).toBeGreaterThan(e1);
    expect(e10).toBeGreaterThan(e3);
    expect(e10).toBeLessThanOrEqual(1);
  });
  it('clamps negatives to the floor', () => {
    expect(computeActivityEnergy(-5)).toBeCloseTo(0.15, 5);
  });
});

describe('computeSoundscape', () => {
  it('maps a healthy quiet city to a bright, low-energy soundscape', () => {
    const s = computeSoundscape({ systemHealth: { overallHealth: 'healthy' }, agentCount: 0 });
    expect(s.mood).toBe('bright');
    expect(s.chordSet).toBe('bright');
    expect(s.arpGain).toBeCloseTo(0.02 + 0.15 * 0.08, 4);
    expect(s.padDetune).toBe(8);
  });
  it('maps a stressed city to a tense chord set and muffled filter', () => {
    const calm = computeSoundscape({ systemHealth: { overallHealth: 'healthy' }, agentCount: 0 });
    const tense = computeSoundscape({ systemHealth: { overallHealth: 'critical' }, agentCount: 0 });
    expect(tense.chordSet).toBe('tense');
    expect(tense.filterBase).toBeLessThan(calm.filterBase);
    expect(tense.padDetune).toBeGreaterThan(calm.padDetune);
  });
  it('raises arp gain and energy as agents spin up', () => {
    const idle = computeSoundscape({ agentCount: 0 });
    const busy = computeSoundscape({ agentCount: 6 });
    expect(busy.arpGain).toBeGreaterThan(idle.arpGain);
    expect(busy.energy).toBeGreaterThan(idle.energy);
    expect(busy.pulse).toBe(busy.energy);
  });
  it('keeps the bright chord table for neutral mood (only filter darkens)', () => {
    const s = computeSoundscape({ systemHealth: { overallHealth: 'degraded' }, agentCount: 1 });
    expect(s.mood).toBe('neutral');
    expect(s.chordSet).toBe('bright');
  });
  it('handles an empty snapshot', () => {
    const s = computeSoundscape();
    expect(s.mood).toBe('bright');
    expect(Number.isFinite(s.filterBase)).toBe(true);
  });
});
