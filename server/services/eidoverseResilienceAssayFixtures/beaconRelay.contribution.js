/**
 * Reference PASSING fixture for the agent-free resilience assay (#7460).
 *
 * A minimal "beacon relay" world foundation: every tick it advances a pulse
 * counter and derives a label from an optional peer id. Everything the
 * controller needs lives in `worldState`, so it survives a fresh
 * `createSandbox()` call, a simulated host restart, and a missing optional
 * peer without throwing or drifting into an invalid state. This is the
 * "still works with no author narrating it" example the harness exists to
 * recognize as promotable.
 */

const RESTART_CARRYOVER_KEYS = ['pulses', 'optionalPeerId', 'entities'];

function beaconLabel(worldState) {
  return worldState.optionalPeerId
    ? `beacon-relay-to-${worldState.optionalPeerId}`
    : 'beacon-relay-idle';
}

function createBeaconRelayController() {
  return {
    step(worldState, tick) {
      return {
        ...worldState,
        pulses: worldState.pulses + 1,
        lastBeaconLabel: beaconLabel(worldState),
        lastTick: tick,
      };
    },
    applyDisturbance(worldState, disturbance) {
      if (disturbance === 'reconnect') {
        return { ...worldState, connected: true };
      }
      if (disturbance === 'restart-world-host') {
        // Rehydrate from only the durable, serializable fields — proves the
        // controller does not depend on an in-process handle to the host
        // that just bounced.
        const carried = {};
        for (const key of RESTART_CARRYOVER_KEYS) carried[key] = worldState[key];
        return { ...carried, connected: true };
      }
      if (disturbance === 'missing-optional-deps') {
        return { ...worldState, optionalPeerId: null };
      }
      return worldState;
    },
  };
}

export function createBeaconRelayContribution() {
  return {
    id: 'beacon-relay-demo',
    description: 'Reference passing contribution: a pulse-counting beacon relay that keeps all state in worldState.',
    createSandbox() {
      return {
        worldState: { pulses: 0, connected: true, optionalPeerId: 'peer-a', entities: {} },
        controller: createBeaconRelayController(),
        projectionSource: {},
      };
    },
    invariants: [
      function pulsesAreMonotonicIntegers(worldState) {
        return Number.isInteger(worldState.pulses) && worldState.pulses >= 0;
      },
      function beaconLabelIsSet(worldState) {
        if (typeof worldState.lastBeaconLabel !== 'string' || worldState.lastBeaconLabel.length === 0) {
          return { ok: false, reason: `lastBeaconLabel was ${JSON.stringify(worldState.lastBeaconLabel)}` };
        }
        return true;
      },
    ],
  };
}
