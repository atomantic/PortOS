/**
 * The supervised runtime for executable Eidoverse world controllers (#7456,
 * epic #7453) — the install store, the tick pass, and the arming reconcile.
 *
 * `lib/eidoverseControllers.js` owns the schema and the sandboxed step
 * boundary; `eidoverseControllerRegistry.js` owns the fixed id-to-code map.
 * This module is the persistence, the clock, and the supervision around them,
 * so that a controller a mind installed keeps running between that mind's
 * wakes and across a server restart — SwarmWorld's "executable inheritance",
 * which is the whole point of the issue.
 *
 * **The tick path cannot reach an AI provider.** A controller step is
 * synchronous (`runControllerStep` refuses a Promise), so there is no await
 * for a provider call to hide behind, and the only thing a tick may do
 * outwards is deliver effects from a closed vocabulary through the existing
 * Eidoverse world verbs, which make no provider call either. That is root
 * AGENTS.md's "no cold-bootstrap LLM calls" rule enforced structurally rather
 * than trusted — boot arms timers here and nothing else.
 *
 * **Arming is reconciled at every gate move, not only at boot.** Installing,
 * retiring, or disarming a controller all end in
 * `reconcileEidoverseControllerTicks()`, which registers the supervisor
 * schedule when at least one install is armed and cancels it when none is.
 * `services/beeperArming.js` is the worked example of the same contract; the
 * failure it exists to prevent is background work whose gate moved while the
 * work kept running (or never started) until the next restart.
 *
 * **A pass never replays a backlog.** Every due install steps exactly once per
 * pass and its next tick is measured from now — see `nextControllerTickAt`. A
 * laptop asleep for three days wakes to one tick, not to eight hundred
 * ambient verbs it owes the world.
 *
 * Storage is `data/eidoverse/controllers.json` — `file-primary` and MACHINE
 * LOCAL, the same class as `foundations.json` and `portos-world.json` beside
 * it (`docs/STORAGE.md`). None of it federates: a controller install names
 * this install's world entities and carries its author's intent, and the
 * machine-local privacy ADR keeps records off the federation layer. There is
 * no `data.reference/` seed — an absent file IS the empty set every install
 * starts from, so no migration is owed.
 */

import { join } from 'node:path';
import { PATHS, atomicWrite, readJSONFile } from '../lib/fileUtils.js';
import { createMutex } from '../lib/asyncMutex.js';
import {
  EIDOVERSE_CONTROLLER_LIMITS,
  controllerTickDue,
  eidoverseControllerInstallSchema,
  nextControllerTickAt,
  runControllerStep,
  summarizeControllerEffect,
  summarizeControllerInstall,
} from '../lib/eidoverseControllers.js';
import { findControllerDefinitionById } from './eidoverseControllerRegistry.js';
import { cancel, getEvent, schedule } from './eventScheduler.js';

/** Storage-layout version stamped on `data/eidoverse/controllers.json`. */
const STORE_SCHEMA_VERSION = 1;

const SCHEDULER_EVENT_ID = 'eidoverse-controller-tick';

/**
 * How often the supervisor wakes. This is NOT a controller's cadence — each
 * install carries its own `tickIntervalMs` and steps only when due — it is the
 * resolution at which "due" is noticed.
 *
 * Derived from the cadence floor rather than written beside it, because the two
 * numbers are one decision: a `tickIntervalMs` below the supervisor's wake
 * interval is a cadence the schema would accept and the supervisor could never
 * honor, and two independent constants would drift into exactly that.
 */
const SUPERVISOR_INTERVAL_MS = EIDOVERSE_CONTROLLER_LIMITS.minTickIntervalMs;

const LOG_PREFIX = '🌀 Eidoverse controllers';

// Read through `PATHS` per call, NOT `dataPath()`: a suite redirects the data
// root by proxying this module's `fileUtils` import, and `dataPath()` resolves
// against `paths.js`'s own `PATHS` binding, which that proxy never sees — so
// the helper would send every test at the live install's controllers.
const storeFile = () => join(PATHS.data, 'eidoverse', 'controllers.json');

const withStoreLock = createMutex();

/**
 * Serializes whole tick passes. A pass reads every install, steps the due
 * ones, and writes them back; two overlapping passes (the scheduler firing
 * while a reconcile-triggered pass is still running) would each write a record
 * the other had already advanced. This is the single-writer re-entrancy guard
 * root AGENTS.md sanctions, not a defence against competing humans.
 */
let passTail = Promise.resolve();

/**
 * Strict read: a `controllers.json` this process cannot parse must NOT read as
 * "nothing installed", because the very next write would then replace the
 * user's armed controllers with an empty set. `strict: true` throws on
 * unreadable bytes, while a genuinely ABSENT file still reads as the empty set
 * it is.
 *
 * Returns the file's OWN stamped `schemaVersion` alongside the installs, not
 * the build's constant — a store written by a newer install must keep
 * reporting what it actually is (#7629). An absent file, or one predating the
 * stamp, reads as this build's version: there is nothing to disagree with yet.
 */
async function readInstalls() {
  const raw = await readJSONFile(storeFile(), null, { allowArray: false, strict: true });
  const installs = raw && typeof raw === 'object' && raw.installs && typeof raw.installs === 'object' ? { ...raw.installs } : {};
  const schemaVersion = raw && typeof raw === 'object' && Number.isInteger(raw.schemaVersion) ? raw.schemaVersion : STORE_SCHEMA_VERSION;
  return { schemaVersion, installs };
}

/**
 * Writes never DOWNGRADE the file's stamp (#7629). A store a newer build wrote
 * carries a higher `schemaVersion`, and this build still has to persist to it —
 * a disarm, a delivery outcome. Re-stamping it with this build's own older
 * constant would erase the very signal `stepInstall` refuses to step on, so the
 * newer-store guard would fire exactly once and then never again, and the
 * newer build would read its own file back as one this version wrote. Callers
 * pass the stamp they read under the same lock.
 */
async function writeInstalls(installs, storeSchemaVersion = STORE_SCHEMA_VERSION) {
  const schemaVersion = Math.max(STORE_SCHEMA_VERSION, storeSchemaVersion);
  await atomicWrite(storeFile(), { schemaVersion, installs });
}

/** Every controller this install has, most recently installed first. */
export async function listEidoverseControllers() {
  const { schemaVersion, installs: stored } = await readInstalls();
  const installs = Object.values(stored)
    .sort((a, b) => String(b.installedAt || '').localeCompare(String(a.installedAt || '')));
  const counts = installs.reduce((totals, entry) => ({
    total: totals.total + 1,
    armed: totals.armed + (entry.armed === true ? 1 : 0),
    delivering: totals.delivering + (entry.armed === true && entry.deliverEffects === true ? 1 : 0),
  }), { total: 0, armed: 0, delivering: 0 });
  return { schemaVersion, counts, installs };
}

export async function getEidoverseControllerInstall(id) {
  const { installs } = await readInstalls();
  return installs[id] || null;
}

const refused = (reasons) => ({ outcome: 'refused', install: null, reasons });

/**
 * Install (or re-install) a controller.
 *
 * A refusal is a RESULT, not an exception: "that controller id is not one this
 * version ships" and "that config is not one this controller accepts" are
 * ordinary, expected output the caller shows the author with its reasons —
 * the same proposal-versus-consequence shape the construction tools and the
 * promote gate already have.
 *
 * Re-installing an existing id keeps its `installedAt` and its accumulated
 * `tick` ordinal but REBUILDS state from the new config. State is shaped by
 * the config that produced it; carrying it across an edit would leave a
 * controller reasoning over counters that describe a configuration nobody has.
 * The first tick is one full interval away, never immediate: installing arms a
 * schedule, it does not fire a world verb.
 *
 * `resolveDefinition` is injectable so a test can install a controller of its
 * own shaping without a registry back door. It is a function argument inside
 * the server process, never anything a request body can reach — the id-only
 * rule the registry enforces is not weakened by it.
 */
export async function installEidoverseController(input, {
  installedBy = 'user',
  now = new Date().toISOString(),
  resolveDefinition = findControllerDefinitionById,
} = {}) {
  const parsed = eidoverseControllerInstallSchema.safeParse(input);
  if (!parsed.success) return refused(parsed.error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`));
  const authored = parsed.data;

  const definition = await resolveDefinition(authored.controllerId);
  if (!definition) return refused([`no controller is registered under "${authored.controllerId}" — a controller is named by id, never by a module path, so only the ids this install ships can be installed`]);

  const config = definition.configSchema.safeParse(authored.config);
  if (!config.success) return refused(config.error.issues.map((issue) => `config.${issue.path.join('.') || '<root>'}: ${issue.message}`));

  // `armed` DEFAULTS to true in the schema, so an absent flag is indistinguishable
  // from `armed: true` by the time zod is done with it. On a re-install that
  // difference decides whether a controller somebody deliberately quieted comes
  // back on by itself, so the raw input is what answers it — the "absent vs
  // intentionally empty" rule in AGENTS.md, applied to a boolean.
  const armedRequested = typeof input?.armed === 'boolean' ? input.armed : null;

  const nowMs = Date.parse(now);
  return withStoreLock(async () => {
    const { schemaVersion: storeSchemaVersion, installs } = await readInstalls();
    const existing = installs[authored.id] || null;
    if (!existing && Object.keys(installs).length >= EIDOVERSE_CONTROLLER_LIMITS.installs) {
      return refused([`this install already holds ${EIDOVERSE_CONTROLLER_LIMITS.installs} controllers — retire one before installing another`]);
    }

    const armed = armedRequested ?? (existing ? existing.armed : authored.armed);
    const record = {
      ...authored,
      armed,
      config: config.data,
      installedBy: existing?.installedBy || installedBy,
      installedAt: existing?.installedAt || now,
      updatedAt: now,
      state: definition.createState(config.data),
      tick: existing?.tick ?? 0,
      nextTickAt: nextControllerTickAt(authored, nowMs),
      lastTickAt: existing?.lastTickAt ?? null,
      lastOutcome: null,
      recentEffects: [],
      consecutiveFailures: 0,
      consecutiveDeliveryFailures: 0,
      // A re-install that leaves a controller disarmed keeps the reason it was
      // disarmed for, so the author is not left looking at a stopped controller
      // with no explanation. Re-arming answers the reason, so it clears it.
      disarmedReason: armed ? null : (existing?.disarmedReason ?? null),
    };
    installs[authored.id] = record;
    await writeInstalls(installs, storeSchemaVersion);
    console.log(`${LOG_PREFIX}: installed "${record.id}" (${record.controllerId}, every ${Math.round(record.tickIntervalMs / 1000)}s, ${record.armed ? 'armed' : 'disarmed'})`);
    return { outcome: 'installed', install: record, reasons: [] };
  }).then(afterGateMove('install'));
}

/**
 * Retire a controller — remove it and stop it stepping.
 *
 * Retiring DELETES the install rather than parking it. A controller that is
 * "installed but off forever" is a record nobody reads and a counter that
 * silently drifts from the world it describes; an author who wants it back
 * installs it again, which is one tool call.
 */
export async function retireEidoverseController(id) {
  return withStoreLock(async () => {
    const { schemaVersion: storeSchemaVersion, installs } = await readInstalls();
    const existing = installs[id];
    if (!existing) return { outcome: 'unknown-install', install: null, reasons: [`no controller is installed under "${id}"`] };
    delete installs[id];
    await writeInstalls(installs, storeSchemaVersion);
    console.log(`${LOG_PREFIX}: retired "${id}" (${existing.controllerId}) after ${existing.tick} tick${existing.tick === 1 ? '' : 's'}`);
    return { outcome: 'retired', install: existing, reasons: [] };
  }).then(afterGateMove('retire'));
}

/**
 * Arm or disarm an installed controller without losing its state.
 *
 * The state survives the pause on purpose: a controller the author quiets for
 * an afternoon should resume its count, not restart it. Explicitly clears any
 * `disarmedReason` the supervisor set, since a human re-arming has answered it.
 */
export async function setEidoverseControllerArmed(id, armed, { now = new Date().toISOString() } = {}) {
  const nowMs = Date.parse(now);
  return withStoreLock(async () => {
    const { schemaVersion: storeSchemaVersion, installs } = await readInstalls();
    const existing = installs[id];
    if (!existing) return { outcome: 'unknown-install', install: null, reasons: [`no controller is installed under "${id}"`] };
    const record = {
      ...existing,
      armed: armed === true,
      updatedAt: now,
      // Re-arming restarts the cadence from now rather than firing immediately
      // on the next pass against a `nextTickAt` that went stale while paused.
      ...(armed === true ? {
        nextTickAt: nextControllerTickAt(existing, nowMs),
        consecutiveFailures: 0,
        consecutiveDeliveryFailures: 0,
        disarmedReason: null,
      } : {}),
    };
    installs[id] = record;
    await writeInstalls(installs, storeSchemaVersion);
    return { outcome: 'updated', install: record, reasons: [] };
  }).then(afterGateMove('arm-toggle'));
}

/**
 * Change an installed controller's `config` while its accumulated `state`
 * survives untouched (#7629) — the "inherit and modify" verb the epic names.
 * A re-install of the same id is the alternative, but it REBUILDS state from
 * scratch (`installEidoverseController` above); a later mind that only wants
 * to tune a value should not have to destroy what the controller has already
 * accumulated to do it.
 *
 * Re-parsed through the definition's own `configSchema`, the same refusal
 * shape every other install-touching call uses: a config the schema rejects
 * changes nothing and reports why, rather than throwing.
 */
export async function updateEidoverseControllerConfig(id, config, {
  now = new Date().toISOString(),
  resolveDefinition = findControllerDefinitionById,
} = {}) {
  return withStoreLock(async () => {
    const { schemaVersion: storeSchemaVersion, installs } = await readInstalls();
    const existing = installs[id];
    if (!existing) return { outcome: 'unknown-install', install: null, reasons: [`no controller is installed under "${id}"`] };

    const definition = await resolveDefinition(existing.controllerId);
    if (!definition) return refused([`no controller is registered under "${existing.controllerId}" any more — this install was authored by a version that shipped it`]);

    const parsed = definition.configSchema.safeParse(config);
    if (!parsed.success) return refused(parsed.error.issues.map((issue) => `config.${issue.path.join('.') || '<root>'}: ${issue.message}`));

    const record = { ...existing, config: parsed.data, updatedAt: now };
    installs[id] = record;
    await writeInstalls(installs, storeSchemaVersion);
    console.log(`${LOG_PREFIX}: updated config for "${id}" (${existing.controllerId}), state preserved`);
    return { outcome: 'updated', install: record, reasons: [] };
  });
}

/**
 * Every path that moves the arming gate ends here, so no caller has to
 * remember to reconcile — the failure mode root AGENTS.md names is a toggle
 * that arms background work and only reconciles it at the next boot.
 */
const afterGateMove = (reason) => async (result) => {
  await reconcileEidoverseControllerTicks({ reason });
  return result;
};

// ---------------------------------------------------------------------------
// The tick pass
// ---------------------------------------------------------------------------

/**
 * Deliver one controller's effects into the world.
 *
 * Lazily imported: `eidoverseWorld.js` carries the world socket, the
 * projection planner and the design resolver, and only an install that
 * explicitly turned `deliverEffects` on ever reaches them — a static import
 * would put that whole subtree in the closure of everything that merely lists
 * controllers. Neither verb calls an AI provider.
 *
 * `augmentEidoverseWorld()` never throws on a world refusal (#7454) — the
 * verdict is its RETURN VALUE (`success`, `applied`, per-operation
 * `outcome`), so it must be read, not assumed delivered because the await
 * resolved. #7628 was exactly this: the return value was discarded, so a
 * controller whose every write the world refused counted as delivered every
 * tick, forever. `delivered` here is the world's own committed count
 * (`applied`), never the loop's attempt count, and a `rewritten` operation
 * counts as delivered — the world landed different args, not nothing — only
 * `refused` does not.
 *
 * @returns {Promise<{ delivered: number, error: string|null }>}
 */
async function deliverControllerEffects(effects, { signal } = {}) {
  const outbound = effects.filter((effect) => effect.kind !== 'note');
  if (outbound.length === 0) return { delivered: 0, error: null };
  const world = await import('./eidoverseWorld.js');
  let delivered = 0;
  let error = null;
  for (const effect of outbound) {
    if (effect.kind === 'say') {
      // `sayInEidoverseWorld` has no rewrite/refusal dimension of its own —
      // it either resolves (the world acked it) or throws, which the caller
      // in `deliverPassEffects` already treats as a delivery failure.
      await world.sayInEidoverseWorld(effect.text, { signal });
      delivered += 1;
      continue;
    }
    const result = await world.augmentEidoverseWorld(effect.operations, { signal });
    delivered += result.applied;
    if (result.success === false && error === null) {
      const refusal = result.operations.find((operation) => operation.outcome === 'refused');
      error = refusal?.reason ?? 'Eidoverse refused part of this augment batch.';
    }
  }
  return { delivered, error };
}

function recordedEffects(existing, effects, { at, tick }) {
  const added = effects.map((effect) => ({ at, tick, kind: effect.kind, summary: summarizeControllerEffect(effect) }));
  return [...added, ...existing].slice(0, EIDOVERSE_CONTROLLER_LIMITS.recentEffects);
}

/**
 * An immediate disarm that does NOT consume a tick — the shape a controller
 * id that no longer resolves, a store from a build this one cannot read, or a
 * config that no longer parses all share: none of these is a transient
 * failure retrying could recover from, so none should count as an attempt or
 * wait out `maxConsecutiveFailures` before saying so.
 */
function disarmedWithoutStepping(record, { reason, nextTickAt, at }) {
  console.error(`❌ ${LOG_PREFIX}: disarming "${record.id}" — ${reason}`);
  return {
    record: {
      ...record, armed: false, disarmedReason: reason, nextTickAt, lastTickAt: at,
      lastOutcome: { at, tick: record.tick, ok: false, reason, effects: 0, delivered: 0, deliveryError: null },
    },
    effects: [],
  };
}

/**
 * Advance one install by one tick and return the record to persist.
 *
 * A failure disarms after `maxConsecutiveFailures` in a row rather than
 * retrying forever: a controller failing every minute writes a log nobody
 * reads, and one that stopped and says why is a thing the author can fix. A
 * controller id that no longer resolves disarms immediately — retrying a
 * missing definition cannot start succeeding.
 *
 * Two more disarm-immediately cases (#7629), both because retrying cannot
 * help: `storeSchemaVersion` ahead of this build's own `STORE_SCHEMA_VERSION`
 * means a newer install (or a not-yet-upgraded restore) wrote this file, so
 * stepping it here would run this build's older rules against a shape it does
 * not fully understand; and `record.config` re-parsed against the
 * definition's OWN `configSchema` catches a config that stopped validating
 * since install (a shipped schema tightened, a hand-edited file) before it
 * ever reaches `step()`. A parse that succeeds but changes the value — a
 * newly-added default landing for the first time — is persisted back onto the
 * record here, so the default applies exactly once rather than being
 * re-derived on every tick.
 */
async function stepInstall(record, { nowMs, at, resolveDefinition, storeSchemaVersion }) {
  const nextTickAt = nextControllerTickAt(record, nowMs);

  if (storeSchemaVersion > STORE_SCHEMA_VERSION) {
    const reason = `controllers.json is stamped schemaVersion ${storeSchemaVersion}, newer than this build's ${STORE_SCHEMA_VERSION} — refusing to step until this build is upgraded`;
    return disarmedWithoutStepping(record, { reason, nextTickAt, at });
  }

  const definition = await resolveDefinition(record.controllerId);
  if (!definition) {
    const reason = `no controller is registered under "${record.controllerId}" any more — this install was authored by a version that shipped it`;
    return disarmedWithoutStepping(record, { reason, nextTickAt, at });
  }

  const reparsedConfig = definition.configSchema.safeParse(record.config);
  if (!reparsedConfig.success) {
    const reason = `stored config no longer parses against "${record.controllerId}"'s schema: ${reparsedConfig.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ')}`.slice(0, EIDOVERSE_CONTROLLER_LIMITS.reasonMax);
    return disarmedWithoutStepping(record, { reason, nextTickAt, at });
  }
  const config = reparsedConfig.data;

  const tick = record.tick + 1;
  const outcome = runControllerStep({ definition, state: record.state, config, tick });
  if (!outcome.ok) {
    const consecutiveFailures = record.consecutiveFailures + 1;
    const exhausted = consecutiveFailures >= EIDOVERSE_CONTROLLER_LIMITS.maxConsecutiveFailures;
    console.error(`❌ ${LOG_PREFIX}: "${record.id}" tick ${tick} failed (${consecutiveFailures}/${EIDOVERSE_CONTROLLER_LIMITS.maxConsecutiveFailures}): ${outcome.reason}`);
    return {
      record: {
        ...record,
        config,
        // The tick ordinal advances on a failure too: it counts attempts the
        // supervisor made, so a controller cannot look younger than it is by
        // failing, and a step that reads `tick` sees time moving either way.
        tick,
        consecutiveFailures,
        ...(exhausted ? { armed: false, disarmedReason: `disarmed after ${consecutiveFailures} consecutive failed ticks: ${outcome.reason}` } : {}),
        nextTickAt,
        lastTickAt: at,
        lastOutcome: { at, tick, ok: false, reason: outcome.reason, effects: 0, delivered: 0, deliveryError: null },
      },
      effects: [],
    };
  }

  return {
    record: {
      ...record,
      config,
      state: outcome.state,
      tick,
      consecutiveFailures: 0,
      nextTickAt,
      lastTickAt: at,
      // Delivery has not run yet — it happens after the store lock is released.
      // A reader between the two phases sees an honest "nothing delivered yet"
      // rather than a number the pass has not earned.
      lastOutcome: { at, tick, ok: true, reason: null, effects: outcome.effects.length, delivered: 0, deliveryError: null },
      recentEffects: recordedEffects(record.recentEffects, outcome.effects, { at, tick }),
    },
    effects: record.deliverEffects ? outcome.effects : [],
  };
}

/**
 * Deliver one pass's effects, OUTSIDE the store lock.
 *
 * Stepping is synchronous and fast; reaching the world is neither. Holding the
 * store lock across a world call would block a mind's install or retire for as
 * long as an unreachable world takes to give up — so the pass steps and writes
 * first, then delivers, then records what happened in a second short write.
 *
 * try/catch per install at a boundary OUTSIDE the Express request lifecycle,
 * per the explicit exception in AGENTS.md "Code Conventions": the world may be
 * unreachable, and a rejection here would surface from a timer callback. A
 * failed delivery is recorded and the STEP still counts — the controller's own
 * state already advanced, and re-running it to retry a world write would
 * double-count everything it did.
 */
async function deliverPassEffects(stepped, { deliver, signal }) {
  const deliveries = [];
  for (const { record, effects } of stepped) {
    if (effects.length === 0) continue;
    try {
      const { delivered, error } = await deliver(effects, { signal });
      deliveries.push({ id: record.id, tick: record.tick, delivered, error });
    } catch (error) {
      const message = String(error.message).slice(0, EIDOVERSE_CONTROLLER_LIMITS.reasonMax);
      console.error(`❌ ${LOG_PREFIX}: "${record.id}" tick ${record.tick} stepped but could not reach the world: ${message}`);
      deliveries.push({ id: record.id, tick: record.tick, delivered: 0, error: message });
    }
  }
  return deliveries;
}

/**
 * Fold delivery outcomes back onto the records they belong to.
 *
 * Each patch is applied only while the record's `lastOutcome.tick` still
 * matches the tick that produced those effects: an install or retire landing
 * between the two phases has replaced what the delivery was about, and
 * stamping a delivery count onto it would describe work that record never did.
 *
 * A run of REFUSED deliveries disarms the same way a run of throwing/refusing
 * `step()`s already does (#7628): `consecutiveFailures` only counts the step,
 * so a controller that steps cleanly every tick while the world refuses
 * everything it proposes would otherwise never disarm and never report
 * anything but "ok". `consecutiveDeliveryFailures` is that same clause, keyed
 * on the delivery verdict instead.
 *
 * @returns {Promise<{ gateMoved: boolean }>}
 */
async function recordDeliveries(deliveries) {
  if (deliveries.length === 0) return { gateMoved: false };
  return withStoreLock(async () => {
    const { schemaVersion: storeSchemaVersion, installs } = await readInstalls();
    let changed = false;
    let gateMoved = false;
    for (const { id, tick, delivered, error } of deliveries) {
      const current = installs[id];
      if (!current || current.lastOutcome?.tick !== tick) continue;
      const consecutiveDeliveryFailures = error ? (current.consecutiveDeliveryFailures ?? 0) + 1 : 0;
      const exhausted = error && consecutiveDeliveryFailures >= EIDOVERSE_CONTROLLER_LIMITS.maxConsecutiveFailures;
      if (exhausted) {
        console.error(`❌ ${LOG_PREFIX}: disarming "${id}" — ${consecutiveDeliveryFailures} consecutive delivery failures: ${error}`);
      }
      installs[id] = {
        ...current,
        lastOutcome: { ...current.lastOutcome, delivered, deliveryError: error },
        consecutiveDeliveryFailures,
        ...(exhausted ? {
          armed: false,
          disarmedReason: `disarmed after ${consecutiveDeliveryFailures} consecutive delivery failures: ${error}`,
        } : {}),
      };
      changed = true;
      gateMoved = gateMoved || exhausted;
    }
    if (changed) await writeInstalls(installs, storeSchemaVersion);
    return { gateMoved };
  });
}

/**
 * Run one supervisor pass: step every armed install that is due.
 *
 * Three phases, and the split is the point. The step phase holds the store
 * lock — read, step every due install, write — because stepping is synchronous
 * and fast and nothing else may interleave a write with it. Delivery then runs
 * with the lock RELEASED, because reaching the world is neither fast nor
 * bounded by anything this module controls, and a mind's install call must not
 * queue behind an unreachable world. A short third phase folds the delivery
 * outcomes back on.
 *
 * Passes are serialized against each other on `passTail`, so the gap between
 * phases can only be filled by an install/retire/arm — which the third phase's
 * tick-match guard already refuses to stamp over.
 *
 * @returns {Promise<{ ticked: number, due: number, results: Array }>}
 */
export function tickEidoverseControllers(options = {}) {
  const run = () => tickOnce(options);
  const next = passTail.then(run, run);
  passTail = next.then(() => {}, () => {});
  return next;
}

async function tickOnce({
  now = new Date().toISOString(),
  resolveDefinition = findControllerDefinitionById,
  deliver = deliverControllerEffects,
  signal,
} = {}) {
  const nowMs = Date.parse(now);
  const pass = await withStoreLock(async () => {
    const { schemaVersion: storeSchemaVersion, installs } = await readInstalls();
    const due = Object.values(installs).filter((record) => controllerTickDue(record, nowMs));
    if (due.length === 0) return { ticked: 0, due: 0, results: [], stepped: [], gateMoved: false };

    const stepped = [];
    let gateMoved = false;
    for (const record of due) {
      const next = await stepInstall(record, { nowMs, at: now, resolveDefinition, storeSchemaVersion });
      installs[next.record.id] = next.record;
      gateMoved = gateMoved || next.record.armed !== record.armed;
      stepped.push(next);
    }
    await writeInstalls(installs, storeSchemaVersion);
    return {
      ticked: stepped.length,
      due: due.length,
      results: stepped.map(({ record }) => ({ id: record.id, tick: record.tick, ok: record.lastOutcome?.ok === true, reason: record.lastOutcome?.reason ?? null })),
      stepped,
      gateMoved,
    };
  });

  const { gateMoved: deliveryGateMoved } = await recordDeliveries(await deliverPassEffects(pass.stepped, { deliver, signal }));

  // A pass that disarmed a controller — whether stepping it failed or, per
  // #7628, delivering its effects into the world did — has moved the arming
  // gate, so it reconciles for the same reason install and retire do. The
  // reconcile is idempotent and re-reads the gate itself, so it correctly
  // does nothing when other installs are still armed and stands the
  // supervisor down when the disarmed one was the last.
  if (pass.gateMoved || deliveryGateMoved) await reconcileEidoverseControllerTicks({ reason: 'supervisor-disarm' });

  const { stepped: _stepped, gateMoved: _gateMoved, ...result } = pass;
  return result;
}

// ---------------------------------------------------------------------------
// Arming
// ---------------------------------------------------------------------------

let reconcileTail = Promise.resolve();

/**
 * Bring the supervisor schedule into line with whether anything is armed.
 *
 * IDEMPOTENT and safe to call repeatedly — a reconcile that finds the schedule
 * already registered leaves it alone rather than re-`schedule()`ing it, which
 * would reset `nextRunAt` a whole interval into the future every time an
 * author touched an unrelated install. Logging is transition-only, so an
 * install with no controllers reconciles silently, boot included.
 *
 * @returns {Promise<{armed: boolean, scheduled: boolean, changed: boolean}>}
 */
export function reconcileEidoverseControllerTicks({ reason = 'unspecified' } = {}) {
  const run = () => reconcileOnce(reason);
  const next = reconcileTail.then(run, run);
  reconcileTail = next.then(() => {}, () => {});
  return next;
}

async function reconcileOnce(reason) {
  const { installs } = await readInstalls();
  const armed = Object.values(installs).some((record) => record.armed === true);
  const registered = Boolean(getEvent(SCHEDULER_EVENT_ID));

  if (!armed) {
    const changed = registered ? Boolean(cancel(SCHEDULER_EVENT_ID)) : false;
    if (changed) console.log(`${LOG_PREFIX}: disarmed (${reason})`);
    return { armed: false, scheduled: false, changed };
  }
  if (registered) return { armed: true, scheduled: true, changed: false };

  schedule({
    id: SCHEDULER_EVENT_ID,
    type: 'interval',
    intervalMs: SUPERVISOR_INTERVAL_MS,
    handler: supervisorPass,
    metadata: { source: 'eidoverseControllerRuntime' },
  });
  console.log(`${LOG_PREFIX}: armed (${reason})`);
  return { armed: true, scheduled: true, changed: true };
}

/**
 * The scheduled handler. `eventScheduler.runEvent` already records and re-arms
 * around a rejection, but this runs outside the Express request lifecycle, so
 * it carries its own try/catch and emoji log per AGENTS.md rather than relying
 * on a caller two modules away to keep doing so.
 */
async function supervisorPass() {
  try {
    return await tickEidoverseControllers();
  } catch (error) {
    console.error(`❌ ${LOG_PREFIX}: tick pass failed: ${error.message}`);
    return { ticked: 0, due: 0, results: [] };
  }
}

/** Whether the supervisor schedule is currently registered. */
export function isEidoverseControllerSupervisorRegistered() {
  return Boolean(getEvent(SCHEDULER_EVENT_ID));
}

/**
 * Arm the supervisor at boot, so controllers survive a restart — the
 * "executable inheritance" half of the issue. Boot only ARMS a timer: nothing
 * steps until an install's own cadence elapses, and no provider is reachable
 * from the tick path at all.
 */
export async function startEidoverseControllerSupervisor() {
  return reconcileEidoverseControllerTicks({ reason: 'boot' });
}

/** Cancel the supervisor schedule and forget the serialization tails. */
export function __resetEidoverseControllerRuntimeForTests() {
  cancel(SCHEDULER_EVENT_ID);
  passTail = Promise.resolve();
  reconcileTail = Promise.resolve();
}

// Re-exported so a caller that already has the runtime does not need a second
// import to shape a record for a prompt or a UI.
export { summarizeControllerInstall };
