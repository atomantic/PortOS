/**
 * Music artists — shared mutation logic (backend-agnostic).
 *
 * The file backend (file.js) and the PostgreSQL backend (db.js) both import the
 * sanitizer + record builders from here so the two backends can never drift in
 * how an artist record is shaped, trimmed, or patched. This module has NO I/O —
 * pure functions only. It deliberately mirrors `services/authors/logic.js`: an
 * Artist is the music studio's analogue of an Author persona.
 *
 * An Artist is a reusable musical persona used as a track/album byline and as
 * the prompt source for generating a portrait + music:
 *   - name                — display / stage name
 *   - genre               — primary genre(s), e.g. "indie folk, dream pop"
 *   - bio                 — about-the-artist blurb
 *   - musicalStyle        — voice / production notes fed into music-gen prompts
 *                           (the audio analogue of an author's writingStyle)
 *   - physicalDescription — subject description for the portrait render
 *   - portraitStyle       — art/photography direction for the portrait render
 *   - portraitImageUrl    — optional pointer to a generated/chosen portrait
 *
 * Artists are `db-primary` (PostgreSQL `artists` table). The storage layer is
 * federation-ready (LWW merge + tombstone prune mirror authors), but the cross-
 * peer peer-sync REGISTRATION (schemaVersions / peerSync / syncWire / tombstone
 * GC) is not wired yet — see issue #1502. Until then artists are local-only, like
 * the Rounds workbench.
 */

import { compareNewerWins } from '../../lib/lwwTimestamp.js';

export const ARTIST_ID_RE = /^artist-[A-Za-z0-9-]{1,64}$/;

export const NAME_MAX = 120;
export const GENRE_MAX = 120;
export const BIO_MAX = 4000;
export const MUSICAL_STYLE_MAX = 4000;
export const PHYSICAL_DESCRIPTION_MAX = 2000;
export const PORTRAIT_STYLE_MAX = 2000;
export const PORTRAIT_IMAGE_URL_MAX = 1000;

const isStr = (v) => typeof v === 'string';
const trimTo = (v, max) => (isStr(v) ? v.trim().slice(0, max) : '');

/**
 * Normalize a raw artist record into the canonical stored shape. Returns null
 * for a non-object or a record without a usable id/name (mirrors the other
 * sanitizers' "drop on the floor" contract so a malformed import can't land).
 */
export function sanitizeArtist(raw) {
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
    genre: trimTo(raw.genre, GENRE_MAX),
    bio: trimTo(raw.bio, BIO_MAX),
    musicalStyle: trimTo(raw.musicalStyle, MUSICAL_STYLE_MAX),
    physicalDescription: trimTo(raw.physicalDescription, PHYSICAL_DESCRIPTION_MAX),
    portraitStyle: trimTo(raw.portraitStyle, PORTRAIT_STYLE_MAX),
    // Empty string = no portrait chosen; never null so the on-disk shape is stable.
    portraitImageUrl: trimTo(raw.portraitImageUrl, PORTRAIT_IMAGE_URL_MAX),
    createdAt,
    updatedAt,
    deleted,
    deletedAt: deleted && isStr(raw.deletedAt) && raw.deletedAt.trim() ? raw.deletedAt : null,
  };
}

/**
 * Resolve an artist's `portraitImageUrl` to the bare gallery-image filename that
 * lives under `data/images/` — the unit a future peer-sync asset pipeline can
 * hash + transfer. Returns null when there's nothing local to ship (empty,
 * external URL, or a non-image path). Mirrors authors' headshotImageFilename.
 */
export function portraitImageFilename(portraitImageUrl) {
  if (!isStr(portraitImageUrl)) return null;
  const url = portraitImageUrl.trim();
  if (!url) return null;
  if (/^(https?:|data:|blob:)/i.test(url)) return null;
  let name = url;
  const imagesPrefix = '/data/images/';
  if (url.startsWith(imagesPrefix)) name = url.slice(imagesPrefix.length);
  else if (url.startsWith('/')) return null; // some other absolute path → not a gallery image
  name = name.split(/[?#]/)[0];
  const base = name.split('/').pop();
  return base || null;
}

/** Build a fresh artist record from create input. */
export function buildArtistRecord(input, { id, now }) {
  return sanitizeArtist({
    id,
    name: input.name,
    genre: input.genre || '',
    bio: input.bio || '',
    musicalStyle: input.musicalStyle || '',
    physicalDescription: input.physicalDescription || '',
    portraitStyle: input.portraitStyle || '',
    portraitImageUrl: input.portraitImageUrl || '',
    createdAt: now,
    updatedAt: now,
    deleted: false,
    deletedAt: null,
  });
}

// The user-authored scalar fields a partial patch may overwrite. `id`, the
// LWW/tombstone trio, and `createdAt` are server-owned / structural.
const PATCHABLE = [
  'name', 'genre', 'bio', 'musicalStyle', 'physicalDescription', 'portraitStyle', 'portraitImageUrl',
];

/**
 * LWW merge decision for one incoming artist record against the local copy.
 * Mirrors mergeAuthorRecord: sanitize remote (drop-on-floor), insert when no
 * local counterpart, else newer `updatedAt` wins (tombstone-aware). Returns
 * `{ next, inserted, remoteWins, changed }`.
 */
export function mergeArtistRecord(local, remoteRaw) {
  const remote = sanitizeArtist(remoteRaw);
  if (!remote) return { next: null, inserted: false, remoteWins: false, changed: false };
  if (!local) return { next: remote, inserted: true, remoteWins: true, changed: true };
  const remoteWins = compareNewerWins(remote.updatedAt, local.updatedAt);
  const next = remoteWins ? remote : local;
  const changed = JSON.stringify(next) !== JSON.stringify(local);
  return { next, inserted: false, remoteWins, changed };
}

/**
 * Apply a partial patch onto an existing record. Only keys PRESENT in `patch`
 * overwrite — an absent key preserves the current value, a present empty-string
 * applies the clear (distinguish-absent-vs-empty per CLAUDE.md). Bumps updatedAt.
 */
export function applyArtistPatch(current, patch = {}) {
  const next = { ...current };
  for (const key of PATCHABLE) {
    if (key in patch) next[key] = patch[key];
  }
  next.updatedAt = new Date().toISOString();
  return sanitizeArtist(next);
}
