import { fitFades } from './videoTimelineFades.js';

/**
 * Browser-safe source-span resolution for the layered video timeline.
 *
 * A saved lane stores the span the author ASKED for; the sources can be shorter
 * (a history entry whose clip was re-cut, a music file shorter than the
 * guessed placement). The ffmpeg export resolves those spans against the real
 * sources, and the editor preview must resolve them with the SAME rules or it
 * plays a different timeline than the one that renders — a later cut lands
 * seconds off and a fade envelope ramps on the wrong clock. Both sides call
 * these functions (`resolveTimeline` in services/videoTimeline/local.js and the
 * client model in client/src/lib/videoTimelineModel.js); no I/O, no React.
 *
 * "Unknown" is never "zero": a source whose length could not be established
 * (no frame metadata, no ffprobe, a metadata load that failed) keeps the
 * authored span rather than collapsing the lane entry to nothing.
 */

// Floor for a probe-clamped audio slice — atrim with start === end produces an
// empty stream that amix rejects.
export const MIN_MEDIA_SEC = 0.05;

// Seconds, or null when the span cannot be established. Rejects anything that
// is not a positive finite number so Infinity (a streamed media element) and 0
// (a probe that found no duration) read as "unknown", not "available: forever"
// or "available: nothing".
const knownSeconds = (value) => (Number.isFinite(value) && value > 0 ? value : null);

/** Length of a video-history entry's clip in seconds, or null when unknown. */
export function historySourceDuration(entry) {
  return entry?.numFrames && entry?.fps ? knownSeconds(entry.numFrames / entry.fps) : null;
}

/**
 * The trim a clip segment actually plays: `outSec` clamped to the source length
 * (when known) and the fade pair refit against what is left, so a fade authored
 * for the stored trim cannot outlast a shortened clip (ffmpeg renders a fade
 * with a negative start time as an all-black segment). `duration` is never
 * negative — an `inSec` past the end of the source resolves to 0 and the caller
 * decides whether that is an error (the export rejects it; the preview skips it).
 */
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

/**
 * The slice of an audio file a bed actually plays, given the file's real length.
 * A probe reporting LESS than the requested slice is authoritative: the offset
 * is pulled back inside the file, the length shrinks to what remains, and the
 * fades are refit to the shortened length. An unknown length (`null`, a failed
 * probe, a media element that never reported) returns the authored slice
 * untouched — fades included, since nothing shortened them.
 */
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
