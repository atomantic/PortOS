/**
 * Author personas — shared mutation logic (backend-agnostic).
 *
 * The file backend (file.js) and the PostgreSQL backend (db.js) both import
 * the sanitizer + record builders from here so the two backends can never
 * drift in how an author record is shaped, trimmed, or patched. This module
 * has NO I/O — pure functions only.
 *
 * An Author is a reusable creative persona used as a series' cover byline and
 * as the prompt source for generating an author headshot on the book cover:
 *   - name                — display name / byline
 *   - writingStyle        — voice / tone notes fed into stage prompts
 *   - bio                 — back-cover / about-the-author blurb
 *   - physicalDescription — subject description for the headshot render
 *   - headshotStyle       — art/photography direction for the headshot render
 *   - headshotImageUrl    — optional pointer to a generated/chosen headshot
 *
 * Authors are `db-primary` (PostgreSQL) and federate across peers via the
 * per-record peer-sync push pipeline (`server/services/sharing/peerSync.js`,
 * record kind `author`, sync category `authors`): a create auto-subscribes to
 * every authors-enabled peer, every edit/delete pushes the LWW-merged record,
 * and the referenced headshot image rides along as a pulled asset. A federated
 * series still keeps its denormalized `author` byline string so peers render
 * the cover correctly even before the author record itself has synced.
 */

import { compareNewerWins } from '../../lib/lwwTimestamp.js';
import { localImageFilename } from '../../lib/localImageFilename.js';

export const AUTHOR_ID_RE = /^auth-[A-Za-z0-9-]{1,64}$/;

export const NAME_MAX = 120;
export const WRITING_STYLE_MAX = 4000;
export const BIO_MAX = 4000;
export const PHYSICAL_DESCRIPTION_MAX = 2000;
export const HEADSHOT_STYLE_MAX = 2000;
export const HEADSHOT_IMAGE_URL_MAX = 1000;

const isStr = (v) => typeof v === 'string';
const trimTo = (v, max) => (isStr(v) ? v.trim().slice(0, max) : '');

/**
 * Normalize a raw author record into the canonical stored shape. Returns null
 * for a non-object or a record without a usable id/name (mirrors the other
 * sanitizers' "drop on the floor" contract so a malformed import can't land).
 */
export function sanitizeAuthor(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!isStr(raw.id) || !raw.id) return null;
  const name = trimTo(raw.name, NAME_MAX);
  if (!name) return null;
  const createdAt = isStr(raw.createdAt) ? raw.createdAt : new Date().toISOString();
  const updatedAt = isStr(raw.updatedAt) ? raw.updatedAt : createdAt;
  const deleted = raw.deleted === true;
  return {
    id: raw.id,
    name,
    writingStyle: trimTo(raw.writingStyle, WRITING_STYLE_MAX),
    bio: trimTo(raw.bio, BIO_MAX),
    physicalDescription: trimTo(raw.physicalDescription, PHYSICAL_DESCRIPTION_MAX),
    headshotStyle: trimTo(raw.headshotStyle, HEADSHOT_STYLE_MAX),
    // Empty string = no headshot chosen; never null so the on-disk shape is stable.
    headshotImageUrl: trimTo(raw.headshotImageUrl, HEADSHOT_IMAGE_URL_MAX),
    createdAt,
    updatedAt,
    deleted,
    deletedAt: deleted && isStr(raw.deletedAt) && raw.deletedAt.trim() ? raw.deletedAt : null,
  };
}

/**
 * Resolve an author's `headshotImageUrl` to the bare gallery-image filename
 * that lives under `data/images/` — the unit the peer-sync asset pipeline can
 * hash + transfer. Thin wrapper over the shared `localImageFilename` helper
 * (the named export is what `peerSync.js` imports).
 */
export function headshotImageFilename(headshotImageUrl) {
  return localImageFilename(headshotImageUrl);
}

/** Build a fresh author record from create input. */
export function buildAuthorRecord(input, { id, now }) {
  return sanitizeAuthor({
    id,
    name: input.name,
    writingStyle: input.writingStyle || '',
    bio: input.bio || '',
    physicalDescription: input.physicalDescription || '',
    headshotStyle: input.headshotStyle || '',
    headshotImageUrl: input.headshotImageUrl || '',
    createdAt: now,
    updatedAt: now,
    deleted: false,
    deletedAt: null,
  });
}

// The user-authored scalar fields a partial patch may overwrite. This is also
// the set the conflict journal tracks + the merge can restore — mirrored in
// RESTORABLE_FIELDS.author (conflictJournal.js). `id`, the LWW/tombstone trio,
// and `createdAt` are server-owned / structural, never patchable/restorable.
const PATCHABLE = [
  'name', 'writingStyle', 'bio', 'physicalDescription', 'headshotStyle', 'headshotImageUrl',
];

/**
 * LWW merge decision for one incoming author record against the local copy.
 *
 *   - remote is sanitized here (drop-on-floor on a malformed payload → returns
 *     `{ next: null }` so the caller skips it).
 *   - No local counterpart → insert the remote verbatim (`inserted: true`).
 *   - Both present → newer `updatedAt` wins via the shared `compareNewerWins`
 *     (epoch-ms compare, unparseable-loses, tie → local). Tombstones ride the
 *     same path: a deleted record with a newer `updatedAt` overwrites a live
 *     local one, and vice-versa.
 *
 * Returns `{ next, inserted, remoteWins, changed }`. `changed` is false when the
 * winning record is byte-identical to local (sanitized both sides → canonical
 * key order → JSON compare is sufficient).
 */
export function mergeAuthorRecord(local, remoteRaw) {
  const remote = sanitizeAuthor(remoteRaw);
  if (!remote) return { next: null, inserted: false, remoteWins: false, changed: false };
  if (!local) return { next: remote, inserted: true, remoteWins: true, changed: true };
  const remoteWins = compareNewerWins(remote.updatedAt, local.updatedAt);
  const next = remoteWins ? remote : local;
  const changed = JSON.stringify(next) !== JSON.stringify(local);
  return { next, inserted: false, remoteWins, changed };
}

/**
 * Apply a partial patch onto an existing record. Only keys PRESENT in `patch`
 * overwrite — an absent key preserves the current value, while a present
 * empty-string value applies the clear (distinguish-absent-vs-empty per
 * CLAUDE.md). Always bumps `updatedAt`.
 */
export function applyAuthorPatch(current, patch = {}) {
  const next = { ...current };
  for (const key of PATCHABLE) {
    if (key in patch) next[key] = patch[key];
  }
  next.updatedAt = new Date().toISOString();
  return sanitizeAuthor(next);
}
