/**
 * Reference DELIBERATELY-FAILING fixture for the agent-free resilience
 * assay (#7460).
 *
 * Named `.failing.fixture.js` (not `.contribution.js`) on purpose: the CI
 * script's default fixture glob only picks up `*.contribution.js`, so this
 * one is exercised only by `eidoverseResilienceAssay.test.js`, which asserts
 * the harness correctly rejects it. It is proof the assay works, not a
 * contribution anyone should promote.
 *
 * The bug it demonstrates: an "author session" handle captured outside
 * `worldState` at sandbox-creation time. It behaves fine for `reconnect` and
 * `missing-optional-deps`, but a simulated `restart-world-host` invalidates
 * that live-only handle — exactly the "only works because the author mind is
 * narrating it" failure mode SwarmWorld's agent-free evaluation targets.
 */

function createNarratedOnlyController() {
  // Captured OUTSIDE worldState. A real world host restart would drop this
  // along with the process that created it; nothing here re-derives it from
  // serialized state the way the beacon-relay fixture does.
  const authorSession = { narrate: (tick) => `authored beacon pulse ${tick}` };
  let hostAlive = true;

  return {
    step(worldState, tick) {
      if (!hostAlive) {
        throw new Error('author session handle is gone after the world host restarted, and this contribution has no fallback path that re-derives it from worldState');
      }
      return { ...worldState, pulses: worldState.pulses + 1, lastNarration: authorSession.narrate(tick) };
    },
    applyDisturbance(worldState, disturbance) {
      if (disturbance === 'restart-world-host') {
        hostAlive = false;
      }
      return worldState;
    },
  };
}

export function createNarratedOnlyContribution() {
  return {
    id: 'narrated-only-demo',
    description: 'Reference failing contribution: depends on an in-memory author-session handle a world-host restart invalidates.',
    createSandbox() {
      return {
        worldState: { pulses: 0, entities: {} },
        controller: createNarratedOnlyController(),
        projectionSource: {},
      };
    },
    invariants: [
      function pulsesAreNonNegative(worldState) {
        return Number.isInteger(worldState.pulses) && worldState.pulses >= 0;
      },
    ],
  };
}
