/**
 * The facade is a re-export surface (#3450), so argument forwarding cannot fail —
 * `export { x } from './y.js'` is a binding alias, not a wrapper. What CAN fail
 * is the wiring: an alias pointed at the wrong leaf. `agentManagement.js` and
 * `cosAgentLifecycle.js` both export a function called `terminateAgent` and they
 * do completely different things — one emits `agent:terminate` and returns, the
 * other runs the real SIGTERM/SIGKILL sequence — so a copy-paste swap between
 * them is silent and severe. These assertions pin binding identity, which is the
 * property that actually holds, and pin the surface so the facade cannot quietly
 * regrow into a second barrel.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('./agentManagement.js', () => ({
  pauseAgent: () => {},
  killAgent: () => {},
  terminateAgent: () => {},
  getAgentProcessStats: () => {}
}));

vi.mock('./cosAgentLifecycle.js', () => ({
  completeAgent: () => {},
  terminateAgent: () => {}
}));

vi.mock('./agentLifecycle.js', () => ({
  spawnAgentForTask: () => {}
}));

import * as orchestrator from './agentOrchestrator.js';
import * as agentManagement from './agentManagement.js';
import * as cosAgentLifecycle from './cosAgentLifecycle.js';
import * as agentLifecycle from './agentLifecycle.js';

// [facade export, source module, name in that module]
const WIRING = [
  ['pauseAgent', agentManagement, 'pauseAgent'],
  ['killAgent', agentManagement, 'killAgent'],
  ['terminateAgent', agentManagement, 'terminateAgent'],
  ['getAgentProcessStats', agentManagement, 'getAgentProcessStats'],
  ['completeAgent', cosAgentLifecycle, 'completeAgent'],
  ['requestAgentTermination', cosAgentLifecycle, 'terminateAgent'],
  ['spawnAgentForTask', agentLifecycle, 'spawnAgentForTask']
];

describe('agentOrchestrator facade (#3450)', () => {
  it.each(WIRING)('%s resolves to the intended leaf', (exported, mod, leaf) => {
    expect(orchestrator[exported]).toBe(mod[leaf]);
  });

  it('keeps the two same-named terminates distinct', () => {
    // The whole point of the rename. If these ever converge, one of the two
    // aliases is pointed at the wrong module and the identity checks above
    // would both still pass against a single shared binding.
    expect(orchestrator.terminateAgent).not.toBe(orchestrator.requestAgentTermination);
  });

  it('exposes exactly the transition surface — new exports are a deliberate decision', () => {
    // The facade's value is that it is small and complete. A drive-by export
    // slipped in here is how a facade turns back into a second barrel, so the
    // set is pinned: growing it means updating this list on purpose.
    expect(Object.keys(orchestrator).sort()).toEqual(WIRING.map(([name]) => name).sort());
  });
});
