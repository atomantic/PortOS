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
 *     audio, output length follows the audio, priced per output second by
 *     resolution — lib/falVideoModels.js) is listed. Grok's CLI image_to_video lane takes no audio at all, so
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
 *   - `shotSplitLimit` / `planShotSplit` — how such an over-long shot is split:
 *     contiguous pieces within the lane's per-take limit, cut at a pause between
 *     sung lines, a lyric/phrase boundary or a beat (in that order).
 *
 *   - `falSceneTake` — the fal.ai request (model, length, resolution) a scene
 *     take makes on the fal lane and its estimated cost, shared by the board,
 *     the submit path and the production autopilot's spend cap.
 *
 * Dependency-free (only grokVideoClip.js and falVideoModels.js, themselves
 * dependency-free) so the client
 * re-exports it from `client/src/lib/musicVideoShotTiming.js` and the two sides
 * cannot drift.
 */

import { GROK_VIDEO_DURATIONS, nearestGrokDuration } from './grokVideoClip.js';
import {
  FAL_DEFAULT_IMAGE_VIDEO_MODEL,
  FAL_LIPSYNC_VIDEO_MODEL,
  coerceFalVideoSeconds,
  describeFalVideoRate,
  estimateFalVideoCostUsd,
  falVideoResolutions,
  getFalVideoModel,
  resolveFalVideoResolution,
} from './falVideoModels.js';

export const MUSIC_VIDEO_SHOT_MODES = Object.freeze(['cutaway', 'performance']);

/**
 * A scene with no `shotMode` (every pre-#8977 record) is a cutaway. A
 * performance is sung footage, so it only applies on the footage layer
 * (#8985): a still or title-card scene is never lip-synced.
 */
export const isPerformanceScene = (scene) => scene?.shotMode === 'performance'
  && (scene.visualLayer == null || scene.visualLayer === 'footage');

/**
 * The shot instruction of a performance scene's SELECTED video take, or null —
 * for a cutaway scene (even one whose selected take was once generated as a
 * performance), or a take with no usable edit points.
 */
export function selectedPerformanceInstruction(scene) {
  if (!isPerformanceScene(scene) || !scene.videoHistoryId) return null;
  const take = (Array.isArray(scene.takes) ? scene.takes : [])
    .find((t) => t?.kind === 'video' && t.assetId === scene.videoHistoryId);
  const instruction = take?.shotInstruction;
  const edit = instruction?.edit;
  if (instruction?.shotMode !== 'performance' || !Number.isFinite(edit?.inSec) || !Number.isFinite(edit?.outSec)) return null;
  return edit.inSec >= 0 && edit.outSec > edit.inSec ? instruction : null;
}

// Safety margin kept inside the provider's documented bounds so ffmpeg's
// sample rounding can never land a window a hair under the minimum (rejected)
// or over the maximum (silently clipped by the provider).
export const PERFORMANCE_WINDOW_MARGIN_SEC = 0.05;

/**
 * Default output resolution of a Music Video performance take. fal's own
 * default is 768P; a sung close-up is the shot a viewer scrutinizes most, so
 * the board asks for 1080P unless the project pins another
 * (`videoSettings.falLipSyncResolution`).
 */
export const MUSIC_VIDEO_LIPSYNC_DEFAULT_RESOLUTION = '1080P';

/**
 * Verified source-audio lip-sync lanes, keyed by Music Video backend.
 *
 * `maxAudioSec` is PortOS's per-take ceiling, not the provider's: fal accepts
 * up to 15 minutes of audio. A performance take is one shot of the edit, and a
 * flawed take can only be re-rolled whole, so a take is kept to about one
 * sung phrase — 30s — and a longer shot is split on a lyric boundary. 30s also
 * matches Seedance 2.5's audio-reference ceiling (30.2s), so a shot split for
 * one lip-sync lane fits the other. Takes past 15s are billed at 1.2×; the
 * cost label says so, and a director who wants to avoid it splits shorter.
 */
export const SOURCE_AUDIO_LIPSYNC = Object.freeze({
  fal: Object.freeze({
    provider: 'fal',
    label: 'fal.ai MiniMax H3 lip-sync',
    modelId: FAL_LIPSYNC_VIDEO_MODEL,
    minAudioSec: 5,
    maxAudioSec: 30,
    transcription: true,
    resolutions: Object.freeze(falVideoResolutions(getFalVideoModel(FAL_LIPSYNC_VIDEO_MODEL))),
    defaultResolution: MUSIC_VIDEO_LIPSYNC_DEFAULT_RESOLUTION,
    // The published rate at the default resolution; the board shows each
    // take's own estimate beside it (falSceneTake).
    costLabel: `${describeFalVideoRate(FAL_LIPSYNC_VIDEO_MODEL, MUSIC_VIDEO_LIPSYNC_DEFAULT_RESOLUTION)} — billed to your fal.ai account`,
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
      ...(Array.isArray(cue.words) ? { words: cue.words
        .filter((word) => word && Number.isFinite(word.startSec) && Number.isFinite(word.endSec) && word.endSec > word.startSec && word.endSec > windowStartSec && word.startSec < windowEndSec)
        .map((word) => ({ text: word.text, startSec: round6(Math.max(windowStartSec, word.startSec) - windowStartSec), endSec: round6(Math.min(windowEndSec, word.endSec) - windowStartSec) })) } : {}),
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

/**
 * The longest single shot `backend` can render for `scene` without losing song
 * coverage, or null when no per-take limit applies: a performance shot is bound
 * by its lip-sync provider's audio window (inside the safety margin), a Grok
 * footage cutaway by the longest clip Grok delivers. Other lanes — and a
 * performance shot on a lane that cannot lip-sync at all, which is blocked
 * outright rather than split — have no limit here.
 */
export function shotSplitLimit(scene, backend) {
  if (isPerformanceScene(scene)) {
    const capability = performanceCapability(backend);
    return capability ? round6(capability.maxAudioSec - PERFORMANCE_WINDOW_MARGIN_SEC) : null;
  }
  const footage = scene?.visualLayer == null || scene.visualLayer === 'footage';
  return backend === 'grok' && footage ? GROK_VIDEO_DURATIONS[GROK_VIDEO_DURATIONS.length - 1] : null;
}

// Shortest piece a split may produce, so a cut never strands a sliver shot.
export const SHOT_SPLIT_MIN_PIECE_SEC = 1;

// Cut-point preference, best first: a pause between sung lines, a lyric line
// or phrase boundary, a beat; the even-split fallback ranks below all three.
const CUT_RANK = Object.freeze({ pause: 0, line: 1, beat: 2 });
const CUT_KIND = Object.freeze(['pause', 'line', 'beat']);

const timedNumber = (v) => typeof v === 'number' && Number.isFinite(v);

function splitCandidates({ lyricCues, phrases, beats }) {
  const out = [];
  const timedCues = (Array.isArray(lyricCues) ? lyricCues : [])
    .filter((cue) => timedNumber(cue?.startSec))
    .map((cue) => ({ startSec: cue.startSec, endSec: timedNumber(cue.endSec) ? cue.endSec : cue.startSec }))
    .sort((a, b) => a.startSec - b.startSec);
  let sungUntil = -Infinity;
  for (const cue of timedCues) {
    // The middle of the silence between one line and the next is the cleanest
    // cut: neither take has to start or stop mid-word.
    if (cue.startSec > sungUntil && Number.isFinite(sungUntil)) out.push({ t: (sungUntil + cue.startSec) / 2, rank: CUT_RANK.pause });
    out.push({ t: cue.startSec, rank: CUT_RANK.line });
    sungUntil = Math.max(sungUntil, cue.endSec);
  }
  for (const phrase of Array.isArray(phrases) ? phrases : []) {
    if (timedNumber(phrase?.startSec)) out.push({ t: phrase.startSec, rank: CUT_RANK.line });
    if (timedNumber(phrase?.endSec)) out.push({ t: phrase.endSec, rank: CUT_RANK.line });
  }
  for (const beat of Array.isArray(beats) ? beats : []) {
    if (timedNumber(beat)) out.push({ t: beat, rank: CUT_RANK.beat });
  }
  // A point strictly inside a sung line is never a lyric/phrase boundary; a
  // beat may still land there, but that cut is not clean (it splits a word).
  const insideLine = (t) => timedCues.some((cue) => t > cue.startSec + 1e-6 && t < cue.endSec - 1e-6);
  return out
    .map((c) => ({ ...c, clean: !insideLine(c.t) }))
    .filter((c) => c.rank === CUT_RANK.beat || c.clean);
}

// Cut `[startSec, endSec]` into exactly `count` pieces of at most `maxSec`,
// or null when that count cannot keep every piece at least `minPieceSec`.
function cutPieces({ startSec, endSec, maxSec, minPieceSec, count, candidates }) {
  if ((endSec - startSec) / count < minPieceSec) return null;
  const pieces = [];
  let clean = true;
  let cursor = startSec;
  for (let remaining = count; remaining > 1; remaining -= 1) {
    // Any cut in [lo, hi] leaves the rest coverable by `remaining - 1` pieces
    // and keeps both sides at least `minPieceSec` long.
    const lo = Math.max(cursor + minPieceSec, endSec - (remaining - 1) * maxSec);
    const hi = Math.min(cursor + maxSec, endSec - minPieceSec);
    const target = cursor + (endSec - cursor) / remaining;
    let best = null;
    for (const c of candidates) {
      if (c.t < lo - 1e-6 || c.t > hi + 1e-6) continue;
      if (!best || c.rank < best.rank || (c.rank === best.rank && Math.abs(c.t - target) < Math.abs(best.t - target))) best = c;
    }
    clean = clean && Boolean(best?.clean);
    const at = round6(Math.min(hi, Math.max(lo, best ? best.t : target)));
    pieces.push({ startSec: round6(cursor), endSec: at, cut: best ? CUT_KIND[best.rank] : 'even' });
    cursor = at;
  }
  pieces.push({ startSec: round6(cursor), endSec: round6(endSec), cut: null });
  return { pieces, clean };
}

// How many pieces beyond the minimum a split may add to avoid cutting a sung
// line mid-word. Each piece is a separate (possibly paid) take, so the search
// stays tight: one extra take for a clean cut, never more.
export const SHOT_SPLIT_MAX_EXTRA_PIECES = 1;

/**
 * Split a shot spanning `[startSec, endSec]` into contiguous pieces of at most
 * `maxSec` each, cutting on musical boundaries: the pause between two timed
 * lyric lines first, then a line or phrase boundary, then a beat, and only
 * when none lies in reach an even cut. It uses the fewest pieces unless one
 * more (`SHOT_SPLIT_MAX_EXTRA_PIECES`) is what lets every cut avoid splitting
 * a sung line. Pieces cover the span exactly — no gap, no overlap — so nothing
 * is looped, stretched or dropped.
 *
 * Returns `{ ok: true, pieces: [{ startSec, endSec, cut }] }` — `cut` names what
 * the piece's END was cut on (`pause` | `line` | `beat` | `even`; null for
 * the last piece, which ends where the shot did) — or `{ ok: false, code,
 * message }` when the shot is untimed or already fits.
 */
export function planShotSplit({ startSec, endSec, maxSec, lyricCues, phrases, beats, minPieceSec = SHOT_SPLIT_MIN_PIECE_SEC }) {
  if (!timedNumber(startSec) || !timedNumber(endSec) || !(endSec > startSec)) {
    return { ok: false, code: 'MUSIC_VIDEO_SPLIT_UNTIMED', message: 'Set a start and end before splitting a shot.' };
  }
  if (!(maxSec > 0) || endSec - startSec <= maxSec + 1e-6) {
    return { ok: false, code: 'MUSIC_VIDEO_SPLIT_NOT_NEEDED', message: 'This shot already fits in a single take.' };
  }
  const candidates = splitCandidates({ lyricCues, phrases, beats });
  // The same 1µs tolerance as the fits-one-take check above: float noise in
  // a span like 29.9999999 must not demand a fourth 10s piece, and no piece
  // may exceed the limit by more than that tolerance.
  const fewest = Math.ceil((endSec - startSec - 1e-6) / maxSec);
  const base = { startSec, endSec, maxSec, minPieceSec, candidates };
  const first = cutPieces({ ...base, count: fewest });
  let chosen = first;
  for (let extra = 1; !chosen.clean && extra <= SHOT_SPLIT_MAX_EXTRA_PIECES; extra += 1) {
    const more = cutPieces({ ...base, count: fewest + extra });
    if (more?.clean) chosen = more;
  }
  return { ok: true, pieces: chosen.pieces };
}

/**
 * The fal.ai request one take of `scene` makes on the fal lane, and its
 * estimated cost — the single answer the board's cost line, the submit
 * payload and the production autopilot's dollar cap all read, so what the
 * director is shown is what is sent and what is charged against the cap.
 *
 * A performance scene renders on the lip-sync route for its planned audio
 * window at `videoSettings.falLipSyncResolution` (default 1080P). A cutaway
 * renders on `videoSettings.falModelId` (default Hailuo-02 image-to-video) at
 * `falResolution` (default: the model's), for the pinned `falDuration` or else
 * the shot's span — rounded UP to a length the model delivers, so the clip
 * covers the shot. An uncurated model keeps the legacy contract (only an
 * explicit pin is sent) and reports cost unknown.
 *
 * Returns `{ performance, modelId, seconds, resolution, costUsd }`; `seconds`
 * and `costUsd` are null when unknown (an untimed or unplannable performance,
 * an uncurated model).
 */
export function falSceneTake({ scene, videoSettings = {}, songDurationSec = null } = {}) {
  const settings = videoSettings || {};
  if (isPerformanceScene(scene)) {
    const capability = SOURCE_AUDIO_LIPSYNC.fal;
    const model = getFalVideoModel(capability.modelId);
    const resolution = resolveFalVideoResolution(model, settings.falLipSyncResolution || capability.defaultResolution);
    const plan = planPerformanceWindow({
      startSec: scene.startSec, endSec: scene.endSec, songDurationSec: songDurationSec ?? Infinity, capability,
    });
    const seconds = plan.ok ? plan.windowSec : null;
    return {
      performance: true,
      modelId: capability.modelId,
      seconds,
      resolution,
      costUsd: seconds == null ? null : estimateFalVideoCostUsd({ modelId: capability.modelId, seconds, resolution }),
    };
  }
  const modelId = settings.falModelId || FAL_DEFAULT_IMAGE_VIDEO_MODEL;
  const model = getFalVideoModel(modelId);
  if (!model) {
    return { performance: false, modelId, seconds: settings.falDuration || null, resolution: settings.falResolution || null, costUsd: null };
  }
  const spanSec = typeof scene?.startSec === 'number' && typeof scene?.endSec === 'number' && scene.endSec > scene.startSec
    ? scene.endSec - scene.startSec
    : null;
  const seconds = coerceFalVideoSeconds(model, settings.falDuration || spanSec);
  const resolution = resolveFalVideoResolution(model, settings.falResolution);
  return { performance: false, modelId, seconds, resolution, costUsd: estimateFalVideoCostUsd({ modelId, seconds, resolution }) };
}

/**
 * A `falSceneTake` as `/api/video-gen` fields. A performance take sends only
 * its lip-sync resolution — its length follows the song slice the server cuts;
 * a cutaway names its model, length and resolution. Unknown values stay absent
 * so the server resolves its own defaults (an uncurated model's legacy body).
 */
export const falTakeRequestFields = (take) => (take.performance
  ? (take.resolution ? { falResolution: take.resolution } : {})
  : {
    falModelId: take.modelId,
    ...(take.seconds != null ? { falDuration: take.seconds } : {}),
    ...(take.resolution ? { falResolution: take.resolution } : {}),
  });
