// Direct file-upload + voice-memo attachment for catalog ingredients.
//
// The existing `catalogIngestSources.ingestFromVoice` runs audio through the
// scrap → LLM-extraction → review flow (it MINTS new ingredients). This module
// is the other seam: take a file the user dropped/picked, or a memo they just
// recorded, and attach it DIRECTLY to an ingredient that already exists.
//
// Bytes land in a peer-federating library dir (images/audio/videos) so the
// `media_key` reference federates through catalogSync while the file itself
// federates through peerMediaLibrarySync — the same two-layer path gallery
// attachments already use. Nothing here calls hashImageForManifest; the library
// replica hashes the file when it federates.

import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { ensureDir, PATHS, atomicWrite, resolveImageInputPath } from '../lib/fileUtils.js';
import { extractPngGenerationMetadata, normalizeGenerationMetadata } from '../lib/pngMetadata.js';
import { ServerError } from '../lib/errorHandler.js';
import { getIngredient, attachMedia } from './catalogDB.js';
import { readImageSidecar, saveUploadedGalleryImage } from './imageGen/local.js';
import { transcribe } from './voice/stt.js';

// media_key caption cap mirrors catalogMediaAttachSchema.caption (2 000 chars).
const MAX_CAPTION = 2_000;

// MIME → file extension for the non-image library dirs (images always normalize
// to .png in saveUploadedGalleryImage). Unknown-but-recognized-category MIMEs
// fall back to a sane container extension.
const AUDIO_EXT = {
  'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
  'audio/wave': 'wav', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'm4a',
};
const VIDEO_EXT = {
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/ogg': 'ogv',
};

const hasMetadata = (value) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;

const mediaAttachOptions = ({ role = null, caption = null, metadata = {} } = {}) => {
  const options = { role, caption };
  const normalized = normalizeGenerationMetadata(metadata);
  if (hasMetadata(normalized)) options.metadata = normalized;
  return options;
};

/**
 * Classify a browser-reported MIME into the media library it belongs in. Pure —
 * unit-tested. Strips any `;codecs=…` parameter first. Returns
 * `{ category, kind, ext }` or `null` for a MIME we don't federate (documents
 * have no library dir yet, so attaching one would break references on peers).
 */
export function classifyUploadMime(mimeType) {
  const mime = (mimeType || '').toLowerCase().split(';')[0].trim();
  if (mime.startsWith('image/')) return { category: 'image', kind: 'reference', ext: 'png' };
  if (mime.startsWith('audio/')) return { category: 'audio', kind: 'audio', ext: AUDIO_EXT[mime] || 'webm' };
  if (mime.startsWith('video/')) return { category: 'video', kind: 'video', ext: VIDEO_EXT[mime] || 'mp4' };
  return null;
}

/**
 * Read the generation provenance for an existing gallery image. Sidecars are
 * authoritative for normalized/generated assets; the PNG fallback covers a
 * gallery key that arrived before its sidecar or was created by an older build.
 * Metadata is best-effort: a corrupt sidecar must not make an otherwise valid
 * image impossible to attach.
 */
export async function readImageGenerationMetadata(
  mediaKey,
  {
    readSidecarFn = readImageSidecar,
    readFileFn = readFile,
    resolveImagePathFn = resolveImageInputPath,
  } = {},
) {
  const sidecar = await Promise.resolve(readSidecarFn(mediaKey)).catch(() => null);
  const fromSidecar = normalizeGenerationMetadata(sidecar?.metadata);
  if (hasMetadata(fromSidecar)) return fromSidecar;

  const imagePath = resolveImagePathFn(mediaKey);
  if (!imagePath) return {};
  const bytes = await Promise.resolve(readFileFn(imagePath)).catch(() => null);
  return bytes ? extractPngGenerationMetadata(bytes) : {};
}

// Write raw bytes into a federating library dir under a collision-free
// `upload-<uuid8>.<ext>` key. Returns the bare filename (the media_key).
async function persistLibraryFile(buffer, dir, ext) {
  const filename = `upload-${randomUUID().slice(0, 8)}.${ext}`;
  await ensureDir(dir);
  await atomicWrite(join(dir, filename), buffer);
  return filename;
}

async function requireIngredient(getIngredientFn, ingredientId) {
  const ingredient = await getIngredientFn(ingredientId);
  if (!ingredient) throw new ServerError('Ingredient not found', { status: 404 });
  return ingredient;
}

/**
 * Persist an uploaded file into the media library and attach it to an
 * ingredient. Images route through `saveUploadedGalleryImage` (magic-byte
 * sniffed, re-encoded to PNG, EXIF-baked); audio/video are stored as-is. Returns
 * the attached media row. `deps` lets tests run without DB/disk.
 */
export async function uploadIngredientMediaFile(
  { ingredientId, dataBase64, mimeType, filename = null, role = null, caption = null } = {},
  {
    getIngredientFn = getIngredient,
    attachMediaFn = attachMedia,
    saveImageFn = saveUploadedGalleryImage,
    persistFileFn = persistLibraryFile,
  } = {},
) {
  await requireIngredient(getIngredientFn, ingredientId);
  const classified = classifyUploadMime(mimeType);
  if (!classified) {
    throw new ServerError(`Unsupported file type "${mimeType}" — attach an image, audio, or video file.`, {
      status: 422, code: 'UNSUPPORTED_MEDIA',
    });
  }
  const meta = { role, caption };

  if (classified.category === 'image') {
    // saveUploadedGalleryImage validates size + format and 400s on a non-image.
    const sourceMetadata = extractPngGenerationMetadata(Buffer.from(dataBase64, 'base64'));
    const saved = await saveImageFn(dataBase64);
    const metadata = hasMetadata(saved?.metadata) ? saved.metadata : sourceMetadata;
    const mediaKey = saved.filename;
    console.log(`📎 Catalog media upload: image ${mediaKey} → ingredient ${ingredientId}`);
    return attachMediaFn(ingredientId, mediaKey, classified.kind, mediaAttachOptions({ ...meta, metadata }));
  }

  const buffer = Buffer.from(dataBase64, 'base64');
  if (buffer.length === 0) throw new ServerError('Empty file upload', { status: 400, code: 'VALIDATION_ERROR' });
  const dir = classified.category === 'audio' ? PATHS.audio : PATHS.videos;
  const mediaKey = await persistFileFn(buffer, dir, classified.ext);
  console.log(`📎 Catalog media upload: ${classified.kind} ${mediaKey} → ingredient ${ingredientId} (${(buffer.length / 1024).toFixed(0)}KB, ${filename || 'unnamed'})`);
  return attachMediaFn(ingredientId, mediaKey, classified.kind, mediaAttachOptions(meta));
}

/**
 * Attach a recorded voice memo: transcribe the WAV via Whisper, persist the
 * audio into data/audio, and attach a `kind:'audio'` media row with the
 * transcript in `caption`. Persist happens AFTER transcription so a failed
 * transcript doesn't orphan a file (mirrors ingestFromVoice). An empty
 * transcript still attaches the audio (the recording is the primary artifact;
 * the client already guards against a silent mic). Returns `{ media, transcript }`.
 */
export async function recordIngredientVoiceMemo(
  { ingredientId, audioBase64, mimeType = 'audio/wav', role = 'voice-memo' } = {},
  {
    getIngredientFn = getIngredient,
    attachMediaFn = attachMedia,
    transcribeFn = transcribe,
    persistFileFn = persistLibraryFile,
  } = {},
) {
  await requireIngredient(getIngredientFn, ingredientId);
  const buffer = Buffer.from(audioBase64, 'base64');
  if (buffer.length === 0) throw new ServerError('Voice memo audio was empty', { status: 400, code: 'VALIDATION_ERROR' });

  const { text } = await transcribeFn(buffer, { mimeType });
  const transcript = (text || '').trim().slice(0, MAX_CAPTION);

  const ext = AUDIO_EXT[(mimeType || '').toLowerCase().split(';')[0].trim()] || 'wav';
  const mediaKey = await persistFileFn(buffer, PATHS.audio, ext);
  console.log(`🎙️ Catalog voice memo: ${mediaKey} → ingredient ${ingredientId} (${transcript.length} chars)`);
  const media = await attachMediaFn(ingredientId, mediaKey, 'audio', mediaAttachOptions({ role, caption: transcript || null }));
  return { media, transcript };
}
