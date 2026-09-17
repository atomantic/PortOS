/**
 * Agent-free resilience assay for Eidoverse world foundations, run before a
 * contribution is eligible to promote from an instance's local vernacular
 * into the shared PortOS baseline (#7460, part of epic #7453).
 *
 * SwarmWorld's premise: a build only earns "promote" once it still works
 * with its author mind gone. This harness enforces that mechanically —
 * `runResilienceAssay()` never receives, imports, or invokes any mind, CoS
 * agent, or AI-provider handle, and it rejects a controller step that
 * returns a Promise (an async step is the shape a live network/provider call
 * would take, so "agent-free" is enforced as "synchronous", not merely
 * documented). A contribution's `createSandbox()` is re-invoked fresh for
 * every scenario, so no state can leak in from a previous run or from a
 * closure captured back when the contribution's author was still narrating
 * it live.
 *
 * A contribution supplies:
 *   - `id` / `description`: identity for readable failure output.
 *   - `createSandbox()`: returns `{ worldState, controller, projectionSource? }`.
 *     `worldState` is plain, JSON-serializable state (a promoted foundation
 *     must be loadable by a peer that never saw the authoring session).
 *   - `controller.step(worldState, tick)`: advances one tick, returning the
 *     next `worldState` (or mutating and returning it — the harness does not
 *     require immutability, only determinism and survival).
 *   - `controller.applyDisturbance(worldState, disturbanceId)` (optional):
 *     called once per scenario between the warm-up ticks and the recovery
 *     ticks. A controller that omits it is asserting the disturbance is a
 *     no-op, which the recovery ticks still have to prove out.
 *   - `invariants` (optional): `(worldState, tick) => true | false | { ok, reason }`
 *     checks specific to the contribution (e.g. "no entity outside its
 *     district bounds"), run after every tick alongside the harness's own
 *     built-in serializability check.
 *
 * This module makes no network, filesystem, or provider calls and depends
 * only on `buildProjectionPlan` (already pure) for the "load projections in
 * a clean sandbox" leg of the assay. The promote path (#7455) calls
 * `runResilienceAssay()` per candidate contribution and refuses to package a
 * promote candidate on a failing verdict — see
 * `services/eidoverseFoundationLedger.js`; `scripts/eidoverse-resilience-assay.js`
 * gives CI (or a human) the same verdict from the command line.
 *
 * try/catch here is deliberate, not the "errors bubble to middleware" default
 * (AGENTS.md "Code Conventions"): a contribution's controller is untrusted,
 * isolated code the assay evaluates rather than internal PortOS request
 * handling, and turning its exceptions into a readable pass/fail verdict is
 * this module's whole job — same rationale as the PTY/child-process boundary
 * exception, applied to a sandboxed replay boundary instead of a process one.
 */

import { buildProjectionPlan } from './eidoverseWorldProjection.js';

/** The fixed, mild disturbance suite every contribution is replayed against. */
export const RESILIENCE_DISTURBANCES = Object.freeze([
  // A peer/session dropping and re-establishing its connection to the world.
  'reconnect',
  // The Eidoverse host bridge (server/services/eidoverseHost.js) bouncing —
  // the controller has to resume from serialized state, not an in-memory
  // handle to the process that just died.
  'restart-world-host',
  // An optional dependency (a feature flag, a peer, an asset) going missing —
  // the controller must degrade rather than assume everything it saw during
  // authoring is still there.
  'missing-optional-deps',
]);

const DEFAULT_WARMUP_TICKS = 5;
const DEFAULT_RECOVERY_TICKS = 3;

function describeInvariant(invariant, index) {
  return invariant.name || `invariant[${index}]`;
}

/** Built-in structural check: state a promoted foundation carries must be
 * loadable by a peer that never ran the authoring session, so it has to
 * round-trip through JSON without throwing or losing identity to `NaN`/
 * `undefined` coercion. */
function serializabilityFailure(worldState) {
  let json;
  try {
    json = JSON.stringify(worldState);
  } catch (error) {
    return `world state is not JSON-serializable: ${error.message}`;
  }
  if (json === undefined) return 'world state serialized to undefined (functions/symbols at the top level are not portable to a peer sandbox)';
  return null;
}

function runInvariants(worldState, tick, invariants) {
  const failures = [];
  const structural = serializabilityFailure(worldState);
  if (structural) failures.push(`tick ${tick}: ${structural}`);

  invariants.forEach((invariant, index) => {
    const label = describeInvariant(invariant, index);
    let result;
    try {
      result = invariant(worldState, tick);
    } catch (error) {
      failures.push(`tick ${tick}: invariant "${label}" threw: ${error.message}`);
      return;
    }
    if (result === true || result == null) return;
    if (isThenable(result)) {
      failures.push(`tick ${tick}: invariant "${label}" returned a Promise — invariants must be synchronous`);
      return;
    }
    if (result === false) {
      failures.push(`tick ${tick}: invariant "${label}" failed`);
      return;
    }
    if (typeof result === 'object' && result.ok === false) {
      failures.push(`tick ${tick}: invariant "${label}" failed${result.reason ? `: ${result.reason}` : ''}`);
    }
  });
  return failures;
}

function isThenable(value) {
  return Boolean(value) && typeof value === 'object' && typeof value.then === 'function';
}

const ASYNC_STEP_REASON = 'controller.step() returned a Promise — the resilience assay replays contributions synchronously and agent-free; a controller that needs to await anything is reaching for a live network, disk, or provider call the assay does not permit';

function runStep(controller, worldState, tick) {
  const next = controller.step(worldState, tick);
  if (isThenable(next)) throw new Error(ASYNC_STEP_REASON);
  return next === undefined ? worldState : next;
}

function runScenario({ contribution, disturbance, warmupTicks, recoveryTicks }) {
  let sandbox;
  try {
    sandbox = contribution.createSandbox();
  } catch (error) {
    return { disturbance, pass: false, reasons: [`createSandbox() threw: ${error.message}`] };
  }
  if (!sandbox || typeof sandbox.controller?.step !== 'function') {
    return { disturbance, pass: false, reasons: ['createSandbox() must return { worldState, controller } with a controller.step(worldState, tick) function'] };
  }

  const invariants = Array.isArray(contribution.invariants) ? contribution.invariants : [];
  let worldState = sandbox.worldState;
  let tick = 0;
  const reasons = [];

  for (; tick < warmupTicks; tick += 1) {
    try {
      worldState = runStep(sandbox.controller, worldState, tick);
    } catch (error) {
      return { disturbance, pass: false, reasons: [`tick ${tick} (warm-up, before "${disturbance}"): ${error.message}`] };
    }
    reasons.push(...runInvariants(worldState, tick, invariants));
  }
  if (reasons.length > 0) return { disturbance, pass: false, reasons };

  if (typeof sandbox.controller.applyDisturbance === 'function') {
    try {
      const disturbed = sandbox.controller.applyDisturbance(worldState, disturbance);
      if (isThenable(disturbed)) return { disturbance, pass: false, reasons: [`applyDisturbance("${disturbance}") returned a Promise — disturbances are applied synchronously`] };
      worldState = disturbed === undefined ? worldState : disturbed;
    } catch (error) {
      return { disturbance, pass: false, reasons: [`applyDisturbance("${disturbance}") threw: ${error.message}`] };
    }
  }

  for (let recovered = 0; recovered < recoveryTicks; recovered += 1, tick += 1) {
    try {
      worldState = runStep(sandbox.controller, worldState, tick);
    } catch (error) {
      return { disturbance, pass: false, reasons: [`tick ${tick} (recovering from "${disturbance}"): ${error.message}`] };
    }
    reasons.push(...runInvariants(worldState, tick, invariants));
  }

  return { disturbance, pass: reasons.length === 0, reasons };
}

/**
 * Try loading projections against the sandbox's initial world state, the
 * "replay ... / load projections in a clean sandbox instance" leg of the
 * assay. `buildProjectionPlan` is already pure/deterministic, so this only
 * proves the contribution's state shape survives that boundary — it does
 * not touch a live world or Eidoverse host.
 */
function checkProjectionLoad(contribution) {
  let sandbox;
  try {
    sandbox = contribution.createSandbox();
  } catch (error) {
    return { pass: false, reason: `createSandbox() threw before projection load: ${error.message}` };
  }
  try {
    const plan = buildProjectionPlan({
      source: sandbox.projectionSource || {},
      currentState: sandbox.worldState || {},
    });
    if (!plan || !Array.isArray(plan.operations)) {
      return { pass: false, reason: 'buildProjectionPlan() did not return a plan with an operations array' };
    }
  } catch (error) {
    return { pass: false, reason: `buildProjectionPlan() threw against this contribution's world state: ${error.message}` };
  }
  return { pass: true, reason: null };
}

/**
 * Run the full agent-free resilience assay for one contribution.
 *
 * @param {object} contribution
 * @param {string} [contribution.id]
 * @param {() => { worldState: object, controller: object, projectionSource?: object }} contribution.createSandbox
 * @param {Array<Function>} [contribution.invariants]
 * @param {object} [options]
 * @param {string[]} [options.disturbances]
 * @param {number} [options.warmupTicks]
 * @param {number} [options.recoveryTicks]
 * @returns {{ contributionId: string, pass: boolean, scenarios: Array, projection: {pass: boolean, reason: string|null}, reasons: string[] }}
 */
export function runResilienceAssay(contribution, {
  disturbances = RESILIENCE_DISTURBANCES,
  warmupTicks = DEFAULT_WARMUP_TICKS,
  recoveryTicks = DEFAULT_RECOVERY_TICKS,
} = {}) {
  const contributionId = contribution?.id || 'unknown-contribution';
  if (!contribution || typeof contribution.createSandbox !== 'function') {
    return {
      contributionId,
      pass: false,
      scenarios: [],
      projection: { pass: false, reason: 'contribution did not run: missing createSandbox()' },
      reasons: ['contribution must provide createSandbox()'],
    };
  }

  const projection = checkProjectionLoad(contribution);
  const scenarios = disturbances.map((disturbance) => runScenario({ contribution, disturbance, warmupTicks, recoveryTicks }));

  const reasons = [
    ...(projection.pass ? [] : [`[load-projection] ${projection.reason}`]),
    ...scenarios.flatMap((scenario) => (scenario.pass ? [] : scenario.reasons.map((reason) => `[${scenario.disturbance}] ${reason}`))),
  ];

  return {
    contributionId,
    pass: reasons.length === 0,
    scenarios,
    projection,
    reasons,
  };
}
