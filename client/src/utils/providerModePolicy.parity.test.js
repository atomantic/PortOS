import { describe, it, expect } from 'vitest';
import { CALLER_MODE_POLICIES } from '../../../server/lib/callerModePolicy.js';
import { CALLER_MODE_POLICY_MODES, callerModeList, providerModeSelectionPolicy } from './providerSelection.js';

/**
 * The browser mirror only decides what a PICKER offers; the server decides what
 * actually runs. They must agree, or a user saves a route the server refuses at
 * spawn time (or, worse, the picker hides a route the server would happily run).
 */
describe('caller execution-mode policy — client/server parity', () => {
  it('mirrors every server policy, name for name and mode for mode', () => {
    expect(Object.keys(CALLER_MODE_POLICY_MODES).sort()).toEqual(Object.keys(CALLER_MODE_POLICIES).sort());
    for (const [id, { allowedModes }] of Object.entries(CALLER_MODE_POLICIES)) {
      expect(CALLER_MODE_POLICY_MODES[id]).toEqual([...allowedModes]);
    }
  });

  it('permits nothing for an unknown policy name rather than everything', () => {
    // Fail-closed in the same direction as the server, which throws: a typo has
    // to be visible, never a silently permissive picker.
    expect(callerModeList('typo')).toEqual([]);
    const policy = providerModeSelectionPolicy('typo');
    expect(policy.provider({ type: 'cli' })).toBe(false);
  });

  it('offers exactly the caller policy modes', () => {
    const agent = providerModeSelectionPolicy('agent-harness');
    expect(agent.provider({ type: 'cli' })).toBe(true);
    expect(agent.provider({ type: 'tui' })).toBe(true);
    expect(agent.provider({ type: 'api' })).toBe(false);
    expect(agent.provider(null)).toBe(false);

    const apiOnly = providerModeSelectionPolicy('direct-api');
    expect(apiOnly.provider({ type: 'api' })).toBe(true);
    expect(apiOnly.provider({ type: 'tui' })).toBe(false);
  });
});
