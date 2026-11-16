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
 * Storage: `file-primary` (`quota-burn.json`; the others are `ephemeral-file`,
 * regenerable and safe to delete) — machine-local, never federated: quota belongs
 * to one machine and provider account, so peers sharing a plan would spend each
 * other's window budget, and step targets name this machine's task types and apps.
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
 * Merge `patch` over the stored config and persist the normalized result. Shallow at the
 * top level and per family; a family's `jobs` array is REPLACED wholesale (ordered list,
 * so element-wise merging could not express reorder or delete).
 */
export async function saveQuotaBurnConfig(patch) {
  return configWriteQueue(async () => {
    const current = normalizeQuotaBurnConfig(await readJSONFile(configFile(), null, { strict: true }));
    // Mirrors `client/src/lib/quotaBurnPatch.js#mergeQuotaBurnPatch` line for line (the client merges optimistically).
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
 * How long an enqueued render keeps its entry out of the next pick: renders take minutes
 * and `imageRefs` fills only on completion, but a silently failed one is retried the same day.
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
 * How long a reservation survives unsettled. It is released on accept or refuse, so the TTL
 * only catches a burn whose request vanished (crash, hand-edited schedule). Same 6h as the
 * in-flight cooldown.
 */
const RESERVATION_TTL_MS = IN_FLIGHT_TTL_MS;

/** `<familyId>::<stepId>` — one reservation per plan step at a time. */
export const quotaBurnReservationKey = (familyId, stepId) => `${familyId}::${stepId}`;

const liveReservations = (entries, now) => Object.fromEntries(Object.entries(entries)
  .filter(([, record]) => isPlainObject(record)
    && Number.isFinite(Number(record.at))
    && now - Number(record.at) < RESERVATION_TTL_MS));

/**
 * Reservations still awaiting acceptance, or `null` when the file could not be read
 * (#4115, like the sibling ledgers). A reservation stops a second cycle re-queuing the
 * step and holds its share of the window cap, so a failed read must not look like
 * "nothing pending". Absent is a trustworthy `{}`.
 */
export async function getQuotaBurnReservations({ now = Date.now() } = {}) {
  const { ok, value } = await readJSONFileStrict(reservationFile(), {}, { logError: false });
  if (!ok) return null;
  return isPlainObject(value) ? liveReservations(value, now) : {};
}

/** Read-modify-write inside the queue, expiring aged reservations; `mutate` returns the next map or `null` for no change. Never overwrites an unreadable file. */
const writeReservations = (mutate, now) => reservationWriteQueue(async () => {
  const loaded = await getQuotaBurnReservations({ now });
  if (!loaded) return null;
  const next = mutate({ ...loaded });
  if (!next) return null;
  await atomicWrite(reservationFile(), next);
  return next;
});

/**
 * Hold a step's place while its request waits to be accepted. Returns null when the file
 * was unreadable (treat as unreserved) or the step is already reserved (the double-enqueue this prevents).
 */
export async function reserveQuotaBurnStep(record, { now = Date.now() } = {}) {
  const key = quotaBurnReservationKey(record?.familyId, record?.stepId);
  return writeReservations((reservations) => (reservations[key]
    ? null
    : { ...reservations, [key]: { ...record, at: now, chargedAt: null } }), now);
}

/**
 * Stamp the instant a reservation's cap charge was CLAIMED, before the ledger write it
 * authorizes. Claiming first makes settlement exactly-once across a crash (the ledger
 * write and release are separate files); the residual is one lost charge, which costs
 * one extra burn. Pass `null` to RELEASE a claim whose ledger write failed, so the retry charges.
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

/** Append one run-log entry (newest first). Records SKIPS too: "why did nothing burn last night" is the page's question. */
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
 * Settle the run-log row a burn already wrote, in place (written once `pending`, then with
 * the task id or refusal). Patching keeps one line per burn in the capped feed; a row that
 * aged out is simply not found.
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
