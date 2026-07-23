import { describe, it, expect, vi } from 'vitest';
import { mockNoPeerSync, mockNoPeers } from '../../lib/mockPathsDataRoot.js';

vi.mock('../instances.js', () => mockNoPeers());
vi.mock('../sharing/peerSync.js', () => mockNoPeerSync());

// COLD import: this file deliberately imports a FOCUSED module from the #2842
// split WITHOUT importing ./seriesAutopilot.js first — the barrel test can't
// catch this because importing the barrel initializes every binding up front.
//
// `session.js` reaches the barrel through a genuine import cycle
// (session → autoRunner → episodeVideo → completionHook → planAdvance →
// seriesAutopilot), so anything the barrel READS at module-evaluation time from
// a not-yet-initialized module throws `ReferenceError: Cannot access 'x' before
// initialization`. That is exactly what an eager `__testing = { …, providerOverrideOpts }`
// did; the barrel now uses lazy getters. Keep this file's first autopilot import
// pointed at a focused module or the guard silently stops guarding.
const session = await import('./seriesAutopilot/session.js');

describe('seriesAutopilot cold module import (issue #2842)', () => {
  it('a focused module imports standalone without a TDZ error from the barrel cycle', () => {
    expect(typeof session.providerOverrideOpts).toBe('function');
    expect(typeof session.broadcast).toBe('function');
  });

  it('the barrel imported afterwards still exposes the __testing bundle', async () => {
    const barrel = await import('./seriesAutopilot.js');
    expect(barrel.__testing.providerOverrideOpts).toBe(session.providerOverrideOpts);
    expect(barrel.__testing.runs).toBeInstanceOf(Map);
  });
});
