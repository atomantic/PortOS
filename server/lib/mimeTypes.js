/** MIME tables, extension policy, and lightweight image format detection. */
import { basename, extname } from 'path';

/**
 * MIME types that could execute scripts when served inline — force
 * Content-Disposition: attachment.
 *
 * Lowercase by construction: RFC 2045 makes a media type case-insensitive, so
 * every membership test has to fold case first (`serveLocalFile` does).
 * `application/xhtml+xml` and `text/xml` are here because both render as a
 * document with script enabled in every browser that accepts them, which makes
 * them the same hazard as `text/html` under a different spelling.
 */
export const RISKY_MIME_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/javascript',
  'text/javascript',
  'application/xml',
  'text/xml',
]);

/**
 * Full extension→MIME map covering documents, images, audio, video, code, and
 * archives accepted by the generic uploads route. The attachments route uses a
 * strict subset — see ATTACHMENT_ALLOWED_EXTENSIONS below.
 *
 * Exported so routes can serve the correct Content-Type header without keeping
 * their own copy. Unknown extensions fall back to 'application/octet-stream'.
 */
export const EXTENSION_MIME_MAP = {
  // Documents
  '.txt':  'text/plain',
  '.md':   'text/markdown',
  '.json': 'application/json',
  '.csv':  'text/csv',
  '.xml':  'application/xml',
  '.yaml': 'application/x-yaml',
  '.yml':  'application/x-yaml',
  '.pdf':  'application/pdf',
  // Images
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.bmp':  'image/bmp',
  // Audio
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
  '.ogg':  'audio/ogg',
  '.m4a':  'audio/mp4',
  '.mid':  'audio/midi',
  '.midi': 'audio/midi',
  // Video
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  '.mov':  'video/quicktime',
  // Code
  '.js':   'text/javascript',
  '.ts':   'text/typescript',
  '.jsx':  'text/javascript',
  '.tsx':  'text/typescript',
  '.py':   'text/x-python',
  '.sh':   'text/x-shellscript',
  '.sql':  'text/x-sql',
  '.html': 'text/html',
  '.css':  'text/css',
  '.go':   'text/x-go',
  '.rs':   'text/x-rust',
  '.java': 'text/x-java',
  '.c':    'text/x-c',
  '.cpp':  'text/x-c++',
  '.h':    'text/x-c',
  // Archives
  '.zip':  'application/zip',
  '.tar':  'application/x-tar',
  '.gz':   'application/gzip',
  '.7z':   'application/x-7z-compressed',
  '.rar':  'application/vnd.rar',
  // Other
  '.log':  'text/plain',
  '.env':  'text/plain',
  '.conf': 'text/plain',
  '.cfg':  'text/plain',
  '.ini':  'text/plain',
};

/**
 * Strict allowlist for file attachments (task attachments, CoS context files).
 * A subset of EXTENSION_MIME_MAP — excludes audio, video, ICO, BMP, and
 * miscellaneous text/config types that are not meaningful attachment types.
 * The attachments route validates against this set; uploads uses the full map.
 */
export const ATTACHMENT_ALLOWED_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.csv', '.xml', '.yaml', '.yml',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf',
  '.js',  '.ts', '.jsx',  '.tsx', '.py',  '.sh',  '.sql', '.html', '.css',
  '.zip', '.tar', '.gz',
]);

/**
 * Curated allowlist for SongBook attachments (sheet-music PDFs, scans, MIDI,
 * practice audio). Deliberately NOT a superset of ATTACHMENT_ALLOWED_EXTENSIONS
 * — code/archive/config types make no sense on a song record, while MIDI and
 * audio (which the CoS attachment set excludes) are core sheet-music formats.
 */
export const SONGBOOK_ATTACHMENT_EXTENSIONS = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
  '.txt', '.md',
  '.mid', '.midi', '.mp3', '.wav', '.m4a', '.ogg',
]);

/**
 * Look up the MIME type for a file extension (including the leading dot, e.g.
 * ".png"). Returns 'application/octet-stream' for unknown extensions.
 *
 * @param {string} ext - Lowercased extension with leading dot (e.g. '.png')
 * @returns {string} MIME type string
 */
export function getMimeType(ext) {
  return EXTENSION_MIME_MAP[ext] || 'application/octet-stream';
}

/**
 * Magic-byte sniff of an image buffer. The client-supplied extension / MIME is
 * not trustworthy, so when we persist uploaded image bytes (e.g. an author
 * headshot routed into the gallery) we derive the real format from the leading
 * bytes. Recognises PNG, JPEG, WebP, and GIF.
 *
 * @param {Buffer} buf - Raw decoded image bytes
 * @returns {{ format: 'png'|'jpeg'|'webp'|'gif', ext: string, mime: string } | null}
 *   The detected format with its canonical extension + MIME, or null when the
 *   bytes don't match a known image signature.
 */
export function detectImageFormat(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  if (buf.length >= 8 &&
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
    return { format: 'png', ext: '.png', mime: 'image/png' };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { format: 'jpeg', ext: '.jpg', mime: 'image/jpeg' };
  }
  if (buf.length >= 12 &&
      buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    return { format: 'webp', ext: '.webp', mime: 'image/webp' };
  }
  if (buf.length >= 6 &&
      buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38 &&
      (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61) {
    return { format: 'gif', ext: '.gif', mime: 'image/gif' };
  }
  return null;
}

/**
 * Get a file's extension, normalised to lowercase with a leading dot.
 * Returns null when the filename has no extension.
 *
 * @param {string} filename
 * @returns {string|null}
 */
export function getFileExtension(filename) {
  return extname(filename).toLowerCase() || null;
}

/**
 * Sanitize a user-supplied filename to prevent path traversal and filesystem
 * surprises. Strips any directory component, replaces characters that are not
 * alphanumeric / dot / hyphen / underscore with `_`, and ensures the name
 * does not start with a dot (hidden-file prevention).
 *
 * Identical logic was copy-pasted across uploads.js, attachments.js, and
 * screenshots.js — consolidated here so fixes propagate to all callers.
 *
 * @param {string} filename - User-provided filename (possibly with path components)
 * @returns {string} Safe basename
 */
export function sanitizeFilename(filename) {
  const base = basename(filename);
  const sanitized = base.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (sanitized.startsWith('.')) {
    return '_' + sanitized.slice(1);
  }
  return sanitized;
}
