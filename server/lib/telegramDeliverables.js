/**
 * Telegram deliverable attachments: finds artifact paths in notification prose, jails them to PortOS media/report directories, and picks each file's Bot API upload method.
 *
 * Paths inside code are never extracted. The method is one of `sendPhoto`,
 * `sendDocument`, `sendAudio`, `sendVoice` or `sendVideo`.
 *
 * The jail is the security boundary. A path is uploaded only when its realpath
 * (symlinks resolved) sits strictly inside one of `DELIVERABLE_ROOTS` and both
 * the requested name AND the resolved name carry an allowlisted extension, so a
 * `photo.png` symlink to `settings.json` or a `../` walk out of `data/images/`
 * is refused. Everything else under `data/` (settings, secrets, auth sessions,
 * backups, the DB, privacy exports) is outside every root.
 */

import { realpath, stat } from 'fs/promises';
import { basename, extname, isAbsolute, join, relative, sep } from 'path';
import { PATHS } from './paths.js';

/** Telegram's Bot API ceiling for any multipart upload. */
export const TELEGRAM_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/** `sendPhoto` rejects photos over 10 MB; larger images go out as documents. */
export const TELEGRAM_MAX_PHOTO_BYTES = 10 * 1024 * 1024;
/** Telegram caption limit (characters). */
const TELEGRAM_MAX_CAPTION_CHARS = 1024;
/** Bound how many uploads a single notification may fan out into. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/** PortOS artifact directories a deliverable may live in. */
const DELIVERABLE_ROOTS = Object.freeze([
  PATHS.images,
  PATHS.imageThumbnails,
  PATHS.videos,
  PATHS.videoThumbnails,
  PATHS.audio,
  PATHS.music,
  PATHS.screenshots,
  PATHS.reports,
  PATHS.runs
]);

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.ogg', '.opus', '.m4a', '.flac']);
const VOICE_EXTS = new Set(['.ogg', '.opus']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm']);
const DOCUMENT_EXTS = new Set(['.pdf', '.csv', '.txt', '.md', '.html', '.zip']);
const ALLOWED_EXTS = new Set([...IMAGE_EXTS, ...AUDIO_EXTS, ...VIDEO_EXTS, ...DOCUMENT_EXTS]);

const ATTACHMENT_KINDS = Object.freeze(['auto', 'photo', 'document', 'audio', 'voice', 'video']);

/** Bot API method → multipart field name carrying the file. */
const METHOD_FIELD = {
  sendPhoto: 'photo',
  sendDocument: 'document',
  sendAudio: 'audio',
  sendVoice: 'voice',
  sendVideo: 'video'
};

// A path-shaped token ending in an allowlisted extension: absolute (`/…`),
// home-relative (`~/…`, matched only so its refusal is logged; it never
// resolves inside a root) or the install-relative `data/…` form. Stops at
// whitespace and the delimiters markdown/HTML wrap a path in.
// A path ends at a non-word character; a sentence-ending `.` still ends it
// (`see /data/images/x.png.`) but `x.png.bak` does not.
const PATH_END = '(?!\\w|\\.\\w)';
const EXT_ALTERNATION = [...ALLOWED_EXTS].map(e => e.slice(1)).join('|');
const PATH_TOKEN = new RegExp(`(?:~?/|\\bdata/)[^\\s()<>"'\`\\[\\]]+?\\.(?:${EXT_ALTERNATION})${PATH_END}`, 'gi');

/**
 * Split text into prose and code segments. Fenced blocks (```…```) and inline
 * code spans (`…`) are code; an unterminated fence runs to the end of the text
 * so a half-written block is never mined for paths either.
 *
 * @param {string} text
 * @returns {Array<{ code: boolean, text: string }>}
 */
function segmentText(text) {
  const segments = [];
  const source = typeof text === 'string' ? text : '';
  const re = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;
  let last = 0;
  for (const match of source.matchAll(re)) {
    if (match.index > last) segments.push({ code: false, text: source.slice(last, match.index) });
    segments.push({ code: true, text: match[0] });
    last = match.index + match[0].length;
  }
  if (last < source.length) segments.push({ code: false, text: source.slice(last) });
  return segments;
}

/**
 * Candidate deliverable path strings in prose (code segments are ignored),
 * deduplicated in first-seen order.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function extractDeliverablePaths(text) {
  const found = new Set();
  for (const segment of segmentText(text)) {
    if (segment.code) continue;
    for (const match of segment.text.matchAll(PATH_TOKEN)) found.add(match[0]);
  }
  return [...found];
}

/**
 * The first image path in the prose of `text` (code ignored), or null.
 *
 * @param {string} text
 * @returns {string|null}
 */
export function firstImagePath(text) {
  return extractDeliverablePaths(text).find(path => IMAGE_EXTS.has(extname(path).toLowerCase())) ?? null;
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Remove delivered paths from the prose of `text` (a markdown link/image
 * wrapping one goes with it), leaving code segments byte-identical.
 *
 * @param {string} text
 * @param {string[]} paths - the raw strings `extractDeliverablePaths` returned
 *   that were actually accepted for upload
 * @returns {string}
 */
export function stripDeliverablePaths(text, paths) {
  if (typeof text !== 'string' || !Array.isArray(paths) || paths.length === 0) return text;
  return segmentText(text).map(segment => {
    if (segment.code) return segment.text;
    let prose = segment.text;
    for (const raw of paths) {
      const escaped = escapeRegExp(raw);
      prose = prose
        .replace(new RegExp(`!?\\[[^\\]\\n]*\\]\\(\\s*<?${escaped}>?\\s*\\)`, 'g'), '')
        .replace(new RegExp(`${escaped}${PATH_END}`, 'g'), '');
    }
    // Tidy the holes: trailing spaces and runs of blank lines a removed path left.
    return prose.replace(/[ \t]+(?=\n)/g, '').replace(/\n{3,}/g, '\n\n');
  }).join('').trim();
}

/**
 * Map a path as written in a notification onto the filesystem. `/data/…` is the
 * URL form PortOS serves artifacts under (`/data/images/<file>.png`), `data/…`
 * the install-relative form; both resolve against the install's data tree.
 */
function toFilesystemPath(rawPath, dataRoot) {
  let decoded = rawPath;
  try { decoded = decodeURIComponent(rawPath); } catch { /* keep the raw string */ }
  if (decoded.startsWith('/data/')) return join(dataRoot, decoded.slice('/data/'.length));
  if (decoded.startsWith('data/')) return join(dataRoot, decoded.slice('data/'.length));
  return decoded;
}

const isInside = (root, target) => {
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
};

/**
 * Choose the Bot API method for a file.
 *
 * @param {string} filePath
 * @param {{ kind?: string, asDocument?: boolean, audioAsVoice?: boolean, size?: number }} [opts]
 * @returns {{ method: string, field: string }|null} null for a disallowed extension
 */
export function classifyAttachment(filePath, { kind = 'auto', asDocument = false, audioAsVoice = false, size = 0 } = {}) {
  const ext = extname(String(filePath || '')).toLowerCase();
  if (!ALLOWED_EXTS.has(ext)) return null;
  let method;
  if (kind === 'document' || asDocument) method = 'sendDocument';
  else if (IMAGE_EXTS.has(ext)) method = size > TELEGRAM_MAX_PHOTO_BYTES ? 'sendDocument' : 'sendPhoto';
  else if (AUDIO_EXTS.has(ext)) method = (audioAsVoice || kind === 'voice') && VOICE_EXTS.has(ext) ? 'sendVoice' : 'sendAudio';
  else if (VIDEO_EXTS.has(ext)) method = 'sendVideo';
  else method = 'sendDocument';
  return { method, field: METHOD_FIELD[method] };
}

const realRootsCache = new Map();

async function resolveRealRoots(roots) {
  const key = roots.join('\0');
  if (realRootsCache.has(key)) return realRootsCache.get(key);
  const resolved = (await Promise.all(roots.map(root => realpath(root).catch(() => null)))).filter(Boolean);
  // Only cache a complete answer: a root created later (first image render)
  // must become deliverable without a restart.
  if (resolved.length === roots.length) realRootsCache.set(key, resolved);
  return resolved;
}

/**
 * Validate one attachment request against the jail and size limits.
 *
 * @param {{ path: string, kind?: string, caption?: string }} spec
 * @param {{ asDocument?: boolean, audioAsVoice?: boolean, roots?: string[], dataRoot?: string }} [opts]
 * @returns {Promise<{ ok: true, attachment: { path: string, filename: string, method: string, field: string, caption: string|null, size: number } } | { ok: false, reason: string }>}
 */
export async function resolveDeliverable(spec, { asDocument = false, audioAsVoice = false, roots = DELIVERABLE_ROOTS, dataRoot = PATHS.data } = {}) {
  const rawPath = typeof spec?.path === 'string' ? spec.path.trim() : '';
  if (!rawPath) return { ok: false, reason: 'no path' };
  const kind = ATTACHMENT_KINDS.includes(spec.kind) ? spec.kind : 'auto';

  const requested = toFilesystemPath(rawPath, dataRoot);
  if (!isAbsolute(requested)) return { ok: false, reason: 'not an absolute artifact path' };
  if (!ALLOWED_EXTS.has(extname(requested).toLowerCase())) return { ok: false, reason: 'extension not allowed' };

  let real;
  try {
    real = await realpath(requested);
  } catch (err) {
    return { ok: false, reason: err.code === 'ENOENT' ? 'missing file' : `unreadable (${err.code || err.message})` };
  }
  if (!ALLOWED_EXTS.has(extname(real).toLowerCase())) return { ok: false, reason: 'resolved extension not allowed' };
  const realRoots = await resolveRealRoots(roots);
  if (!realRoots.some(root => isInside(root, real))) return { ok: false, reason: 'outside artifact directories' };

  const info = await stat(real).catch(() => null);
  if (!info?.isFile()) return { ok: false, reason: 'not a regular file' };
  if (info.size === 0) return { ok: false, reason: 'empty file' };
  if (info.size > TELEGRAM_MAX_UPLOAD_BYTES) return { ok: false, reason: `exceeds ${TELEGRAM_MAX_UPLOAD_BYTES / (1024 * 1024)} MB upload limit` };

  const classified = classifyAttachment(real, { kind, asDocument, audioAsVoice, size: info.size });
  if (!classified) return { ok: false, reason: 'extension not allowed' };

  const caption = typeof spec.caption === 'string' && spec.caption.trim()
    ? spec.caption.trim().slice(0, TELEGRAM_MAX_CAPTION_CHARS)
    : null;
  return {
    ok: true,
    attachment: { path: real, filename: basename(real), ...classified, caption, size: info.size }
  };
}

/**
 * Resolve every deliverable a notification carries: structured
 * `metadata.attachments` first, then paths found in the description prose.
 * Refusals log one non-failure line each and never throw, so text delivery is
 * unaffected by a vanished or disallowed artifact.
 *
 * @param {object} notification
 * @param {{ roots?: string[], dataRoot?: string }} [opts] - test seams
 * @returns {Promise<{ attachments: object[], description: string }>} the
 *   accepted uploads and the description with the delivered text paths removed
 */
export async function collectNotificationDeliverables(notification, opts = {}) {
  const metadata = notification?.metadata && typeof notification.metadata === 'object' ? notification.metadata : {};
  const flags = { asDocument: metadata.asDocument === true, audioAsVoice: metadata.audioAsVoice === true, ...opts };
  const description = typeof notification?.description === 'string' ? notification.description : '';

  const structured = Array.isArray(metadata.attachments)
    ? metadata.attachments.filter(entry => entry && typeof entry === 'object' && typeof entry.path === 'string')
    : [];
  const textPaths = extractDeliverablePaths(description);
  const requests = [
    ...structured.map(spec => ({ spec, raw: null })),
    ...textPaths.map(raw => ({ spec: { path: raw }, raw }))
  ];

  const attachments = [];
  const seen = new Set();
  const deliveredRaw = [];
  for (const { spec, raw } of requests) {
    if (attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
      console.log(`📎 Telegram: attachment cap (${MAX_ATTACHMENTS_PER_MESSAGE}) reached — skipping the rest`);
      break;
    }
    const result = await resolveDeliverable(spec, flags);
    if (!result.ok) {
      console.log(`📎 Telegram: skipping attachment ${basename(spec.path)} — ${result.reason}`);
      continue;
    }
    // A path already covered (structured entry repeated in the text) still
    // leaves the text so the message never shows a raw path we uploaded.
    if (raw) deliveredRaw.push(raw);
    if (seen.has(result.attachment.path)) continue;
    seen.add(result.attachment.path);
    attachments.push(result.attachment);
  }

  return { attachments, description: stripDeliverablePaths(description, deliveredRaw) };
}
