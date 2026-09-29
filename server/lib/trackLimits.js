// Length/count caps for tracks records. Pure constants so the server sanitizer
// (services/tracks/logic.js) and the client editors import ONE definition —
// see storyArcLimits.js for the same pattern.
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
