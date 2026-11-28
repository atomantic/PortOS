// Length/count caps for tracks records. Pure constants so the server sanitizer
// (services/tracks/logic.js) and the client editors import ONE definition —
// see storyArcLimits.js for the same pattern.
//
// Track record length/count caps shared by the tracks sanitizer and client editors.
export const TITLE_MAX = 200;
export const ALBUM_ID_MAX = 80;
export const ARTIST_ID_MAX = 80;
export const ARTIST_NAME_MAX = 120;
export const CONCEPT_MAX = 8000;
export const LYRICS_MAX = 20000;
export const PROMPT_MAX = 8000;
export const ENGINE_MAX = 60;
export const MODEL_ID_MAX = 120;
export const EXECUTION_PROFILE_MAX = 80;
export const AUDIO_FILENAME_MAX = 256;
export const RENDER_ID_MAX = 80;
export const RENDER_SOURCE_MAX = 40;
export const RENDERS_MAX = 100;

export const RENDER_SOURCES = Object.freeze({ UPLOAD: 'upload', SUNO: 'suno', YOUTUBE: 'youtube' });

// Cap the render history per track so a runaway generate loop can't grow the
// record unboundedly. Oldest renders fall off first (slice(-RENDERS_MAX)); the
// audio bytes stay in the shared library (they may be referenced elsewhere).
// A track clip's usable duration band — wide enough for a long-form generation,
// bounded so a garbage value can't poison the record.
export const DURATION_MIN_SEC = 1;

export const DURATION_MAX_SEC = 3600;
