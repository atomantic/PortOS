/**
 * Music tracks — shared mutation logic (backend-agnostic).
 *
 * The file backend (file.js) and the PostgreSQL backend (db.js) both import the
 * sanitizer + record builders from here so the two backends can never drift.
 * This module has NO I/O — pure functions only. Mirrors `services/albums/
 * logic.js` with track-specific fields.
 *
 * A Track is a single song/recording — standalone or part of an album:
 *   - title         — track title
 *   - albumId       — FK to the owning album (`album-…`), or '' for a single
 *   - artistId      — FK to the performing artist (`artist-…`), or '' for none
 *   - artist        — denormalized artist name (renders before the artist syncs)
 *   - lyrics        — full lyrics (also the conditioning text for lyric-aware
 *                     generators like Ace-Step)
 *   - prompt        — the text/style prompt used (or to use) for generation
 *   - engine        — music-gen engine id the audio came from (e.g. 'acestep'),
 *                     or '' for an uploaded track
 *   - modelId       — model within that engine, or ''
 *   - durationSec   — clip length in seconds, or null
 *   - audioFilename — the music-library filename under data/music/ (the bytes),
 *                     or '' when no audio is attached yet
 *
 * Tracks are `db-primary` (PostgreSQL `tracks` table). The audio bytes live in
 * the shared music library (services/pipeline/musicLibrary.js, `data/music/`);
 * a track stores only the filename pointer. The storage layer is federation-
 * ready, but cross-peer sync is not wired yet — see issue #1502 (local-only).
 */

import { compareNewerWins } from '../../lib/lwwTimestamp.js';

export const TRACK_ID_RE = /^track-[A-Za-z0-9-]{1,64}$/;

export const TITLE_MAX = 200;
export const ALBUM_ID_MAX = 80;
export const ARTIST_ID_MAX = 80;
export const ARTIST_NAME_MAX = 120;
export const LYRICS_MAX = 20000;
export const PROMPT_MAX = 8000;
export const ENGINE_MAX = 60;
export const MODEL_ID_MAX = 120;
export const AUDIO_FILENAME_MAX = 256;
// A track clip's usable duration band — wide enough for a long-form generation,
// bounded so a garbage value can't poison the record.
export const DURATION_MIN_SEC = 1;
export const DURATION_MAX_SEC = 3600;

const isStr = (v) => typeof v === 'string';
const trimTo = (v, max) => (isStr(v) ? v.trim().slice(0, max) : '');

function sanitizeDuration(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const s = Math.round(v);
  if (s < DURATION_MIN_SEC || s > DURATION_MAX_SEC) return null;
  return s;
}

/**
 * Normalize a raw track record into the canonical stored shape. Returns null for
 * a non-object or a record without a usable id/title (drop-on-floor contract).
 */
export function sanitizeTrack(raw) {
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
    albumId: trimTo(raw.albumId, ALBUM_ID_MAX),
    artistId: trimTo(raw.artistId, ARTIST_ID_MAX),
    artist: trimTo(raw.artist, ARTIST_NAME_MAX),
    lyrics: trimTo(raw.lyrics, LYRICS_MAX),
    prompt: trimTo(raw.prompt, PROMPT_MAX),
    engine: trimTo(raw.engine, ENGINE_MAX),
    modelId: trimTo(raw.modelId, MODEL_ID_MAX),
    durationSec: sanitizeDuration(raw.durationSec),
    // Empty string = no audio attached yet; never null so the shape is stable.
    audioFilename: trimTo(raw.audioFilename, AUDIO_FILENAME_MAX),
    createdAt,
    updatedAt,
    deleted,
    deletedAt: deleted && isStr(raw.deletedAt) && raw.deletedAt.trim() ? raw.deletedAt : null,
  };
}

/**
 * The bare music-library filename for a track's audio (already a basename), or
 * null when no audio is attached. Tracks store the filename directly (not a
 * URL), so this is mostly an existence/trim guard for the future asset pipeline.
 */
export function trackAudioFilename(audioFilename) {
  const name = trimTo(audioFilename, AUDIO_FILENAME_MAX);
  if (!name) return null;
  // Defense-in-depth: never let a path-ish value through as an asset basename.
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  return name;
}

/** Build a fresh track record from create input. */
export function buildTrackRecord(input, { id, now }) {
  return sanitizeTrack({
    id,
    title: input.title,
    albumId: input.albumId || '',
    artistId: input.artistId || '',
    artist: input.artist || '',
    lyrics: input.lyrics || '',
    prompt: input.prompt || '',
    engine: input.engine || '',
    modelId: input.modelId || '',
    durationSec: input.durationSec ?? null,
    audioFilename: input.audioFilename || '',
    createdAt: now,
    updatedAt: now,
    deleted: false,
    deletedAt: null,
  });
}

// The user-authored fields a partial patch may overwrite. `id`, the LWW/
// tombstone trio, and `createdAt` are server-owned / structural.
const PATCHABLE = [
  'title', 'albumId', 'artistId', 'artist', 'lyrics', 'prompt', 'engine', 'modelId', 'durationSec', 'audioFilename',
];

/**
 * LWW merge decision for one incoming track record against the local copy.
 * Mirrors mergeAlbumRecord. Returns `{ next, inserted, remoteWins, changed }`.
 */
export function mergeTrackRecord(local, remoteRaw) {
  const remote = sanitizeTrack(remoteRaw);
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
export function applyTrackPatch(current, patch = {}) {
  const next = { ...current };
  for (const key of PATCHABLE) {
    if (key in patch) next[key] = patch[key];
  }
  next.updatedAt = new Date().toISOString();
  return sanitizeTrack(next);
}
