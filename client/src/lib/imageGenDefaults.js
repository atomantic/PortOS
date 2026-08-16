// Image-gen defaults shared between the full Image Gen form and quick-submit
// entry points (e.g. the Dashboard Quick Image widget).
//
// The server keeps its own copy in `server/services/imageGen/defaults.js`
// (the client cannot import server modules). The two are pinned together by
// `server/services/imageGen/defaults.parity.test.js` — change one, and the
// test names the other until they match again.

export const DEFAULT_NEGATIVE_PROMPT = 'blurry, low quality, distorted, deformed, ugly, watermark, text, signature';
