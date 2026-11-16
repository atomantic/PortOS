/**
 * Browser-safe source-span resolution for the layered video timeline: `resolveClipSpan`, `resolveStillFades` and `resolveAudioSpan` clamp trims, fades and offsets to real file lengths.
 *
 * One implementation for the ffmpeg export and the editor preview so both play the same timeline.
 *
 * A saved lane stores the span the author ASKED for, but sources can be shorter (a re-cut history clip, a music file shorter than the guessed placement). The export resolves against the real sources and the preview must use the SAME rules, or a later cut lands seconds off and a fade ramps on the wrong clock
 * (`resolveTimeline` in services/videoTimeline/local.js and client/src/lib/videoTimelineModel.js both call these; no I/O, no React). "Unknown" is never "zero": a source whose length couldn't be established (no frame metadata, no ffprobe, failed metadata load) keeps the authored span.
 */

import { fitFades } from './videoTimelineFades.js';

// Floor for a probe-clamped audio slice: atrim with start === end produces an empty stream that amix rejects.
export const MIN_MEDIA_SEC = 0.05;

// Seconds, or null when unestablishable; rejects non-positive/non-finite so Infinity (a streamed media element) and 0 (a probe that found no duration) read as "unknown", not "available forever" or "nothing".
const knownSeconds = (value) => (Number.isFinite(value) && value > 0 ? value : null);

/** Length of a video-history entry's clip in seconds, or null when unknown. */
export function historySourceDuration(entry) {
  return entry?.numFrames && entry?.fps ? knownSeconds(entry.numFrames / entry.fps) : null;
}

/** The trim a clip segment actually plays: `outSec` clamped to the source length (when known) and the fade pair refit to what's left, so a fade authored for the stored trim can't outlast a shortened clip (ffmpeg renders a negative-start fade as an all-black segment). `duration` is never negative: an `inSec` past the end resolves to 0 and the caller decides (export rejects, preview skips). */
export function resolveClipSpan(segment, sourceDurationSec) {
  const source = knownSeconds(sourceDurationSec);
  const inSec = Math.max(0, segment.inSec || 0);
  const outSec = source != null ? Math.min(segment.outSec || 0, source) : (segment.outSec || 0);
  const duration = Math.max(0, outSec - inSec);
  return { inSec, outSec, duration, ...fitFades(segment.fadeInSec, segment.fadeOutSec, duration) };
}

/** A still's fade pair refit against its own hold. */
export function resolveStillFades(segment) {
  return fitFades(segment.fadeInSec, segment.fadeOutSec, Math.max(0, segment.durationSec || 0));
}

/** The slice of an audio file a bed actually plays given its real length: a probe reporting LESS than requested is authoritative (offset pulled back inside, length shrunk, fades refit); an unknown length (`null`, failed probe, a media element that never reported) returns the authored slice untouched. */
export function resolveAudioSpan(track, fileDurationSec) {
  const offsetSec = track.offsetSec || 0;
  const durationSec = track.durationSec || 0;
  const available = knownSeconds(fileDurationSec);
  if (available == null) {
    return { offsetSec, durationSec, fadeInSec: track.fadeInSec || 0, fadeOutSec: track.fadeOutSec || 0 };
  }
  const fittedOffset = Math.min(offsetSec, Math.max(0, available - MIN_MEDIA_SEC));
  const fittedDuration = Math.min(durationSec, Math.max(MIN_MEDIA_SEC, available - fittedOffset));
  return {
    offsetSec: fittedOffset,
    durationSec: fittedDuration,
    ...fitFades(track.fadeInSec, track.fadeOutSec, fittedDuration),
  };
}
