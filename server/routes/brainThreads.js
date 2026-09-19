/**
 * Brain Threads Routes — the bullet journal's open loops (#7664).
 *
 * A *thread* here is one tracked topic or commitment: a status, a next action,
 * and the set of PortOS records and external items that belong to it. It is NOT
 * a message thread — `messageSync.js` / `messageGmailSync.js` / `beeperSync.js`
 * own that sense of the word and nothing in this file touches them.
 *
 * Stored as the Brain entity type `threads`, so every write rides brainStorage's
 * generic API and inherits the sync-log / LWW / tombstone federation pipeline
 * with no wire-version bump (brain is intentionally ungated in schemaVersions).
 *
 * Mounted from the brain barrel at /threads → /api/brain/threads/...
 *
 * `source`, `externalState` and `closedAt` are server-managed: the write schemas
 * have no key for them, so Zod's unknown-key stripping drops a client-supplied
 * value (the brainSongbook.js `practice`/`attachments` convention). `source` and
 * `externalState` exist for the auto-ingest sync that lands later; this file
 * only ever births them at their neutral values and stamps `closedAt` when the
 * status enters a terminal state.
 *
 * Ref writes go through `updateWith` so two attach clicks — or an attach racing
 * a peer-sync apply — merge against the freshest record instead of clobbering.
 */

import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest, isPaginationRequested, paginateArray } from '../lib/validation.js';
import {
  threadInputSchema,
  threadUpdateSchema,
  threadQuerySchema,
  threadRefInputSchema,
  threadAttachSchema,
  THREAD_TERMINAL_STATUSES,
} from '../lib/brainValidation.js';
import { canonicalThreadRefKind } from '../lib/threadRefKinds.js';
import * as brainStorage from '../services/brainStorage.js';
import { resolveThreadRefs } from '../services/threadRefs.js';

const router = Router();

function requireThread(thread) {
  if (!thread) {
    throw new ServerError('Thread not found', { status: 404, code: 'NOT_FOUND' });
  }
  return thread;
}

const isTerminal = (status) => THREAD_TERMINAL_STATUSES.includes(status);

/**
 * `closedAt` for a record whose status is MOVING to `nextStatus`.
 *
 * Stamped on the transition into a terminal status and cleared on the way out,
 * but PRESERVED when the record was already terminal — re-saving a done thread
 * must not rewrite when it was finished.
 */
function resolveClosedAt(previous, nextStatus, now) {
  if (!isTerminal(nextStatus)) return null;
  return isTerminal(previous?.status) && previous?.closedAt ? previous.closedAt : now;
}

// Identity of one ref. JSON-stringify so the two fields join on an unambiguous,
// PRINTABLE delimiter — no in-band separator a ref id could itself contain, and
// no non-printable byte (catalogRefResolver.js sets that rule).
const refKey = (ref) => JSON.stringify([canonicalThreadRefKind(ref?.kind), ref?.id]);

/**
 * Append `ref` to `existing`, replacing a same-`(kind, id)` entry in place.
 *
 * In-place rather than move-to-end so attaching a ref twice (a double click, or
 * an attach racing a peer apply) is idempotent in ORDER as well as content —
 * two peers that both re-attach converge on the same array.
 */
function mergeRef(existing, ref) {
  // `ref` is already schema-canonical (threadRefKindValue canonicalizes before
  // validating); `refKey` canonicalizes the STORED side, which may predate an
  // alias or have arrived from a peer.
  const refs = Array.isArray(existing) ? existing : [];
  const at = refs.findIndex((r) => refKey(r) === refKey(ref));
  if (at === -1) return [...refs, ref];
  const merged = [...refs];
  merged[at] = ref;
  return merged;
}

// The list projection: everything the Threads list and the dashboard widget
// render, minus the markdown body. `notes` is capped at 20k per thread, so a
// few hundred open loops would ship megabytes nobody reads; the full record
// comes from GET /:id.
const toListRow = ({ notes, ...rest }) => rest;

// Case-insensitive substring match over the fields a user would expect `?q=` to
// search. `notes` IS searched even though the list projection drops it — the
// filter runs on the full record, and finding a thread by something written in
// its body is the point of a search box.
function matchesQuery(thread, q) {
  const needle = q.toLowerCase();
  const haystack = [
    thread.title, thread.nextAction, thread.waitingOn, thread.notes,
    ...(Array.isArray(thread.tags) ? thread.tags : []),
    ...(Array.isArray(thread.refs) ? thread.refs.map((r) => r?.label) : []),
  ];
  return haystack.some((v) => typeof v === 'string' && v.toLowerCase().includes(needle));
}

// Sort key for the due date: a thread with no due date sorts AFTER every dated
// one rather than poisoning the comparator with NaN.
const dueSortKey = (thread) => {
  const t = Date.parse(thread?.dueAt ?? '');
  return Number.isNaN(t) ? Infinity : t;
};

// Pinned first, then soonest-due, then most recently touched, with the id as a
// deterministic tiebreak — a stable order matters because the list paginates,
// and an unstable one drops or duplicates rows at the slice boundary.
function compareThreads(a, b) {
  if (Boolean(b.pinned) !== Boolean(a.pinned)) return Boolean(b.pinned) - Boolean(a.pinned);
  const due = dueSortKey(a) - dueSortKey(b);
  if (due !== 0) return due;
  const touched = Date.parse(b?.updatedAt ?? '') - Date.parse(a?.updatedAt ?? '');
  if (!Number.isNaN(touched) && touched !== 0) return touched;
  return String(a.id).localeCompare(String(b.id));
}

// =============================================================================
// ATTACH (before /:id routes so 'attach' is never treated as an id)
// =============================================================================

// POST /attach — `{ ref, threadId?, title? }`. Attaches to an existing thread,
// or mints one and attaches, in a single call: the one-click affordance every
// "add this to a thread" button posts, without making the caller choose between
// create and update first.
router.post('/attach', asyncHandler(async (req, res) => {
  const { ref, threadId, title } = validateRequest(threadAttachSchema, req.body);

  if (threadId) {
    const thread = requireThread(await brainStorage.updateWith('threads', threadId,
      (fresh) => ({ refs: mergeRef(fresh.refs, ref) })));
    console.log(`🧵 Attached ${ref.kind} ref to thread "${thread.title}"`);
    return res.json({ thread, created: false });
  }

  const now = new Date().toISOString();
  const data = validateRequest(threadInputSchema, {
    title: title || ref.label || ref.id,
    refs: [ref],
  });
  const thread = await brainStorage.create('threads', {
    ...data,
    source: null,
    externalState: 'unknown',
    closedAt: resolveClosedAt(null, data.status, now),
  });
  console.log(`🧵 Created thread "${thread.title}" from a ${ref.kind} ref`);
  return res.status(201).json({ thread, created: true });
}));

// =============================================================================
// THREAD CRUD
// =============================================================================

router.get('/', asyncHandler(async (req, res) => {
  const filters = validateRequest(threadQuerySchema, req.query);
  const all = await brainStorage.getAll('threads');

  const matching = all.filter((thread) => {
    if (filters.status && thread.status !== filters.status) return false;
    if (filters.priority && thread.priority !== filters.priority) return false;
    // A bare `?pinned` arrives as '' and reads as true; 'false' filters to the
    // unpinned set. Absent means "don't filter" (the tri-state in the schema).
    if (filters.pinned !== undefined && Boolean(thread.pinned) !== (filters.pinned !== 'false')) return false;
    if (filters.tag && !(Array.isArray(thread.tags) && thread.tags.includes(filters.tag))) return false;
    if (filters.refKind) {
      const wanted = canonicalThreadRefKind(filters.refKind);
      const refs = Array.isArray(thread.refs) ? thread.refs : [];
      if (!refs.some((r) => canonicalThreadRefKind(r?.kind) === wanted)) return false;
    }
    if (filters.q && !matchesQuery(thread, filters.q)) return false;
    return true;
  }).sort(compareThreads);

  const rows = matching.map(toListRow);
  if (isPaginationRequested(req.query)) {
    const { items, total, limit, offset } = paginateArray(rows, req.query);
    return res.json({ threads: items, total, limit, offset });
  }
  return res.json({ threads: rows, total: rows.length });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const thread = requireThread(await brainStorage.getById('threads', req.params.id));
  // Hydrated for display only — the stored `refs` array is untouched, so a
  // target this build can't resolve still round-trips through a later write.
  res.json({ ...thread, resolvedRefs: await resolveThreadRefs(thread.refs) });
}));

router.post('/', asyncHandler(async (req, res) => {
  const data = validateRequest(threadInputSchema, req.body);
  const thread = await brainStorage.create('threads', {
    ...data,
    // Born unsourced: only the auto-ingest sync sets `source`, and only it knows
    // what a tracker last said about the item.
    source: null,
    externalState: 'unknown',
    closedAt: resolveClosedAt(null, data.status, new Date().toISOString()),
  });
  console.log(`🧵 Created thread: "${thread.title}" (${thread.status})`);
  res.status(201).json(thread);
}));

router.put('/:id', asyncHandler(async (req, res) => {
  // threadUpdateSchema is defaults-free, so an omitted field is genuinely absent
  // instead of resetting to its default, and it has no key for the
  // server-managed trio — Zod's unknown-key stripping drops a client copy.
  const data = validateRequest(threadUpdateSchema, req.body);
  const now = new Date().toISOString();
  // Derive closedAt inside the store write lock, against the FRESH record: the
  // stamp depends on the status the thread is coming FROM, and reading that
  // before the lock would race a concurrent edit or a peer-sync apply.
  const thread = requireThread(await brainStorage.updateWith('threads', req.params.id, (fresh) => (
    data.status === undefined
      ? data
      : { ...data, closedAt: resolveClosedAt(fresh, data.status, now) }
  )));
  res.json(thread);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  // Tombstone delete so the deletion federates rather than resurrecting from a
  // peer that still holds the record.
  requireThread(await brainStorage.remove('threads', req.params.id));
  res.json({ id: req.params.id });
}));

// =============================================================================
// REFS
// =============================================================================

// POST /:id/refs — attach one ref. Idempotent by `(kind, id)`.
router.post('/:id/refs', asyncHandler(async (req, res) => {
  const ref = validateRequest(threadRefInputSchema, req.body);
  const thread = requireThread(await brainStorage.updateWith('threads', req.params.id,
    (fresh) => ({ refs: mergeRef(fresh.refs, ref) })));
  res.status(201).json(thread);
}));

// DELETE /:id/refs/:kind/:refId — detach one ref. `:refId` is URL-encoded by the
// caller, so an external ref whose id is a full URL survives the round trip.
router.delete('/:id/refs/:kind/:refId', asyncHandler(async (req, res) => {
  const target = refKey({ kind: req.params.kind, id: req.params.refId });
  const thread = requireThread(await brainStorage.updateWith('threads', req.params.id, (fresh) => ({
    refs: (Array.isArray(fresh.refs) ? fresh.refs : []).filter((r) => refKey(r) !== target),
  })));
  res.json(thread);
}));

export default router;
