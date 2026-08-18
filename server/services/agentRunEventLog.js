/**
 * CoS run event ledger — machine-local, append-only, bounded.
 *
 * Storage class `ephemeral-file` (see `docs/STORAGE.md`): the durable record of
 * a run is still `data/runs/{id}/metadata.json`; this file is the ordered trace
 * of how that record got where it is. It is **intentionally machine-local and
 * never federated** — every line describes a process on this box, so a peer's
 * copy would describe nothing that exists there. No sync cursor, no tombstone,
 * no `PORTOS_SCHEMA_VERSIONS` entry.
 *
 * On disk:
 *   data/cos/run-events.jsonl    — active generation
 *   data/cos/run-events.1.jsonl  — the one retained archive generation
 *
 * The bound is a count, not a byte size, because the useful question is "how
 * many transitions back can I look", and a count survives a payload-shape change
 * that a byte cap would not. Once the active file reaches MAX_ACTIVE_EVENTS it
 * becomes the archive and the previous archive is dropped, so the ledger holds
 * between MAX_ACTIVE_EVENTS and 2×MAX_ACTIVE_EVENTS events forever.
 *
 * Two invariants the callers depend on:
 *
 * - **Appends never reject.** These are called from agent lifecycle paths,
 *   several of them inside child-process exit handlers where a throw takes the
 *   Node process with it. Telemetry must never be able to fail a run, so the
 *   promise chain absorbs and logs instead of propagating.
 * - **Appends are serialized.** Every append goes through one module-level
 *   promise queue, so the file order matches the call order and the seen-id set
 *   can't be read between another append's check and its write.
 */

import { join } from 'path';
import { rename, unlink } from 'fs/promises';
import {
  PATHS,
  appendJSONLine,
  readJSONLFile,
  pathExists
} from '../lib/fileUtils.js';
import {
  buildRunEvent,
  isValidRunEvent,
  projectRunStates,
  AGENT_RUN_EVENT_KINDS
} from '../lib/agentRunEvents.js';

const ACTIVE_PATH = join(PATHS.cos, 'run-events.jsonl');
const ARCHIVE_PATH = join(PATHS.cos, 'run-events.1.jsonl');

/**
 * Events per generation. 5000 covers weeks of a busy install's lifecycle
 * boundaries at a few hundred bytes per line — a couple of MB per generation.
 */
export const MAX_ACTIVE_EVENTS = 5000;

/** Default page size for the read API, and the ceiling a caller can request. */
export const DEFAULT_READ_LIMIT = 200;
export const MAX_READ_LIMIT = 1000;

// Lazily hydrated on first append/read. `null` (not an empty Set) is the
// "never loaded" sentinel, so a genuinely empty ledger caches as empty instead
// of re-reading both files on every single append.
let activeIds = null;
let archiveIds = null;
let activeCount = 0;

// Serializes appends; also the handle callers await.
let appendQueue = Promise.resolve();

async function hydrate() {
  if (activeIds) return;
  const [active, archive] = await Promise.all([
    readJSONLFile(ACTIVE_PATH),
    readJSONLFile(ARCHIVE_PATH)
  ]);
  activeIds = new Set(active.map((e) => e?.eventId).filter(Boolean));
  archiveIds = new Set(archive.map((e) => e?.eventId).filter(Boolean));
  activeCount = active.length;
}

/**
 * Rotate when the active generation is full: active becomes the archive, the
 * previous archive is dropped. The seen-id sets move with the files, so an
 * event whose only copy just aged out of the ledger is appendable again — which
 * is correct: a duplicate we can no longer see is no longer a duplicate.
 */
async function rotateIfFull() {
  if (activeCount < MAX_ACTIVE_EVENTS) return;
  if (await pathExists(ARCHIVE_PATH)) await unlink(ARCHIVE_PATH);
  await rename(ACTIVE_PATH, ARCHIVE_PATH);
  archiveIds = activeIds;
  activeIds = new Set();
  activeCount = 0;
  console.log(`🔁 Rotated CoS run event ledger at ${MAX_ACTIVE_EVENTS} events`);
}

async function appendNow(input) {
  const event = buildRunEvent(input);
  await hydrate();
  if (activeIds.has(event.eventId) || archiveIds.has(event.eventId)) {
    return { appended: false, duplicate: true, event };
  }
  await rotateIfFull();
  await appendJSONLine(ACTIVE_PATH, event);
  activeIds.add(event.eventId);
  activeCount += 1;
  return { appended: true, duplicate: false, event };
}

/**
 * Append one lifecycle event.
 *
 * Never rejects and never throws: a bad envelope or an unwritable disk is
 * logged and swallowed, because no run may fail on account of its own
 * telemetry. Returns `{ appended, duplicate, event }` on success and
 * `{ appended: false, error }` when the append was dropped, so a caller that
 * wants to know can look — none currently needs to.
 *
 * @param {object} input - see `buildRunEvent` in `lib/agentRunEvents.js`
 * @returns {Promise<{appended: boolean, duplicate?: boolean, event?: object, error?: string}>}
 */
export function appendRunEvent(input) {
  appendQueue = appendQueue.then(() => appendNow(input)).catch((err) => {
    console.error(`❌ Failed to append CoS run event (${input?.kind}): ${err.message}`);
    return { appended: false, error: err.message };
  });
  return appendQueue;
}

/** Resolve once every queued append has landed. Used by the read path + tests. */
export function flushRunEvents() {
  return appendQueue.then(() => undefined, () => undefined);
}

/**
 * Read the ledger, oldest generation first so the result is in append order —
 * which is what `projectRunStates` folds and what a replay needs.
 *
 * Filters are applied before the limit, and the limit keeps the NEWEST events
 * (the tail), because a diagnostic asking for 50 events wants the last 50, not
 * the first 50 of an aged-out generation.
 *
 * @param {object} [options]
 * @param {string} [options.runId] - exact run id
 * @param {string} [options.agentId] - exact agent id
 * @param {string} [options.taskId] - exact task id
 * @param {string} [options.kind] - one of AGENT_RUN_EVENT_KINDS
 * @param {string} [options.since] - ISO timestamp; events strictly after it
 * @param {number} [options.limit] - newest-N cap (default DEFAULT_READ_LIMIT)
 * @returns {Promise<object[]>} validated events in append order
 */
export async function readRunEvents({ runId, agentId, taskId, kind, since, limit } = {}) {
  await flushRunEvents();
  const [archive, active] = await Promise.all([
    readJSONLFile(ARCHIVE_PATH),
    readJSONLFile(ACTIVE_PATH)
  ]);
  // A line that fails validation is a corrupt/truncated write, not data —
  // dropping it keeps one bad line from poisoning the whole projection.
  let events = [...archive, ...active].filter(isValidRunEvent);

  if (runId) events = events.filter((e) => e.runId === runId);
  if (agentId) events = events.filter((e) => e.agentId === agentId);
  if (taskId) events = events.filter((e) => e.taskId === taskId);
  if (kind) events = events.filter((e) => e.kind === kind);
  if (since) events = events.filter((e) => e.at > since);

  const cap = Math.min(Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_READ_LIMIT, MAX_READ_LIMIT);
  return events.length > cap ? events.slice(events.length - cap) : events;
}

/**
 * Replay the ledger into per-run current state.
 *
 * This is the "how did it get here" answer the mutable run record can't give.
 * `limit` bounds the PROJECTIONS returned (newest activity first), never the
 * events folded — the fold always runs over the newest `MAX_READ_LIMIT` events,
 * so a run's spawn and finalize are read together rather than a paged read
 * lopping the head off a lifecycle. Pass `runId` to fold one run's full history
 * regardless of how much unrelated traffic followed it.
 *
 * @param {object} [options]
 * @param {string} [options.runId] - restrict the replay to one run
 * @param {string} [options.agentId] - restrict the replay to one agent
 * @param {number} [options.limit] - max projections returned
 * @returns {Promise<object[]>}
 */
export async function getRunProjections({ runId, agentId, limit } = {}) {
  const events = await readRunEvents({ runId, agentId, limit: MAX_READ_LIMIT });
  const states = projectRunStates(events);
  const cap = Math.min(Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_READ_LIMIT, MAX_READ_LIMIT);
  return states.slice(0, cap);
}

/**
 * One run's projection plus the events it was folded from.
 *
 * @param {string} id - a run id, or `agent:<agentId>` for a run that never got one
 * @returns {Promise<{projection: object|null, events: object[]}>}
 */
export async function getRunDiagnostic(id) {
  const isAgentKey = typeof id === 'string' && id.startsWith('agent:');
  const events = isAgentKey
    ? (await readRunEvents({ agentId: id.slice('agent:'.length), limit: MAX_READ_LIMIT })).filter((e) => !e.runId)
    : await readRunEvents({ runId: id, limit: MAX_READ_LIMIT });
  const projection = projectRunStates(events).find((state) => state.id === id) ?? null;
  return { projection, events };
}

/**
 * Ledger health for the diagnostics route: generation sizes and the bound they
 * are held to, so "why is this run missing" has an answer that isn't a guess.
 */
export async function getRunEventLedgerStats() {
  await flushRunEvents();
  const [archive, active] = await Promise.all([
    readJSONLFile(ARCHIVE_PATH),
    readJSONLFile(ACTIVE_PATH)
  ]);
  return {
    activeEvents: active.length,
    archivedEvents: archive.length,
    maxActiveEvents: MAX_ACTIVE_EVENTS,
    maxRetainedEvents: MAX_ACTIVE_EVENTS * 2,
    kinds: AGENT_RUN_EVENT_KINDS
  };
}

/**
 * Drop every cached seen-id set so the next call re-reads from disk.
 *
 * Exported for tests, which write ledger files directly to simulate a restart —
 * the in-process caches are exactly what a real restart discards.
 */
export function __resetRunEventLogCache() {
  activeIds = null;
  archiveIds = null;
  activeCount = 0;
  appendQueue = Promise.resolve();
}
