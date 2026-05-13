/**
 * Media Annotations
 *
 * Per-item star + free-text note, keyed by the same `<kind>:<ref>` convention
 * used by mediaCollections.js and the client-side normalize.js (`item.key`).
 * Persisted to data/media-annotations.json as a single
 * `{ annotations: { [key]: { starred, note, updatedAt } } }` document.
 *
 * Decoupled from the generation pipeline records (media-jobs.json,
 * video-history.json) so annotations survive pruning/archival of jobs.
 */

import { join } from 'path';
import { PATHS, atomicWrite, readJSONFile, ensureDir } from '../lib/fileUtils.js';
import { isValidKey } from '../lib/mediaItemKey.js';

const STATE_PATH = join(PATHS.data, 'media-annotations.json');

export const ERR_VALIDATION = 'VALIDATION_ERROR';
const makeErr = (message, code) => Object.assign(new Error(message), { code });

export const NOTE_MAX_LENGTH = 2000;

const DEFAULT_STATE = { annotations: {} };

export { isValidKey };

const sanitizeEntry = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const starred = raw.starred === true;
  const note = typeof raw.note === 'string' ? raw.note.slice(0, NOTE_MAX_LENGTH) : '';
  if (!starred && !note) return null;
  const updatedAt = typeof raw.updatedAt === 'string' && !Number.isNaN(Date.parse(raw.updatedAt))
    ? raw.updatedAt
    : new Date().toISOString();
  return { starred, note, updatedAt };
};

const readAll = async () => {
  await ensureDir(PATHS.data);
  const raw = await readJSONFile(STATE_PATH, DEFAULT_STATE, { logError: false });
  const annotations = raw && typeof raw.annotations === 'object' && raw.annotations !== null
    ? raw.annotations
    : {};
  const out = {};
  for (const [key, value] of Object.entries(annotations)) {
    if (!isValidKey(key)) continue;
    const s = sanitizeEntry(value);
    if (s) out[key] = s;
  }
  return out;
};

export async function listAnnotations() {
  return await readAll();
}

/**
 * Partial merge with prune-on-empty.
 *
 * Patch may include `starred` (boolean) and/or `note` (string). Fields not in
 * the patch keep their prior value. If the merged entry ends up with
 * `starred:false` AND an empty `note`, the entry is removed entirely to keep
 * the file lean.
 *
 * Returns the merged entry, or `null` if it was pruned.
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

  const all = await readAll();
  const prior = all[key] ?? { starred: false, note: '', updatedAt: null };
  const merged = {
    starred: hasStarred ? patch.starred : prior.starred,
    note: hasNote ? patch.note : prior.note,
    updatedAt: new Date().toISOString(),
  };

  const next = { ...all };
  if (!merged.starred && !merged.note) {
    delete next[key];
    await atomicWrite(STATE_PATH, { annotations: next });
    return null;
  }
  next[key] = merged;
  await atomicWrite(STATE_PATH, { annotations: next });
  return merged;
}
