// Length/count caps for albums records. Pure constants so the server sanitizer
// (services/albums/logic.js) and the client editors import ONE definition —
// see storyArcLimits.js for the same pattern.
export const TITLE_MAX = 200;
export const ARTIST_ID_MAX = 80;
export const ARTIST_NAME_MAX = 120;
export const DESCRIPTION_MAX = 4000;
export const GENRE_MAX = 120;
export const COVER_IMAGE_URL_MAX = 1000;
export const TRACK_IDS_MAX = 200;
export const TRACK_ID_MAX = 80;
export const RELEASE_YEAR_MIN = 1850;
export const RELEASE_YEAR_MAX = 2200;
