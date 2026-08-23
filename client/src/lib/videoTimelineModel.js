/**
 * Pure model helpers for the layered video timeline (schemaVersion 2).
 *
 * Mirrors server/services/videoTimeline/segments.js so the browser preview and
 * the ffmpeg export make the SAME cut, geometry, and mix decisions — the whole
 * point of the lane model is that what the editor shows is what renders. When
 * a rule changes on one side (fade curve, overlay placement, asset kinds),
 * change it on the other in the same commit.
 *
 * No React, no I/O — safe to import from the page, its child components, and
 * tests alike.
 */

import { clamp } from '../utils/formatters';

export const IMAGE_ASSET_KINDS = ['images', 'video-thumbnails'];
export const AUDIO_ASSET_KINDS = ['audio', 'music'];

// data/ subdirectory → the URL prefix the server exposes it under.
const ASSET_URL_PREFIX = {
  images: '/data/images',
  'video-thumbnails': '/data/video-thumbnails',
  audio: '/data/audio',
  music: '/data/music',
};

/** Browser URL for an `{ assetKind, assetFile }` pair, or null when unknown. */
export const assetUrl = (assetKind, assetFile) => {
  const prefix = ASSET_URL_PREFIX[assetKind];
  if (!prefix || !assetFile) return null;
  return `${prefix}/${encodeURIComponent(assetFile)}`;
};

/** Project-time length a video-lane segment occupies. */
export const segmentDuration = (segment) => {
  if (!segment) return 0;
  if (segment.type === 'still') return Math.max(0, segment.durationSec || 0);
  return Math.max(0, (segment.outSec || 0) - (segment.inSec || 0));
};

export const timelineDuration = (segments) => (segments || []).reduce((sum, s) => sum + segmentDuration(s), 0);

/**
 * Map project-time `t` to the (segmentIndex, withinSegmentSec) pair the
 * preview needs. The strict `t < acc + dur` comparison falls through on exact
 * boundaries so a playhead landing on a seam shows the NEXT segment, not the
 * last frame of the prior one.
 */
export const findSegmentAt = (segments, t) => {
  let acc = 0;
  for (let i = 0; i < segments.length; i++) {
    const dur = segmentDuration(segments[i]);
    if (t < acc + dur || i === segments.length - 1) {
      return { index: i, within: Math.max(0, t - acc), startAtProj: acc };
    }
    acc += dur;
  }
  return { index: -1, within: 0, startAtProj: 0 };
};

/**
 * Fade multiplier at `within` seconds into something `duration` long.
 *
 * Linear, matching ffmpeg's default `fade`/`afade` curve (`tri`). A zero-length
 * fade returns 1 rather than dividing by zero, and the two fades multiply where
 * they overlap — the server refuses to persist an overlapping pair, but a
 * probe-clamped duration can create one at render time.
 */
export const fadeMultiplier = (fadeInSec, fadeOutSec, duration, within) => {
  if (!(duration > 0)) return 1;
  const clamped = Math.min(Math.max(within, 0), duration);
  let m = 1;
  if (fadeInSec > 0) m *= Math.min(1, clamped / fadeInSec);
  if (fadeOutSec > 0) m *= Math.min(1, (duration - clamped) / fadeOutSec);
  return Math.min(1, Math.max(0, m));
};

/**
 * Effective opacity of an overlay at project-time `t` — 0 outside its window,
 * its configured opacity inside, scaled by whichever alpha fade is active.
 */
export const overlayOpacityAt = (overlay, t) => {
  if (!overlay) return 0;
  const start = overlay.startSec || 0;
  const dur = Math.max(0, overlay.durationSec || 0);
  if (dur <= 0 || t < start || t > start + dur) return 0;
  const base = overlay.opacity == null ? 1 : overlay.opacity;
  return base * fadeMultiplier(overlay.fadeInSec || 0, overlay.fadeOutSec || 0, dur, t - start);
};

/**
 * Where an audio track sits relative to project-time `t`.
 * `active` is false outside its window; `within` is seconds into the track's
 * own (already offset) timeline, which is what the preview element seeks to.
 */
export const audioTrackStateAt = (track, t) => {
  const start = track?.startSec || 0;
  const dur = Math.max(0, track?.durationSec || 0);
  const active = dur > 0 && t >= start && t < start + dur;
  const within = Math.min(Math.max(t - start, 0), dur);
  const volume = active
    ? (track.volume == null ? 1 : track.volume)
      * fadeMultiplier(track.fadeInSec || 0, track.fadeOutSec || 0, dur, within)
    : 0;
  return { active, within, sourceTime: (track?.offsetSec || 0) + within, volume };
};

/** Drop the client-only `_key` identity dnd-kit needs before PATCHing. */
export const stripKey = (entry) => {
  if (!entry || typeof entry !== 'object') return entry;
  const { _key, ...rest } = entry;
  return rest;
};

/**
 * The PATCH body for a timeline save. Lanes are sent whole — the server
 * replaces each lane it receives — and `_key`s are stripped so they never
 * reach the persisted project.
 */
export const timelinePatch = ({ segments, overlays, audio }) => ({
  segments: (segments || []).map(stripKey),
  overlays: (overlays || []).map(stripKey),
  audio: {
    clipVolume: audio?.clipVolume == null ? 1 : audio.clipVolume,
    tracks: (audio?.tracks || []).map(stripKey),
  },
});

/** Stable dnd/React identity for a lane entry. Never persisted. */
export const laneKey = (prefix, idx) => `${prefix}-${idx}-${Math.random().toString(36).slice(2, 8)}`;

/** Attach `_key` to every entry of a lane loaded from the server. */
export const withKeys = (entries, prefix) => (entries || []).map((e, idx) => ({ ...e, _key: laneKey(prefix, idx) }));

/**
 * Shrink a fade pair that no longer fits its own duration, scaling both
 * proportionally so the author's balance survives. Mirrors the server's
 * `fitFades` (`server/services/videoTimeline/local.js`) — ffmpeg's `fade`
 * renders the whole segment black when its start time goes negative, and the
 * persist-time validator rejects an over-long pair outright, so the editor
 * shrinks rather than letting the PATCH 400 mid-edit.
 *
 * Returns the caller's `patch` with the fades folded in only when they had to
 * move, so an already-fitting edit round-trips untouched.
 */
export function fitFadePatch(entry, patch, duration) {
  const merged = { ...entry, ...patch };
  const fin = Math.max(0, merged.fadeInSec || 0);
  const fout = Math.max(0, merged.fadeOutSec || 0);
  if (fin + fout <= duration) return patch;
  const scale = fin + fout > 0 ? Math.max(0, duration) / (fin + fout) : 0;
  return { ...patch, fadeInSec: fin * scale, fadeOutSec: fout * scale };
}

/**
 * Clamp a trim edit to `0..sourceDur`, keeping at least one frame between in
 * and out. The floor is `1/fps` to match the server's CLIP_TOO_SHORT guard —
 * a hardcoded floor was too lenient at 24fps and let the editor build a
 * project the render then rejected with a 400.
 */
export function clampTrim(segment, patch, sourceDur, fps) {
  const limit = sourceDur || Infinity;
  const minDur = fps && fps > 0 ? 1 / fps : 0.04;
  let inSec = patch.inSec != null ? patch.inSec : segment.inSec;
  let outSec = patch.outSec != null ? patch.outSec : segment.outSec;
  inSec = Math.max(0, Math.min(inSec, limit - minDur));
  outSec = Math.max(inSec + minDur, Math.min(outSec, limit));
  return fitFadePatch(segment, { inSec, outSec }, outSec - inSec);
}

/**
 * Effective playback volume for a video segment at `within` seconds in — the
 * project's clip-audio multiplier, the segment's own trim, and its fade ramp,
 * exactly as the export composes them (`volume=` ahead of `afade` in the
 * segment's audio chain).
 */
export const segmentVolumeAt = (segment, clipVolume, within) => {
  if (!segment || segment.type === 'still') return 0;
  const duration = segmentDuration(segment);
  const base = (clipVolume == null ? 1 : clipVolume) * (segment.volume == null ? 1 : segment.volume);
  return clamp(base * fadeMultiplier(segment.fadeInSec || 0, segment.fadeOutSec || 0, duration, within), 0, 1);
};
