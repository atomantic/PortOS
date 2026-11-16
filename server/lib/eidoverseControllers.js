/**
 * Executable Eidoverse world controllers — the install schema, the sandboxed
 * step boundary, and the tick scheduling math (#7456, part of epic #7453).
 *
 * `eidoverseControllerInstallSchema` / `eidoverseControllerRecordSchema` describe an install (a
 * registry `controllerId`, a bounded `config`, a `tickIntervalMs`, and a `deliverEffects` flag that is
 * FALSE by default, so installing arms bookkeeping and never a world verb).
 * `eidoverseRiddleActionSchema` validates the fixed offer/guess/reveal action with an inspected
 * `expectedRevision`. `runControllerStep` is the sandbox: it hands the controller JSON copies of its
 * state and config, REFUSES a step that returns a Promise (an await is the shape every
 * network/disk/AI-provider call takes, so the tick path is provider-free structurally rather than by
 * convention), caps the state it may return, and validates its effects against a closed vocabulary —
 * `note` (never leaves the ledger), `say`, and `augment`, which reuses `eidoverseValidation.js`'s own
 * world-verb operation schema. `controllerTickDue` / `nextControllerTickAt` are the scheduling math,
 * measured from now so a machine that slept wakes to ONE tick and not a replayed backlog.
 * `summarizeControllerInstall` is the prompt-shaped projection that keeps a 16KB state blob out of a
 * mind turn; it surfaces `derivedFrom`, the edge an install adopted from a peer's foundation carries
 * (#7626). Pure: callers pass `now`.
 *
 * PortOS minds wake intermittently, so a controller is the durable thing that
 * keeps running between wakes, supervised by PortOS rather than by its installer.
 *
 * **What "sandboxed" means here, precisely.** The threat is not a hostile
 * shipped module; it is a mind (or an HTTP body) turning a string into code:
 *
 *   1. **Behavior is resolved by ID against a fixed registry, never by path.**
 *      An install names a `controllerId`;
 *      `services/eidoverseControllerRegistry.js` maps it to a module PortOS
 *      ships. Nothing a caller supplies is ever imported or evaluated (the same
 *      rule as `services/eidoverseResilienceContributions.js`).
 *   2. **A step is SYNCHRONOUS.** `runControllerStep()` refuses a step that
 *      returns a Promise. An await is the shape every network, disk, and AI
 *      provider call takes, so refusing it makes "no cold-bootstrap LLM calls"
 *      structural: a controller *cannot* reach a provider. The resilience assay
 *      enforces the same rule, so a controller doubles as an assay contribution.
 *   3. **State is DATA, and bounded.** A controller is handed JSON copies of
 *      its state and config, so it can never retain a live reference into the
 *      ledger, and the state it returns must round-trip through JSON under a
 *      byte cap (it must survive a restart).
 *   4. **Side effects are a closed vocabulary, and they are PROPOSALS.** A
 *      step returns effects, it does not perform them. `note` never leaves the
 *      ledger; `say` and `augment` reach the world only for an install whose
 *      `deliverEffects` was explicitly turned on, and `augment` reuses the
 *      already-bounded world verb schema.
 *
 * Pure: no I/O, no clock of its own (callers pass `now`), no provider calls.
 * The persisted installs and the supervised tick loop live in
 * `services/eidoverseControllerRuntime.js`.
 */

import { z } from 'zod';
import { eidoverseWorldAugmentSchema } from './eidoverseValidation.js';
import { foundationDerivationEdgeSchema } from './eidoverseFoundations.js';

export const EIDOVERSE_CONTROLLER_LIMITS = Object.freeze({
  idMax: 64,
  // Ceiling on armed controllers; the supervisor runs every due install in one
  // pass, so this keeps a pass bounded.
  installs: 24,
  configBytes: 4_096,
  stateBytes: 16_384,
  effectsPerTick: 8,
  effectTextMax: 280,
  augmentOperationsPerEffect: 8,
  recentEffects: 20,
  noteMax: 240,
  reasonMax: 400,
  // The floor MATCHES the supervisor's wake interval (`SUPERVISOR_INTERVAL_MS` in
  // `services/eidoverseControllerRuntime.js`); a day is the longest cadence that
  // still reads as "running".
  minTickIntervalMs: 60_000,
  maxTickIntervalMs: 86_400_000,
  defaultTickIntervalMs: 300_000,
  // Disarm after this many consecutive failed ticks rather than retry forever.
  maxConsecutiveFailures: 3,
});

/** What a controller may ask the world to do. Deliberately closed. */
export const EIDOVERSE_CONTROLLER_EFFECT_KINDS = Object.freeze(['note', 'say', 'augment']);

const effectTextSchema = z.string().trim().min(1).max(EIDOVERSE_CONTROLLER_LIMITS.effectTextMax);

/**
 * One proposed effect from a tick.
 *
 * `note` never crosses into the world. `say` and `augment` are world verbs;
 * `augment` reuses `eidoverseWorldAugmentSchema`'s operation array (verb enum and
 * per-argument cap) with a tighter length bound, so there is one definition of a
 * legal construction operation.
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
 * Where in the world this controller sits. PortOS does not resolve these ids
 * here: they are carried to the definition as config, and an id naming nothing
 * means a controller with nothing local to act on.
 */
const controllerPlacementSchema = z.object({
  districtId: z.string().trim().min(1).max(64).nullable().default(null),
  anchorEntityId: z.string().trim().min(1).max(64).nullable().default(null),
}).strict();

/**
 * What a caller (route, mind tool, test) may install.
 *
 * `deliverEffects` defaults to FALSE on purpose: installing arms bookkeeping;
 * letting a controller speak and build in the world is a second, explicit
 * decision.
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
 * A config-only update: the accumulated `state` survives untouched, unlike
 * re-installing the same id, which rebuilds state from the new config.
 */
export const eidoverseControllerConfigUpdateSchema = z.object({
  id: controllerInstallIdSchema,
  config: boundedJsonObject(EIDOVERSE_CONTROLLER_LIMITS.configBytes),
}).strict();

export const eidoverseControllerArmSchema = z.object({ id: controllerInstallIdSchema, armed: z.boolean() }).strict();

// Explicit shipped gameplay, never an interpreter for foundation bodies.
// Provider tool parameters need an object root. Refinements keep the HTTP/tool
// runtime action-specific without exporting a top-level oneOf to providers.
export const eidoverseRiddleActionSchema = z.object({
  id: controllerInstallIdSchema,
  expectedRevision: z.number().int().nonnegative(),
  action: z.enum(['offer', 'guess', 'reveal']),
  clue: z.string().trim().min(1).max(200).optional(),
  answer: z.string().trim().min(1).max(120).optional(),
  guess: z.string().trim().min(1).max(120).optional(),
}).strict().superRefine((input, ctx) => {
  const fields = input.action === 'offer' ? ['clue', 'answer'] : input.action === 'guess' ? ['guess'] : [];
  for (const field of ['clue', 'answer', 'guess']) {
    if (fields.includes(field) && input[field] === undefined) ctx.addIssue({ code: 'custom', path: [field], message: `Required for ${input.action}` });
    if (!fields.includes(field) && input[field] !== undefined) ctx.addIssue({ code: 'custom', path: [field], message: `Not accepted for ${input.action}` });
  }
});

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

/** A completed outbound attempt, retained independently of quiet/failed ticks.
 * `at` is the originating tick's time; no legacy proposal implies a verdict. */
const controllerCompletedDeliverySchema = z.object({
  at: isoDateSchema,
  tick: z.number().int().min(0),
  ok: z.boolean(),
  delivered: z.number().int().min(0),
  reason: z.string().trim().min(1).max(EIDOVERSE_CONTROLLER_LIMITS.reasonMax).nullable().default(null),
}).strict();

/** The persisted install record. Machine-local; nothing here federates. */
export const eidoverseControllerRecordSchema = eidoverseControllerInstallSchema.extend({
  installedBy: installedBySchema,
  installedAt: isoDateSchema,
  updatedAt: isoDateSchema,
  // The controller's durable state, advanced one step per tick; the whole of
  // what survives a restart.
  state: z.record(z.string().min(1).max(64), z.unknown()),
  tick: z.number().int().min(0),
  nextTickAt: isoDateSchema,
  lastTickAt: isoDateSchema.nullable().default(null),
  lastOutcome: controllerTickOutcomeSchema.nullable().default(null),
  lastCompletedDelivery: controllerCompletedDeliverySchema.nullable().default(null),
  recentEffects: z.array(z.object({
    at: isoDateSchema,
    tick: z.number().int().min(0),
    kind: z.enum(EIDOVERSE_CONTROLLER_EFFECT_KINDS),
    summary: z.string().trim().min(1).max(EIDOVERSE_CONTROLLER_LIMITS.effectTextMax),
  }).strict()).max(EIDOVERSE_CONTROLLER_LIMITS.recentEffects).default([]),
  consecutiveFailures: z.number().int().min(0).default(0),
  // Ticks whose STEP succeeded but whose delivery was refused; separate from
  // `consecutiveFailures` (a throwing/refusing `step()`) so a controller whose
  // every write is rejected can disarm instead of reporting "ok" forever.
  consecutiveDeliveryFailures: z.number().int().min(0).default(0),
  // Set when the supervisor disarms a controller itself (repeated failures, a
  // controller id that no longer resolves). Distinct from `armed: false`
  // chosen by a human, which carries no reason.
  disarmedReason: z.string().trim().min(1).max(EIDOVERSE_CONTROLLER_LIMITS.reasonMax).nullable().default(null),
  // `null` unless this install ADOPTED a peer's foundation, in which case it
  // names the origin install, foundation id and envelope fingerprint. Same edge
  // shape a derived foundation carries. Additive and nullable on a machine-local
  // store, so no migration: older records read back as `null`.
  derivedFrom: foundationDerivationEdgeSchema.nullable().default(null),
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
 * `eidoverseResilienceAssay.js`'s `runInvariants` uses, so the live tick path is
 * held to the same contract as the promote gate.
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
 * Used on the way IN as well as out, so a controller never retains a live
 * reference into the persisted record.
 */
function jsonCopy(value) {
  // `JSON.stringify` throws on a BigInt or cycle and returns `undefined` for a
  // function or symbol; all mean "did not survive the trip" and none may escape
  // as an exception on the background tick.
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
 * try/catch is deliberate: this runs in a supervised background loop, not an
 * Express request, and turning a controller's exception into a recorded reason
 * is the job; an uncaught throw would reach a timer callback and crash Node.
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

  // A step returning nothing asserts "no state change" (ordinary for an every-Nth-tick controller).
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
  // An unparseable `nextTickAt` reads as due: stuck forever is worse than one extra step.
  return Number.isNaN(due) || due <= nowMs;
}

/**
 * When this install should step next.
 *
 * Measured from NOW, not the missed tick: a machine asleep for days must wake to
 * ONE tick, not a replayed backlog.
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
 * A LIST omits the durable state (up to 16KB that would ride into every prompt
 * turn) and an INSPECT of one install includes it, as `summarizeFoundation` does.
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
    // Delivery is a SEPARATE verdict from the step. `null` covers both "delivery
    // is off" and "nothing to deliver"; neither is a failure.
    lastDelivery: summarizeLastDelivery(record),
    lastCompletedDelivery: record?.lastCompletedDelivery ?? null,
    consecutiveDeliveryFailures: record?.consecutiveDeliveryFailures ?? 0,
    disarmedReason: record?.disarmedReason ?? null,
    note: record?.note ?? null,
    // In the SUMMARY, not behind `includeState`: attribution is needed in the list.
    derivedFrom: record?.derivedFrom ?? null,
    recentEffects: (record?.recentEffects ?? []).slice(0, 5),
    ...(includeState ? { config: record?.config ?? {}, state: record?.state ?? {} } : {}),
  };
}

/**
 * The last tick's delivery verdict, distinct from `lastTickOk` (the STEP).
 * `deliverControllerEffects()` in `services/eidoverseControllerRuntime.js` folds
 * the world's ack/refusal onto `lastOutcome.delivered` / `deliveryError`; this
 * reshapes that into an `{ ok, reason }` verdict.
 */
function summarizeLastDelivery(record) {
  if (record?.deliverEffects !== true) return { ok: null, delivered: 0, reason: null };
  const outcome = record?.lastOutcome;
  // Delivery never attempted: no verdict yet.
  if (!outcome || outcome.effects === 0) return { ok: null, delivered: outcome?.delivered ?? 0, reason: null };
  return { ok: outcome.deliveryError === null, delivered: outcome.delivered, reason: outcome.deliveryError };
}
