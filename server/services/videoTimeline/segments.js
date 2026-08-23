/**
 * Video Timeline — layered segment/lane model (schemaVersion 2).
 *
 * v1 projects persisted a single ordered `clips` array of `{ clipId, inSec,
 * outSec }`, so anything that wasn't a trimmed generated video clip (a held
 * still, a logo overlay, a music bed, a deliberate cross-fade) needed a
 * separate tool or a manual re-render. v2 replaces that with three lanes that
 * the browser preview and the ffmpeg export both read:
 *
 *   segments — the ordered video lane. Heterogeneous: `clip` (a trimmed
 *              entry from video history) or `still` (an image held for a
 *              duration). Each carries its own fade in/out and volume.
 *   overlays — free-floating image overlays positioned in project time and
 *              in normalized canvas space, with their own alpha fades.
 *   audio    — `{ clipVolume, tracks[] }`. `clipVolume` scales the video
 *              lane's own audio; each track places a library file at an
 *              absolute project time with offset/trim/fades.
 *
 * Assets are addressed as `{ assetKind, assetFile }` rather than a free path:
 * `assetKind` selects one of a fixed allowlist of `data/` subdirectories and
 * `assetFile` must be a plain basename, so `resolveAsset` can reuse the
 * existing `safeUnder` containment check instead of trusting a stored path.
 *
 * `clips` stays on every persisted project as a DERIVED mirror of the video
 * lane's clip segments. It is never the source of truth once `segments`
 * exists — it is there so an install rolled back to a v1 build still renders
 * the video lane instead of seeing an empty project.
 */

import { existsSync } from 'fs';
import { PATHS } from '../../lib/fileUtils.js';
import { safeUnder } from '../../lib/ffmpeg.js';
import { ServerError } from '../../lib/errorHandler.js';

export const TIMELINE_SCHEMA_VERSION = 2;

// Allowlisted `data/` subdirectories a timeline asset may come from. Anything
// not in this map is rejected before it can reach ffmpeg.
export const ASSET_ROOTS = {
  images: PATHS.images,
  'video-thumbnails': PATHS.videoThumbnails,
  audio: PATHS.audio,
  music: PATHS.music,
};

export const IMAGE_ASSET_KINDS = ['images', 'video-thumbnails'];
export const AUDIO_ASSET_KINDS = ['audio', 'music'];

export const MAX_SEGMENTS = 200;
export const MAX_OVERLAYS = 50;
export const MAX_AUDIO_TRACKS = 20;
export const MAX_FADE_SEC = 30;
export const MAX_STILL_SEC = 600;
export const MAX_VOLUME = 4;

const bad = (message, context) => new ServerError(message, { status: 400, code: 'VALIDATION_ERROR', context });

/**
 * Resolve an `{ assetKind, assetFile }` pair to an absolute on-disk path, or
 * null when the kind is not allowlisted, the filename is not a safe basename,
 * or the file does not exist. Never returns a path outside the asset root.
 */
export function resolveAsset(assetKind, assetFile, { allowedKinds = null, requireExists = true } = {}) {
  if (allowedKinds && !allowedKinds.includes(assetKind)) return null;
  const root = ASSET_ROOTS[assetKind];
  if (!root) return null;
  const full = safeUnder(root, assetFile);
  if (!full) return null;
  if (requireExists && !existsSync(full)) return null;
  return full;
}

const num = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// Fades are stored per segment/overlay/track and always land inside their
// own duration — a fade longer than the thing it fades produces an ffmpeg
// `fade` with a negative start time, which silently renders black.
const clampFades = (fadeInSec, fadeOutSec, duration, label) => {
  const fin = clamp(num(fadeInSec, 0), 0, MAX_FADE_SEC);
  const fout = clamp(num(fadeOutSec, 0), 0, MAX_FADE_SEC);
  if (fin + fout > duration) {
    throw bad(`${label}: fadeInSec + fadeOutSec (${(fin + fout).toFixed(2)}s) exceeds its duration (${duration.toFixed(2)}s)`);
  }
  return { fadeInSec: fin, fadeOutSec: fout };
};

const assetFields = (raw, allowedKinds, label) => {
  const assetKind = String(raw.assetKind || '').trim();
  if (!allowedKinds.includes(assetKind)) {
    throw bad(`${label}: assetKind must be one of ${allowedKinds.join(', ')}`);
  }
  const assetFile = String(raw.assetFile || '').trim();
  // Containment is re-checked at render time against the live filesystem;
  // this is the persist-time shape guard so a traversal string never lands
  // in the project file at all.
  if (!assetFile || !safeUnder(ASSET_ROOTS[assetKind], assetFile)) {
    throw bad(`${label}: assetFile must be a plain filename inside data/${assetKind}`);
  }
  return { assetKind, assetFile };
};

const validateClipSegment = (raw, label) => {
  const clipId = String(raw.clipId || '').trim();
  if (!/^[a-f0-9-]{36}$/i.test(clipId)) throw bad(`${label}: invalid clipId`);
  const inSec = num(raw.inSec, NaN);
  const outSec = num(raw.outSec, NaN);
  if (!Number.isFinite(inSec) || !Number.isFinite(outSec) || inSec < 0 || outSec <= inSec) {
    throw bad(`${label}: inSec/outSec invalid (need 0 ≤ inSec < outSec)`);
  }
  const { fadeInSec, fadeOutSec } = clampFades(raw.fadeInSec, raw.fadeOutSec, outSec - inSec, label);
  return {
    type: 'clip',
    clipId,
    inSec,
    outSec,
    fadeInSec,
    fadeOutSec,
    volume: clamp(num(raw.volume, 1), 0, MAX_VOLUME),
  };
};

const validateStillSegment = (raw, label) => {
  const { assetKind, assetFile } = assetFields(raw, IMAGE_ASSET_KINDS, label);
  const durationSec = num(raw.durationSec, NaN);
  if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > MAX_STILL_SEC) {
    throw bad(`${label}: durationSec must be in (0, ${MAX_STILL_SEC}]`);
  }
  const { fadeInSec, fadeOutSec } = clampFades(raw.fadeInSec, raw.fadeOutSec, durationSec, label);
  return { type: 'still', assetKind, assetFile, durationSec, fadeInSec, fadeOutSec };
};

/**
 * Validate the ordered video lane. Accepts the v1 shape too — an entry with
 * no `type` but a `clipId` is a legacy clip — so a client that hasn't been
 * updated (or a project loaded from a v1 file) round-trips unchanged.
 */
export function validateSegments(raw) {
  if (!Array.isArray(raw)) throw bad('segments must be an array');
  if (raw.length > MAX_SEGMENTS) throw bad(`segments: at most ${MAX_SEGMENTS} entries`);
  return raw.map((entry, idx) => {
    const label = `Segment ${idx}`;
    if (!entry || typeof entry !== 'object') throw bad(`${label}: must be an object`);
    const type = entry.type || (entry.clipId ? 'clip' : null);
    if (type === 'clip') return validateClipSegment(entry, label);
    if (type === 'still') return validateStillSegment(entry, label);
    throw bad(`${label}: unknown segment type "${entry.type}" (expected clip or still)`);
  });
}

export function validateOverlays(raw) {
  if (!Array.isArray(raw)) throw bad('overlays must be an array');
  if (raw.length > MAX_OVERLAYS) throw bad(`overlays: at most ${MAX_OVERLAYS} entries`);
  return raw.map((entry, idx) => {
    const label = `Overlay ${idx}`;
    if (!entry || typeof entry !== 'object') throw bad(`${label}: must be an object`);
    const { assetKind, assetFile } = assetFields(entry, IMAGE_ASSET_KINDS, label);
    const startSec = Math.max(0, num(entry.startSec, 0));
    const durationSec = num(entry.durationSec, NaN);
    if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > MAX_STILL_SEC) {
      throw bad(`${label}: durationSec must be in (0, ${MAX_STILL_SEC}]`);
    }
    const { fadeInSec, fadeOutSec } = clampFades(entry.fadeInSec, entry.fadeOutSec, durationSec, label);
    return {
      type: 'image',
      assetKind,
      assetFile,
      startSec,
      durationSec,
      // Normalized to the canonical canvas so an overlay keeps its placement
      // when the project's canonical dimensions change (a different first
      // clip). Slight overscan is allowed so a graphic can bleed off-frame.
      x: clamp(num(entry.x, 0), -1, 2),
      y: clamp(num(entry.y, 0), -1, 2),
      width: clamp(num(entry.width, 0.25), 0.01, 4),
      opacity: clamp(num(entry.opacity, 1), 0, 1),
      fadeInSec,
      fadeOutSec,
    };
  });
}

export function validateAudio(raw) {
  if (raw == null) return defaultAudio();
  if (typeof raw !== 'object' || Array.isArray(raw)) throw bad('audio must be an object');
  const rawTracks = raw.tracks == null ? [] : raw.tracks;
  if (!Array.isArray(rawTracks)) throw bad('audio.tracks must be an array');
  if (rawTracks.length > MAX_AUDIO_TRACKS) throw bad(`audio.tracks: at most ${MAX_AUDIO_TRACKS} entries`);
  const tracks = rawTracks.map((entry, idx) => {
    const label = `Audio track ${idx}`;
    if (!entry || typeof entry !== 'object') throw bad(`${label}: must be an object`);
    const { assetKind, assetFile } = assetFields(entry, AUDIO_ASSET_KINDS, label);
    const durationSec = num(entry.durationSec, NaN);
    if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > MAX_STILL_SEC) {
      throw bad(`${label}: durationSec must be in (0, ${MAX_STILL_SEC}]`);
    }
    const { fadeInSec, fadeOutSec } = clampFades(entry.fadeInSec, entry.fadeOutSec, durationSec, label);
    return {
      assetKind,
      assetFile,
      startSec: Math.max(0, num(entry.startSec, 0)),
      offsetSec: Math.max(0, num(entry.offsetSec, 0)),
      durationSec,
      volume: clamp(num(entry.volume, 1), 0, MAX_VOLUME),
      fadeInSec,
      fadeOutSec,
    };
  });
  return { clipVolume: clamp(num(raw.clipVolume, 1), 0, MAX_VOLUME), tracks };
}

export const defaultAudio = () => ({ clipVolume: 1, tracks: [] });

/**
 * The `clips` mirror written alongside `segments`. Only clip segments survive
 * — a v1 build has no way to render a still, and emitting a placeholder entry
 * would make it render the wrong source.
 */
export const deriveLegacyClips = (segments) => segments
  .filter((s) => s.type === 'clip')
  .map((s) => ({ clipId: s.clipId, inSec: s.inSec, outSec: s.outSec }));

/**
 * Upgrade a persisted project to the v2 lane shape in memory. Idempotent, and
 * tolerant of a hand-edited file: a non-array `clips`/`segments`/`overlays`
 * degrades to empty rather than throwing, because this runs on every read.
 *
 * A v1 project (no `segments`) has its `clips` promoted to clip segments. A
 * v2 project keeps `segments` as the source of truth and REBUILDS the `clips`
 * mirror, so a stale mirror written by an older build can never resurrect a
 * removed segment.
 */
export function normalizeProject(project) {
  if (!project || typeof project !== 'object') return project;
  const legacyClips = Array.isArray(project.clips) ? project.clips : [];
  const rawSegments = Array.isArray(project.segments)
    ? project.segments
    : legacyClips.map((c) => ({ type: 'clip', ...c }));

  const segments = rawSegments.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const type = entry.type || (entry.clipId ? 'clip' : null);
    if (type === 'clip') {
      const inSec = Math.max(0, num(entry.inSec, 0));
      const outSec = num(entry.outSec, NaN);
      if (!Number.isFinite(outSec) || outSec <= inSec) return [];
      return [{
        type: 'clip',
        clipId: String(entry.clipId || ''),
        inSec,
        outSec,
        fadeInSec: clamp(num(entry.fadeInSec, 0), 0, MAX_FADE_SEC),
        fadeOutSec: clamp(num(entry.fadeOutSec, 0), 0, MAX_FADE_SEC),
        volume: clamp(num(entry.volume, 1), 0, MAX_VOLUME),
      }];
    }
    if (type === 'still') {
      const durationSec = num(entry.durationSec, NaN);
      if (!Number.isFinite(durationSec) || durationSec <= 0) return [];
      return [{
        type: 'still',
        assetKind: String(entry.assetKind || ''),
        assetFile: String(entry.assetFile || ''),
        durationSec,
        fadeInSec: clamp(num(entry.fadeInSec, 0), 0, MAX_FADE_SEC),
        fadeOutSec: clamp(num(entry.fadeOutSec, 0), 0, MAX_FADE_SEC),
      }];
    }
    return [];
  });

  const overlays = Array.isArray(project.overlays)
    ? project.overlays.filter((o) => o && typeof o === 'object').map((o) => ({
      type: 'image',
      assetKind: String(o.assetKind || ''),
      assetFile: String(o.assetFile || ''),
      startSec: Math.max(0, num(o.startSec, 0)),
      durationSec: Math.max(0, num(o.durationSec, 0)),
      x: clamp(num(o.x, 0), -1, 2),
      y: clamp(num(o.y, 0), -1, 2),
      width: clamp(num(o.width, 0.25), 0.01, 4),
      opacity: clamp(num(o.opacity, 1), 0, 1),
      fadeInSec: clamp(num(o.fadeInSec, 0), 0, MAX_FADE_SEC),
      fadeOutSec: clamp(num(o.fadeOutSec, 0), 0, MAX_FADE_SEC),
    })).filter((o) => o.durationSec > 0)
    : [];

  const rawAudio = project.audio && typeof project.audio === 'object' && !Array.isArray(project.audio)
    ? project.audio
    : {};
  const audio = {
    clipVolume: clamp(num(rawAudio.clipVolume, 1), 0, MAX_VOLUME),
    tracks: Array.isArray(rawAudio.tracks)
      ? rawAudio.tracks.filter((t) => t && typeof t === 'object').map((t) => ({
        assetKind: String(t.assetKind || ''),
        assetFile: String(t.assetFile || ''),
        startSec: Math.max(0, num(t.startSec, 0)),
        offsetSec: Math.max(0, num(t.offsetSec, 0)),
        durationSec: Math.max(0, num(t.durationSec, 0)),
        volume: clamp(num(t.volume, 1), 0, MAX_VOLUME),
        fadeInSec: clamp(num(t.fadeInSec, 0), 0, MAX_FADE_SEC),
        fadeOutSec: clamp(num(t.fadeOutSec, 0), 0, MAX_FADE_SEC),
      })).filter((t) => t.durationSec > 0)
      : [],
  };

  return {
    ...project,
    schemaVersion: TIMELINE_SCHEMA_VERSION,
    segments,
    overlays,
    audio,
    clips: deriveLegacyClips(segments),
  };
}

/** Project-time duration of the video lane. */
export const segmentDuration = (segment) => (segment.type === 'still'
  ? segment.durationSec
  : Math.max(0, segment.outSec - segment.inSec));

export const laneDuration = (segments) => segments.reduce((sum, s) => sum + segmentDuration(s), 0);
