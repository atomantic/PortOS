/**
 * Executable Eidoverse world controllers — the install schema, the sandboxed
 * step boundary, and the tick scheduling math (#7456, part of epic #7453).
 *
 * SwarmWorld's strongest result is that technologies are *executable*: they
 * keep running when the agent that authored them is gone. PortOS minds wake
 * intermittently, so a world that only changes during a mind turn is a world
 * that is dead most of the time. A controller is the durable thing that keeps
 * running between wakes — a resource tick, an ambient verb, a gentle NPC, a
 * maintenance hook — supervised by PortOS rather than by whoever installed it.
 *
 * **What "sandboxed" means here, precisely.** The threat is not a hostile
 * shipped module; it is a mind (or an HTTP body) turning a string into code:
 *
 *   1. **Behavior is resolved by ID against a fixed registry, never by path.**
 *      An install names a `controllerId`;
 *      `services/eidoverseControllerRegistry.js` maps that id to a module
 *      PortOS ships. Nothing a caller supplies is ever imported, required, or
 *      evaluated. This is the same rule
 *      `services/eidoverseResilienceContributions.js` already applies to assay
 *      contributions, for the same reason: "import the module this request
 *      names" is arbitrary code execution wearing a feature's clothes.
 *   2. **A step is SYNCHRONOUS.** `runControllerStep()` refuses a step that
 *      returns a Promise. An await is the shape every network, disk, and AI
 *      provider call takes, so refusing it makes root AGENTS.md's
 *      "no cold-bootstrap LLM calls" a structural property of the tick path
 *      instead of a comment: a controller *cannot* reach a provider, whatever
 *      its author intended. It is the same rule the resilience assay enforces
 *      on the same reasoning, which is why a controller doubles as an assay
 *      contribution for free.
 *   3. **State is DATA, and bounded.** A controller is handed JSON copies of
 *      its state and config, so it can never retain a live reference into the
 *      ledger, and the state it returns must round-trip through JSON under a
 *      byte cap. A controller that cannot serialize is a controller that could
 *      not survive the restart it exists to survive.
 *   4. **Side effects are a closed vocabulary, and they are PROPOSALS.** A
 *      step returns effects, it does not perform them — the same
 *      proposal-versus-consequence separation #7454 gave the construction
 *      tools. `note` never leaves the ledger at all; `say` and `augment` reach
 *      the world only for an install whose `deliverEffects` was explicitly
 *      turned on, and `augment` reuses the already-bounded world verb schema
 *      rather than inventing a second one.
 *
 * Pure: no I/O, no clock of its own (callers pass `now`), no provider calls.
 * The persisted installs and the supervised tick loop live in
 * `services/eidoverseControllerRuntime.js`.
 */

import { z } from 'zod';
import { eidoverseWorldAugmentSchema } from './eidoverseValidation.js';

export const EIDOVERSE_CONTROLLER_LIMITS = Object.freeze({
  idMax: 64,
  // A per-install ceiling on how many controllers can be armed at once. The
  // supervisor runs every due install in one pass, so this is what keeps a
  // pass bounded regardless of how enthusiastic an author was.
  installs: 24,
  configBytes: 4_096,
  stateBytes: 16_384,
  effectsPerTick: 8,
  effectTextMax: 280,
  augmentOperationsPerEffect: 8,
  recentEffects: 20,
  noteMax: 240,
  reasonMax: 400,
  // The floor MATCHES the supervisor's own wake interval
  // (`SUPERVISOR_INTERVAL_MS` in `services/eidoverseControllerRuntime.js`): a
  // cadence below the resolution at which "due" is noticed is a number the
  // schema would accept and the supervisor could never honor. A day is the
  // longest cadence that still reads as "running".
  minTickIntervalMs: 60_000,
  maxTickIntervalMs: 86_400_000,
  defaultTickIntervalMs: 300_000,
  // A controller that fails this many ticks in a row is disarmed rather than
  // retried forever. A broken controller that keeps its schedule is a log the
  // user never reads; one that stops and says why is a thing they can fix.
  maxConsecutiveFailures: 3,
});

/** What a controller may ask the world to do. Deliberately closed. */
export const EIDOVERSE_CONTROLLER_EFFECT_KINDS = Object.freeze(['note', 'say', 'augment']);

const effectTextSchema = z.string().trim().min(1).max(EIDOVERSE_CONTROLLER_LIMITS.effectTextMax);

/**
 * One proposed effect from a tick.
 *
 * `note` is bookkeeping the author reads back later and never crosses into the
 * world. `say` and `augment` are world verbs, and `augment` reuses
 * `eidoverseWorldAugmentSchema`'s own operation array — including its verb
 * enum and its 8KB per-argument cap — with a tighter length bound on top, so
 * there is exactly one definition of a legal construction operation in the
 * tree rather than a second one that can drift from it.
 */
export const eidoverseControllerEffectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('note'), text: effectTextSchema }).strict(),
  z.object({ kind: z.literal('say'), text: effectTextSchema }).strict(),
  z.object({
    kind: z.literal('augment'),
    operations: eidoverseWorldAugmentSchema.shape.operations.max(EIDOVERSE_CONTROLLER_LIMITS.augmentOperationsPerEffect),
  }).strict(),
]);

const slugSchema = (max) => z.string().trim().min(1).max(max)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be a lowercase slug (letters, digits, hyphens)');

const controllerInstallIdSchema = slugSchema(EIDOVERSE_CONTROLLER_LIMITS.idMax);
const controllerDefinitionIdSchema = slugSchema(EIDOVERSE_CONTROLLER_LIMITS.idMax);

const isoDateSchema = z.string().datetime();

const boundedJsonObject = (maxBytes) => z.record(z.string().min(1).max(64), z.unknown())
  .refine((value) => JSON.stringify(value).length <= maxBytes, `must serialize to at most ${maxBytes} bytes`);

/**
 * Where in the world this controller sits. Spatial situation is part of the
 * issue's premise — a controller reads and acts on LOCAL world state — but
 * PortOS does not resolve these ids here: they are carried to the definition
 * as config it may use, and an id naming nothing simply means a controller
 * with nothing local to act on.
 */
const controllerPlacementSchema = z.object({
  districtId: z.string().trim().min(1).max(64).nullable().default(null),
  anchorEntityId: z.string().trim().min(1).max(64).nullable().default(null),
}).strict();

/**
 * What a caller (route, mind tool, test) may install.
 *
 * `deliverEffects` defaults to FALSE on purpose. Installing a controller arms
 * bookkeeping; letting it speak and build in the world is a second, explicit
 * decision. Nothing here is ever shared by omission — the same posture the
 * foundation layers take toward promotion.
 */
export const eidoverseControllerInstallSchema = z.object({
  id: controllerInstallIdSchema,
  controllerId: controllerDefinitionIdSchema,
  tickIntervalMs: z.number().int()
    .min(EIDOVERSE_CONTROLLER_LIMITS.minTickIntervalMs)
    .max(EIDOVERSE_CONTROLLER_LIMITS.maxTickIntervalMs)
    .default(EIDOVERSE_CONTROLLER_LIMITS.defaultTickIntervalMs),
  placement: controllerPlacementSchema.default({}),
  config: boundedJsonObject(EIDOVERSE_CONTROLLER_LIMITS.configBytes).default({}),
  deliverEffects: z.boolean().default(false),
  armed: z.boolean().default(true),
  note: z.string().trim().min(1).max(EIDOVERSE_CONTROLLER_LIMITS.noteMax).nullable().default(null),
}).strict();

export const eidoverseControllerIdParamSchema = z.object({ id: controllerInstallIdSchema }).strict();

/**
 * A config-only update: change what an installed controller is configured
 * with while its accumulated `state` survives untouched (#7629). This is the
 * "inherit and modify" verb the epic names — distinct from re-installing the
 * same id, which rebuilds state from the new config and throws the old state
 * away.
 */
export const eidoverseControllerConfigUpdateSchema = z.object({
  id: controllerInstallIdSchema,
  config: boundedJsonObject(EIDOVERSE_CONTROLLER_LIMITS.configBytes),
}).strict();

export const eidoverseControllerArmSchema = z.object({ id: controllerInstallIdSchema, armed: z.boolean() }).strict();

/** Who installed this, at the coarsest grain that is still useful — the same
 * three actors a foundation records, and deliberately no display name. */
const installedBySchema = z.enum(['mind', 'cos', 'user']);

/** The last tick's outcome, kept so "is this thing alive, and did it work"
 * is answerable without re-running anything. */
const controllerTickOutcomeSchema = z.object({
  at: isoDateSchema,
  tick: z.number().int().min(0),
  ok: z.boolean(),
  reason: z.string().trim().min(1).max(EIDOVERSE_CONTROLLER_LIMITS.reasonMax).nullable().default(null),
  effects: z.number().int().min(0).default(0),
  delivered: z.number().int().min(0).default(0),
  deliveryError: z.string().trim().min(1).max(EIDOVERSE_CONTROLLER_LIMITS.reasonMax).nullable().default(null),
}).strict();

/** The persisted install record. Machine-local; nothing here federates. */
export const eidoverseControllerRecordSchema = eidoverseControllerInstallSchema.extend({
  installedBy: installedBySchema,
  installedAt: isoDateSchema,
  updatedAt: isoDateSchema,
  // The controller's own durable state, advanced one step per tick. This is
  // the whole of what survives a restart — a controller that stashes anything
  // outside it does not survive the disturbance it claims to.
  state: z.record(z.string().min(1).max(64), z.unknown()),
  tick: z.number().int().min(0),
  nextTickAt: isoDateSchema,
  lastTickAt: isoDateSchema.nullable().default(null),
  lastOutcome: controllerTickOutcomeSchema.nullable().default(null),
  recentEffects: z.array(z.object({
    at: isoDateSchema,
    tick: z.number().int().min(0),
    kind: z.enum(EIDOVERSE_CONTROLLER_EFFECT_KINDS),
    summary: z.string().trim().min(1).max(EIDOVERSE_CONTROLLER_LIMITS.effectTextMax),
  }).strict()).max(EIDOVERSE_CONTROLLER_LIMITS.recentEffects).default([]),
  consecutiveFailures: z.number().int().min(0).default(0),
  // Set when the supervisor disarms a controller itself (repeated failures, a
  // controller id that no longer resolves). Distinct from `armed: false`
  // chosen by a human, which carries no reason.
  disarmedReason: z.string().trim().min(1).max(EIDOVERSE_CONTROLLER_LIMITS.reasonMax).nullable().default(null),
}).strict();

// ---------------------------------------------------------------------------
// The sandboxed step boundary
// ---------------------------------------------------------------------------

const ASYNC_STEP_REASON = 'step() returned a Promise — a controller tick is synchronous by design, so a controller that needs to await something is reaching for a network, disk, or AI-provider call the supervisor does not permit';

const isThenable = (value) => Boolean(value) && typeof value === 'object' && typeof value.then === 'function';

const stepFailure = (reason) => ({ ok: false, state: null, effects: [], reason });

/**
 * Run a definition's `invariants` against the state a step just produced, the
 * same `(state, tick) => true | false | { ok, reason }` shape
 * `eidoverseResilienceAssay.js`'s `runInvariants` evaluates them under. The
 * live tick path holds a controller to the same contract the promote gate
 * does, rather than the gate being the stricter of the two (#7629).
 */
function invariantFailures(state, tick, invariants) {
  const failures = [];
  for (const invariant of invariants) {
    const label = invariant.name || 'invariant';
    let result;
    try {
      result = invariant(state, tick);
    } catch (error) {
      failures.push(`"${label}" threw: ${error.message}`);
      continue;
    }
    if (isThenable(result)) {
      failures.push(`"${label}" returned a Promise — invariants must be synchronous`);
    } else if (result === false) {
      failures.push(`"${label}" failed`);
    } else if (result && typeof result === 'object' && result.ok === false) {
      failures.push(`"${label}" failed${result.reason ? `: ${result.reason}` : ''}`);
    }
  }
  return failures;
}

/**
 * A JSON round-trip copy, or `null` when the value cannot make the trip.
 *
 * Used on the way IN as well as out: handing a controller a copy is what stops
 * it retaining a live reference into the persisted record, and a config that
 * cannot serialize would have failed at the write anyway.
 */
function jsonCopy(value) {
  // `JSON.stringify` THROWS on a BigInt and on a circular reference, and
  // returns `undefined` for a bare function or symbol. All three are the same
  // verdict here — "this did not survive the trip" — and none of them may
  // escape as an exception: this runs on a supervised background tick, where
  // an uncaught throw reaches a timer callback and takes the process down.
  let json;
  try {
    json = JSON.stringify(value);
  } catch {
    return null;
  }
  if (json === undefined) return null;
  return { value: JSON.parse(json), bytes: json.length };
}

/**
 * Run ONE controller step under the sandbox rules in the module header.
 *
 * try/catch here is deliberate rather than the "errors bubble to centralized
 * middleware" default (AGENTS.md "Code Conventions"): this is the boundary
 * where PortOS evaluates code on behalf of a supervised background loop, not
 * inside an Express request, and turning a controller's exception into a
 * recorded reason is this function's whole job. An uncaught throw here would
 * reach a timer callback and take the process down.
 *
 * @param {object} options
 * @param {object} options.definition - a registry definition (`{ id, step }`)
 * @param {object} options.state - the controller's durable state
 * @param {object} options.config - the install's validated config
 * @param {number} options.tick - the tick ordinal about to run
 * @returns {{ ok: boolean, state: object|null, effects: Array, reason: string|null }}
 */
export function runControllerStep({ definition, state, config, tick }) {
  if (!definition || typeof definition.step !== 'function') {
    return stepFailure('controller definition has no step(state, context) function');
  }

  const inputState = jsonCopy(state ?? {});
  const inputConfig = jsonCopy(config ?? {});
  if (!inputState || !inputConfig) return stepFailure('controller state or config is not JSON-serializable');

  let outcome;
  try {
    outcome = definition.step(inputState.value, { tick, config: inputConfig.value });
  } catch (error) {
    return stepFailure(`step() threw: ${error.message}`.slice(0, EIDOVERSE_CONTROLLER_LIMITS.reasonMax));
  }
  if (isThenable(outcome)) return stepFailure(ASYNC_STEP_REASON);

  // A step that returns nothing is asserting "this tick changed no state",
  // which is an ordinary outcome for a controller that only acts every Nth
  // tick — not a failure, and not a reason to lose the state it already had.
  const nextState = outcome?.state === undefined ? inputState.value : outcome.state;
  if (!nextState || typeof nextState !== 'object' || Array.isArray(nextState)) {
    return stepFailure('step() must return { state } as a plain object (or nothing, to leave state unchanged)');
  }
  const serialized = jsonCopy(nextState);
  if (!serialized) return stepFailure('step() returned state that is not JSON-serializable — a controller that cannot serialize cannot survive the restart it exists to survive');
  if (serialized.bytes > EIDOVERSE_CONTROLLER_LIMITS.stateBytes) {
    return stepFailure(`step() returned ${serialized.bytes} bytes of state, over the ${EIDOVERSE_CONTROLLER_LIMITS.stateBytes}-byte cap — a controller that grows without bound is a disk leak with a schedule`);
  }

  const rawEffects = outcome?.effects === undefined ? [] : outcome.effects;
  if (!Array.isArray(rawEffects)) return stepFailure('step() returned a non-array `effects`');
  if (rawEffects.length > EIDOVERSE_CONTROLLER_LIMITS.effectsPerTick) {
    return stepFailure(`step() proposed ${rawEffects.length} effects, over the ${EIDOVERSE_CONTROLLER_LIMITS.effectsPerTick}-per-tick cap`);
  }
  const effects = z.array(eidoverseControllerEffectSchema).safeParse(rawEffects);
  if (!effects.success) {
    const [issue] = effects.error.issues;
    return stepFailure(`step() proposed an effect outside the permitted vocabulary: ${issue ? `${issue.path.join('.')}: ${issue.message}` : 'unknown'}`.slice(0, EIDOVERSE_CONTROLLER_LIMITS.reasonMax));
  }

  if (Array.isArray(definition.invariants) && definition.invariants.length > 0) {
    const failed = invariantFailures(serialized.value, tick, definition.invariants);
    if (failed.length > 0) {
      return stepFailure(`live state violated an invariant: ${failed.join('; ')}`.slice(0, EIDOVERSE_CONTROLLER_LIMITS.reasonMax));
    }
  }

  return { ok: true, state: serialized.value, effects: effects.data, reason: null };
}

/** One line per effect for the install's recent-effects ring. */
export function summarizeControllerEffect(effect) {
  if (effect.kind === 'augment') {
    return `${effect.operations.length} world operation${effect.operations.length === 1 ? '' : 's'}: ${effect.operations.map((operation) => operation.verb).join(', ')}`
      .slice(0, EIDOVERSE_CONTROLLER_LIMITS.effectTextMax);
  }
  return effect.text;
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/**
 * Whether this install is due to step, given the supervisor's current wall
 * clock. An unarmed install is never due.
 */
export function controllerTickDue(record, nowMs) {
  if (!record || record.armed !== true) return false;
  const due = Date.parse(record.nextTickAt);
  // An unparseable `nextTickAt` (hand-edited file, a record from a shape this
  // version does not know) reads as due rather than as never: a controller
  // stuck forever is a worse failure than one extra step.
  return Number.isNaN(due) || due <= nowMs;
}

/**
 * When this install should step next.
 *
 * Deliberately measured from NOW rather than from the tick that was missed: a
 * laptop asleep for three days must wake to ONE tick, not to a backlog of
 * eight hundred replayed ambient verbs. A controller's cadence is "about this
 * often", never a ledger of owed executions.
 */
export function nextControllerTickAt(record, nowMs) {
  return new Date(nowMs + record.tickIntervalMs).toISOString();
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * An install record reduced to what a MODEL needs to reason about it.
 *
 * The full record carries the controller's whole durable state — up to 16KB of
 * counters and ring buffers that would ride into every prompt turn for no
 * decision value — so a LIST omits it and an INSPECT of one install includes
 * it. That is the same discipline `summarizeFoundation` applies to a
 * foundation's `style` and packaged candidate.
 */
export function summarizeControllerInstall(record, { includeState = false } = {}) {
  return {
    id: record?.id ?? null,
    controllerId: record?.controllerId ?? null,
    armed: record?.armed === true,
    deliverEffects: record?.deliverEffects === true,
    tickIntervalMs: record?.tickIntervalMs ?? null,
    placement: record?.placement ?? null,
    installedBy: record?.installedBy ?? null,
    installedAt: record?.installedAt ?? null,
    tick: record?.tick ?? 0,
    lastTickAt: record?.lastTickAt ?? null,
    nextTickAt: record?.nextTickAt ?? null,
    // `null` is "it has never stepped", which is a different state from a
    // recorded failure — never collapse the two into `false`.
    lastTickOk: record?.lastOutcome ? record.lastOutcome.ok === true : null,
    lastTickReason: record?.lastOutcome?.reason ?? null,
    consecutiveFailures: record?.consecutiveFailures ?? 0,
    disarmedReason: record?.disarmedReason ?? null,
    note: record?.note ?? null,
    recentEffects: (record?.recentEffects ?? []).slice(0, 5),
    ...(includeState ? { config: record?.config ?? {}, state: record?.state ?? {} } : {}),
  };
}
