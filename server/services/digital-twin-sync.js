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
 *                            receiver (a local doc is never overwritten)
 *   - autobiography/        — stories union by id (LWW); config (the prompt
 *                            schedule) is NOT synced — it's machine-local
 *   - social-accounts.json  — the user's own social accounts, union by id (LWW)
 *
 * Merge philosophy mirrors the rest of dataSync: union semantics, no data is
 * ever lost, and every field is key-presence guarded so an OLDER peer that only
 * sends the four legacy keys can't blank out taste/documents/autobiography. The
 * snapshot is additive and ignore-if-unknown, so it needs no schemaVersions gate
 * (digitalTwin stays unversioned — see SNAPSHOT_CATEGORY_SCHEMA_KEYS).
 */

import crypto from 'crypto';
import { join, basename } from 'path';
import { readdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { atomicWrite, readJSONFile, ensureDir, PATHS } from '../lib/fileUtils.js';
import { isPlainObject } from '../lib/objects.js';

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

/**
 * Union two arrays of records by a key field. Records unique to either side are
 * kept; on a key collision the local record is kept (ADD-ONLY) unless a
 * timestampField is given and remote's is strictly newer (LWW).
 */
export function unionByKey(localArr, remoteArr, keyField, timestampField = null) {
  const local = Array.isArray(localArr) ? localArr : [];
  const remote = Array.isArray(remoteArr) ? remoteArr : [];
  const map = new Map();
  for (const item of local) if (isPlainObject(item)) map.set(item[keyField], item);
  let changed = false;
  for (const item of remote) {
    if (!isPlainObject(item)) continue;
    const key = item[keyField];
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

/**
 * Merge digital-twin meta.json: documents union by filename (ADD-ONLY — a local
 * doc entry is never replaced), the four test histories + personas union by id,
 * enrichment deep-unions, settings fill missing keys (local values win), and the
 * analyzed personality-trait confidence max-per-dimension.
 */
export function mergeMeta(local, remote) {
  if (!isPlainObject(remote)) return { merged: local, changed: false };
  if (!isPlainObject(local)) return { merged: remote, changed: true };

  let changed = false;
  const merged = { ...local };

  const docs = unionByKey(local.documents, remote.documents, 'filename');
  if (docs.changed) { merged.documents = docs.merged; changed = true; }

  for (const key of ['testHistory', 'valuesTestHistory', 'adversarialTestHistory', 'multiTurnTestHistory']) {
    const u = unionByKey(local[key], remote[key], 'id');
    if (u.changed) { merged[key] = u.merged; changed = true; }
  }

  const personas = unionByKey(local.personas, remote.personas, 'id');
  if (personas.changed) { merged.personas = personas.merged; changed = true; }

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

  return { merged, changed };
}

/**
 * Merge the user's own social accounts (social-accounts.json: `{ accounts: { id:
 * {...} } }`). Accounts union by id, LWW on updatedAt — an account added on
 * either machine survives, and the more-recently-edited copy wins a collision.
 * Key-presence guarded: a peer that sends no socialAccounts can't blank local.
 */
export function mergeSocialAccounts(local, remote) {
  if (!isPlainObject(remote)) return { merged: local, changed: false };
  if (!isPlainObject(local)) return { merged: remote, changed: true };

  const lAcc = isPlainObject(local.accounts) ? local.accounts : {};
  const rAcc = isPlainObject(remote.accounts) ? remote.accounts : {};
  const accounts = { ...lAcc };
  let changed = false;
  for (const [id, rv] of Object.entries(rAcc)) {
    if (!isPlainObject(rv)) continue;
    const lv = accounts[id];
    if (!isPlainObject(lv)) { accounts[id] = rv; changed = true; continue; }
    if ((rv.updatedAt || '') > (lv.updatedAt || '')) { accounts[id] = rv; changed = true; }
  }
  return { merged: { ...local, accounts }, changed };
}

/**
 * Merge autobiography stories: union by id (LWW on updatedAt||createdAt), union
 * usedPrompts. Both outputs are sorted by a stable key — this file feeds the
 * snapshot checksum (via JSON.stringify), and union-by-Map preserves insertion
 * order, so without a stable sort two peers with identical stories would emit
 * different array orders → different checksums → never converge. (getStories
 * re-sorts by createdAt for display, so the on-disk order is presentation-free.)
 */
export function mergeAutobiographyStories(local, remote) {
  if (!isPlainObject(remote)) return { merged: local, changed: false };
  if (!isPlainObject(local)) return { merged: remote, changed: true };

  const byId = new Map((Array.isArray(local.stories) ? local.stories : []).map((s) => [s.id, s]));
  let changed = false;
  for (const rs of Array.isArray(remote.stories) ? remote.stories : []) {
    if (!isPlainObject(rs)) continue;
    const ls = byId.get(rs.id);
    if (!ls) { byId.set(rs.id, rs); changed = true; continue; }
    const lt = ls.updatedAt || ls.createdAt || '';
    const rt = rs.updatedAt || rs.createdAt || '';
    if (rt > lt) { byId.set(rs.id, rs); changed = true; }
  }

  const localUsed = Array.isArray(local.usedPrompts) ? local.usedPrompts : [];
  const usedPrompts = [...new Set([...localUsed, ...(Array.isArray(remote.usedPrompts) ? remote.usedPrompts : [])])].sort();
  if (usedPrompts.length !== localUsed.length) changed = true;

  const stories = Array.from(byId.values()).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { merged: { ...local, stories, usedPrompts }, changed };
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

// Documents are written ADD-ONLY: a local .md is never overwritten by a peer's
// copy (we have no per-document timestamp to order edits). New documents the
// receiver is missing are written verbatim. The meta.json merge separately
// brings over each document's metadata entry so the UI lists them.
async function applyDocuments(documents) {
  if (!isPlainObject(documents)) return 0;
  let count = 0;
  for (const [rawName, content] of Object.entries(documents)) {
    const name = safeMdName(rawName);
    if (!name || typeof content !== 'string') continue;
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
  count += await applyDocuments(remoteData.documents);

  if (isPlainObject(remoteData.autobiography)) {
    // stories only — config (prompt schedule) is intentionally machine-local.
    count += await applyMerge(AUTOBIO_STORIES_FILE, remoteData.autobiography.stories, mergeAutobiographyStories, { dir: AUTOBIO_DIR });
  }

  count += await applySocialAccounts(remoteData.socialAccounts);

  if (count > 0) console.log(`🔄 Digital twin sync: updated ${count} items`);
  return { applied: count > 0, count };
}
