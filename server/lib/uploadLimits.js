/**
 * Shared upload limits for JSON/base64 and bounded binary requests.
 *
 * single source of truth for upload size caps (`JSON_BODY_LIMIT`/`JSON_BODY_LIMIT_BYTES` applied by express.json in `index.js`, `MAX_BASE64_UPLOAD_BYTES` derived from it, `MAX_SCREENSHOT_BYTES`), as `server/lib/ports.js` is for ports.
 * Legacy callers send base64 files inside a JSON body (multipart streams separately and isn't constrained by this). Base64 inflates bytes by 4/3, so a route advertising a cap above `JSON_BODY_LIMIT × 3/4` is unreachable: the parser 413s before the route's size check, with an opaque failure instead of a limit message. The client mirrors it as `JSON_UPLOAD_MAX_FILE_SIZE` in `client/src/utils/fileUpload.js` (it can't import server modules); `uploadLimits.test.js` keeps them honest.
 */

export const JSON_BODY_LIMIT = '55mb';

export const JSON_BODY_LIMIT_BYTES = 55 * 1024 * 1024;

const BASE64_INFLATION = 4 / 3;

export const MAX_BASE64_UPLOAD_BYTES =
  Math.floor(JSON_BODY_LIMIT_BYTES / BASE64_INFLATION / (1024 * 1024)) * 1024 * 1024;

export const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;

// Assistant speech WAV is sent to the local avatar worker through a bounded pipe.
export const MAX_AVATAR_WAV_BYTES = 2 * 1024 * 1024;
