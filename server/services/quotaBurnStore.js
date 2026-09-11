/**
 * Quota-burn config + run-log storage (machine-local).
 *
 * Four files under `data/cos/`:
 *   - `quota-burn.json`          — the install's burn plan (see lib/quotaBurnConfig.js)
 *   - `quota-burn-runs.json`     — a capped log of what the runner did, for the page
 *   - `quota-burn-inflight.json` — per-entry render cooldown keys, `key -> epochMs`
 *   - `quota-burn-pending.json`  — reservations for burns whose request has gone
 *     out but has not been accepted yet (see `quotaBurnAcceptance.js`)
 *
 * None of them ships a `data.reference/` seed: an absent file means "nothing
 * recorded", which is exactly right on a fresh install, so there is no migration
 * to run and nothing for `setup-data.js` to overwrite.
 *
 * Deliberately NOT federated, for the same reason the dispatch ledger isn't:
 * quota belongs to a particular machine and provider account. Two peers sharing
 * a burn plan would each think they owned the other's window budget, and the
 * "which managed app" targets differ per machine anyway.
 *
 * Every read normalizes, so a config file written by an older PortOS (or by
 * hand) loads without a migration step — `normalizeQuotaBurnConfig` fills the
 * family set and drops what it can't interpret.
 */

import { join } from 'path';
import { atomicWrite, PATHS, readJSONFile, readJSONFileStrict } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { isPlainObject } from '../lib/objects.js';
import { normalizeQuotaBurnConfig } from '../lib/quotaBurnConfig.js';

const configFile = () => join(PATHS.cos, 'quota-burn.json');
const runLogFile = () => join(PATHS.cos, 'quota-burn-runs.json');

/** Keep the run log skimmable and bounded — it is a UI feed, not an audit trail. */
const RUN_LOG_LIMIT = 50;

// One tail per file. The config's read-modify-write races with itself when the
// page saves twice quickly; the run log's races between the scheduler tick and
// an on-demand "Run now". Same "serialize two write paths that mutate the same
// record" case the dispatch ledger documents — not a multi-user defense.
const configWriteQueue = createFileWriteQueue();
const runLogWriteQueue = createFileWriteQueue();

export async function getQuotaBurnConfig() {
  return normalizeQuotaBurnConfig(await readJSONFile(configFile(), null, { strict: true }));
}

/**
 * Merge `patch` over the stored config and persist the normalized result.
 * Shallow at the top level and per family, so the page can PUT a single family
 * (or just `{ enabled }`) without restating the whole plan. A family's `jobs`
 * array is REPLACED wholesale when present — it is an ordered list, and
 * element-wise merging would make reordering and deletion inexpressible.
 */
export async function saveQuotaBurnConfig(patch) {
  return configWriteQueue(async () => {
    const current = normalizeQuotaBurnConfig(await readJSONFile(configFile(), null, { strict: true }));
    // Written to match `client/src/lib/quotaBurnPatch.js#mergeQuotaBurnPatch`
    // line for line — the client applies the same merge optimistically while the
    // PUT is debounced, and the two only stay honest if the claim is checkable
    // at a glance. `normalizeQuotaBurnConfig` below drops any unknown family id.
    const families = { ...current.families };
    for (const [id, familyPatch] of Object.entries(isPlainObject(patch?.families) ? patch.families : {})) {
      families[id] = { ...(families[id] || {}), ...familyPatch };
    }
    const next = normalizeQuotaBurnConfig({ ...current, ...patch, families });
    await atomicWrite(configFile(), next);
    return next;
  });
}

const inFlightFile = () => join(PATHS.cos, 'quota-burn-inflight.json');
const inFlightWriteQueue = createFileWriteQueue();

/**
 * How long an enqueued render keeps its entry out of the next cycle's pick.
 *
 * A cloud image render commonly takes minutes and `imageRefs` only fills in
 * when it COMPLETES, so without a cooldown every tick re-selects the same
 * entries. Long enough to outlast a queued render, short enough that a render
 * which silently failed is retried the same day rather than being stranded.
 */
const IN_FLIGHT_TTL_MS = 6 * 60 * 60 * 1000;

/** Keys enqueued within the TTL, as a Set. Expired keys are simply not returned. */
export async function getQuotaBurnInFlight({ now = Date.now() } = {}) {
  const loaded = await readJSONFile(inFlightFile(), null, { strict: true });
  const entries = loaded && typeof loaded === 'object' && !Array.isArray(loaded) ? loaded : {};
  return new Set(Object.entries(entries)
    .filter(([, at]) => Number.isFinite(Number(at)) && now - Number(at) < IN_FLIGHT_TTL_MS)
    .map(([key]) => key));
}

/** Stamp keys as just-enqueued, dropping any that have aged out of the TTL. */
export async function recordQuotaBurnInFlight(keys, { now = Date.now() } = {}) {
  if (!keys?.length) return;
  return inFlightWriteQueue(async () => {
    const loaded = await readJSONFile(inFlightFile(), null, { strict: true });
    const entries = loaded && typeof loaded === 'object' && !Array.isArray(loaded) ? loaded : {};
    const next = Object.fromEntries(Object.entries(entries)
      .filter(([, at]) => Number.isFinite(Number(at)) && now - Number(at) < IN_FLIGHT_TTL_MS));
    for (const key of keys) next[key] = now;
    await atomicWrite(inFlightFile(), next);
    return next;
  });
}

const reservationFile = () => join(PATHS.cos, 'quota-burn-pending.json');
const reservationWriteQueue = createFileWriteQueue();

/**
 * How long a reservation survives without being settled.
 *
 * A reservation is released the moment the request it names is accepted or
 * refused, so the TTL only ever catches a burn whose request vanished while the
 * runner was not running (a crash between the request write and the next cycle,
 * or a schedule edited by hand). The same 6h the in-flight cooldown uses, and
 * for the same reason: long enough to outlast the slowest legitimate drain,
 * short enough that a stranded step is retried the same day.
 */
const RESERVATION_TTL_MS = IN_FLIGHT_TTL_MS;

/** `<familyId>::<stepId>` — one reservation per plan step at a time. */
export const quotaBurnReservationKey = (familyId, stepId) => `${familyId}::${stepId}`;

const liveReservations = (entries, now) => Object.fromEntries(Object.entries(entries)
  .filter(([, record]) => isPlainObject(record)
    && Number.isFinite(Number(record.at))
    && now - Number(record.at) < RESERVATION_TTL_MS));

/**
 * Reservations still awaiting acceptance, or `null` when the file could not be
 * read.
 *
 * The `null` is load-bearing, the same way it is on the three sibling ledgers
 * (#4115): a reservation is what stops a second cycle queuing the step a first
 * cycle already asked for AND what holds the step's share of the window cap
 * before the charge lands. Reading a failed read back as "nothing pending" would
 * both re-enqueue the work and re-open the cap, and the next write would then
 * persist that empty file over the reservations that survived. Absent (nothing
 * ever reserved) is still a trustworthy `{}`.
 */
export async function getQuotaBurnReservations({ now = Date.now() } = {}) {
  const { ok, value } = await readJSONFileStrict(reservationFile(), {}, { logError: false });
  if (!ok) return null;
  return isPlainObject(value) ? liveReservations(value, now) : {};
}

/**
 * Read-modify-write inside the queue, expiring aged reservations on the way
 * through. `mutate` returns the next map, or `null` for "nothing to change".
 * Never overwrites a file it could not read — the guard that is the whole point
 * of the strict read above.
 */
const writeReservations = (mutate, now) => reservationWriteQueue(async () => {
  const loaded = await getQuotaBurnReservations({ now });
  if (!loaded) return null;
  const next = mutate({ ...loaded });
  if (!next) return null;
  await atomicWrite(reservationFile(), next);
  return next;
});

/**
 * Hold a step's place while its request waits to be accepted. Returns null when
 * the file was unreadable (the caller must then treat the dispatch as
 * unreserved) or when the step is already reserved — a second reservation for
 * one step is exactly the double-enqueue this primitive exists to prevent.
 */
export async function reserveQuotaBurnStep(record, { now = Date.now() } = {}) {
  const key = quotaBurnReservationKey(record?.familyId, record?.stepId);
  return writeReservations((reservations) => (reservations[key]
    ? null
    : { ...reservations, [key]: { ...record, at: now, chargedAt: null } }), now);
}

/**
 * Stamp the instant a reservation's cap charge was CLAIMED, before the ledger
 * write it authorizes.
 *
 * Claiming first is what makes settlement exactly-once across a crash: the
 * ledger write and the release are two separate files, so a process that dies
 * between them would otherwise charge the same accepted unit twice on the next
 * reconcile. With the claim persisted first, a re-reconcile sees `chargedAt` and
 * releases without charging again. The residual is the reverse and smaller
 * failure — a crash in the gap between the claim and the ledger write loses one
 * charge, which costs the user nothing but one extra burn later.
 *
 * Pass `null` to RELEASE a claim whose ledger write then failed: that is a
 * reported failure rather than a crash, so the retry next cycle should charge
 * rather than inherit a claim nothing ever honored.
 */
export async function markQuotaBurnReservationCharged(key, chargedAt, { now = Date.now() } = {}) {
  return writeReservations((reservations) => (reservations[key]
    ? { ...reservations, [key]: { ...reservations[key], chargedAt: chargedAt ?? null } }
    : null), now);
}

/** Drop a reservation — its request was accepted, refused, or has aged out. */
export async function releaseQuotaBurnStep(key, { now = Date.now() } = {}) {
  return writeReservations((reservations) => {
    if (!reservations[key]) return null;
    delete reservations[key];
    return reservations;
  }, now);
}

export async function getQuotaBurnRuns() {
  const loaded = await readJSONFile(runLogFile(), null, { strict: true });
  return Array.isArray(loaded?.runs) ? loaded.runs : [];
}

/**
 * Append one run-log entry (newest first). Records SKIPS as well as dispatches:
 * "why did nothing burn last night" is the question the page exists to answer,
 * and a log that only shows successful dispatches cannot answer it.
 */
export async function recordQuotaBurnRun(entry) {
  return runLogWriteQueue(async () => {
    const loaded = await readJSONFile(runLogFile(), null, { strict: true });
    const runs = Array.isArray(loaded?.runs) ? loaded.runs : [];
    const next = [{ at: new Date().toISOString(), ...entry }, ...runs].slice(0, RUN_LOG_LIMIT);
    await atomicWrite(runLogFile(), { runs: next });
    return next;
  });
}

/**
 * Settle the run-log row a burn already wrote, in place.
 *
 * A reference burn is recorded when its request goes out and only ACCEPTED
 * later, so the row is written twice — once as `pending`, once with the task id
 * the request produced (or the reason it was refused). Patching the existing row
 * rather than appending a second one keeps one line per burn in a feed capped at
 * `RUN_LOG_LIMIT`, where a duplicate row per dispatch would halve the history
 * the page can show. A row that has already aged out is simply not found, which
 * is not an error — the burn still happened, the feed just moved on.
 */
export async function settleQuotaBurnRun(requestId, patch) {
  if (!requestId) return null;
  return runLogWriteQueue(async () => {
    const loaded = await readJSONFile(runLogFile(), null, { strict: true });
    const runs = Array.isArray(loaded?.runs) ? loaded.runs : [];
    const at = runs.findIndex((entry) => entry?.requestId === requestId);
    if (at < 0) return runs;
    const next = runs.map((entry, index) => (index === at ? { ...entry, ...patch } : entry));
    await atomicWrite(runLogFile(), { runs: next });
    return next;
  });
}
