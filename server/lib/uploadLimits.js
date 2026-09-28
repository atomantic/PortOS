/**
 * JSON transport limits for legacy base64 uploads.
 *
 * Legacy callers send files base64-encoded inside a JSON body, where the
 * Express body-parser limit sets the transport ceiling. Multipart uploads
 * stream files separately and are not constrained by this JSON limit.
 * Base64 inflates bytes by 4/3, so a route advertising a cap above
 * `JSON_BODY_LIMIT × 3/4` is advertising something unreachable: the parser
 * 413s before the route's own size check ever runs, and the user sees an
 * opaque failure instead of a limit message.
 *
 * Keeping the parser limit and the derived file cap in one module is the same
 * pattern `server/lib/ports.js` uses for the port map — change the limit here
 * and every JSON upload consumer follows. The client mirrors
 * `MAX_BASE64_UPLOAD_BYTES` as `JSON_UPLOAD_MAX_FILE_SIZE` in `client/src/utils/fileUpload.js` (it can't
 * import server modules); `uploadLimits.test.js` is what keeps the two honest.
 */

// Body-parser limit applied in server/index.js to express.json/urlencoded.
export const JSON_BODY_LIMIT = '55mb';

// Parsed form of JSON_BODY_LIMIT, in bytes.
export const JSON_BODY_LIMIT_BYTES = 55 * 1024 * 1024;

// Base64 encodes 3 bytes as 4 characters.
const BASE64_INFLATION = 4 / 3;

/**
 * Largest raw file that still fits the body limit once base64-encoded, rounded
 * DOWN to a whole MB so the number we show users is both honest and tidy.
 * (55MB ÷ 4/3 ≈ 41.25MB → 41MB.)
 */
export const MAX_BASE64_UPLOAD_BYTES =
  Math.floor(JSON_BODY_LIMIT_BYTES / BASE64_INFLATION / (1024 * 1024)) * 1024 * 1024;

// Screenshots are pasted/dragged UI captures, not archives — a much smaller
// cap than the wire allows is a deliberate product choice, not a wire limit.
export const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
