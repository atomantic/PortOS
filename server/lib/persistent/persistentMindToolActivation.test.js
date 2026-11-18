import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOOL_ACTIVATION_RETENTION_TURNS,
  activatePersistentMindToolActivationFamilies,
  agePersistentMindToolActivation,
  createDefaultPersistentMindToolActivation,
  deactivatePersistentMindToolActivationFamilies,
  normalizePersistentMindToolActivation,
  renewPersistentMindToolActivationFamily,
  toolsActivateInputSchema,
  toolsDeactivateInputSchema,
} from './persistentMindToolActivation.js';

describe('persistentMindToolActivation', () => {
  it('defaults to no leases and drops unknown families or non-integer/negative counts on normalize', () => {
    expect(createDefaultPersistentMindToolActivation()).toEqual({ leases: {}, lastAgedTurnId: null });
    expect(normalizePersistentMindToolActivation(null)).toEqual({ leases: {}, lastAgedTurnId: null });
    expect(normalizePersistentMindToolActivation({
      leases: { mind: 2, bogus: 5, eidoverse: -1, voice: 1.5, tasks: '3' },
      lastAgedTurnId: 'turn-1',
    })).toEqual({ leases: { mind: 2 }, lastAgedTurnId: 'turn-1' });
  });

  it('activates a family for exactly the configured retention window and skips persisting a zero-turn activation', () => {
    expect(activatePersistentMindToolActivationFamilies({}, ['mind', 'eidoverse'], 3)).toEqual({ mind: 3, eidoverse: 3 });
    // 0 is deliberately one-turn-only: nothing survives for a future turn.
    expect(activatePersistentMindToolActivationFamilies({}, ['mind'], 0)).toEqual({});
    // An unknown family name is silently ignored rather than corrupting the map.
    expect(activatePersistentMindToolActivationFamilies({}, ['not-a-family'], 3)).toEqual({});
  });

  it('ages a lease down to its floor, keeps it visible on its last turn, and drops it only the turn after', () => {
    // Activated with a 1-turn window: still present (at floor 0) for exactly
    // one more aging pass — visible through every round-refresh of that
    // turn — then gone on the next.
    const leases = activatePersistentMindToolActivationFamilies({}, ['mind'], 1);
    const afterFirstAge = agePersistentMindToolActivation(leases);
    expect(afterFirstAge.leases).toEqual({ mind: 0 });
    const afterSecondAge = agePersistentMindToolActivation(afterFirstAge.leases);
    expect(afterSecondAge.leases).toEqual({});
  });

  it('ages a multi-turn lease down by exactly one turn per call', () => {
    const leases = activatePersistentMindToolActivationFamilies({}, ['eidoverse'], 3);
    const once = agePersistentMindToolActivation(leases);
    expect(once.leases).toEqual({ eidoverse: 2 });
    const twice = agePersistentMindToolActivation(once.leases);
    expect(twice.leases).toEqual({ eidoverse: 1 });
  });

  it('renews only the family actually used, leaving an unrelated activated family to keep aging', () => {
    const leases = activatePersistentMindToolActivationFamilies({}, ['mind', 'eidoverse'], 3);
    const aged = agePersistentMindToolActivation(leases).leases; // { mind: 2, eidoverse: 2 }
    const renewed = renewPersistentMindToolActivationFamily(aged, 'mind', DEFAULT_TOOL_ACTIVATION_RETENTION_TURNS);
    expect(renewed).toEqual({ mind: DEFAULT_TOOL_ACTIVATION_RETENTION_TURNS, eidoverse: 2 });
  });

  it('deactivate clears named families or, with none given, every lease', () => {
    const leases = activatePersistentMindToolActivationFamilies({}, ['mind', 'eidoverse', 'voice'], 3);
    expect(deactivatePersistentMindToolActivationFamilies(leases, ['mind'])).toEqual({ eidoverse: 3, voice: 3 });
    expect(deactivatePersistentMindToolActivationFamilies(leases, undefined)).toEqual({});
    expect(deactivatePersistentMindToolActivationFamilies(leases, [])).toEqual({});
  });

  it('validates tools.activate/tools.deactivate input against the exact family vocabulary', () => {
    expect(toolsActivateInputSchema.safeParse({ families: ['mind', 'eidoverse'] }).success).toBe(true);
    expect(toolsActivateInputSchema.safeParse({ families: [] }).success).toBe(false);
    expect(toolsActivateInputSchema.safeParse({ families: ['not-a-family'] }).success).toBe(false);
    expect(toolsActivateInputSchema.safeParse({}).success).toBe(false);
    expect(toolsDeactivateInputSchema.safeParse({}).success).toBe(true);
    expect(toolsDeactivateInputSchema.safeParse({ families: ['voice'] }).success).toBe(true);
    expect(toolsDeactivateInputSchema.safeParse({ families: ['not-a-family'] }).success).toBe(false);
  });
});
