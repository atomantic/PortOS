// Image-gen defaults shared between the full Image Gen form and quick-submit
// entry points (e.g. the Dashboard Quick Image widget).
//
// The server mirrors DEFAULT_NEGATIVE_PROMPT in
// `server/services/imageGen/index.js` and `server/services/imageGen/external.js`
// — when changing this string, update both server copies too.

export const DEFAULT_NEGATIVE_PROMPT = 'blurry, low quality, distorted, deformed, ugly, watermark, text, signature';
