// Length/count caps for authors records. Pure constants so the server sanitizer
// (services/authors/logic.js) and the client editors import ONE definition —
// see storyArcLimits.js for the same pattern.
export const NAME_MAX = 120;
export const WRITING_STYLE_MAX = 4000;
export const BIO_MAX = 4000;
export const PHYSICAL_DESCRIPTION_MAX = 2000;
export const HEADSHOT_STYLE_MAX = 2000;
export const HEADSHOT_IMAGE_URL_MAX = 1000;
