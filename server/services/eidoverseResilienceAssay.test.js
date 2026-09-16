import { describe, expect, it } from 'vitest';
import { runResilienceAssay, RESILIENCE_DISTURBANCES } from './eidoverseResilienceAssay.js';
import { createBeaconRelayContribution } from './eidoverseResilienceAssayFixtures/beaconRelay.contribution.js';
import { createNarratedOnlyContribution } from './eidoverseResilienceAssayFixtures/narratedOnly.failing.fixture.js';

describe('runResilienceAssay', () => {
  it('passes a contribution that keeps all state in worldState and survives every disturbance', () => {
    const result = runResilienceAssay(createBeaconRelayContribution());

    expect(result.pass).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.projection.pass).toBe(true);
    expect(result.scenarios).toHaveLength(RESILIENCE_DISTURBANCES.length);
    expect(result.scenarios.every((scenario) => scenario.pass)).toBe(true);
  });

  it('fails a contribution that only works via a live author-session handle a world-host restart drops', () => {
    const result = runResilienceAssay(createNarratedOnlyContribution());

    expect(result.pass).toBe(false);
    const restartScenario = result.scenarios.find((scenario) => scenario.disturbance === 'restart-world-host');
    expect(restartScenario.pass).toBe(false);
    expect(restartScenario.reasons[0]).toMatch(/author session handle is gone/);
    // Readable failure reasons name the offending disturbance so a promote
    // path can surface exactly why a contribution was blocked.
    expect(result.reasons.some((reason) => reason.startsWith('[restart-world-host]'))).toBe(true);

    // The unrelated disturbances this fixture happens to survive still pass —
    // the assay isolates each scenario rather than failing everything once
    // one disturbance breaks the contribution.
    const reconnectScenario = result.scenarios.find((scenario) => scenario.disturbance === 'reconnect');
    expect(reconnectScenario.pass).toBe(true);
  });

  it('re-creates the sandbox per scenario, so no state leaks from one disturbance run into the next', () => {
    let sandboxBuilds = 0;
    const contribution = {
      id: 'isolation-probe',
      createSandbox() {
        sandboxBuilds += 1;
        return {
          worldState: { pulses: 0 },
          controller: { step: (state, tick) => ({ ...state, pulses: state.pulses + 1, lastTick: tick }) },
        };
      },
    };

    runResilienceAssay(contribution);

    // Once for the projection-load preflight, once per disturbance scenario.
    expect(sandboxBuilds).toBe(RESILIENCE_DISTURBANCES.length + 1);
  });

  it('rejects a contribution missing createSandbox() with a readable reason instead of throwing', () => {
    const result = runResilienceAssay({ id: 'no-sandbox' });

    expect(result.pass).toBe(false);
    expect(result.reasons).toEqual(['contribution must provide createSandbox()']);
    expect(result.scenarios).toEqual([]);
  });

  it('rejects an async controller.step() as an agent-free violation instead of hanging on a promise', () => {
    const contribution = {
      id: 'async-step',
      createSandbox() {
        return {
          worldState: { pulses: 0 },
          controller: { step: async (state) => ({ ...state, pulses: state.pulses + 1 }) },
        };
      },
    };

    const result = runResilienceAssay(contribution);

    expect(result.pass).toBe(false);
    expect(result.reasons.some((reason) => reason.includes('agent-free'))).toBe(true);
  });

  it('surfaces a contribution-supplied invariant failure with its reason and tick', () => {
    const contribution = {
      id: 'invariant-probe',
      createSandbox() {
        return {
          worldState: { pulses: 0 },
          controller: { step: (state) => ({ ...state, pulses: state.pulses + 1 }) },
        };
      },
      invariants: [
        function pulsesStayUnderThree(worldState) {
          return worldState.pulses < 3
            ? true
            : { ok: false, reason: `pulses reached ${worldState.pulses}, over the fixture's cap of 3` };
        },
      ],
    };

    const result = runResilienceAssay(contribution, { warmupTicks: 5, recoveryTicks: 0 });

    expect(result.pass).toBe(false);
    expect(result.reasons.some((reason) => reason.includes('pulsesStayUnderThree') && reason.includes('cap of 3'))).toBe(true);
  });

  it('flags world state that cannot round-trip through JSON, even with no contribution invariants', () => {
    const contribution = {
      id: 'unserializable-state',
      createSandbox() {
        const worldState = { pulses: 0 };
        worldState.self = worldState; // circular — not portable to a peer sandbox
        return {
          worldState,
          controller: { step: (state) => state },
        };
      },
    };

    const result = runResilienceAssay(contribution);

    expect(result.pass).toBe(false);
    expect(result.reasons.some((reason) => reason.includes('not JSON-serializable'))).toBe(true);
  });

  it('fails the projection-load leg with a readable reason when buildProjectionPlan cannot use the sandbox state', () => {
    const contribution = {
      id: 'bad-projection-source',
      createSandbox() {
        return {
          worldState: { entities: {} },
          controller: { step: (state) => state },
          // A source whose `health` read throws makes buildProjectionPlan's
          // own property access fail well before any assay code is involved.
          projectionSource: {
            get health() {
              throw new Error('synthetic source read failure');
            },
          },
        };
      },
    };

    const result = runResilienceAssay(contribution);

    expect(result.projection.pass).toBe(false);
    expect(result.pass).toBe(false);
    expect(result.reasons.some((reason) => reason.startsWith('[load-projection]'))).toBe(true);
  });

  it('rejects an async invariant as a failure, same as an async controller.step()', () => {
    const contribution = {
      id: 'async-invariant',
      createSandbox() {
        return {
          worldState: { counter: 0 },
          controller: { step: (state) => ({ ...state, counter: state.counter + 1 }) },
        };
      },
      invariants: [
        async (worldState) => {
          // Simulating an invariant that awaits something (network, disk, etc.)
          await Promise.resolve();
          return worldState.counter < 5;
        },
      ],
    };

    const result = runResilienceAssay(contribution, { warmupTicks: 2, recoveryTicks: 0 });

    expect(result.pass).toBe(false);
    expect(result.reasons.some((reason) => reason.includes('returned a Promise') && reason.includes('must be synchronous'))).toBe(true);
  });
});
