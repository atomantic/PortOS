/**
 * The facade is a re-export surface (#3450), so argument forwarding cannot fail —
 * `export { x } from './y.js'` is a binding alias, not a wrapper. What CAN fail
 * is the wiring: an alias pointed at the wrong leaf. These assertions pin binding identity, which is the
 * property that actually holds, and pin the surface so the facade cannot quietly
 * regrow into a second barrel.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('./agentManagement.js', () => ({
  pauseAgent: () => {},
  resumeAgent: () => {},
  relaunchAgent: () => {},
  killAgent: () => {},
  getAgentProcessStats: () => {}
}));

vi.mock('../cos/cosAgentLifecycle.js', () => ({
  completeAgent: () => {}
}));

vi.mock('./agentLifecycle.js', () => ({
  spawnAgentForTask: () => {}
}));

import * as orchestrator from './agentOrchestrator.js';
import * as agentManagement from './agentManagement.js';
import * as cosAgentLifecycle from '../cos/cosAgentLifecycle.js';
import * as agentLifecycle from './agentLifecycle.js';

// [facade export, source module, name in that module]
const WIRING = [
  ['pauseAgent', agentManagement, 'pauseAgent'],
  ['resumeAgent', agentManagement, 'resumeAgent'],
  ['relaunchAgent', agentManagement, 'relaunchAgent'],
  ['killAgent', agentManagement, 'killAgent'],
  ['getAgentProcessStats', agentManagement, 'getAgentProcessStats'],
  ['completeAgent', cosAgentLifecycle, 'completeAgent'],
  ['spawnAgentForTask', agentLifecycle, 'spawnAgentForTask']
];

describe('agentOrchestrator facade (#3450)', () => {
  it.each(WIRING)('%s resolves to the intended leaf', (exported, mod, leaf) => {
    expect(orchestrator[exported]).toBe(mod[leaf]);
  });

  it('exposes exactly the transition surface — new exports are a deliberate decision', () => {
    // The facade's value is that it is small and complete. A drive-by export
    // slipped in here is how a facade turns back into a second barrel, so the
    // set is pinned: growing it means updating this list on purpose.
    expect(Object.keys(orchestrator).sort()).toEqual(WIRING.map(([name]) => name).sort());
  });
});
