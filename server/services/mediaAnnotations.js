/**
 * Per-author star + free-text note, keyed by `<kind>:<ref>`. Each PortOS
 * instance only ever writes its own `instanceId` sub-entry; peer notes arrive
 * via sharing/annotationsSync.js and merge in per-author LWW. Decoupled from
 * media-jobs.json so annotations survive job pruning.
 */

import { join } from 'path';
import { PATHS, atomicWrite, readJSONFile, ensureDir } from '../lib/fileUtils.js';
import { isValidKey } from '../lib/mediaItemKey.js';
import { getInstanceId } from './instances.js';
import { resolveLocalAuthorName } from './sharing/annotationIdentity.js';

const STATE_PATH = join(PATHS.data, 'media-annotations.json');

export const ERR_VALIDATION = 'VALIDATION_ERROR';
const makeErr = (message, code) => Object.assign(new Error(message), { code });

export const NOTE_MAX_LENGTH = 2000;

const DEFAULT_STATE = { annotations: {} };

export { isValidKey };

// Indirection avoids a circular import on sharing/annotationsSync.js.
const localChangeListeners = new Set();
export function onLocalAnnotationChange(fn) {
  localChangeListeners.add(fn);
  return () => localChangeListeners.delete(fn);
}
function emitLocalChange(key) {
  for (const fn of localChangeListeners) {
    try { fn(key); } catch (err) { console.error(`⚠️ mediaAnnotations: listener failed: ${err.message}`); }
  }
}

function sanitizeAuthorEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const starred = raw.starred === true;
  const note = typeof raw.note === 'string' ? raw.note.slice(0, NOTE_MAX_LENGTH) : '';
  if (!starred && !note) return null;
  const updatedAt = typeof raw.updatedAt === 'string' && !Number.isNaN(Date.parse(raw.updatedAt))
    ? raw.updatedAt
    : new Date().toISOString();
  const authorName = typeof raw.authorName === 'string' && raw.authorName.trim()
    ? raw.authorName.trim().slice(0, 120)
    : '';
  return { authorName, starred, note, updatedAt };
}

// Safety net for a stale install: migration 014 rewrites the file once, but a
// hand-edited or pre-014 file still parses correctly here. Identity inputs
// (`localInstanceId`, `defaultAuthorName`) are resolved ONCE per readAll() and
// passed in — when the file holds N legacy entries the previous shape paid
// N awaits on getInstanceId() + N on resolveLocalAuthorName() while every
// call returned the same value.
function liftLegacyEntry(rawEntry, { localInstanceId, defaultAuthorName }) {
  const isLegacy = rawEntry
    && typeof rawEntry === 'object'
    && !rawEntry.authors
    && ('starred' in rawEntry || 'note' in rawEntry);
  if (!isLegacy) return rawEntry;
  const author = sanitizeAuthorEntry(rawEntry);
  if (!author) return null;
  const authorName = author.authorName || defaultAuthorName;
  return { authors: { [localInstanceId]: { ...author, authorName } } };
}

async function readAll() {
  await ensureDir(PATHS.data);
  const raw = await readJSONFile(STATE_PATH, DEFAULT_STATE, { logError: false });
  const annotations = raw && typeof raw.annotations === 'object' && raw.annotations !== null
    ? raw.annotations
    : {};
  // Resolve identity inputs ONCE for the whole file scan — every legacy entry
  // would otherwise repeat both awaits below.
  const [localInstanceId, defaultAuthorName] = await Promise.all([
    getInstanceId().catch(() => 'unknown'),
    resolveLocalAuthorName().catch(() => ''),
  ]);
  const liftCtx = { localInstanceId, defaultAuthorName };
  const out = {};
  for (const [key, value] of Object.entries(annotations)) {
    if (!isValidKey(key)) continue;
    const lifted = liftLegacyEntry(value, liftCtx);
    if (!lifted || !lifted.authors || typeof lifted.authors !== 'object') continue;
    const authors = {};
    for (const [instanceId, sub] of Object.entries(lifted.authors)) {
      if (typeof instanceId !== 'string' || !instanceId) continue;
      const sane = sanitizeAuthorEntry(sub);
      if (sane) authors[instanceId] = sane;
    }
    if (Object.keys(authors).length > 0) out[key] = { authors };
  }
  return out;
}

function projectForLocal(authorsMap, localInstanceId) {
  if (!authorsMap || typeof authorsMap !== 'object') return { own: null, others: [] };
  const own = authorsMap[localInstanceId] ?? null;
  const others = Object.entries(authorsMap)
    .filter(([id]) => id !== localInstanceId)
    .map(([instanceId, entry]) => ({ instanceId, ...entry }))
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return { own, others };
}

export async function listAnnotations() {
  const [all, localInstanceId] = await Promise.all([
    readAll(),
    getInstanceId().catch(() => 'unknown'),
  ]);
  const out = {};
  for (const [key, { authors }] of Object.entries(all)) {
    out[key] = projectForLocal(authors, localInstanceId);
  }
  return out;
}

/** Used by sharing/annotationsSync.js to project just the local-author entries for export. */
export async function listLocalAuthorAnnotations() {
  const [all, localInstanceId] = await Promise.all([
    readAll(),
    getInstanceId().catch(() => 'unknown'),
  ]);
  const out = {};
  for (const [key, { authors }] of Object.entries(all)) {
    const entry = authors[localInstanceId];
    if (entry) out[key] = entry;
  }
  return out;
}

/**
 * Per-author LWW: a peer payload only ever rewrites its own `instanceId`
 * sub-entry, never another author's. Returns the changed keys AND the
 * post-merge `{ own, others }` projection for each — so callers can broadcast
 * without paying for a second readAll() per key.
 *
 * `payload` shape: `{ instanceId, authorName, annotations: { [key]: { starred, note, updatedAt } } }`.
 */
export async function mergePeerAnnotations(payload) {
  if (!payload || typeof payload !== 'object') return { changed: [], projections: new Map() };
  const peerInstanceId = typeof payload.instanceId === 'string' ? payload.instanceId : null;
  if (!peerInstanceId) return { changed: [], projections: new Map() };
  const localInstanceId = await getInstanceId().catch(() => null);
  if (peerInstanceId === localInstanceId) return { changed: [], projections: new Map() };
  const incoming = payload.annotations && typeof payload.annotations === 'object'
    ? payload.annotations : {};
  const all = await readAll();
  const changed = [];
  for (const [key, rawEntry] of Object.entries(incoming)) {
    if (!isValidKey(key)) continue;
    const sane = sanitizeAuthorEntry({ ...rawEntry, authorName: rawEntry?.authorName || payload.authorName });
    const prior = all[key]?.authors?.[peerInstanceId] ?? null;
    if (!sane) {
      if (prior) {
        delete all[key].authors[peerInstanceId];
        if (Object.keys(all[key].authors).length === 0) delete all[key];
        changed.push(key);
      }
      continue;
    }
    if (prior && (prior.updatedAt || '') >= sane.updatedAt) continue;
    if (!all[key]) all[key] = { authors: {} };
    all[key].authors[peerInstanceId] = sane;
    changed.push(key);
  }
  if (changed.length > 0) {
    await atomicWrite(STATE_PATH, { annotations: all });
  }
  const projections = new Map();
  for (const key of changed) {
    projections.set(key, projectForLocal(all[key]?.authors, localInstanceId));
  }
  return { changed, projections };
}



/**
 * Partial merge with prune-on-empty — writes the local-instance author entry.
 *
 * Patch may include `starred` (boolean) and/or `note` (string). Fields not in
 * the patch keep their prior value (the local author's prior value, not any
 * peer's). If the merged entry ends up with `starred:false` AND an empty
 * `note`, the local-author entry is removed; if no authors remain on the key,
 * the whole key is removed.
 *
 * Returns the post-write projection `{ own, others }` for this key.
 */
export async function setAnnotation(key, patch) {
  if (!isValidKey(key)) throw makeErr(`Invalid key: ${key}`, ERR_VALIDATION);
  if (!patch || typeof patch !== 'object') {
    throw makeErr('patch must include starred and/or note', ERR_VALIDATION);
  }
  const hasStarred = Object.prototype.hasOwnProperty.call(patch, 'starred');
  const hasNote = Object.prototype.hasOwnProperty.call(patch, 'note');
  if (!hasStarred && !hasNote) {
    throw makeErr('patch must include starred and/or note', ERR_VALIDATION);
  }
  if (hasStarred && typeof patch.starred !== 'boolean') {
    throw makeErr('starred must be boolean', ERR_VALIDATION);
  }
  if (hasNote && typeof patch.note !== 'string') {
    throw makeErr('note must be string', ERR_VALIDATION);
  }
  if (hasNote && patch.note.length > NOTE_MAX_LENGTH) {
    throw makeErr(`note exceeds max length (${NOTE_MAX_LENGTH})`, ERR_VALIDATION);
  }

  const [all, localInstanceId, authorName] = await Promise.all([
    readAll(),
    getInstanceId(),
    resolveLocalAuthorName().catch(() => ''),
  ]);
  if (!localInstanceId || localInstanceId === 'unknown') {
    throw makeErr('Local instance identity not initialized', ERR_VALIDATION);
  }

  const priorAuthors = all[key]?.authors ?? {};
  const priorOwn = priorAuthors[localInstanceId] ?? { starred: false, note: '', updatedAt: null };
  const merged = {
    authorName: authorName || priorOwn.authorName || '',
    starred: hasStarred ? patch.starred : priorOwn.starred,
    note: hasNote ? patch.note : priorOwn.note,
    updatedAt: new Date().toISOString(),
  };

  const nextAuthors = { ...priorAuthors };
  if (!merged.starred && !merged.note) {
    delete nextAuthors[localInstanceId];
  } else {
    nextAuthors[localInstanceId] = merged;
  }

  const next = { ...all };
  if (Object.keys(nextAuthors).length === 0) delete next[key];
  else next[key] = { authors: nextAuthors };
  await atomicWrite(STATE_PATH, { annotations: next });
  emitLocalChange(key);

  return projectForLocal(next[key]?.authors, localInstanceId);
}
