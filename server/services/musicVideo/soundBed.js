/**
 * Music Video — optional sound-design bed (#8988, part of #8966).
 *
 * The song is the video's sole audio master by default. A director may
 * EXPLICITLY choose one music-library track as a sound-design bed (ambience,
 * risers, texture); the render mixes it UNDER the master through the shared
 * audio-bed chain (`videoTimeline/audioBedMix.js`, the same one the video
 * timeline render uses). The master keeps its full level and its length —
 * the bed is trimmed to the song and can never extend or replace it. With no
 * bed chosen the render maps the master track as the only audio, unchanged.
 *
 * Peer sync: `soundBed` is an additive field on the whole-record LWW project
 * body. An older peer stores it verbatim and renders without it, which is the
 * pre-#8988 behaviour, so no `musicVideoProjects` schema bump is needed.
 */

import { isNonBlankStr } from '../../lib/textUtils.js';

const DEFAULT_SOUND_BED_VOLUME = 0.3;
const MIN_SOUND_BED_VOLUME = 0.05;
const MAX_SOUND_BED_VOLUME = 1;

const clampVolume = (v) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_SOUND_BED_VOLUME;
  return Math.min(MAX_SOUND_BED_VOLUME, Math.max(MIN_SOUND_BED_VOLUME, Math.round(v * 100) / 100));
};

/**
 * Normalize a `soundBed` patch value. `null` (or anything without a track)
 * clears the bed — the song alone is the soundtrack again.
 */
export function normalizeSoundBed(input) {
  if (!input || typeof input !== 'object' || !isNonBlankStr(input.trackId)) return null;
  return { trackId: input.trackId.trim(), volume: clampVolume(input.volume) };
}

/** The project's chosen bed, or null when the song is the sole audio. */
export const projectSoundBed = (project) => normalizeSoundBed(project?.soundBed);
