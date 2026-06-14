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
 * Authors are `db-primary` (PostgreSQL) but LOCAL-ONLY for now — they carry no
 * sync cursor/tombstone wire path. A federated series keeps its denormalized
 * `author` byline string so peers still render the cover correctly even when
 * the author record itself hasn't synced. See PLAN.md for the federation
 * follow-up.
 */

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

const PATCHABLE = [
  'name', 'writingStyle', 'bio', 'physicalDescription', 'headshotStyle', 'headshotImageUrl',
];

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
