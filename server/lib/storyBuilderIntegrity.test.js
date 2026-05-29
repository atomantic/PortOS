import { describe, it, expect } from 'vitest';
import { hashUpstream, computeStaleSteps } from './storyBuilderIntegrity.js';

describe('storyBuilderIntegrity — hashUpstream', () => {
  it('is deterministic for the same inputs', () => {
    const a = hashUpstream('plotArc', { logline: 'x', themes: ['a', 'b'] });
    const b = hashUpstream('plotArc', { logline: 'x', themes: ['a', 'b'] });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is independent of object key order', () => {
    const a = hashUpstream('s', { logline: 'x', summary: 'y', nested: { p: 1, q: 2 } });
    const b = hashUpstream('s', { nested: { q: 2, p: 1 }, summary: 'y', logline: 'x' });
    expect(a).toBe(b);
  });

  it('changes when a semantic field changes', () => {
    const a = hashUpstream('s', { logline: 'x' });
    const b = hashUpstream('s', { logline: 'y' });
    expect(a).not.toBe(b);
  });

  it('is sensitive to array order (order is semantic for beats/seasons)', () => {
    const a = hashUpstream('s', { beats: [1, 2, 3] });
    const b = hashUpstream('s', { beats: [3, 2, 1] });
    expect(a).not.toBe(b);
  });

  it('namespaces by stepId so identical inputs for different steps differ', () => {
    expect(hashUpstream('a', { x: 1 })).not.toBe(hashUpstream('b', { x: 1 }));
  });

  it('handles null/undefined inputs without throwing', () => {
    expect(hashUpstream('s', null)).toBe(hashUpstream('s', undefined));
  });
});

describe('storyBuilderIntegrity — computeStaleSteps', () => {
  const session = {
    steps: {
      idea: { locked: true, upstreamHash: 'h-idea' },
      universeAesthetic: { locked: true, upstreamHash: 'h-univ' },
      plotArc: { locked: false, upstreamHash: 'h-arc' },
      readerMap: { locked: true, upstreamHash: 'h-reader' },
    },
  };

  it('flags only locked steps whose hash drifted', () => {
    const stale = computeStaleSteps(session, {
      idea: 'h-idea', // unchanged
      universeAesthetic: 'h-univ-CHANGED', // drifted → stale
      plotArc: 'h-arc-CHANGED', // changed but NOT locked → ignored
      readerMap: 'h-reader-CHANGED', // drifted → stale
    });
    expect(stale.sort()).toEqual(['readerMap', 'universeAesthetic']);
  });

  it('never flags unlocked steps even when drifted', () => {
    const stale = computeStaleSteps(session, { plotArc: 'totally-different' });
    expect(stale).not.toContain('plotArc');
  });

  it('skips steps with no current hash available', () => {
    const stale = computeStaleSteps(session, { idea: 'h-idea' });
    // universeAesthetic + readerMap have no current hash → not flagged
    expect(stale).toEqual([]);
  });

  it('returns empty for an empty/missing session', () => {
    expect(computeStaleSteps(null, {})).toEqual([]);
    expect(computeStaleSteps({}, {})).toEqual([]);
    expect(computeStaleSteps({ steps: {} }, { a: 'b' })).toEqual([]);
  });
});
