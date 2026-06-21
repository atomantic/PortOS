/**
 * Music albums — shared mutation logic (backend-agnostic).
 *
 * The file backend (file.js) and the PostgreSQL backend (db.js) both import the
 * sanitizer + record builders from here so the two backends can never drift.
 * This module has NO I/O — pure functions only. Mirrors `services/artists/
 * logic.js` (the persona store) with album-specific fields.
 *
 * An Album groups ordered tracks under an artist, with cover art:
 *   - title          — album title
 *   - artistId       — FK to the owning artist (`artist-…`), or '' for none
 *   - artist         — denormalized artist name, so a peer/cover renders before
 *                      the artist record itself has synced (mirrors series→author)
 *   - description    — liner-notes blurb
 *   - genre          — primary genre(s)
 *   - releaseYear    — integer year, or null
 *   - coverImageUrl  — optional pointer to a generated/uploaded cover image
 *   - trackIds       — ordered list of track ids (`track-…`) on the album
 *
 * Albums are `db-primary` (PostgreSQL `albums` table). The storage layer is
 * federation-ready (LWW merge + tombstone prune mirror authors/artists), but the
 * cross-peer peer-sync REGISTRATION is not wired yet — see issue #1502. Until
 * then albums are local-only.
 */

import { compareNewerWins } from '../../lib/lwwTimestamp.js';

export const ALBUM_ID_RE = /^album-[A-Za-z0-9-]{1,64}$/;

export const TITLE_MAX = 200;
export const ARTIST_ID_MAX = 80;
export const ARTIST_NAME_MAX = 120;
export const DESCRIPTION_MAX = 4000;
export const GENRE_MAX = 120;
export const COVER_IMAGE_URL_MAX = 1000;
export const TRACK_IDS_MAX = 200;
export const TRACK_ID_MAX = 80;
// Sane bounds for a release year — wide enough for archival reissues, narrow
// enough to reject a fat-fingered/garbage value.
export const RELEASE_YEAR_MIN = 1850;
export const RELEASE_YEAR_MAX = 2200;

const isStr = (v) => typeof v === 'string';
const trimTo = (v, max) => (isStr(v) ? v.trim().slice(0, max) : '');

// Clamp an integer release year into the supported band; null when unparseable
// so an album without a year stays distinct from one pinned to a bound.
function sanitizeReleaseYear(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const y = Math.round(v);
  if (y < RELEASE_YEAR_MIN || y > RELEASE_YEAR_MAX) return null;
  return y;
}

// Ordered, deduped list of track ids — keeps the first occurrence's position,
// drops blanks/non-strings, and bounds the length. Order IS the track order.
function sanitizeTrackIds(arr) {
  const seen = new Set();
  return (Array.isArray(arr) ? arr : [])
    .map((v) => trimTo(v, TRACK_ID_MAX))
    .filter((id) => id && !seen.has(id) && seen.add(id))
    .slice(0, TRACK_IDS_MAX);
}

/**
 * Normalize a raw album record into the canonical stored shape. Returns null for
 * a non-object or a record without a usable id/title (drop-on-floor contract).
 */
export function sanitizeAlbum(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!isStr(raw.id) || !raw.id) return null;
  const title = trimTo(raw.title, TITLE_MAX);
  if (!title) return null;
  const createdAt = isStr(raw.createdAt) ? raw.createdAt : new Date().toISOString();
  const updatedAt = isStr(raw.updatedAt) ? raw.updatedAt : createdAt;
  const deleted = raw.deleted === true;
  return {
    id: raw.id,
    title,
    artistId: trimTo(raw.artistId, ARTIST_ID_MAX),
    artist: trimTo(raw.artist, ARTIST_NAME_MAX),
    description: trimTo(raw.description, DESCRIPTION_MAX),
    genre: trimTo(raw.genre, GENRE_MAX),
    releaseYear: sanitizeReleaseYear(raw.releaseYear),
    // Empty string = no cover chosen; never null so the on-disk shape is stable.
    coverImageUrl: trimTo(raw.coverImageUrl, COVER_IMAGE_URL_MAX),
    trackIds: sanitizeTrackIds(raw.trackIds),
    createdAt,
    updatedAt,
    deleted,
    deletedAt: deleted && isStr(raw.deletedAt) && raw.deletedAt.trim() ? raw.deletedAt : null,
  };
}

/**
 * Resolve an album's `coverImageUrl` to the bare gallery-image filename under
 * `data/images/` for a future peer-sync asset transfer. Returns null when
 * there's nothing local to ship. Mirrors artists' portraitImageFilename.
 */
export function coverImageFilename(coverImageUrl) {
  if (!isStr(coverImageUrl)) return null;
  const url = coverImageUrl.trim();
  if (!url) return null;
  if (/^(https?:|data:|blob:)/i.test(url)) return null;
  let name = url;
  const imagesPrefix = '/data/images/';
  if (url.startsWith(imagesPrefix)) name = url.slice(imagesPrefix.length);
  else if (url.startsWith('/')) return null;
  name = name.split(/[?#]/)[0];
  const base = name.split('/').pop();
  return base || null;
}

/** Build a fresh album record from create input. */
export function buildAlbumRecord(input, { id, now }) {
  return sanitizeAlbum({
    id,
    title: input.title,
    artistId: input.artistId || '',
    artist: input.artist || '',
    description: input.description || '',
    genre: input.genre || '',
    releaseYear: input.releaseYear ?? null,
    coverImageUrl: input.coverImageUrl || '',
    trackIds: input.trackIds || [],
    createdAt: now,
    updatedAt: now,
    deleted: false,
    deletedAt: null,
  });
}

// The user-authored fields a partial patch may overwrite. `id`, the LWW/
// tombstone trio, and `createdAt` are server-owned / structural.
const PATCHABLE = [
  'title', 'artistId', 'artist', 'description', 'genre', 'releaseYear', 'coverImageUrl', 'trackIds',
];

/**
 * LWW merge decision for one incoming album record against the local copy.
 * Mirrors mergeArtistRecord. Returns `{ next, inserted, remoteWins, changed }`.
 */
export function mergeAlbumRecord(local, remoteRaw) {
  const remote = sanitizeAlbum(remoteRaw);
  if (!remote) return { next: null, inserted: false, remoteWins: false, changed: false };
  if (!local) return { next: remote, inserted: true, remoteWins: true, changed: true };
  const remoteWins = compareNewerWins(remote.updatedAt, local.updatedAt);
  const next = remoteWins ? remote : local;
  const changed = JSON.stringify(next) !== JSON.stringify(local);
  return { next, inserted: false, remoteWins, changed };
}

/**
 * Apply a partial patch onto an existing record. Only keys PRESENT in `patch`
 * overwrite — absent preserves, present-empty clears (per CLAUDE.md). Bumps
 * updatedAt.
 */
export function applyAlbumPatch(current, patch = {}) {
  const next = { ...current };
  for (const key of PATCHABLE) {
    if (key in patch) next[key] = patch[key];
  }
  next.updatedAt = new Date().toISOString();
  return sanitizeAlbum(next);
}
