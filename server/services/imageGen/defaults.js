/**
 * Image Gen — shared default constants.
 *
 * Standalone for the same reason as modes.js: the dispatcher (`index.js`)
 * and the provider modules (`external.js`, …) both import, so the base
 * negative prompt is defined exactly once on the server. The client keeps
 * its own mirror in `client/src/lib/imageGenDefaults.js` because it cannot
 * import server modules; `defaults.parity.test.js` fails when the two
 * drift apart.
 */

export const DEFAULT_NEGATIVE_PROMPT = 'blurry, low quality, distorted, deformed, ugly, watermark, text, signature';
