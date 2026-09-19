/**
 * The persistent mind's decision journal — store and extraction.
 *
 * Machine-local, beside the rollup cache, for the same reason the rollups are:
 * the journal quotes one human's private conversation, so the machine-local
 * privacy ADR keeps it off the federation layer entirely — no
 * `PORTOS_SCHEMA_VERSIONS` entry, no sync cursor, no tombstone. An absent file
 * is the correct empty state, so no `data.reference/` seed and no migration.
 *
 * A corrupt or unreadable store fails CLOSED rather than becoming `[]`: the
 * journal is the only record of what the mind still owes the user once the raw
 * events behind it have left retention, and a silent reset would quietly
 * discharge every outstanding commitment.
 */

import { join } from 'path';
import { PATHS, atomicWrite, readJSONFileStrict } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { parseLLMJSON } from '../lib/llmText.js';
import { PERSISTENT_MIND_ID } from '../lib/persistentMindTrajectory.js';
import {
  PERSISTENT_MIND_JOURNAL_PROMPT_VERSION,
  applyPersistentMindJournalOperations,
  buildPersistentMindJournalPrompt,
  buildPersistentMindJournalRepairPrompt,
  isStoredPersistentMindJournalEvent,
  persistentMindJournalEventSchema,
  persistentMindJournalOperationsSchema,
  selectPersistentMindJournal,
} from '../lib/persistentMindJournal.js';

const JOURNAL_PATH = join(PATHS.cos, 'persistent-mind-journal.json');
const JOURNAL_STORE_SCHEMA_VERSION = 1;
const queueJournalWrite = createFileWriteQueue();

const emptyStore = () => ({ schemaVersion: JOURNAL_STORE_SCHEMA_VERSION, events: [] });

async function loadJournalStore() {
  const { ok, value } = await readJSONFileStrict(JOURNAL_PATH, emptyStore());
  if (!ok) throw new Error('Persistent mind journal store is unreadable');
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.schemaVersion !== JOURNAL_STORE_SCHEMA_VERSION || !Array.isArray(value.events)
      || value.events.some((event) => !isStoredPersistentMindJournalEvent(event))) {
    throw new Error('Persistent mind journal store has an invalid shape');
  }
  return value;
}

export async function readPersistentMindJournal(mindId = PERSISTENT_MIND_ID, filters = {}) {
  const store = await loadJournalStore();
  return selectPersistentMindJournal(store.events, { mindId, ...filters });
}

/** Drop one mind's journal. Used by the `history` cleanup scope, which removes the source it cites. */
export function clearPersistentMindJournal(mindId = PERSISTENT_MIND_ID) {
  return queueJournalWrite(async () => {
    const store = await loadJournalStore();
    const events = store.events.filter((event) => event.mindId !== mindId);
    const cleared = store.events.length - events.length;
    // Nothing to clear means nothing to write: a cleanup on an install that has
    // never recorded an entry must not create the file it is trying to empty.
    if (cleared > 0) await atomicWrite(JOURNAL_PATH, { schemaVersion: JOURNAL_STORE_SCHEMA_VERSION, events });
    return { cleared };
  });
}

/**
 * Apply one batch of already-validated operations. Every write goes through
 * here — the mind's extraction and the user's correction alike — so the
 * status-transition rules cannot be bypassed by a second write path.
 */
export function recordPersistentMindJournalOperations({
  mindId = PERSISTENT_MIND_ID,
  operations = [],
  range = null,
  actor = 'mind',
  providerId = null,
  model = null,
  promptVersion = PERSISTENT_MIND_JOURNAL_PROMPT_VERSION,
} = {}) {
  return queueJournalWrite(async () => {
    const store = await loadJournalStore();
    const others = store.events.filter((event) => event.mindId !== mindId);
    const mine = store.events.filter((event) => event.mindId === mindId);
    const result = applyPersistentMindJournalOperations({
      events: mine, operations, mindId, range, actor, providerId, model, promptVersion,
    });
    // Zero operations is the normal outcome, and an idempotent re-resolve
    // changes nothing. Neither should create the file or rewrite it — an absent
    // journal is the correct empty state.
    if (result.applied.some((entry) => entry.effect !== 'unchanged')) {
      await atomicWrite(JOURNAL_PATH, {
        schemaVersion: JOURNAL_STORE_SCHEMA_VERSION,
        events: [...others, ...result.events],
      });
    }
    return { applied: result.applied, rejected: result.rejected, events: result.events };
  });
}

/**
 * The user's correction verb: retire or settle an entry the mind got wrong.
 *
 * `retire` is a supersession with no replacement — the statement stops being
 * quoted as current and stays readable as history, the same transition the mind
 * performs when it replaces one. Neither verb deletes a record.
 */
export function correctPersistentMindJournalEvent({
  mindId = PERSISTENT_MIND_ID,
  eventId,
  action,
  resolution = null,
} = {}) {
  return queueJournalWrite(async () => {
    const store = await loadJournalStore();
    const target = store.events.find((event) => event.id === eventId && event.mindId === mindId);
    if (!target) return { success: false, error: 'Journal entry not found', status: 404, code: 'NOT_FOUND' };
    if (action === 'resolve' && target.status === 'resolved') return { success: true, event: target, changed: false };
    if (action === 'retire' && target.status === 'superseded') return { success: true, event: target, changed: false };
    if (target.status !== 'active') {
      return { success: false, error: 'Only an active journal entry can be corrected', status: 409, code: 'INVALID_STATE' };
    }
    const at = new Date().toISOString();
    const updated = action === 'resolve'
      ? { ...target, status: 'resolved', resolution: resolution?.trim() || null, retiredBy: 'user' }
      : { ...target, status: 'superseded', supersededBy: null, retiredBy: 'user' };
    const next = persistentMindJournalEventSchema.parse({ ...updated, provenance: { ...target.provenance, updatedAt: at } });
    await atomicWrite(JOURNAL_PATH, {
      schemaVersion: JOURNAL_STORE_SCHEMA_VERSION,
      events: store.events.map((event) => (event.id === next.id && event.mindId === mindId ? next : event)),
    });
    return { success: true, event: next, changed: true };
  });
}

// A model answer that is not valid for the closed contract gets ONE narrow
// repair attempt and then gives up without writing. Storing a half-understood
// batch is worse than storing nothing: the range stays unextracted and a later
// turn can try again, but a wrong supersession retires a live commitment.
const parseOperations = (text) => Promise.resolve()
  .then(() => persistentMindJournalOperationsSchema.parse(parseLLMJSON(text)))
  .then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error: String(error?.message || error || 'invalid journal response').slice(0, 300) })
  );

/**
 * Extract journal operations for one sealed range and write what survives
 * validation.
 *
 * `extract` is the provider transport the caller already resolved — this
 * introduces no new provider path and no cold-bootstrap call. `attempted:
 * false` means the transport never reached a provider, so the caller can leave
 * the range open for a later turn instead of recording a failure.
 */
export async function extractPersistentMindJournal({
  mindId = PERSISTENT_MIND_ID,
  events = [],
  range,
  extract,
  providerId = null,
  model = null,
  promptVersion = PERSISTENT_MIND_JOURNAL_PROMPT_VERSION,
  isCallDenial = () => false,
} = {}) {
  if (typeof extract !== 'function' || events.length === 0) return { attempted: false, ok: false, applied: [], rejected: [] };
  const journal = await readPersistentMindJournal(mindId);
  const prompt = buildPersistentMindJournalPrompt({ events, journal, mindId, range });
  const first = await Promise.resolve()
    .then(() => extract({ prompt }))
    .then((text) => ({ attempted: true, text }), (error) => ({ attempted: !isCallDenial(error), error }));
  if (!first.attempted) return { attempted: false, ok: false, applied: [], rejected: [] };
  if (first.error) {
    return { attempted: true, ok: false, applied: [], rejected: [], error: String(first.error?.message || first.error).slice(0, 300) };
  }

  let parsed = await parseOperations(first.text);
  if (!parsed.ok) {
    const repair = await Promise.resolve()
      .then(() => extract({ prompt: buildPersistentMindJournalRepairPrompt({ prompt, response: first.text, error: parsed.error }) }))
      .then((text) => ({ text }), (error) => ({ error }));
    if (repair.error) {
      return { attempted: true, ok: false, applied: [], rejected: [], error: String(repair.error?.message || repair.error).slice(0, 300) };
    }
    parsed = await parseOperations(repair.text);
    if (!parsed.ok) return { attempted: true, ok: false, repaired: true, applied: [], rejected: [], error: parsed.error };
  }

  const { applied, rejected } = await recordPersistentMindJournalOperations({
    mindId, operations: parsed.value.operations, range, actor: 'mind', providerId, model, promptVersion,
  });
  return { attempted: true, ok: true, applied, rejected };
}
