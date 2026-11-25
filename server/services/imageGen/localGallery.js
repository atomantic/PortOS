import { open, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { trashFiles } from '../../lib/trashFiles.js';
import { atomicWrite, assertSafeFilename, ensureDir, listDirectoryByExtension, PATHS, unlinkGuarded } from '../../lib/fileUtils.js';
import { detectImageFormat } from '../../lib/mimeTypes.js';
import { extractPngGenerationMetadata, extractPngGenerationMetadataFile } from '../../lib/pngMetadata.js';
import { ServerError } from '../../lib/errorHandler.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { GALLERY_IMAGE_EXTENSIONS } from '../../lib/pathSafety.js';
import { registerGallerySha256Writer, sidecarPathForImage } from '../../lib/assetHash.js';
import { beginMediaTombstone, commitLocalDeleteTombstone, clearMediaTombstone } from '../mediaTombstones.js';
import { withLocalImageOrigin } from './imageRecords.js';
import { readImageSidecar, refreshImageIndex, sidecarEditQueue, editImageSidecar } from './sidecarStore.js';

// Validate a gallery filename: PNG-only, basename only, no path separators.
// Delegates to the shared `assertSafeFilename` helper in fileUtils.js.
// Substring `..` is allowed (e.g. `my..render.png` is fine) because the
// helper only rejects the exact-string traversal cases.
// `requiredMessage` preserves the original "Invalid filename" wording for
// the missing-input case so existing client error-message expectations
// (and the previously-shipped error-middleware contract) don't shift.
export function assertGalleryFilename(filename, { pngOnly = false } = {}) {
  assertSafeFilename(filename, {
    extensions: pngOnly ? ['.png'] : GALLERY_IMAGE_EXTENSIONS,
    subject: 'filename',
    requiredMessage: 'Invalid filename',
  });
}

export { readImageSidecar };

// Decoder safety is independent of the upload file-size policy.
const MAX_GALLERY_UPLOAD_PIXELS = 96 * 1000 * 1000;

/**
 * Persist user-uploaded image bytes (base64) into the gallery dir under
 * `data/images/` so the file rides the existing `image` peer-sync asset path
 * (a record pointing at `/data/images/<f>` ships its bytes to peers; a
 * `/api/uploads/<f>` path does not). The payload is sniffed by magic bytes —
 * the client-supplied name/extension is not trusted — and a non-image is
 * rejected with a 400, then re-encoded to **PNG** so the saved file is a
 * first-class gallery citizen: it lists in `/image-gen/gallery` and deletes via
 * `deleteImage`. Returns the bare gallery
 * filename and its `/data/images/` mount path for the caller to store.
 *
 * @param {string|null} base64Data - Legacy raw base64 image bytes
 * @param {string} [tempPath] - Server-staged multipart file, preferred over base64
 * @returns {Promise<{ filename: string, path: string, metadata: object }>}
 */
export async function saveUploadedGalleryImage(base64Data, tempPath) {
  const input = tempPath || Buffer.from(base64Data, 'base64');
  let header = input;
  if (tempPath) {
    const file = await open(tempPath, 'r');
    header = Buffer.alloc(12);
    await file.read(header, 0, header.length, 0).finally(() => file.close());
  }
  if (!tempPath && input.length === 0) {
    throw new ServerError('Empty image upload', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const detected = detectImageFormat(header);
  if (!detected) {
    throw new ServerError('Unsupported image format (expected PNG, JPEG, WebP, or GIF)', { status: 400, code: 'UNSUPPORTED_IMAGE' });
  }
  // Read Stable Diffusion-compatible PNG text chunks before sharp normalizes
  // the image. JPEG/WebP/GIF uploads simply produce an empty projection.
  // An upload is made here, so this machine owns it (its sidecar records that).
  const metadata = await withLocalImageOrigin(tempPath
    ? await extractPngGenerationMetadataFile(tempPath)
    : extractPngGenerationMetadata(input));
  // Normalize to PNG so the gallery's PNG-only list/delete paths manage it.
  // `.rotate()` with no args bakes in EXIF orientation before the metadata is
  // dropped, so a camera-JPEG portrait isn't saved sideways/upside-down.
  const filename = `upload-${randomUUID().slice(0, 8)}.png`;
  await ensureDir(PATHS.images);
  const output = join(PATHS.images, filename);
  const staging = `${output}.tmp`;
  try {
    const { default: sharp } = await import('sharp');
    await sharp(input, { limitInputPixels: MAX_GALLERY_UPLOAD_PIXELS }).rotate().png().toFile(staging);
    // Encoding stays outside admission. Publish the final file, metadata, and
    // derived database row together so a backup cannot split those writes.
    return await withBackupAssetPublication(async () => {
      await rename(staging, output);
      // PNG normalization strips source text chunks; keep their bounded
      // projection in the gallery sidecar for listings and later attachments.
      if (Object.keys(metadata).length > 0) {
        await atomicWrite(join(PATHS.images, filename.replace('.png', '.metadata.json')), metadata);
      }
      await refreshImageIndex(filename);
      import('../imageVerifier.js').then(async ({ getVerifierSettings, verifyImageAsync }) => {
        const vs = await getVerifierSettings().catch(() => null);
        if (vs?.enabledForImport || metadata?.verify === true) {
          verifyImageAsync(filename, { isImport: true, prompt: metadata?.prompt || '' });
        }
      }).catch(() => {});
      console.log(`📥 Saved uploaded gallery image: ${filename} (PNG from ${detected.mime})`);
      return { filename, path: `/data/images/${filename}`, metadata };
    });
  } finally {
    await unlinkGuarded(staging).catch(() => {});
  }
}

export async function listGallery() {
  if (!existsSync(PATHS.images)) return [];
  // requireRegularFile:false preserves the original gallery behavior — it
  // never checked isFile(), only dropped on stat failure. listLoras /
  // listMusicLibrary do filter directories; mirroring that here would be a
  // behavior change.
  const items = await listDirectoryByExtension(PATHS.images, {
    extensions: GALLERY_IMAGE_EXTENSIONS,
    requireRegularFile: false,
    mapEntry: async (f, _fullPath, s) => {
      const { metadata } = await readImageSidecar(f);
      return {
        filename: f,
        path: `/data/images/${f}`,
        createdAt: metadata.createdAt || s.birthtime.toISOString(),
        ...metadata,
        fileSizeBytes: s.size,
      };
    },
  });
  return items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// `fromRemoteTombstone`: the owner's tombstone, already merged, deleted it, so
// it is neither re-recorded (that would restamp deletedAt) nor re-announced.
export async function deleteImage(filename, { fromRemoteTombstone = false } = {}) {
  assertGalleryFilename(filename);
  let record = null;
  let tombstone = null;
  const result = await withBackupAssetPublication(() => sidecarEditQueue(filename, async () => {
    const { metadata } = await readImageSidecar(filename);
    record = { filename, originInstanceId: metadata.originInstanceId };
    // Record BEFORE trashing: a crash between the two must never leave a
    // deleted image without its tombstone. It stays in flight (unexported)
    // until the trash commits, and is withdrawn if the trash fails (#14088).
    if (!fromRemoteTombstone) tombstone = await beginMediaTombstone('image', filename);
    try {
      await trashFiles([
        join(PATHS.images, filename),
        sidecarPathForImage(filename),
        join(PATHS.images, `${filename}.metadata.json`),
        ...(/\.png$/i.test(filename) ? [join(PATHS.imageThumbnails, filename.replace(/\.png$/i, '.webp'))] : []),
      ]);
    } catch (err) {
      if (tombstone) await clearMediaTombstone('image', filename, { deletedAt: tombstone.deletedAt });
      throw err;
    }
    if (tombstone) await commitLocalDeleteTombstone('image', tombstone);
    // trashFiles verifies removal before derived records can be retired.
    await import('../mediaAssetIndex/index.js')
      .then((m) => m.unindexImage(filename))
      .catch((err) => console.error(`❌ Media index image delete hook: ${err.message}`));
    console.log(`🗑️ Trashed image: ${filename}`);
    return { ok: true };
  }));
  // The one emitter of an image delete: views refresh, and the owner's own
  // delete goes to peers (a remote-tombstone delete was announced by its owner).
  void import('../peerSyncEventBus.js')
    .then(async (m) => {
      m.emitMediaHistoryChanged({ kind: 'image', op: 'delete', ids: [filename] });
      if (!fromRemoteTombstone) await m.announceLocalImageDelete(record, tombstone);
    })
    .catch((err) => console.error(`❌ Image delete announce failed: ${err.message}`));
  return result;
}

export async function setImageHidden(filename, hidden) {
  assertGalleryFilename(filename);
  return editImageSidecar(filename, (metadata) => {
    metadata.hidden = !!hidden;
    return { ok: true, hidden: metadata.hidden };
  });
}

// Machine-local, like `hidden`: a delete this machine queued for the image's
// owner (`{ peerId, queuedAt }`), or null to clear it. Resolves true when changed.
export async function setImagePendingDelete(filename, pending) {
  assertGalleryFilename(filename);
  return editImageSidecar(filename, (metadata) => {
    if (!pending && !('pendingDelete' in metadata)) return null;
    if (pending) metadata.pendingDelete = pending;
    else delete metadata.pendingDelete;
    return true;
  });
}

// Make primary (services/mediaHolders.js): the holder chosen to keep this
// image's bytes. Only an image with a sidecar records it. Resolves true when changed.
export async function setImagePrimary(filename, { instanceId, at }) {
  assertGalleryFilename(filename);
  return editImageSidecar(filename, (metadata) => {
    if (!metadata || Object.keys(metadata).length === 0) return null;
    // Field LWW on primaryAt, as on video rows: an older designation never replaces a newer one.
    if (Date.parse(metadata.primaryAt) >= Date.parse(at)) return null;
    Object.assign(metadata, { primaryInstanceId: instanceId, primaryAt: at });
    return true;
  });
}

export async function updateImagePrompt(filename, prompt) {
  assertGalleryFilename(filename);
  const trimmedPrompt = typeof prompt === 'string' ? prompt.trim() : '';
  return editImageSidecar(filename, (metadata) => {
    if (trimmedPrompt) metadata.prompt = trimmedPrompt;
    else delete metadata.prompt;
    return { filename, prompt: trimmedPrompt };
  });
}

// Fill only keys the sidecar lacks, through the same edit queue as prompt and
// visibility edits so neither write drops the other. An image without a sidecar
// is left alone: a stub holding only these fields would carry no prompt, seed
// or model. Resolves true when the sidecar changed, null otherwise.
export function fillImageSidecarFields(filename, fields) {
  return editImageSidecar(filename, (metadata) => {
    if (!metadata || Object.keys(metadata).length === 0) return null;
    const missing = Object.entries(fields).filter(([key, value]) => value != null && metadata[key] == null);
    if (missing.length === 0) return null;
    Object.assign(metadata, Object.fromEntries(missing));
    return true;
  });
}

// Persist the byte-hash cache (`lib/assetHash.js`) through the edit queue so it
// re-reads the CURRENT sidecar and cannot drop a concurrent edit (hidden flag,
// supplying peer, ...). An image without a sidecar gets none created for the
// cache. Not indexed: the hash cache is not a searchable field. Resolves to the
// merged sidecar, or null when nothing was written.
export function cacheImageSha256(filename, entry) {
  assertGalleryFilename(filename);
  return editImageSidecar(filename, (metadata) => {
    if (!metadata || Object.keys(metadata).length === 0) return null;
    metadata.sha256 = entry;
    return { ...metadata };
  }, { reindex: false });
}
registerGallerySha256Writer(cacheImageSha256);

