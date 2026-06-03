import { describe, it, expect } from 'vitest';
import { FLOW, computeFlowConnections } from './cityFlowLines';

// Four downtown buildings in a row plus one non-downtown and one offscreen.
const positions = new Map([
  ['a', { x: 0, z: 0, district: 'downtown' }],
  ['b', { x: 2, z: 0, district: 'downtown' }],
  ['c', { x: 4, z: 0, district: 'downtown' }],
  ['d', { x: 6, z: 0, district: 'downtown' }],
  ['w', { x: 0, z: 20, district: 'warehouse' }],
]);

describe('computeFlowConnections', () => {
  it('returns nothing with fewer than two active buildings', () => {
    expect(computeFlowConnections({ positions, activeIds: new Set(['a']), agentIds: new Set() })).toEqual([]);
    expect(computeFlowConnections({ positions, activeIds: new Set(), agentIds: new Set() })).toEqual([]);
    expect(computeFlowConnections({})).toEqual([]);
  });

  it('only connects buildings that are active (online)', () => {
    const conns = computeFlowConnections({
      positions,
      activeIds: new Set(['a', 'b']),
      agentIds: new Set(),
    });
    expect(conns).toHaveLength(1);
    expect(conns[0].key).toBe('a→b');
  });

  it('excludes non-downtown districts even when marked active', () => {
    const conns = computeFlowConnections({
      positions,
      activeIds: new Set(['a', 'w']),
      agentIds: new Set(),
    });
    // 'w' is warehouse district → not a flow source, leaving <2 downtown actives
    expect(conns).toEqual([]);
  });

  it('connects each active building to up to maxNeighbors nearest active neighbors, deduped', () => {
    const conns = computeFlowConnections({
      positions,
      activeIds: new Set(['a', 'b', 'c', 'd']),
      agentIds: new Set(),
      maxNeighbors: 2,
    });
    const keys = conns.map(c => c.key).sort();
    // a↔b, b↔c, c↔d (adjacent), plus a→c and b→d as second-nearest — deduped both ways
    expect(new Set(keys).size).toBe(keys.length); // no duplicate keys
    expect(keys).toContain('a→b');
    expect(keys).toContain('c→d');
    // never a self-link
    expect(keys.every(k => k.split('→')[0] !== k.split('→')[1])).toBe(true);
  });

  it('marks a link hot (agent color, more+faster packets) when either endpoint has a running agent', () => {
    const conns = computeFlowConnections({
      positions,
      activeIds: new Set(['a', 'b']),
      agentIds: new Set(['b']),
    });
    expect(conns[0].hot).toBe(true);
    expect(conns[0].color).toBe(FLOW.hotColor);
    expect(conns[0].packets).toBe(FLOW.hotPackets);
    expect(conns[0].speed).toBeGreaterThan(FLOW.baseSpeed);
  });

  it('marks a link idle (steady color, base packets) when neither endpoint has an agent', () => {
    const conns = computeFlowConnections({
      positions,
      activeIds: new Set(['a', 'b']),
      agentIds: new Set(['c']), // agent on an unrelated building
    });
    expect(conns[0].hot).toBe(false);
    expect(conns[0].color).toBe(FLOW.idleColor);
    expect(conns[0].packets).toBe(FLOW.basePackets);
  });

  it('produces a deterministic topology across calls', () => {
    const args = { positions, activeIds: new Set(['a', 'b', 'c']), agentIds: new Set(['a']) };
    expect(computeFlowConnections(args)).toEqual(computeFlowConnections(args));
  });

  it('places stream endpoints at the buildings xz with a fixed y', () => {
    const conns = computeFlowConnections({ positions, activeIds: new Set(['a', 'b']), agentIds: new Set() });
    expect(conns[0].start).toEqual([0, 0.5, 0]);
    expect(conns[0].end).toEqual([2, 0.5, 0]);
  });
});
