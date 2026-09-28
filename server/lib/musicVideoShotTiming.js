/**
 * Music Video shot modes and provider-aware timing (#8977).
 *
 * A scene is either a CUTAWAY (the default — any image-to-video lane animates
 * the reference frame; the master song is laid under it at render time) or a
 * PERFORMANCE shot: a visible singer whose mouth must follow the actual master
 * recording. Prompting cannot deliver that; only a provider that accepts the
 * exact song audio as conditioning can. This module is the one definition of
 * which lanes can, and of the timing math both runtimes share:
 *
 *   - `SOURCE_AUDIO_LIPSYNC` — the capability snapshot per backend. Only fal.ai's
 *     documented MiniMax H3 lip-sync route (image_url + audio_url, at least 5s of
 *     audio, silently clipped beyond 14.8s, output length follows the clipped
 *     audio) is listed. Grok's CLI image_to_video lane takes no audio at all, so
 *     it is cutaway-only here until an actual adapter proves exact-source-audio
 *     conditioning — REST documentation for a different Grok surface is not that
 *     proof. Local runtimes are absent for the same reason.
 *   - `planPerformanceWindow` — the audio window a performance shot submits:
 *     inside the provider's limits (never relying on its silent truncation), a
 *     short shot padded to a supported contextual window with an explicit edit
 *     in-point, a long shot refused so the director splits it on a lyric/phrase
 *     boundary. Nothing is looped or time-stretched to fill a slot.
 *   - `grokCoverage` — the 6/10-second Grok request that COVERS a cutaway shot
 *     (reusing `nearestGrokDuration`), flagging spans a single clip cannot cover.
 *
 * Dependency-free (only grokVideoClip.js, itself dependency-free) so the client
 * re-exports it from `client/src/lib/musicVideoShotTiming.js` and the two sides
 * cannot drift.
 */

import { GROK_VIDEO_DURATIONS, nearestGrokDuration } from './grokVideoClip.js';

export const MUSIC_VIDEO_SHOT_MODES = Object.freeze(['cutaway', 'performance']);

/** A scene with no `shotMode` (every pre-#8977 record) is a cutaway. */
export const isPerformanceScene = (scene) => scene?.shotMode === 'performance';

// Safety margin kept inside the provider's documented bounds so ffmpeg's
// sample rounding can never land a window a hair under the minimum (rejected)
// or over the maximum (silently clipped by the provider).
export const PERFORMANCE_WINDOW_MARGIN_SEC = 0.05;

/** Verified source-audio lip-sync lanes, keyed by Music Video backend. */
export const SOURCE_AUDIO_LIPSYNC = Object.freeze({
  fal: Object.freeze({
    provider: 'fal',
    label: 'fal.ai MiniMax H3 lip-sync',
    modelId: 'minimax/h3-max/lip-sync/image-to-video',
    minAudioSec: 5,
    maxAudioSec: 14.8,
    transcription: true,
    // fal.ai publishes no per-request price PortOS can read; say so plainly
    // rather than inventing an estimate.
    costLabel: 'cost unknown — billed to your fal.ai account',
  }),
});

/** The lip-sync capability a backend offers, or null. */
export const performanceCapability = (backend) => (
  Object.prototype.hasOwnProperty.call(SOURCE_AUDIO_LIPSYNC, backend || '') ? SOURCE_AUDIO_LIPSYNC[backend] : null
);

/**
 * Why a performance shot cannot render on `backend`, or null when it can.
 * `backend` is the project's pinned Music Video backend ('' / null = the
 * install default, which is never assumed to be a lip-sync provider).
 */
export function performanceBlockedReason(backend) {
  if (performanceCapability(backend)) return null;
  if (backend === 'grok') {
    return 'Grok video is cutaway-only: it cannot synchronize a singer to the song. Pin fal.ai for performance shots, or switch this scene to Cutaway.';
  }
  if (backend === 'local') {
    return 'Local video models cannot lip-sync to the song. Pin fal.ai for performance shots, or switch this scene to Cutaway.';
  }
  return 'Performance shots need a source-audio lip-sync provider — pin fal.ai as this project\'s video backend.';
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;

/**
 * The audio window a performance shot submits, for a scene spanning
 * `[startSec, endSec]` of a song `songDurationSec` long.
 *
 * Returns `{ ok: true, spanSec, windowStartSec, windowEndSec, windowSec,
 * editInSec, editOutSec }` — the window is absolute song time; the edit in/out
 * points are relative to the generated clip (whose length follows the window).
 * Returns `{ ok: false, code, message }` when the shot cannot be planned.
 */
export function planPerformanceWindow({ startSec, endSec, songDurationSec, capability }) {
  if (!capability) {
    return { ok: false, code: 'MUSIC_VIDEO_PERFORMANCE_UNSUPPORTED', message: performanceBlockedReason(null) };
  }
  if (typeof startSec !== 'number' || typeof endSec !== 'number' || !(endSec > startSec) || startSec < 0) {
    return { ok: false, code: 'MUSIC_VIDEO_PERFORMANCE_UNTIMED', message: 'A performance shot needs a timed start and end on the song.' };
  }
  if (!(songDurationSec > 0) || endSec > songDurationSec + 1e-6) {
    return { ok: false, code: 'MUSIC_VIDEO_PERFORMANCE_OUT_OF_RANGE', message: 'The performance shot runs past the end of the song.' };
  }
  const minSec = capability.minAudioSec + PERFORMANCE_WINDOW_MARGIN_SEC;
  const maxSec = capability.maxAudioSec - PERFORMANCE_WINDOW_MARGIN_SEC;
  const spanSec = endSec - startSec;
  if (spanSec > maxSec) {
    return {
      ok: false,
      code: 'MUSIC_VIDEO_PERFORMANCE_TOO_LONG',
      message: `This performance shot runs ${spanSec.toFixed(2)}s, but ${capability.label} synchronizes at most ${maxSec.toFixed(2)}s of audio per take. Split the scene on a lyric or phrase boundary.`,
    };
  }
  if (songDurationSec < minSec) {
    return {
      ok: false,
      code: 'MUSIC_VIDEO_PERFORMANCE_SONG_TOO_SHORT',
      message: `${capability.label} needs at least ${minSec.toFixed(2)}s of audio; the song is only ${songDurationSec.toFixed(2)}s.`,
    };
  }
  let windowStartSec = startSec;
  let windowEndSec = endSec;
  if (spanSec < minSec) {
    // Pad a short shot to a supported contextual window, centered on the shot
    // where the song allows, then shifted to stay inside it. The edit in-point
    // records exactly where the shot starts inside the generated clip.
    const pad = minSec - spanSec;
    windowStartSec = Math.max(0, startSec - pad / 2);
    windowEndSec = windowStartSec + minSec;
    if (windowEndSec > songDurationSec) {
      windowEndSec = songDurationSec;
      windowStartSec = songDurationSec - minSec;
    }
  }
  return {
    ok: true,
    spanSec: round6(spanSec),
    windowStartSec: round6(windowStartSec),
    windowEndSec: round6(windowEndSec),
    windowSec: round6(windowEndSec - windowStartSec),
    editInSec: round6(startSec - windowStartSec),
    editOutSec: round6(endSec - windowStartSec),
  };
}

/**
 * Lyric cues overlapping `[windowStartSec, windowEndSec]`, re-timed relative to
 * the window start and clamped to it. Untimed cues are dropped.
 */
export function clipRelativeCues(cues, windowStartSec, windowEndSec) {
  const out = [];
  for (const cue of Array.isArray(cues) ? cues : []) {
    if (typeof cue?.startSec !== 'number') continue;
    const end = typeof cue.endSec === 'number' ? cue.endSec : cue.startSec;
    if (end < windowStartSec || cue.startSec > windowEndSec) continue;
    out.push({
      text: typeof cue.text === 'string' ? cue.text : '',
      startSec: round6(Math.max(0, cue.startSec - windowStartSec)),
      endSec: round6(Math.min(windowEndSec, end) - windowStartSec),
    });
  }
  return out;
}

/**
 * The Grok CLI request that covers a cutaway shot of `spanSec`: the shortest
 * deliverable clip at least that long (6 or 10s), or the longest when none is.
 * `uncoveredSec > 0` means one clip cannot cover the shot — split the scene
 * rather than loop or stretch the clip.
 */
export function grokCoverage(spanSec) {
  const requestSec = nearestGrokDuration(spanSec);
  const longest = GROK_VIDEO_DURATIONS[GROK_VIDEO_DURATIONS.length - 1];
  const span = Number(spanSec);
  const uncoveredSec = Number.isFinite(span) && span > longest ? round6(span - longest) : 0;
  return { requestSec, uncoveredSec, needsSplit: uncoveredSec > 0 };
}

/**
 * Phrase intents overlapping a cutaway shot, as approximate clip-relative motion
 * prose for providers that take no timed controls (Grok's CLI lane). The timing
 * is explicitly approximate — the provider is not bound to it.
 */
export function approximateMotionCues(phrases, startSec, endSec) {
  if (typeof startSec !== 'number' || typeof endSec !== 'number' || !(endSec > startSec)) return '';
  const beats = [];
  for (const phrase of Array.isArray(phrases) ? phrases : []) {
    const intent = typeof phrase?.intent === 'string' ? phrase.intent.trim() : '';
    if (!intent || typeof phrase.startSec !== 'number') continue;
    const phraseEnd = typeof phrase.endSec === 'number' ? phrase.endSec : phrase.startSec;
    if (phraseEnd <= startSec || phrase.startSec >= endSec) continue;
    beats.push(`around ${Math.max(0, phrase.startSec - startSec).toFixed(1)}s: ${intent}`);
  }
  return beats.length ? `Approximate motion timing within the clip — ${beats.join('; ')}.` : '';
}
