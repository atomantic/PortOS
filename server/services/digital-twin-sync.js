/**
 * Digital Twin Sync
 *
 * Snapshot + merge for the FULL Digital Twin / identity dataset between PortOS
 * peer instances. The `digitalTwin` snapshot category in `dataSync.js` delegates
 * here (the same way the universe/pipeline categories delegate to their owning
 * services).
 *
 * Historically only four files synced — identity, chronotype, longevity,
 * feedback — so the "Digital Twin: synced" badge could read green while the
 * documents, taste profile, and autobiography never crossed between peers. This
 * module widens the snapshot to cover everything under `data/digital-twin/`:
 *
 *   - identity.json        — LWW on updatedAt
 *   - chronotype.json      — deep union (derived markers, derivedAt tiebreak)
 *   - longevity.json       — deep union (derived markers, derivedAt tiebreak)
 *   - feedback.json        — LWW on updatedAt
 *   - taste-profile.json   — per-section union of responses (never lose answers)
 *   - meta.json            — union of documents/histories/personas, deep-union
 *                            enrichment, fill-missing settings, and the analyzed
 *                            personality-trait confidence (max per dimension —
 *                            see mergeConfidence)
 *   - *.md documents       — content shipped by filename, ADD-ONLY on the
 *                            receiver (a local doc is never overwritten) MINUS
 *                            anything either side tombstoned (see below)
 *   - autobiography/        — stories union by id (LWW) MINUS anything either
 *                            side tombstoned (see below); config (the prompt
 *                            schedule) is NOT synced — it's machine-local
 *   - social-accounts.json  — the user's own social accounts, union by id (LWW)
 *                            MINUS anything either side tombstoned (see below)
 *
 * Merge philosophy mirrors the rest of dataSync: union semantics, no data is
 * ever lost, and every field is key-presence guarded so an OLDER peer that only
 * sends the four legacy keys can't blank out taste/documents/autobiography. The
 * snapshot is additive and ignore-if-unknown, so it needs no schemaVersions gate
 * (digitalTwin stays unversioned — see SNAPSHOT_CATEGORY_SCHEMA_KEYS).
 *
 * DELETES are the one thing pure union semantics can't express, so documents
 * carry tombstones (#3530): `meta.deletedDocuments` is a `{ filename, deletedAt }`
 * list that unions in BOTH directions, suppressing the document metadata entry
 * and reaping the `.md` file on whichever peer still has it. A document
 * re-created after a delete carries a `createdAt` that supersedes the tombstone,
 * so it is never permanently suppressed. Autobiography stories carry the same
 * mechanism (#3531) as `deletedStories` inside autobiography/stories.json, keyed
 * on the story id. This stays additive too: an older peer simply drops the
 * unknown tombstone key (Zod strips it, or it never reads it), keeps
 * resurrecting its own copy, and the upgraded peer defends locally — degraded,
 * but never corrupting, so still no schemaVersions bump. See lib/tombstones.js.
 *
 * Personas carry the same tombstone (#3533) as `meta.deletedPersonas`, keyed on
 * the persona id — a persona lives only in meta.json, so the merge alone
 * completes the delete with no file to reap.
 *
 * Social accounts carry the same machinery on `deletedAccounts`, keyed on the
 * account id (#3532) — see mergeSocialAccounts.
 */

import crypto from 'crypto';
import { join, basename } from 'path';
import { readdir, readFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { atomicWrite, readJSONFile, ensureDir, PATHS } from '../lib/fileUtils.js';
import { canonicalStringify, isPlainObject } from '../lib/objects.js';
import { normalizeTombstones, mergeTombstones, isTombstoned, pruneTombstones, tombstonesEqual } from '../lib/tombstones.js';
import { compareNewerWins } from '../lib/lwwTimestamp.js';
import { queueAutobiographyStoriesWrite } from './autobiographyFileQueues.js';

const DIR = PATHS.digitalTwin;
const IDENTITY_FILE = join(DIR, 'identity.json');
const CHRONOTYPE_FILE = join(DIR, 'chronotype.json');
const LONGEVITY_FILE = join(DIR, 'longevity.json');
const FEEDBACK_FILE = join(DIR, 'feedback.json');
const TASTE_FILE = join(DIR, 'taste-profile.json');
// Observed-behavior evidence records (Phase 7, #2156) — supplement, never
// overwrite, the questionnaire/genome twin. Regenerated on each aggregation, so
// they federate LWW on `derivedAt` (newest observation wins wholesale — a
// per-key union would splice one machine's top-artists into another's).
const TASTE_OBSERVED_FILE = join(DIR, 'taste-observed.json');
const CHRONOTYPE_OBSERVED_FILE = join(DIR, 'chronotype-observed.json');
const META_FILE = join(DIR, 'meta.json');
const AUTOBIO_DIR = join(DIR, 'autobiography');
const AUTOBIO_STORIES_FILE = join(AUTOBIO_DIR, 'stories.json');
const SOCIAL_ACCOUNTS_FILE = join(DIR, 'social-accounts.json');

// Paths whose fingerprints feed the dataSync checksum cache. The whole
// digital-twin dir is watched (two levels deep — covers top-level files, the
// .md documents, and autobiography/*) so any edit invalidates the snapshot.
// goals.json also lives here under its own `goals` category — re-checksumming
// on a goals edit is harmless over-invalidation (the snapshot omits goals, so
// the checksum is unchanged and the orchestrator still skips the transfer).
export const DIGITAL_TWIN_CHECKSUM_PATHS = [DIR];

function computeChecksum(data) {
  return crypto.createHash('md5').update(JSON.stringify(data)).digest('hex');
}

// --- Pure merge helpers (exported for unit tests) ---

/** LWW for single objects — remote wins when its timestamp is strictly newer. */
export function mergeObjectLWW(local, remote, timestampField = 'updatedAt') {
  if (!isPlainObject(remote)) return { merged: local, changed: false };
  if (!isPlainObject(local)) return { merged: remote, changed: true };
  const localTs = local[timestampField] || '';
  const remoteTs = remote[timestampField] || '';
  if (remoteTs > localTs) return { merged: remote, changed: true };
  return { merged: local, changed: false };
}

/**
 * Deep union for derived files (chronotype, longevity) where timestamps are
 * regenerated on every derivation: union nested marker objects (local wins
 * per-key), take remote for locally-missing/default scalars, newer timestamp.
 */
export function mergeDeepUnion(local, remote, timestampField = 'derivedAt') {
  if (!isPlainObject(remote)) return { merged: local, changed: false };
  if (!isPlainObject(local)) return { merged: remote, changed: true };

  const merged = { ...local };
  let changed = false;

  for (const [key, remoteVal] of Object.entries(remote)) {
    if (key === timestampField) continue;
    const localVal = local[key];

    if (isPlainObject(remoteVal) && isPlainObject(localVal)) {
      const mergedObj = { ...localVal };
      for (const [k, v] of Object.entries(remoteVal)) {
        if (!(k in mergedObj)) { mergedObj[k] = v; changed = true; }
      }
      merged[key] = mergedObj;
      continue;
    }
    if (localVal === undefined || localVal === null) {
      merged[key] = remoteVal; changed = true; continue;
    }
    if (localVal === 0 && remoteVal !== 0) { merged[key] = remoteVal; changed = true; }
  }

  const localTs = local[timestampField] || '';
  const remoteTs = remote[timestampField] || '';
  merged[timestampField] = remoteTs > localTs ? remoteTs : localTs;
  return { merged, changed };
}

// Resolve the dedupe key for one record. A record that carries no usable value
// under `keyField` must NOT fall through to a shared `undefined` Map key —
// every such record would collide, collapsing the whole array down to one
// survivor and silently destroying history on the next sync. That is exactly
// what #3529 did: the four digital-twin test histories were unioned on 'id'
// while the schema stores 'runId', so a single peer merge wiped every run but
// the last. Unkeyed records fall back to a canonical content signature instead
// — they survive the merge, and re-syncing the same record stays idempotent.
function unionKeyFor(item, keyField) {
  const key = item[keyField];
  if (typeof key === 'string' && key !== '') return key;
  if (typeof key === 'number' && Number.isFinite(key)) return key;
  return `\u0000sig:${canonicalStringify(item)}`;
}

/**
 * Union two arrays of records by a key field. Records unique to either side are
 * kept; on a key collision the local record is kept (ADD-ONLY) unless a
 * timestampField is given and remote's is strictly newer (LWW). Records missing
 * the key field are deduped by content signature rather than collapsing.
 */
export function unionByKey(localArr, remoteArr, keyField, timestampField = null) {
  const local = Array.isArray(localArr) ? localArr : [];
  const remote = Array.isArray(remoteArr) ? remoteArr : [];
  const map = new Map();
  for (const item of local) if (isPlainObject(item)) map.set(unionKeyFor(item, keyField), item);
  let changed = false;
  for (const item of remote) {
    if (!isPlainObject(item)) continue;
    const key = unionKeyFor(item, keyField);
    const existing = map.get(key);
    if (!existing) { map.set(key, item); changed = true; continue; }
    if (timestampField) {
      const lt = existing[timestampField] || '';
      const rt = item[timestampField] || '';
      if (rt > lt) { map.set(key, item); changed = true; }
    }
  }
  return { merged: Array.from(map.values()), changed };
}

// True when an observed-taste record actually rolled up media (either window
// signal). The observed evidence is per-machine, so a machine with no media
// sources produces an empty rollup — and an empty rollup with a newer derivedAt
// must NOT clobber a peer's populated one under plain LWW (#2156 HIGH).
function tasteObservedHasSignal(rec) {
  const m = isPlainObject(rec) ? rec.windows?.month : null;
  return Boolean((m?.listen?.total || 0) > 0 || (m?.watch?.total || 0) > 0);
}

// True when an observed-chronotype record captured any activity.
function chronotypeObservedHasSignal(rec) {
  return isPlainObject(rec) && (rec.sampleSize || 0) > 0;
}

// LWW on `timestampField`, EXCEPT a record with signal always beats an empty
// one regardless of recency — so an idle/fresh peer's empty rollup can't
// overwrite a populated record. When both sides have signal (or both are
// empty) it degrades to plain LWW.
function signalAwareLWW(local, remote, hasSignal, timestampField) {
  if (isPlainObject(remote) && hasSignal(remote) && !hasSignal(local)) return { merged: remote, changed: true };
  if (isPlainObject(local) && hasSignal(local) && !hasSignal(remote)) return { merged: local, changed: false };
  return mergeObjectLWW(local, remote, timestampField);
}

/**
 * Merge observed taste evidence (#2156). The rollup BODY is signal-aware LWW on
 * `derivedAt` (newest observation wins, but a populated record always beats an
 * empty one — see signalAwareLWW), and the AI `interpretation` block is the one
 * piece of EXPLICIT user-triggered content on the record, preserved separately:
 * whichever side carries the newest interpretation (by its own `generatedAt`)
 * is kept regardless of which body won. Without that, an unattended LLM-free
 * recompute on another peer (newer `derivedAt`, no interpretation) would
 * silently drop the user's interpretation cross-machine.
 */
export function mergeTasteObserved(local, remote) {
  const { merged, changed } = signalAwareLWW(local, remote, tasteObservedHasSignal, 'derivedAt');
  const li = isPlainObject(local) && isPlainObject(local.interpretation) ? local.interpretation : null;
  const ri = isPlainObject(remote) && isPlainObject(remote.interpretation) ? remote.interpretation : null;
  const newest = (ri?.generatedAt || '') > (li?.generatedAt || '') ? ri : li;
  if (!newest) return { merged, changed };
  const surviving = isPlainObject(merged) ? merged.interpretation : null;
  if (surviving === newest) return { merged, changed };
  // Only overlay when the newest interpretation is strictly newer than whatever
  // survived on the winning body (or the body has none).
  if ((surviving?.generatedAt || '') >= newest.generatedAt) return { merged, changed };
  return { merged: { ...merged, interpretation: newest }, changed: true };
}

/**
 * Merge observed chronotype evidence (#2156): signal-aware LWW on `derivedAt`
 * so an idle peer's empty histogram can't overwrite a populated one.
 */
export function mergeChronotypeObserved(local, remote) {
  return signalAwareLWW(local, remote, chronotypeObservedHasSignal, 'derivedAt');
}

const TASTE_STATUS_RANK = { pending: 0, in_progress: 1, completed: 2 };
function pickStatus(a, b) {
  return (TASTE_STATUS_RANK[b] ?? -1) > (TASTE_STATUS_RANK[a] ?? -1) ? b : a;
}

/**
 * Merge taste profiles. Within each section, responses union by questionId
 * (LWW on updatedAt||answeredAt) so answers given on either machine survive;
 * section status takes the more-complete value; a missing local summary is
 * filled from remote. Top-level profileSummary/lastSessionAt are LWW on the
 * file's updatedAt.
 */
export function mergeTaste(local, remote) {
  if (!isPlainObject(remote)) return { merged: local, changed: false };
  if (!isPlainObject(local)) return { merged: remote, changed: true };

  let changed = false;
  const sections = { ...(isPlainObject(local.sections) ? local.sections : {}) };

  for (const [secId, remoteSec] of Object.entries(isPlainObject(remote.sections) ? remote.sections : {})) {
    if (!isPlainObject(remoteSec)) continue;
    const localSec = sections[secId];
    if (!isPlainObject(localSec)) { sections[secId] = remoteSec; changed = true; continue; }

    // Responses union by questionId, LWW on updatedAt||answeredAt — so an answer
    // given on either machine survives (taste responses carry no single
    // timestamp field, so resolve the tiebreak explicitly rather than via
    // unionByKey).
    const byId = new Map((Array.isArray(localSec.responses) ? localSec.responses : []).map((r) => [r.questionId, r]));
    let secChanged = false;
    for (const rr of Array.isArray(remoteSec.responses) ? remoteSec.responses : []) {
      if (!isPlainObject(rr)) continue;
      const lr = byId.get(rr.questionId);
      if (!lr) { byId.set(rr.questionId, rr); secChanged = true; continue; }
      const lt = lr.updatedAt || lr.answeredAt || '';
      const rt = rr.updatedAt || rr.answeredAt || '';
      if (rt > lt) { byId.set(rr.questionId, rr); secChanged = true; }
    }
    // Sort by questionId for a stable on-disk order — this file feeds the
    // snapshot checksum, and union-by-Map order would otherwise diverge between
    // peers and prevent convergence. (Display filters by questionId, not order.)
    const mergedResponses = Array.from(byId.values())
      .sort((a, b) => (a.questionId < b.questionId ? -1 : a.questionId > b.questionId ? 1 : 0));

    const status = pickStatus(localSec.status, remoteSec.status);
    const summary = localSec.summary ?? remoteSec.summary ?? null;
    if (secChanged || status !== localSec.status || summary !== localSec.summary) {
      sections[secId] = { ...localSec, responses: mergedResponses, status, summary };
      changed = true;
    }
  }

  const merged = { ...local, sections };
  const localTs = local.updatedAt || '';
  const remoteTs = remote.updatedAt || '';
  if (remoteTs > localTs) {
    if (remote.profileSummary != null && remote.profileSummary !== local.profileSummary) {
      merged.profileSummary = remote.profileSummary; changed = true;
    }
    if ((remote.lastSessionAt || '') > (local.lastSessionAt || '')) {
      merged.lastSessionAt = remote.lastSessionAt; changed = true;
    }
    merged.updatedAt = remote.updatedAt;
  }
  return { merged, changed };
}

function mergeEnrichment(local, remote) {
  const l = isPlainObject(local) ? local : {};
  const r = isPlainObject(remote) ? remote : {};
  const completedCategories = [...new Set([
    ...(Array.isArray(l.completedCategories) ? l.completedCategories : []),
    ...(Array.isArray(r.completedCategories) ? r.completedCategories : []),
  ])];
  const lastSession = (r.lastSession || '') > (l.lastSession || '') ? r.lastSession : (l.lastSession ?? null);
  const questionsAnswered = { ...(isPlainObject(l.questionsAnswered) ? l.questionsAnswered : {}) };
  for (const [k, v] of Object.entries(isPlainObject(r.questionsAnswered) ? r.questionsAnswered : {})) {
    questionsAnswered[k] = Math.max(questionsAnswered[k] || 0, v || 0);
  }
  const merged = { ...l, completedCategories, lastSession };
  if (Object.keys(questionsAnswered).length) merged.questionsAnswered = questionsAnswered;
  return { merged, changed: JSON.stringify(merged) !== JSON.stringify(l) };
}

/**
 * Merge the analyzed personality-trait confidence block (meta.confidence). The
 * per-dimension scores accumulate monotonically as enrichment answers are
 * processed on a machine (digital-twin-enrichment.js boosts then clamps to 1),
 * so the union that loses no analysis is max-per-dimension — mirroring how
 * mergeEnrichment maxes questionsAnswered. `overall` is recomputed as the mean
 * of the merged dimensions (matching the enrichment formula), `lastCalculated`
 * takes the newer stamp, and `gaps` are carried from the more-recently-calculated
 * side (advisory only — a local enrichment answer regenerates them). Key-presence
 * guarded: a peer that sends no confidence can't blank the local analysis.
 */
export function mergeConfidence(local, remote) {
  if (!isPlainObject(remote)) return { merged: local, changed: false };
  if (!isPlainObject(local)) return { merged: remote, changed: true };

  const lDims = isPlainObject(local.dimensions) ? local.dimensions : {};
  const rDims = isPlainObject(remote.dimensions) ? remote.dimensions : {};
  const dimensions = { ...lDims };
  let changed = false;
  for (const [k, rv] of Object.entries(rDims)) {
    if (typeof rv !== 'number') continue;
    const lv = typeof dimensions[k] === 'number' ? dimensions[k] : -Infinity;
    if (rv > lv) { dimensions[k] = rv; changed = true; }
  }

  const dimValues = Object.values(dimensions).filter((v) => typeof v === 'number');
  const overall = dimValues.length
    ? Math.round((dimValues.reduce((a, b) => a + b, 0) / dimValues.length) * 100) / 100
    : 0;

  const localStamp = local.lastCalculated || '';
  const remoteStamp = remote.lastCalculated || '';
  const remoteNewer = remoteStamp > localStamp;
  const gaps = remoteNewer && Array.isArray(remote.gaps) ? remote.gaps
    : Array.isArray(local.gaps) ? local.gaps : [];
  const lastCalculated = remoteNewer ? remoteStamp : localStamp;

  const merged = { ...local, dimensions, overall, gaps, lastCalculated };
  // gaps are derived from dimensions, so the dimension/overall/stamp checks
  // already cover any real change — no separate gaps comparison needed.
  if (!changed) {
    changed = overall !== local.overall || lastCalculated !== (local.lastCalculated || '');
  }
  return { merged, changed };
}

// The four digital-twin evaluation-run histories on meta.json. Each entry is
// identified by `runId` — NOT `id`.
export const TEST_HISTORY_KEYS = ['testHistory', 'valuesTestHistory', 'adversarialTestHistory', 'multiTurnTestHistory'];

// The run recorders (digital-twin-*-testing.js) `unshift` each new run and then
// `slice(0, 50)`, so these arrays are newest-first and the readers' `slice(0,
// limit)` means "most recent N". A union appends the peer's runs at the END, so
// without re-sorting a freshly-synced peer run would read as the oldest — and
// the next local run's slice(0, 50) would discard the newest entries instead of
// the oldest. Sort descending on the ISO `timestamp` to restore the invariant;
// entries with no timestamp sort last rather than jumping to the front. `runId`
// breaks ties so both peers land on the SAME order for the same set of runs
// (each merges its own side first, so insertion order alone would diverge).
function sortRunsNewestFirst(runs) {
  const at = (r) => (typeof r?.timestamp === 'string' ? r.timestamp : '');
  const id = (r) => (typeof r?.runId === 'string' ? r.runId : '');
  return [...runs].sort((a, b) => {
    if (at(a) !== at(b)) return at(a) > at(b) ? -1 : 1;
    if (id(a) === id(b)) return 0;
    return id(a) < id(b) ? -1 : 1;
  });
}

// The tombstone list on meta.json, keyed on document filename (see
// deletedDocumentSchema — document ids are minted per-install, so they can't key
// a cross-machine merge).
const DOC_TOMBSTONE_OPTS = { keyField: 'filename' };

/** The newer of two timestamp strings; either may be absent/unparseable. */
function newerStamp(candidate, incumbent) {
  return compareNewerWins(candidate, incumbent) ? candidate : incumbent;
}

/**
 * The instant a document was last asserted to EXIST — its creation stamp, or a
 * later edit. A delete only wins over a document older than the delete: an edit
 * made after another machine deleted the document is the user's latest word on
 * the subject, and reaping it would silently destroy that edit.
 */
function documentLiveStamp(doc) {
  return newerStamp(doc?.updatedAt, doc?.createdAt);
}

/**
 * Merge the document list against both sides' delete tombstones (#3530).
 *
 * The document union is still ADD-ONLY — a local entry's title/priority/weight
 * is never replaced — but the tombstone lists union in BOTH directions first,
 * and any document a surviving tombstone covers is then dropped. That makes a
 * delete performed on either machine converge: the deleting side stops
 * resurrecting the entry, and the side that still has the document removes it.
 *
 * A document whose own live stamp is strictly newer than the tombstone
 * supersedes it (re-created, or edited after the delete), and the now-obsolete
 * tombstone is pruned so it can't bounce back from a peer that hasn't seen that
 * yet. The two stamps themselves are the one part of a document entry that is
 * NOT add-only: each takes the newer of the two sides, so the knowledge that a
 * document was re-created (or edited) propagates to every peer. Without that, a
 * machine holding a stale entry would keep an older stamp and a third peer's
 * still-live tombstone would reap the document there.
 *
 * Returns the surviving documents plus the merged tombstone list.
 */
export function mergeDocumentsWithTombstones(local, remote) {
  const { merged: tombstonesUnion } = mergeTombstones(local?.deletedDocuments, remote?.deletedDocuments, DOC_TOMBSTONE_OPTS);

  const remoteStamps = new Map();
  for (const doc of Array.isArray(remote?.documents) ? remote.documents : []) {
    if (!isPlainObject(doc) || typeof doc.filename !== 'string') continue;
    const prev = remoteStamps.get(doc.filename);
    remoteStamps.set(doc.filename, {
      createdAt: newerStamp(doc.createdAt, prev?.createdAt),
      updatedAt: newerStamp(doc.updatedAt, prev?.updatedAt),
    });
  }

  const { merged: unioned } = unionByKey(local?.documents, remote?.documents, 'filename');
  const documents = unioned
    .map((doc) => {
      const peer = remoteStamps.get(doc.filename);
      if (!peer) return doc;
      const createdAt = newerStamp(peer.createdAt, doc.createdAt);
      const updatedAt = newerStamp(peer.updatedAt, doc.updatedAt);
      if (createdAt === doc.createdAt && updatedAt === doc.updatedAt) return doc;
      return { ...doc, ...(createdAt ? { createdAt } : {}), ...(updatedAt ? { updatedAt } : {}) };
    })
    .filter((doc) => !isTombstoned(tombstonesUnion, doc.filename, documentLiveStamp(doc), 'filename'));

  // Prune against the same live stamp the filter used, or a document kept alive
  // by an edit would leave its tombstone behind to retry on every cycle.
  const survivorStamps = documents.map((doc) => ({ filename: doc.filename, createdAt: documentLiveStamp(doc) }));
  const deletedDocuments = pruneTombstones(tombstonesUnion, survivorStamps, { ...DOC_TOMBSTONE_OPTS, timestampField: 'createdAt' });
  return { documents, deletedDocuments };
}

// The persona tombstone list on meta.json, keyed on the persona `id` (see
// deletedPersonaSchema). Unlike a document id, a persona id is minted once by
// the machine that created the persona and then travels with the record, so it
// means the same thing on every peer.
const PERSONA_TOMBSTONE_OPTS = { keyField: 'id' };

/**
 * The instant a persona was last asserted to EXIST — its creation stamp, or a
 * later edit. Mirrors the document rule: a delete only wins over a persona older
 * than the delete, so an edit made after another machine deleted the persona is
 * the user's latest word and is not silently destroyed.
 */
function personaLiveStamp(persona) {
  return newerStamp(persona?.updatedAt, persona?.createdAt);
}

/**
 * Merge the persona list against both sides' delete tombstones (#3533).
 *
 * Personas are the same add-only-union shape documents were before #3530: the
 * machine that still had the record simply re-added it, so a deleted persona
 * came back on the next cycle, forever. The tombstone lists union in BOTH
 * directions and any persona a surviving tombstone covers is dropped, so a
 * delete performed on either machine converges. A persona lives entirely inside
 * meta.json, so there is no on-disk companion to reap — unlike documents, the
 * merge alone completes the delete.
 *
 * The union takes the more recently edited copy (LWW on `updatedAt`) rather than
 * always keeping the local one. Persona ids are stable across peers and every
 * persona carries a mandatory `updatedAt` (see personaSchema), so LWW is
 * well-defined here — and it is what keeps supersession honest: a persona edited
 * on one machine after another deleted it must carry that newer stamp to every
 * peer, or a third machine holding a stale copy would still reap it against the
 * older tombstone and the two would never converge.
 *
 * Returns the surviving personas plus the merged tombstone list.
 */
export function mergePersonasWithTombstones(local, remote) {
  const { merged: tombstonesUnion } = mergeTombstones(local?.deletedPersonas, remote?.deletedPersonas, PERSONA_TOMBSTONE_OPTS);
  const { merged: unioned } = unionByKey(local?.personas, remote?.personas, 'id', 'updatedAt');
  const personas = unioned.filter((p) => !isTombstoned(tombstonesUnion, p.id, personaLiveStamp(p), 'id'));

  // Prune against the same live stamp the filter used, or a persona kept alive
  // by an edit would leave its tombstone behind to retry on every cycle.
  const survivorStamps = personas.map((p) => ({ id: p.id, createdAt: personaLiveStamp(p) }));
  const deletedPersonas = pruneTombstones(tombstonesUnion, survivorStamps, { ...PERSONA_TOMBSTONE_OPTS, timestampField: 'createdAt' });
  return { personas, deletedPersonas };
}

/**
 * Merge digital-twin meta.json: documents union by filename (ADD-ONLY — a local
 * doc entry is never replaced) minus anything either side has tombstoned in
 * `deletedDocuments`, the four test histories union by runId, personas union by
 * id (LWW) minus anything tombstoned in `deletedPersonas`, enrichment
 * deep-unions, settings fill missing keys (local values win), and the analyzed
 * personality-trait confidence max-per-dimension.
 */
export function mergeMeta(local, remote) {
  if (!isPlainObject(remote)) return { merged: local, changed: false };
  if (!isPlainObject(local)) return { merged: remote, changed: true };

  let changed = false;
  const merged = { ...local };

  const { documents, deletedDocuments } = mergeDocumentsWithTombstones(local, remote);
  const localDocs = Array.isArray(local.documents) ? local.documents : [];
  // unionByKey preserves the local record objects, so identity comparison is
  // enough to tell whether anything was added, replaced, or reaped.
  if (documents.length !== localDocs.length || documents.some((d, i) => d !== localDocs[i])) {
    merged.documents = documents; changed = true;
  }
  if (!tombstonesEqual(deletedDocuments, normalizeTombstones(local.deletedDocuments, 'filename'), 'filename')) {
    merged.deletedDocuments = deletedDocuments; changed = true;
  }

  // Test-history entries identify a run by `runId` (see digitalTwinValidation.js)
  // — they carry no `id`. Unioning them on 'id' collapsed every history to a
  // single entry on the first peer merge (#3529).
  for (const key of TEST_HISTORY_KEYS) {
    const u = unionByKey(local[key], remote[key], 'runId');
    if (u.changed) { merged[key] = sortRunsNewestFirst(u.merged); changed = true; }
  }

  const { personas, deletedPersonas } = mergePersonasWithTombstones(local, remote);
  const localPersonas = Array.isArray(local.personas) ? local.personas : [];
  // The union preserves the local record objects it kept, so identity
  // comparison is enough to tell whether anything was added, replaced, or reaped.
  if (personas.length !== localPersonas.length || personas.some((p, i) => p !== localPersonas[i])) {
    merged.personas = personas; changed = true;
  }
  if (!tombstonesEqual(deletedPersonas, normalizeTombstones(local.deletedPersonas, 'id'), 'id')) {
    merged.deletedPersonas = deletedPersonas; changed = true;
  }

  if (isPlainObject(remote.enrichment)) {
    const e = mergeEnrichment(local.enrichment, remote.enrichment);
    if (e.changed) { merged.enrichment = e.merged; changed = true; }
  }

  if (isPlainObject(remote.settings)) {
    const settings = { ...remote.settings, ...(isPlainObject(local.settings) ? local.settings : {}) };
    if (JSON.stringify(settings) !== JSON.stringify(local.settings || {})) {
      merged.settings = settings; changed = true;
    }
  }

  if (isPlainObject(remote.confidence)) {
    const c = mergeConfidence(local.confidence, remote.confidence);
    if (c.changed) { merged.confidence = c.merged; changed = true; }
  }

  // A persona another machine deleted is reaped above, which can leave
  // `settings.activePersonaId` pointing at an id that is no longer in the list
  // (deletePersona clears it for a LOCAL delete; this is the remote half).
  // Cleared rather than left dangling so the embodied twin falls back to the
  // base twin instead of silently resolving to nothing (#3533).
  const settings = isPlainObject(merged.settings) ? merged.settings : local.settings;
  const activePersonaId = isPlainObject(settings) ? settings.activePersonaId : null;
  const survivingPersonas = merged.personas ?? localPersonas;
  if (activePersonaId && !survivingPersonas.some((p) => p?.id === activePersonaId)) {
    merged.settings = { ...settings, activePersonaId: null };
    changed = true;
  }

  return { merged, changed };
}

// Social-account tombstones (#3532) key on the account id, NOT a platform/handle
// natural key: the id is minted once by whichever machine created the account
// and then travels verbatim as the `accounts` map key, so every peer agrees on
// it — and re-adding the same handle after a delete mints a FRESH id, which a
// natural key would wrongly suppress.
const ACCOUNT_TOMBSTONE_OPTS = { keyField: 'id' };

/**
 * The instant an account was last asserted to EXIST — its creation stamp, or a
 * later edit. A delete only wins over an account older than the delete: an edit
 * made after another machine deleted it is the user's latest word (#3532).
 */
function accountLiveStamp(account) {
  return newerStamp(account?.updatedAt, account?.createdAt);
}

/**
 * Merge the user's own social accounts (social-accounts.json: `{ accounts: { id:
 * {...} }, deletedAccounts: [{ id, deletedAt }] }`). Accounts union by id, LWW on
 * updatedAt — an account added on either machine survives, and the
 * more-recently-edited copy wins a collision.
 * Key-presence guarded: a peer that sends no socialAccounts can't blank local.
 *
 * DELETES ride the `deletedAccounts` tombstone list (#3532), which unions in
 * BOTH directions before the account union is filtered — so a delete performed
 * on either machine converges: the deleting side stops resurrecting the account,
 * and the side that still has it drops it. An account whose own live stamp is
 * strictly newer than the tombstone supersedes it, and that now-obsolete
 * tombstone is pruned so it can't bounce back from a peer that hasn't caught up.
 */
export function mergeSocialAccounts(local, remote) {
  if (!isPlainObject(remote)) return { merged: local, changed: false };
  if (!isPlainObject(local)) return { merged: remote, changed: true };

  const lAcc = isPlainObject(local.accounts) ? local.accounts : {};
  const rAcc = isPlainObject(remote.accounts) ? remote.accounts : {};
  const { merged: tombstones } = mergeTombstones(local.deletedAccounts, remote.deletedAccounts, ACCOUNT_TOMBSTONE_OPTS);

  const accounts = { ...lAcc };
  for (const [id, rv] of Object.entries(rAcc)) {
    if (!isPlainObject(rv)) continue;
    const lv = accounts[id];
    if (!isPlainObject(lv)) { accounts[id] = rv; continue; }
    if ((rv.updatedAt || '') > (lv.updatedAt || '')) accounts[id] = rv;
  }
  for (const [id, account] of Object.entries(accounts)) {
    if (isTombstoned(tombstones, id, accountLiveStamp(account), 'id')) delete accounts[id];
  }

  // Prune against the same live stamp the filter used, or an account kept alive
  // by an edit would leave its tombstone behind to retry on every cycle.
  const survivors = Object.entries(accounts).map(([id, account]) => ({ id, createdAt: accountLiveStamp(account) }));
  const deletedAccounts = pruneTombstones(tombstones, survivors, { ...ACCOUNT_TOMBSTONE_OPTS, timestampField: 'createdAt' });

  // The account map is rebuilt from the two sides' own objects, so identity
  // comparison catches an add, a replacement, AND a reap.
  const localIds = Object.keys(lAcc);
  const changed = localIds.length !== Object.keys(accounts).length
    || localIds.some((id) => lAcc[id] !== accounts[id])
    || !tombstonesEqual(deletedAccounts, normalizeTombstones(local.deletedAccounts, 'id'), 'id');
  return { merged: { ...local, accounts, deletedAccounts }, changed };
}

// Autobiography story tombstones key on the story `id` (#3531). Unlike the
// per-install document ids of #3530, a story id is minted ONCE by
// `autobiography.saveStory` and travels with the record through sync — every
// peer holds the same logical story under the same id, which is also what this
// merge already unions on.
const STORY_TOMBSTONE_OPTS = { keyField: 'id' };

/** The instant a story was last asserted to EXIST — creation, or a later edit. */
function storyLiveStamp(story) {
  return newerStamp(story?.updatedAt, story?.createdAt);
}

/**
 * Merge autobiography stories: union by id (LWW on updatedAt||createdAt), union
 * usedPrompts, minus anything either side tombstoned in `deletedStories`. Both
 * outputs are sorted by a stable key — this file feeds the snapshot checksum
 * (via JSON.stringify), and union-by-Map preserves insertion order, so without a
 * stable sort two peers with identical stories would emit different array orders
 * → different checksums → never converge. (getStories re-sorts by createdAt for
 * display, so the on-disk order is presentation-free.)
 *
 * DELETES need the tombstone because the story union is add-only: the deleting
 * machine would otherwise re-import the story from any peer that still has it.
 * `deletedStories` unions in BOTH directions, so the delete also propagates to
 * that peer. A story whose own live stamp is strictly newer than the tombstone
 * supersedes it — an edit made after another machine deleted the story is the
 * user's latest word — and the now-obsolete tombstone is pruned so it can't
 * bounce back from a peer that has not seen the edit yet.
 */
export function mergeAutobiographyStories(local, remote) {
  if (!isPlainObject(remote)) return { merged: local, changed: false };
  if (!isPlainObject(local)) return { merged: remote, changed: true };

  const { merged: tombstonesUnion } = mergeTombstones(local.deletedStories, remote.deletedStories, STORY_TOMBSTONE_OPTS);

  const byId = new Map((Array.isArray(local.stories) ? local.stories : []).map((s) => [s.id, s]));
  for (const rs of Array.isArray(remote.stories) ? remote.stories : []) {
    // A peer story without a usable id would key the map on `undefined`, so a
    // second malformed one silently overwrites the first and neither can ever be
    // tombstoned (the tombstone key would be `undefined` too). Drop them.
    if (!isPlainObject(rs) || typeof rs.id !== 'string' || rs.id === '') continue;
    const ls = byId.get(rs.id);
    if (!ls) { byId.set(rs.id, rs); continue; }
    const lt = ls.updatedAt || ls.createdAt || '';
    const rt = rs.updatedAt || rs.createdAt || '';
    if (rt > lt) byId.set(rs.id, rs);
  }

  const stories = Array.from(byId.values())
    .filter((s) => !isTombstoned(tombstonesUnion, s.id, storyLiveStamp(s), 'id'))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const localUsed = Array.isArray(local.usedPrompts) ? local.usedPrompts : [];
  const usedPrompts = [...new Set([...localUsed, ...(Array.isArray(remote.usedPrompts) ? remote.usedPrompts : [])])].sort();
  // Compare CONTENT, not just length: saveStory appends prompt ids in write
  // order, so a local list that is merely unsorted has the same length as the
  // sorted union and would never be written back — leaving two peers with the
  // same prompts emitting different JSON, different checksums, and a sync that
  // retries forever (the same convergence trap the story sort above avoids).
  let changed = usedPrompts.length !== localUsed.length || usedPrompts.some((p, i) => p !== localUsed[i]);

  // Prune against the same live stamp the filter used, or a story kept alive by
  // an edit would leave its tombstone behind to retry on every cycle.
  const survivorStamps = stories.map((s) => ({ id: s.id, createdAt: storyLiveStamp(s) }));
  const deletedStories = pruneTombstones(tombstonesUnion, survivorStamps, { ...STORY_TOMBSTONE_OPTS, timestampField: 'createdAt' });
  if (!tombstonesEqual(deletedStories, normalizeTombstones(local.deletedStories, 'id'), 'id')) changed = true;

  // The union preserves the local story objects, so identity comparison tells
  // whether anything was added, replaced, reaped, or reordered. Comparing the
  // survivors (rather than flagging inside the union loop) keeps a remote story
  // this machine already tombstoned from forcing a no-op write every cycle.
  const localStories = Array.isArray(local.stories) ? local.stories : [];
  if (stories.length !== localStories.length || stories.some((s, i) => s !== localStories[i])) changed = true;

  return { merged: { ...local, stories, usedPrompts, deletedStories }, changed };
}

// Sanitize a peer-supplied document name down to a safe `*.md` basename so a
// malformed/buggy payload can't write outside the digital-twin dir.
export function safeMdName(name) {
  if (typeof name !== 'string') return null;
  const base = basename(name);
  if (base !== name) return null;
  if (!base.toLowerCase().endsWith('.md')) return null;
  if (base.startsWith('.')) return null;
  return base;
}

// --- Snapshot ---

async function readMarkdownDocuments() {
  const files = await readdir(DIR).catch(() => []);
  const reads = await Promise.all(
    files.filter((f) => safeMdName(f)).map((name) =>
      readFile(join(DIR, name), 'utf-8').then((content) => [name, content], () => [name, null])
    )
  );
  // Sort by filename before building the map: readdir() order is
  // filesystem-dependent, and the documents object's key insertion order feeds
  // the snapshot checksum via JSON.stringify — without a stable order two peers
  // with identical documents compute different checksums and never converge.
  reads.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const out = {};
  for (const [name, content] of reads) if (typeof content === 'string') out[name] = content;
  return out;
}

export async function getDigitalTwinSnapshot() {
  // The reads are independent — run them concurrently. The snapshot is
  // re-materialized whenever the dir fingerprint changes (every sync cycle on a
  // checksum-cache miss), so the parallelism is worth it.
  // autobiography/config.json (the prompt schedule: enabled, intervalHours,
  // lastPromptAt) is deliberately NOT in the snapshot — it is machine-local
  // scheduling state, and a fresh peer must not inherit another machine's
  // cadence or have prompts enabled without local opt-in. Only the stories sync.
  const [identity, chronotype, longevity, feedback, taste, tasteObserved, chronotypeObserved, meta, documents, stories, socialAccounts] =
    await Promise.all([
      readJSONFile(IDENTITY_FILE, null),
      readJSONFile(CHRONOTYPE_FILE, null),
      readJSONFile(LONGEVITY_FILE, null),
      readJSONFile(FEEDBACK_FILE, null),
      readJSONFile(TASTE_FILE, null),
      readJSONFile(TASTE_OBSERVED_FILE, null),
      readJSONFile(CHRONOTYPE_OBSERVED_FILE, null),
      readJSONFile(META_FILE, null),
      readMarkdownDocuments(),
      readJSONFile(AUTOBIO_STORIES_FILE, null),
      readJSONFile(SOCIAL_ACCOUNTS_FILE, null),
    ]);
  const data = { identity, chronotype, longevity, feedback, taste, tasteObserved, chronotypeObserved, meta, documents, autobiography: { stories }, socialAccounts };
  return { data, checksum: computeChecksum(data) };
}

// --- Apply ---

async function applyMerge(path, remote, mergeFn, { dir } = {}) {
  if (remote === undefined || remote === null) return 0;
  const local = await readJSONFile(path, null);
  const { merged, changed } = mergeFn(local, remote);
  if (!changed) return 0;
  if (dir) await ensureDir(dir);
  await atomicWrite(path, merged);
  return 1;
}

/**
 * The set of document filenames a delete tombstone currently suppresses (#3530).
 *
 * Read straight off META_FILE rather than through `loadMeta()`: loadMeta's
 * missing-file path REBUILDS meta from a disk scan and saves it, which is
 * exactly the side effect the meta-before-documents ordering below exists to
 * avoid. applyMeta has already written the merged tombstones, so the file is
 * current.
 *
 * A filename that survived the merge as a live document entry is never
 * suppressed — that is the re-created-after-delete case, where the document's
 * `createdAt` superseded the tombstone.
 */
async function readSuppressedDocuments() {
  const meta = await readJSONFile(META_FILE, null);
  if (!isPlainObject(meta)) return new Set();
  const live = new Set(
    (Array.isArray(meta.documents) ? meta.documents : [])
      .filter(isPlainObject)
      .map((d) => d.filename)
  );
  return new Set(
    normalizeTombstones(meta.deletedDocuments, 'filename')
      .map((t) => t.filename)
      .filter((name) => !live.has(name))
  );
}

// Remove local .md files for documents that are tombstoned. This is what makes a
// delete PROPAGATE: mergeMeta drops the metadata entry on the receiving peer,
// and this removes the file the entry pointed at. Without it the receiver would
// keep serving the file and re-ship it in its own snapshot forever (#3530).
async function reapTombstonedDocuments(suppressed) {
  let count = 0;
  for (const rawName of suppressed) {
    const name = safeMdName(rawName);
    if (!name) continue;
    const filePath = join(DIR, name);
    if (!existsSync(filePath)) continue;
    // A file we can't remove (permissions, or it vanished between the check and
    // the call) must not abort the rest of the sync — report and move on.
    const removed = await unlink(filePath).then(() => true, (err) => {
      console.error(`❌ Digital twin sync: could not remove deleted document ${name}: ${err.message}`);
      return false;
    });
    if (!removed) continue;
    console.log(`🧬 Digital twin sync: removed deleted document ${name}`);
    count++;
  }
  return count;
}

// Documents are written ADD-ONLY: a local .md is never overwritten by a peer's
// copy (we have no per-document timestamp to order edits). New documents the
// receiver is missing are written verbatim — unless the filename is tombstoned,
// in which case the user deleted it and the peer is simply behind. The meta.json
// merge separately brings over each document's metadata entry so the UI lists them.
async function applyDocuments(documents, suppressed) {
  if (!isPlainObject(documents)) return 0;
  let count = 0;
  for (const [rawName, content] of Object.entries(documents)) {
    const name = safeMdName(rawName);
    if (!name || typeof content !== 'string') continue;
    if (suppressed.has(name)) continue;
    const filePath = join(DIR, name);
    if (existsSync(filePath)) continue;
    await ensureDir(DIR);
    await atomicWrite(filePath, content);
    count++;
  }
  return count;
}

// taste-questionnaire and digital-twin-meta keep their own in-memory caches (the
// taste cache has NO TTL), so a raw atomicWrite to their files would leave the UI
// serving pre-sync data. Route those two through the owning services so the
// cache invalidates (taste) and the cache refreshes + `meta:changed` fires
// (meta). Dynamic import keeps those services — and taste's heavy digital-twin.js
// barrel — out of this module's load path (mirrors dataSync's peerSync import).

async function applyTaste(remoteTaste) {
  if (!isPlainObject(remoteTaste)) return 0;
  const local = await readJSONFile(TASTE_FILE, null);
  const { merged, changed } = mergeTaste(local, remoteTaste);
  if (!changed) return 0;
  await atomicWrite(TASTE_FILE, merged);
  const { invalidateTasteProfileCache } = await import('./taste-questionnaire.js');
  invalidateTasteProfileCache();
  return 1;
}

async function applyMeta(remoteMeta) {
  if (!isPlainObject(remoteMeta)) return 0;
  const { loadMeta, saveMeta } = await import('./digital-twin-meta.js');
  const local = await loadMeta();
  const { merged, changed } = mergeMeta(local, remoteMeta);
  if (!changed) return 0;
  await saveMeta(merged); // updates the meta cache + emits `meta:changed`
  return 1;
}

// Route through socialAccounts.js's own load/save (mirrors applyMeta) so the
// service's cache stays fresh — a raw write would leave the UI serving pre-sync
// data until the store's TTL lapses. saveAccounts updates the cache in place;
// notifyChanged emits the change event so the Digital Twin UI updates at once.
async function applySocialAccounts(remoteSocial) {
  if (!isPlainObject(remoteSocial)) return 0;
  const { loadAccounts, saveAccounts, notifyChanged } = await import('./socialAccounts.js');
  const local = await loadAccounts();
  const { merged, changed } = mergeSocialAccounts(local, remoteSocial);
  if (!changed) return 0;
  await saveAccounts(merged);
  notifyChanged('sync');
  return 1;
}

export async function applyDigitalTwinRemote(remoteData) {
  if (!isPlainObject(remoteData)) return { applied: false, count: 0 };

  let count = 0;
  count += await applyMerge(IDENTITY_FILE, remoteData.identity, (l, r) => mergeObjectLWW(l, r, 'updatedAt'));
  count += await applyMerge(CHRONOTYPE_FILE, remoteData.chronotype, (l, r) => mergeDeepUnion(l, r, 'derivedAt'));
  count += await applyMerge(LONGEVITY_FILE, remoteData.longevity, (l, r) => mergeDeepUnion(l, r, 'derivedAt'));
  count += await applyMerge(FEEDBACK_FILE, remoteData.feedback, (l, r) => mergeObjectLWW(l, r, 'updatedAt'));
  count += await applyTaste(remoteData.taste);
  // Observed evidence (Phase 7): regenerated derived records — body is LWW on
  // derivedAt; taste also preserves the newest user-triggered AI interpretation.
  count += await applyMerge(TASTE_OBSERVED_FILE, remoteData.tasteObserved, mergeTasteObserved);
  count += await applyMerge(CHRONOTYPE_OBSERVED_FILE, remoteData.chronotypeObserved, mergeChronotypeObserved);
  // Meta BEFORE documents: applyMeta()'s loadMeta() rebuilds meta from a disk
  // .md scan when no meta.json exists, creating DEFAULT document entries. If the
  // peer's .md files were written first, that rebuild would manufacture default
  // entries and mergeMeta's add-only policy would then keep them, discarding the
  // sender's real document metadata (title/category/priority/weight). Merging
  // meta first preserves the sender's entries; the files are written after.
  count += await applyMeta(remoteData.meta);
  // Delete tombstones (#3530) gate both directions of the document apply: reap
  // local files a peer's delete covers, and skip re-writing anything this
  // machine deleted. Read AFTER applyMeta so the merged tombstone list is on disk.
  const suppressed = await readSuppressedDocuments();
  count += await reapTombstonedDocuments(suppressed);
  count += await applyDocuments(remoteData.documents, suppressed);

  if (isPlainObject(remoteData.autobiography)) {
    // stories only — config (prompt schedule) is intentionally machine-local.
    count += await queueAutobiographyStoriesWrite(() =>
      applyMerge(AUTOBIO_STORIES_FILE, remoteData.autobiography.stories, mergeAutobiographyStories, { dir: AUTOBIO_DIR })
    );
  }

  count += await applySocialAccounts(remoteData.socialAccounts);

  if (count > 0) console.log(`🔄 Digital twin sync: updated ${count} items`);
  return { applied: count > 0, count };
}
