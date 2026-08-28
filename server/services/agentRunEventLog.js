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
 *   data/cos/mind-events.jsonl   — persistent-mind active generation
 *   data/cos/mind-events.1.jsonl — persistent-mind archive generation
 *
 * Retention is TWO bounds, and both are load-bearing.
 *
 * The primary bound is a count, not a byte size, because the useful question is
 * "how many transitions back can I look", and a count survives a payload-shape
 * change that a byte cap would not. Once the active file reaches
 * MAX_ACTIVE_EVENTS it becomes the archive and the previous archive is dropped,
 * so the ledger holds between MAX_ACTIVE_EVENTS and 2×MAX_ACTIVE_EVENTS events.
 *
 * Ordinary diagnostics additionally carry an AGE bound (MAX_EVENT_AGE_DAYS).
 * Persistent-mind events live in their own larger count-bounded pool: mind
 * chatter can neither evict ordinary diagnostics nor age out while stopped.
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
import { EventEmitter } from 'events';
import {
  PATHS,
  atomicWrite,
  appendJSONLine,
  readJSONFileStrict,
  readJSONLFile,
  writeJSONLines,
  pathExists
} from '../lib/fileUtils.js';
import {
  buildRunEvent,
  isStoredRunEvent,
  projectRunStates,
  RUN_EVENT_KINDS,
  RUN_EVENT_READ_LIMITS
} from '../lib/agentRunEvents.js';
import {
  PERSISTENT_MIND_ID,
  PERSISTENT_MIND_TRAJECTORY_LIMITS,
  isPersistentMindEventKind,
  parsePersistentMindCursor,
  persistentMindEventCursor,
  projectPersistentMind,
} from '../lib/persistentMindTrajectory.js';

const ACTIVE_PATH = join(PATHS.cos, 'run-events.jsonl');
const ARCHIVE_PATH = join(PATHS.cos, 'run-events.1.jsonl');
const MIND_ACTIVE_PATH = join(PATHS.cos, 'mind-events.jsonl');
const MIND_ARCHIVE_PATH = join(PATHS.cos, 'mind-events.1.jsonl');
const MIND_SEQUENCE_PATH = join(PATHS.cos, 'persistent-mind-sequences.json');
const MIND_SEQUENCE_SCHEMA_VERSION = 1;

// Live delivery is only a hint that a cursor-aware client should backfill from
// the durable ledger. The event itself is already redacted at construction.
export const runEventLogEvents = new EventEmitter();

/**
 * Events per generation. 5000 covers weeks of a busy install's lifecycle
 * boundaries at a few hundred bytes per line — a couple of MB per generation.
 */
export const MAX_ACTIVE_EVENTS = 5000;
export const MAX_ACTIVE_MIND_EVENTS = 10_000;

/**
 * Age bound, on TOP of the count bound.
 *
 * The two answer different failure modes and neither subsumes the other. The
 * count alone lets a quiet install keep a trace of a run from last spring —
 * stale diagnostics that describe a workspace, a provider, and a code path that
 * no longer exist. A busy install has the opposite problem the count already
 * solves. So: keep at most 2×MAX_ACTIVE_EVENTS events, AND nothing older than
 * this, whichever bites first.
 *
 * 30 days is well past the window in which an ordinary run failure is still
 * worth a post-mortem. Persistent-mind events instead use the count bound so
 * their recent unsummarized window survives a long user-initiated stop.
 */
export const MAX_EVENT_AGE_DAYS = 30;
const MAX_EVENT_AGE_MS = MAX_EVENT_AGE_DAYS * 24 * 60 * 60 * 1000;

/**
 * How often the on-disk prune actually runs. Expiry is enforced on every READ
 * by filtering (so a reader never sees an expired event even between prunes);
 * this interval only bounds how often the files are rewritten to reclaim the
 * space, because rewriting a generation on every append would turn an O(1)
 * append into an O(n) one.
 */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

// Default page size for the read API, and the ceiling a caller can request.
// Defined in the pure module so the route's Zod schema can share them without a
// lib → services import (see RUN_EVENT_READ_LIMITS).
export const DEFAULT_READ_LIMIT = RUN_EVENT_READ_LIMITS.default;
export const MAX_READ_LIMIT = RUN_EVENT_READ_LIMITS.max;

// Lazily hydrated on first append/read: Maps of eventId → retention metadata.
// `null` (not an empty Map) is the "never loaded" sentinel, so a genuinely
// empty ledger caches as empty instead of re-reading both files on every single
// append. The timestamp is carried so the duplicate check can apply the SAME age
// cutoff the read path applies — otherwise, in the window between prunes, a
// redelivery could be rejected as a duplicate of an event no reader can see.
let activeIds = null;
let archiveIds = null;
let activeCount = 0;
let mindActiveIds = null;
let mindArchiveIds = null;
let mindActiveCount = 0;
// Highest sequence observed per mind. The timestamp-based floor keeps a new
// event above a fully-retained-away generation after restart; the retained max
// keeps strict monotonic order when the wall clock moves backwards.
let mindSequenceHighWater = null;
let mindSequenceCheckpointError = null;
// `null` = never pruned in this process, so the first append/read always
// prunes; a timestamp means "pruned then, skip until the interval elapses".
let lastPrunedAt = null;

// Serializes appends; also the handle callers await.
let appendQueue = Promise.resolve();
// A read can be the first caller after a restart, while an append arrives in
// the same event-loop turn. Keep all first-load callers on one snapshot so a
// slower read cannot overwrite the append path's in-memory sequence/index
// state with an older view of disk.
let hydrationPromise = null;

/** eventId → retention metadata, for the duplicate check. */
function indexById(events, { persistentMind = false } = {}) {
  return new Map(events.filter((e) => e?.eventId).map((e) => [e.eventId, {
    at: e.at ?? null,
    persistentMind: persistentMind || isPersistentMindEventKind(e.kind),
  }]));
}

const isMindShapedEvent = (event) => isStoredRunEvent(event)
  && typeof event.mindId === 'string'
  && Number.isSafeInteger(event.sequence);

function normalizeMindGenerations(events) {
  const seen = new Set();
  const previousByMind = new Map();
  const ordered = events
    .filter(isMindShapedEvent)
    .filter((event) => !seen.has(event.eventId) && seen.add(event.eventId))
    .sort((a, b) => a.sequence - b.sequence || String(a.eventId).localeCompare(String(b.eventId)))
    .map((event) => {
      const previousSequence = previousByMind.get(event.mindId) ?? null;
      previousByMind.set(event.mindId, event.sequence);
      return Object.hasOwn(event.data, 'previousSequence')
        ? event
        : { ...event, data: { ...event.data, previousSequence } };
    });
  const active = ordered.slice(-MAX_ACTIVE_MIND_EVENTS);
  const archive = ordered.slice(
    Math.max(0, ordered.length - (MAX_ACTIVE_MIND_EVENTS * 2)),
    Math.max(0, ordered.length - MAX_ACTIVE_MIND_EVENTS)
  );
  return { archive, active };
}

const relinkMindPredecessors = (events) => {
  const previousByMind = new Map();
  return [...events]
    .sort((a, b) => a.sequence - b.sequence || String(a.eventId).localeCompare(String(b.eventId)))
    .map((event) => {
      const previousSequence = previousByMind.get(event.mindId) ?? null;
      previousByMind.set(event.mindId, event.sequence);
      return { ...event, data: { ...event.data, previousSequence } };
    });
};

/**
 * Have we already stored this event, in a copy a reader can still see?
 *
 * An id whose only copy has aged past the cutoff does NOT count: the read path
 * filters that event out, so treating a redelivery as a duplicate would leave
 * the ledger with an event nothing can read and no way to re-observe it. Same
 * reasoning as rotation — a duplicate we can no longer see is no longer a
 * duplicate — applied continuously rather than only at the moment of a prune.
 */
function isStoredDuplicate(eventId, cutoff) {
  const metadata = activeIds.has(eventId) ? activeIds.get(eventId)
    : archiveIds.has(eventId) ? archiveIds.get(eventId)
      : mindActiveIds.has(eventId) ? mindActiveIds.get(eventId)
        : mindArchiveIds.has(eventId) ? mindArchiveIds.get(eventId)
      : undefined;
  return metadata !== undefined
    && (metadata.persistentMind || (typeof metadata.at === 'string' && metadata.at > cutoff));
}

async function hydrate() {
  if (activeIds) return;
  if (hydrationPromise) return hydrationPromise;
  const pending = (async () => {
    let [active, archive, mindActive, mindArchive, sequenceStore] = await Promise.all([
      readJSONLFile(ACTIVE_PATH),
      readJSONLFile(ARCHIVE_PATH),
      readJSONLFile(MIND_ACTIVE_PATH),
      readJSONLFile(MIND_ARCHIVE_PATH),
      readJSONFileStrict(MIND_SEQUENCE_PATH, { schemaVersion: MIND_SEQUENCE_SCHEMA_VERSION, minds: {} }),
    ]);
    const legacyArchive = archive.filter((event) => isPersistentMindEventKind(event?.kind));
    const legacyActive = active.filter((event) => isPersistentMindEventKind(event?.kind));
    if (legacyArchive.length > 0 || legacyActive.length > 0) {
      const recovered = normalizeMindGenerations([
        ...mindArchive,
        ...mindActive,
        ...legacyArchive,
        ...legacyActive,
      ]);
      // Destination-first makes recovery retry-safe if a later source rewrite
      // fails. This path handles upgrade -> rollback -> upgrade installs after
      // migration 301 is already marked applied.
      await writeJSONLines(MIND_ARCHIVE_PATH, recovered.archive);
      await writeJSONLines(MIND_ACTIVE_PATH, recovered.active);
      archive = archive.filter((event) => !isPersistentMindEventKind(event?.kind));
      active = active.filter((event) => !isPersistentMindEventKind(event?.kind));
      await writeJSONLines(ARCHIVE_PATH, archive);
      await writeJSONLines(ACTIVE_PATH, active);
      mindArchive = recovered.archive;
      mindActive = recovered.active;
      console.log(`🧠 Re-homed ${legacyArchive.length + legacyActive.length} rollback-era persistent mind event(s)`);
    }
    const invalidSequenceStore = !sequenceStore.ok || !sequenceStore.value
        || typeof sequenceStore.value !== 'object' || Array.isArray(sequenceStore.value)
        || sequenceStore.value.schemaVersion !== MIND_SEQUENCE_SCHEMA_VERSION
        || !sequenceStore.value.minds || typeof sequenceStore.value.minds !== 'object'
        || Array.isArray(sequenceStore.value.minds)
        || Object.entries(sequenceStore.value.minds).some(([mindId, sequence]) => (
          !mindId || mindId.length > 128 || !Number.isSafeInteger(sequence) || sequence < 0
        ));
    const validSequenceStore = !invalidSequenceStore;
    activeIds = indexById(active);
    archiveIds = indexById(archive);
    mindActiveIds = indexById(mindActive, { persistentMind: true });
    mindArchiveIds = indexById(mindArchive, { persistentMind: true });
    activeCount = active.length;
    mindActiveCount = mindActive.length;
    mindSequenceCheckpointError = validSequenceStore
      ? null
      : 'Persistent mind sequence checkpoint is unreadable or invalid';
    mindSequenceHighWater = new Map(validSequenceStore ? Object.entries(sequenceStore.value.minds) : []);
    for (const event of [...mindArchive, ...mindActive]) {
      if (!event?.mindId || !Number.isSafeInteger(event.sequence)) continue;
      mindSequenceHighWater.set(
        event.mindId,
        Math.max(mindSequenceHighWater.get(event.mindId) ?? -1, event.sequence)
      );
    }
  })();
  hydrationPromise = pending;
  try {
    await pending;
  } finally {
    if (hydrationPromise === pending) hydrationPromise = null;
  }
}

function nextMindSequence(mindId) {
  const previous = mindSequenceHighWater.get(mindId) ?? -1;
  return Math.max(previous + 1, Date.now() * 1000);
}

const saveMindSequenceHighWater = () => atomicWrite(MIND_SEQUENCE_PATH, {
  schemaVersion: MIND_SEQUENCE_SCHEMA_VERSION,
  minds: Object.fromEntries(mindSequenceHighWater),
});

/**
 * Rotate when the active generation is full: active becomes the archive, the
 * previous archive is dropped. The seen-id sets move with the files, so an
 * event whose only copy just aged out of the ledger is appendable again — which
 * is correct: a duplicate we can no longer see is no longer a duplicate.
 */
async function rotateIfFull(mindEvent) {
  const count = mindEvent ? mindActiveCount : activeCount;
  const limit = mindEvent ? MAX_ACTIVE_MIND_EVENTS : MAX_ACTIVE_EVENTS;
  if (count < limit) return;
  const activePath = mindEvent ? MIND_ACTIVE_PATH : ACTIVE_PATH;
  const archivePath = mindEvent ? MIND_ARCHIVE_PATH : ARCHIVE_PATH;
  if (await pathExists(archivePath)) await unlink(archivePath);
  await rename(activePath, archivePath);
  if (mindEvent) {
    mindArchiveIds = mindActiveIds;
    mindActiveIds = new Map();
    mindActiveCount = 0;
  } else {
    archiveIds = activeIds;
    activeIds = new Map();
    activeCount = 0;
  }
  console.log(`🔁 Rotated ${mindEvent ? 'persistent mind' : 'CoS run'} event ledger at ${limit} events`);
}

/**
 * The instant before which an event has aged out. Exported-ish only through the
 * behaviour it drives; `now` is a parameter so tests can age a ledger without
 * faking the clock.
 */
function expiryCutoff(now = Date.now()) {
  return new Date(now - MAX_EVENT_AGE_MS).toISOString();
}

/**
 * Would a reader see this line — structurally sound and either a mind event or
 * still inside the ordinary-run age window?
 *
 * One predicate, used by the read path, the stats, and the prune, so all three
 * agree by construction. A structurally invalid or undatable line counts as
 * NOT retained: the read path drops it either way, so counting it would make
 * the stats disagree with the endpoint they describe, and leaving it on disk
 * would let unreadable bytes accumulate forever under a retention policy that
 * can never date them. The prune is the only thing that ever cleans them up.
 */
const isRetained = (event, cutoff) => isStoredRunEvent(event)
  && (isPersistentMindEventKind(event.kind) || event.at > cutoff);

/**
 * Rewrite both generations without their expired events, and drop the expired
 * ids from the seen-id sets so a fresh redelivery of a long-gone event is
 * appendable again (same reasoning as rotation: a duplicate we can no longer
 * see is no longer a duplicate).
 *
 * Only runs inside the append queue or behind `flushRunEvents`, so it never
 * races an append. Throttled by PRUNE_INTERVAL_MS because it is O(ledger);
 * `force` is for the read path's first call and for tests.
 */
async function pruneExpired({ now = Date.now(), force = false } = {}) {
  if (!force && lastPrunedAt !== null && now - lastPrunedAt < PRUNE_INTERVAL_MS) return;
  lastPrunedAt = now;
  const cutoff = expiryCutoff(now);

  const [archive, active] = await Promise.all([
    readJSONLFile(ARCHIVE_PATH),
    readJSONLFile(ACTIVE_PATH)
  ]);

  const keptArchive = archive.filter((e) => isRetained(e, cutoff));
  const keptActive = active.filter((e) => isRetained(e, cutoff));
  const dropped = (archive.length - keptArchive.length) + (active.length - keptActive.length);
  if (dropped === 0) return;

  // An archive with nothing left is unlinked rather than rewritten empty, so a
  // long-idle install ends up with no archive file at all instead of a 0-byte one.
  if (keptArchive.length === 0) {
    if (await pathExists(ARCHIVE_PATH)) await unlink(ARCHIVE_PATH);
  } else if (keptArchive.length !== archive.length) {
    await writeJSONLines(ARCHIVE_PATH, keptArchive);
  }
  if (keptActive.length !== active.length) await writeJSONLines(ACTIVE_PATH, keptActive);

  archiveIds = indexById(keptArchive);
  activeIds = indexById(keptActive);
  activeCount = keptActive.length;
  console.log(`🧹 Pruned ${dropped} CoS run events older than ${MAX_EVENT_AGE_DAYS} days`);
}

async function appendNow(input) {
  await hydrate();
  const mindEvent = isPersistentMindEventKind(input?.kind);
  if (mindEvent && mindSequenceCheckpointError) throw new Error(mindSequenceCheckpointError);
  // A stable explicit id lets a retry short-circuit before consuming a new
  // sequence. Every supervisor boundary supplies one; derived ids remain
  // available for one-off callers and ordinary lifecycle events.
  if (mindEvent && input?.eventId && isStoredDuplicate(input.eventId, expiryCutoff())) {
    return { appended: false, duplicate: true, event: null };
  }
  const previousSequence = mindEvent ? (mindSequenceHighWater.get(input.mindId) ?? null) : null;
  const sequence = mindEvent ? nextMindSequence(input.mindId) : undefined;
  const event = buildRunEvent(mindEvent ? {
    ...input,
    sequence,
    data: { ...(input.data && typeof input.data === 'object' ? input.data : {}), previousSequence },
  } : input);
  // Age out BEFORE the duplicate check: an event whose only copy just expired
  // must be appendable again, exactly as after a rotation.
  await pruneExpired();
  if (isStoredDuplicate(event.eventId, expiryCutoff())) {
    return { appended: false, duplicate: true, event };
  }
  await rotateIfFull(mindEvent);
  const activePath = mindEvent ? MIND_ACTIVE_PATH : ACTIVE_PATH;
  await appendJSONLine(activePath, event);
  const ids = mindEvent ? mindActiveIds : activeIds;
  ids.set(event.eventId, { at: event.at, persistentMind: mindEvent });
  if (mindEvent) mindActiveCount += 1;
  else activeCount += 1;
  if (mindEvent) {
    mindSequenceHighWater.set(event.mindId, event.sequence);
    // Mind generations are bounded by rotation, while rollups can live
    // indefinitely. Persist the high-water separately so a clock rollback
    // after raw retention rotates cannot reuse an old sequence range.
    await saveMindSequenceHighWater();
  }
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

/** Append one persistent-mind trajectory event through the shared queue. */
export async function appendMindEvent(input) {
  const result = await appendRunEvent({ ...input, mindId: input?.mindId || PERSISTENT_MIND_ID });
  if (result.appended && result.event) runEventLogEvents.emit('mind:event', result.event);
  return result;
}

/** Resolve once every queued append has landed. Used by the read path + tests. */
export function flushRunEvents() {
  return appendQueue.then(() => undefined, () => undefined);
}

/**
 * Queue a prune behind any in-flight appends.
 *
 * The read paths call this so a ledger nobody is appending to still gets its
 * expired generations reclaimed. It goes through the SAME queue as appends —
 * `flushRunEvents()` alone would only prove the queue was empty a tick ago, not
 * that a rewrite can't land mid-append. Absorbs its own errors for the same
 * reason appends do: a read must never fail on account of housekeeping.
 */
function schedulePrune() {
  appendQueue = appendQueue.then(() => pruneExpired()).catch((err) => {
    console.error(`❌ Failed to prune CoS run event ledger: ${err.message}`);
  });
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
async function readRetainedEvents() {
  await hydrate();
  await schedulePrune();
  const [archive, active] = await Promise.all([
    readJSONLFile(ARCHIVE_PATH),
    readJSONLFile(ACTIVE_PATH),
  ]);
  // The age bound is enforced on read as well as on disk, so it holds in the
  // window between prunes — a reader must never see an event the retention
  // policy says is gone.
  const cutoff = expiryCutoff();
  // A line that fails the STRUCTURAL check is a corrupt/truncated write, not
  // data — dropping it keeps one bad line from poisoning the whole projection.
  // The check deliberately admits kinds this build does not know (see
  // `isStoredRunEvent`): a newer install's ledger must still read here. The
  // same predicate bounds the age, so a reader never sees an expired event.
  return [...archive, ...active].filter((event) => isRetained(event, cutoff) && !isMindShapedEvent(event));
}

export async function readRunEvents({ runId, agentId, taskId, kind, since, limit } = {}) {
  let events = await readRetainedEvents();

  if (runId) events = events.filter((e) => e.runId === runId);
  if (agentId) events = events.filter((e) => e.agentId === agentId);
  if (taskId) events = events.filter((e) => e.taskId === taskId);
  if (kind) events = events.filter((e) => e.kind === kind);
  if (since) events = events.filter((e) => e.at > since);

  const cap = Math.min(Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_READ_LIMIT, MAX_READ_LIMIT);
  return events.length > cap ? events.slice(events.length - cap) : events;
}

/** All retained events for one mind, ordered by durable sequence. */
export async function readPersistentMindHistory(mindId = PERSISTENT_MIND_ID) {
  await hydrate();
  const [archive, active] = await Promise.all([
    readJSONLFile(MIND_ARCHIVE_PATH),
    readJSONLFile(MIND_ACTIVE_PATH),
  ]);
  return [...archive, ...active]
    // Preserve structurally valid future kinds in the physical mind stream.
    // Current projections can ignore an unknown kind without deleting history.
    .filter((event) => isMindShapedEvent(event) && event.mindId === mindId)
    .sort((a, b) => a.sequence - b.sequence || String(a.eventId).localeCompare(String(b.eventId)));
}

/**
 * Remove one mind's retained trajectory behind the same queue as appends.
 * A cleanup requested by the mind itself may preserve its current turn and
 * originating message so the final reply still has visible provenance.
 */
export function clearPersistentMindHistory({
  mindId = PERSISTENT_MIND_ID,
  preserveTurnId = null,
  preserveMessageId = null,
} = {}) {
  const operation = appendQueue.then(async () => {
    await hydrate();
    const [archive, active] = await Promise.all([
      readJSONLFile(MIND_ARCHIVE_PATH),
      readJSONLFile(MIND_ACTIVE_PATH),
    ]);
    const stored = [...archive, ...active].filter(isMindShapedEvent);
    const shouldPreserve = (event) => event.mindId !== mindId
      || (preserveTurnId && event.turnId === preserveTurnId)
      || (preserveMessageId && event.data?.messageId === preserveMessageId);
    const kept = relinkMindPredecessors(stored.filter(shouldPreserve));
    const removed = stored.filter((event) => event.mindId === mindId && !shouldPreserve(event));
    const generations = normalizeMindGenerations(kept);

    if (generations.archive.length === 0) {
      if (await pathExists(MIND_ARCHIVE_PATH)) await unlink(MIND_ARCHIVE_PATH);
    } else {
      await writeJSONLines(MIND_ARCHIVE_PATH, generations.archive);
    }
    await writeJSONLines(MIND_ACTIVE_PATH, generations.active);

    mindArchiveIds = indexById(generations.archive, { persistentMind: true });
    mindActiveIds = indexById(generations.active, { persistentMind: true });
    mindActiveCount = generations.active.length;
    console.log(`🧹 Cleared ${removed.length} persistent mind history event(s)`);
    return {
      cleared: removed.length,
      preserved: generations.archive.filter((event) => event.mindId === mindId).length
        + generations.active.filter((event) => event.mindId === mindId).length,
    };
  });
  appendQueue = operation.then(
    () => undefined,
    (error) => console.error(`❌ Failed to clear persistent mind history: ${error.message}`),
  );
  return operation;
}

/**
 * Cursor-aware mind tail read. A missing predecessor is explicit `gap: true`;
 * the same response carries a fresh projection and retained tail so a client
 * can recover without treating the gap as an empty conversation.
 */
export async function readPersistentMindEvents({
  mindId = PERSISTENT_MIND_ID,
  cursor,
  limit = PERSISTENT_MIND_TRAJECTORY_LIMITS.defaultPageSize,
} = {}) {
  const retained = await readPersistentMindHistory(mindId);
  const cap = Math.min(
    Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : PERSISTENT_MIND_TRAJECTORY_LIMITS.defaultPageSize,
    PERSISTENT_MIND_TRAJECTORY_LIMITS.maxPageSize
  );
  const parsed = cursor ? parsePersistentMindCursor(cursor) : null;
  const cursorIndex = parsed
    ? retained.findIndex((event) => event.sequence === parsed.sequence && event.eventId === parsed.eventId)
    : -1;
  const gap = Boolean(cursor) && cursorIndex < 0;
  const available = cursorIndex >= 0 ? retained.slice(cursorIndex + 1) : retained;
  const events = cursorIndex >= 0 ? available.slice(0, cap) : available.slice(-cap);
  const last = events.at(-1) || retained.at(-1) || null;
  return {
    mindId,
    events,
    cursor: persistentMindEventCursor(last),
    gap,
    hasMore: cursorIndex >= 0 && available.length > events.length,
    truncated: cursorIndex < 0 && available.length > events.length,
    snapshot: projectPersistentMind(retained, mindId),
  };
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
  await hydrate();
  await schedulePrune();
  const [archive, active, mindArchive, mindActive] = await Promise.all([
    readJSONLFile(ARCHIVE_PATH),
    readJSONLFile(ACTIVE_PATH),
    readJSONLFile(MIND_ARCHIVE_PATH),
    readJSONLFile(MIND_ACTIVE_PATH),
  ]);
  // Counted through the SAME predicate the read path uses, so "stats say 40
  // events" and "the events endpoint returns 40" can never disagree.
  const cutoff = expiryCutoff();
  const freshArchive = archive.filter((e) => isRetained(e, cutoff) && !isMindShapedEvent(e));
  const freshActive = active.filter((e) => isRetained(e, cutoff) && !isMindShapedEvent(e));
  const oldest = freshArchive[0]?.at ?? freshActive[0]?.at ?? null;
  return {
    activeEvents: freshActive.length,
    archivedEvents: freshArchive.length,
    maxActiveEvents: MAX_ACTIVE_EVENTS,
    maxRetainedEvents: MAX_ACTIVE_EVENTS * 2,
    maxEventAgeDays: MAX_EVENT_AGE_DAYS,
    mindActiveEvents: mindActive.filter(isMindShapedEvent).length,
    mindArchivedEvents: mindArchive.filter(isMindShapedEvent).length,
    maxActiveMindEvents: MAX_ACTIVE_MIND_EVENTS,
    maxRetainedMindEvents: MAX_ACTIVE_MIND_EVENTS * 2,
    persistentMindAgeBounded: false,
    oldestEventAt: oldest,
    kinds: RUN_EVENT_KINDS
  };
}

/**
 * Drop every cached seen-id map so the next call re-reads from disk.
 *
 * Exported for tests, which write ledger files directly to simulate a restart —
 * the in-process caches are exactly what a real restart discards.
 */
export function __resetRunEventLogCache() {
  activeIds = null;
  archiveIds = null;
  activeCount = 0;
  mindActiveIds = null;
  mindArchiveIds = null;
  mindActiveCount = 0;
  mindSequenceHighWater = null;
  mindSequenceCheckpointError = null;
  lastPrunedAt = null;
  hydrationPromise = null;
  appendQueue = Promise.resolve();
}
