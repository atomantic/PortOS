/**
 * Music Video per-video sanity bounds (#16196): most subjects and visual references one video may hold.
 *
 * Far above real use so a director adding catalog items by hand is never blocked; the per-shot reference limit is enforced by each renderer, not here.
 */

export const MUSIC_VIDEO_MAX_SUBJECTS = 500;
export const MUSIC_VIDEO_MAX_VISUAL_REFERENCES = 500;

// Timeline audio layers (services/musicVideo/audioLayers.js): most layers one video holds,
// the loudest a layer may be set (2 = +6 dB), and the latest it may start on the song.
export const MUSIC_VIDEO_AUDIO_LAYER_LIMIT = 24;
export const MUSIC_VIDEO_AUDIO_LAYER_MAX_VOLUME = 2;
export const MUSIC_VIDEO_AUDIO_LAYER_MAX_START_SEC = 6 * 60 * 60;
