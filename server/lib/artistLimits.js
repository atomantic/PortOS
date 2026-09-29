// Length/count caps for artists records. Pure constants so the server sanitizer
// (services/artists/logic.js) and the client editors import ONE definition —
// see storyArcLimits.js for the same pattern.
export const NAME_MAX = 120;
export const GENRE_MAX = 120;
export const BIO_MAX = 4000;
export const MUSICAL_STYLE_MAX = 4000;
export const PHYSICAL_DESCRIPTION_MAX = 2000;
export const PORTRAIT_STYLE_MAX = 2000;
export const PORTRAIT_IMAGE_URL_MAX = 1000;
