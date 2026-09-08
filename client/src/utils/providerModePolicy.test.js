import { describe, it, expect } from 'vitest';
import { callerModeList, providerModeSelectionPolicy } from './providerSelection.js';

/**
 * The picker-side policy only decides what a PICKER offers; the server decides
 * what actually runs. The mode table is derived from the server's
 * `CALLER_MODE_POLICIES` directly, so what remains to pin is the picker's own
 * behaviour on top of it: an unknown policy fails closed, and a known one offers
 * exactly its modes.
 */
describe('caller execution-mode policy — picker selection', () => {
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
