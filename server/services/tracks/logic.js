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
 *                     or '' when no audio is attached yet — the ACTIVE render's
 *                     pointer; `engine`/`modelId`/`durationSec` mirror its metadata
 *   - renders       — the full render history (every generated/uploaded take), so
 *                     the studio can show each render as a card and re-select an
 *                     earlier one. Each entry is `{ id, audioFilename, prompt,
 *                     lyrics, engine, modelId, durationSec, createdAt }`. The
 *                     top-level `audioFilename`/`engine`/`modelId`/`durationSec`
 *                     point at whichever render is currently ACTIVE (selected).
 *
 * Tracks are `db-primary` (PostgreSQL `tracks` table). The audio bytes live in
 * the shared music library (services/pipeline/musicLibrary.js, `data/music/`);
 * a track stores only the filename pointer. The storage layer is federation-
 * ready and federates across peers via the per-record peer-sync pipeline
 * (`record kind: track`, sync category: tracks). Audio bytes ride the asset
 * manifest as `music` assets.
 */

import { compareNewerWins } from '../../lib/lwwTimestamp.js';
import { sanitizeChiptuneScore } from '../../lib/chiptuneScore.js';

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
export const RENDER_ID_MAX = 80;
// Cap the render history per track so a runaway generate loop can't grow the
// record unboundedly. Oldest renders fall off first (slice(-RENDERS_MAX)); the
// audio bytes stay in the shared library (they may be referenced elsewhere).
export const RENDERS_MAX = 100;
// A track clip's usable duration band — wide enough for a long-form generation,
// bounded so a garbage value can't poison the record.
export const DURATION_MIN_SEC = 1;
export const DURATION_MAX_SEC = 3600;

const RENDER_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

const isStr = (v) => typeof v === 'string';
const trimTo = (v, max) => (isStr(v) ? v.trim().slice(0, max) : '');

function sanitizeDuration(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const s = Math.round(v);
  if (s < DURATION_MIN_SEC || s > DURATION_MAX_SEC) return null;
  return s;
}

// Deterministic id for a render synthesized from a legacy single-pointer track
// (audio attached before the render-history field existed). The DB read path
// re-sanitizes on every read, so a fresh `randomUUID` here would mint a new id
// each read — derive a STABLE id from the audio filename instead (already unique
// per render: `music-gen-<uuid>.wav` for generated, the upload basename else).
function legacyRenderId(audioFilename) {
  const slug = String(audioFilename).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 72);
  return `r-${slug}`.slice(0, RENDER_ID_MAX);
}

/**
 * Normalize one render-history entry. Returns null for a non-object or an entry
 * without usable audio bytes (a render with no audioFilename is meaningless and
 * dropped — same drop-on-floor contract as sanitizeTrack). The id falls back to
 * a deterministic filename-derived id so re-sanitizing on read stays stable.
 */
export function sanitizeRender(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const audioFilename = trackAudioFilename(raw.audioFilename);
  if (!audioFilename) return null;
  const id = isStr(raw.id) && RENDER_ID_RE.test(raw.id) ? raw.id : legacyRenderId(audioFilename);
  return {
    id,
    audioFilename,
    prompt: trimTo(raw.prompt, PROMPT_MAX),
    lyrics: trimTo(raw.lyrics, LYRICS_MAX),
    engine: trimTo(raw.engine, ENGINE_MAX),
    modelId: trimTo(raw.modelId, MODEL_ID_MAX),
    durationSec: sanitizeDuration(raw.durationSec),
    createdAt: isStr(raw.createdAt) && raw.createdAt ? raw.createdAt : new Date().toISOString(),
  };
}

// De-dup a render list by id (first wins) so a hand-edited record or a sync
// merge can't accumulate duplicate cards.
function dedupRenders(renders) {
  const seen = new Set();
  const out = [];
  for (const r of renders) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
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
  const lyrics = trimTo(raw.lyrics, LYRICS_MAX);
  const prompt = trimTo(raw.prompt, PROMPT_MAX);
  const engine = trimTo(raw.engine, ENGINE_MAX);
  const modelId = trimTo(raw.modelId, MODEL_ID_MAX);
  const durationSec = sanitizeDuration(raw.durationSec);
  // Empty string = no audio attached yet; never null so the shape is stable.
  const audioFilename = trimTo(raw.audioFilename, AUDIO_FILENAME_MAX);

  // Render history. Sanitize + de-dup + cap (newest kept). A legacy single-
  // pointer track (audio but no render array) is BACKFILLED with one synthesized
  // render from its top-level gen metadata — deterministic id + the track's own
  // createdAt, so re-sanitizing on every DB read stays stable (no drift, no new
  // id each read). New writes persist the backfilled array, healing the record.
  let renders = Array.isArray(raw.renders)
    ? dedupRenders(raw.renders.map(sanitizeRender).filter(Boolean)).slice(-RENDERS_MAX)
    : [];
  if (renders.length === 0 && audioFilename) {
    renders = [{
      id: legacyRenderId(audioFilename),
      audioFilename,
      prompt,
      lyrics,
      engine,
      modelId,
      durationSec,
      createdAt,
    }];
  }

  return {
    id: raw.id,
    title,
    albumId: trimTo(raw.albumId, ALBUM_ID_MAX),
    artistId: trimTo(raw.artistId, ARTIST_ID_MAX),
    artist: trimTo(raw.artist, ARTIST_NAME_MAX),
    lyrics,
    prompt,
    engine,
    modelId,
    durationSec,
    audioFilename,
    renders,
    // Chiptune score (#2911): null = no score; an invalid stored/synced value
    // also normalizes to null (sentinel rule — absent and invalid collapse to
    // "no score", never to a half-valid object the renderer would trip on).
    chiptuneScore: sanitizeChiptuneScore(raw.chiptuneScore),
    chiptunePrompt: trimTo(raw.chiptunePrompt, PROMPT_MAX),
    createdAt,
    updatedAt,
    deleted,
    deletedAt: deleted && isStr(raw.deletedAt) && raw.deletedAt.trim() ? raw.deletedAt : null,
  };
}

/**
 * The bare music-library filename for a track's audio (already a basename), or
 * null when no audio is attached. Tracks store the filename directly (not a
 * URL), so this is mostly an existence/trim guard for the asset pipeline.
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
    renders: Array.isArray(input.renders) ? input.renders : [],
    createdAt: now,
    updatedAt: now,
    deleted: false,
    deletedAt: null,
  });
}

/**
 * Build a render-history entry from generation/upload metadata. The caller
 * supplies a unique `id` and `now` timestamp so this stays pure (no crypto/clock
 * I/O in logic.js). Returns null when there's no audio filename (sanitizeRender
 * contract).
 */
export function makeRender(input, { id, now } = {}) {
  return sanitizeRender({ ...input, id, createdAt: now });
}

/**
 * Compute the patch that makes `renderId` the ACTIVE render — copy its audio
 * pointer + gen metadata to the top level. Returns null if the render isn't in
 * the history. Deliberately does NOT touch the user-authored `prompt`/`lyrics`
 * (those are the editable source of the next generation, independent of which
 * past render is selected for playback).
 */
export function selectRenderPatch(current, renderId) {
  const r = (current?.renders || []).find((x) => x.id === renderId);
  if (!r) return null;
  return { audioFilename: r.audioFilename, engine: r.engine, modelId: r.modelId, durationSec: r.durationSec };
}

/**
 * Compute the patch that removes `renderId` from the history. When the removed
 * render was the active one, re-point the active fields at the newest remaining
 * render (or clear them when none remain). Returns null if the render isn't in
 * the history. The audio bytes are left in the shared library (may be shared).
 */
export function deleteRenderPatch(current, renderId) {
  const renders = current?.renders || [];
  const removed = renders.find((x) => x.id === renderId);
  if (!removed) return null;
  const next = renders.filter((x) => x.id !== renderId);
  const patch = { renders: next };
  if (removed.audioFilename === current.audioFilename) {
    // Re-point the active fields at the newest remaining take (reusing the same
    // mirror that selectRenderPatch applies), or clear them when none remain.
    const newest = next.length ? next[next.length - 1] : null;
    Object.assign(
      patch,
      newest
        ? selectRenderPatch({ renders: next }, newest.id)
        : { audioFilename: '', engine: '', modelId: '', durationSec: null },
    );
  }
  return patch;
}

// The user-authored fields a partial patch may overwrite. `id`, the LWW/
// tombstone trio, and `createdAt` are server-owned / structural. `renders` is
// server-managed (generate/upload/select/delete-render routes set it); the
// generic create/patch route schemas omit it so a client can't inject history.
const PATCHABLE = [
  'title', 'albumId', 'artistId', 'artist', 'lyrics', 'prompt', 'engine', 'modelId', 'durationSec', 'audioFilename', 'renders',
  'chiptuneScore', 'chiptunePrompt',
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
