import { describe, it, expect } from 'vitest';
import {
  CALLER_MODE_POLICIES,
  CALLER_MODE_POLICY_IDS,
  EXECUTION_MODES,
  allowedModesFor,
  callerModeRejection,
  filterCallerModeEligible,
  isCallerModeEligible,
  resolveCallerModePolicy,
} from './callerModePolicy.js';
import { PROVIDER_TYPES } from './aiToolkit/constants.js';
import { ROUTE_MODES } from './providerHarnesses.js';

const cli = { id: 'claude-code', type: 'cli' };
const tui = { id: 'claude-code-tui', type: 'tui' };
const api = { id: 'ollama', type: 'api' };

describe('callerModePolicy', () => {
  it('refuses an unregistered policy name instead of resolving it permissively', () => {
    // The dangerous failure is a typo silently becoming "allow everything" —
    // exactly the over-permission this module exists to prevent.
    expect(() => resolveCallerModePolicy('agent-harnes')).toThrow(/Unknown caller mode policy/);
    expect(() => resolveCallerModePolicy({ allowedModes: ['ptty'] })).toThrow(/at least one/);
    expect(() => resolveCallerModePolicy([])).toThrow(/at least one/);
  });

  it('keeps CLI and TUI as separate routes a policy can allow independently', () => {
    expect(allowedModesFor('agent-harness')).toEqual(['cli', 'tui']);
    expect(allowedModesFor('cli-harness')).toEqual(['cli']);
    expect(allowedModesFor('direct-api')).toEqual(['api']);
    expect(allowedModesFor('any-text')).toEqual([...EXECUTION_MODES]);
    // Every registered policy names only real modes.
    for (const id of CALLER_MODE_POLICY_IDS) {
      expect(CALLER_MODE_POLICIES[id].allowedModes.every((mode) => EXECUTION_MODES.includes(mode))).toBe(true);
    }
  });

  it('never lets a CLI-only caller reach a TUI route', () => {
    expect(isCallerModeEligible(cli, 'cli-harness')).toBe(true);
    expect(callerModeRejection(tui, 'cli-harness')).toMatchObject({ code: 'mode-not-allowed' });
    expect(callerModeRejection(tui, 'cli-harness').reason).toContain('this caller allows cli');
    expect(callerModeRejection(api, 'cli-harness')).toMatchObject({ code: 'mode-not-allowed' });
  });

  it('refuses a record whose type names no executable mode, under every policy', () => {
    for (const id of CALLER_MODE_POLICY_IDS) {
      expect(callerModeRejection({ id: 'weird' }, id)).toMatchObject({ code: 'mode-unknown' });
      expect(callerModeRejection({ id: 'weird', type: 'pty' }, id)).toMatchObject({ code: 'mode-unknown' });
    }
  });

  it('does not turn an UNKNOWN required capability into a satisfied one', () => {
    const policy = { allowedModes: ['api'], requiredModelCapabilities: { tools: true } };
    // Proven present → eligible.
    expect(callerModeRejection(api, policy, { modelCapabilities: { tools: true } })).toBeNull();
    // Proven absent, and — the point of this test — NOT PROBED AT ALL both fail.
    expect(callerModeRejection(api, policy, { modelCapabilities: { tools: false } })).toMatchObject({ code: 'capability-tools' });
    expect(callerModeRejection(api, policy, { modelCapabilities: { tools: null } })).toMatchObject({ code: 'capability-tools' });
    expect(callerModeRejection(api, policy, { modelCapabilities: {} })).toMatchObject({ code: 'capability-tools' });
    expect(callerModeRejection(api, policy)).toMatchObject({ code: 'capability-tools' });
  });

  it('ignores a non-true capability REQUIREMENT so an absent-evidence record cannot satisfy it', () => {
    const policy = resolveCallerModePolicy({ allowedModes: ['api'], requiredModelCapabilities: { tools: false, vision: null } });
    expect(policy.requiredModelCapabilities).toEqual({});
    expect(callerModeRejection(api, policy)).toBeNull();
  });

  it('preserves the caller list order when filtering, so preference order survives', () => {
    const list = [api, tui, cli, null, { id: 'x' }];
    expect(filterCallerModeEligible(list, 'agent-harness')).toEqual([tui, cli]);
    expect(filterCallerModeEligible(list, ['api'])).toEqual([api]);
    expect(filterCallerModeEligible(null, 'any-text')).toEqual([]);
  });

  it('declares the same mode vocabulary as the toolkit record type and the route modes', () => {
    // EXECUTION_MODES is declared locally to keep this leaf import-free (see its
    // doc comment). That is only safe while it cannot drift from the two places
    // that already name the same three values.
    expect([...EXECUTION_MODES].sort()).toEqual(Object.values(PROVIDER_TYPES).sort());
    expect([...EXECUTION_MODES]).toEqual([...ROUTE_MODES]);
  });
});
