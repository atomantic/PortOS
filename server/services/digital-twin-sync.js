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
 *                            enrichment, fill-missing settings
 *   - *.md documents       — content shipped by filename, ADD-ONLY on the
 *                            receiver (a local doc is never overwritten)
 *   - autobiography/        — stories union by id (LWW), config stays local
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
const META_FILE = join(DIR, 'meta.json');
const AUTOBIO_DIR = join(DIR, 'autobiography');
const AUTOBIO_STORIES_FILE = join(AUTOBIO_DIR, 'stories.json');
const AUTOBIO_CONFIG_FILE = join(AUTOBIO_DIR, 'config.json');

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
    const mergedResponses = Array.from(byId.values());

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
 * Merge digital-twin meta.json: documents union by filename (ADD-ONLY — a local
 * doc entry is never replaced), the four test histories + personas union by id,
 * enrichment deep-unions, settings fill missing keys (local values win).
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

  return { merged, changed };
}

/** Merge autobiography stories: union by id (LWW on updatedAt||createdAt), union usedPrompts. */
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
  const usedPrompts = [...new Set([...localUsed, ...(Array.isArray(remote.usedPrompts) ? remote.usedPrompts : [])])];
  if (usedPrompts.length !== localUsed.length) changed = true;

  return { merged: { ...local, stories: Array.from(byId.values()), usedPrompts }, changed };
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
  const out = {};
  for (const [name, content] of reads) if (typeof content === 'string') out[name] = content;
  return out;
}

export async function getDigitalTwinSnapshot() {
  // The reads are independent — run them concurrently. The snapshot is
  // re-materialized whenever the dir fingerprint changes (every sync cycle on a
  // checksum-cache miss), so the parallelism is worth it.
  const [identity, chronotype, longevity, feedback, taste, meta, documents, stories, config] =
    await Promise.all([
      readJSONFile(IDENTITY_FILE, null),
      readJSONFile(CHRONOTYPE_FILE, null),
      readJSONFile(LONGEVITY_FILE, null),
      readJSONFile(FEEDBACK_FILE, null),
      readJSONFile(TASTE_FILE, null),
      readJSONFile(META_FILE, null),
      readMarkdownDocuments(),
      readJSONFile(AUTOBIO_STORIES_FILE, null),
      readJSONFile(AUTOBIO_CONFIG_FILE, null),
    ]);
  const data = { identity, chronotype, longevity, feedback, taste, meta, documents, autobiography: { stories, config } };
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

async function applyAutobiographyConfigIfAbsent(config) {
  if (!isPlainObject(config)) return 0;
  if (existsSync(AUTOBIO_CONFIG_FILE)) return 0; // prompt schedule stays machine-local
  await ensureDir(AUTOBIO_DIR);
  await atomicWrite(AUTOBIO_CONFIG_FILE, config);
  return 1;
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

export async function applyDigitalTwinRemote(remoteData) {
  if (!isPlainObject(remoteData)) return { applied: false, count: 0 };

  let count = 0;
  count += await applyMerge(IDENTITY_FILE, remoteData.identity, (l, r) => mergeObjectLWW(l, r, 'updatedAt'));
  count += await applyMerge(CHRONOTYPE_FILE, remoteData.chronotype, (l, r) => mergeDeepUnion(l, r, 'derivedAt'));
  count += await applyMerge(LONGEVITY_FILE, remoteData.longevity, (l, r) => mergeDeepUnion(l, r, 'derivedAt'));
  count += await applyMerge(FEEDBACK_FILE, remoteData.feedback, (l, r) => mergeObjectLWW(l, r, 'updatedAt'));
  count += await applyTaste(remoteData.taste);
  // Documents before meta: if loadMeta has to rebuild meta from a disk scan, the
  // newly-written .md files should already be present to be catalogued.
  count += await applyDocuments(remoteData.documents);
  count += await applyMeta(remoteData.meta);

  if (isPlainObject(remoteData.autobiography)) {
    count += await applyMerge(AUTOBIO_STORIES_FILE, remoteData.autobiography.stories, mergeAutobiographyStories, { dir: AUTOBIO_DIR });
    count += await applyAutobiographyConfigIfAbsent(remoteData.autobiography.config);
  }

  if (count > 0) console.log(`🔄 Digital twin sync: updated ${count} items`);
  return { applied: count > 0, count };
}
