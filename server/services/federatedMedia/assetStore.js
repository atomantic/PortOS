/**
 * Provider-side staging for conditioning images an allowlisted peer uploads
 * ahead of a federated render (ADR
 * docs/decisions/2026-08-22-federated-media-input-assets.md rule 1).
 *
 * Three properties do the work here, and each one is load-bearing:
 *
 * - **Content-addressed.** The stored name embeds the SHA-256 the provider
 *   computed itself, so re-uploading identical bytes is a no-op that refreshes
 *   the expiry. That is what makes a reconcile after a restart cost one HEAD-ish
 *   round trip instead of a second multi-megabyte transfer.
 * - **Caller-scoped.** The name is prefixed with a digest of the AUTHENTICATED
 *   caller id, re-derived (never parsed from the request) on every reference. An
 *   asset id from one peer is unusable by another even if it leaks.
 * - **TTL-bounded.** These are another machine's bytes held to run one job.
 *   Nothing here is this install's data, so it expires rather than accumulating,
 *   and it is excluded from backups.
 *
 * What is NOT here, deliberately: model weights (rule 3) and multi-step chain
 * state (rule 4). Neither is conditioning, and neither has a field on the wire.
 */

import { readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ServerError } from '../../lib/errorHandler.js';
import {
  detectImageFormat,
  ensureDir,
  PATHS,
  resolveFederatedMediaAsset,
  sha256Text,
} from '../../lib/fileUtils.js';
import {
  FEDERATED_MEDIA_ASSET_EXTENSION,
  FEDERATED_MEDIA_ASSET_MAX_BYTES,
  FEDERATED_MEDIA_ASSET_MIME_TYPES,
  FEDERATED_MEDIA_ASSET_TTL_MS,
  FEDERATED_MEDIA_WIRE_VERSION,
  federatedMediaAssetIdSchema,
} from '../../lib/federatedMediaWire.js';

const reject = (message, code, status = 400, context) => {
  throw new ServerError(message, { status, code, ...(context ? { context } : {}) });
};

/**
 * The caller half of an asset id. Derived from the authenticated caller id
 * rather than accepted from the request, so it is an authorization check and
 * not merely a namespace.
 */
export const callerAssetPrefix = (callerId) => sha256Text(String(callerId)).slice(0, 16);

const assetFilename = (assetId, mimeType) => `${assetId}.${FEDERATED_MEDIA_ASSET_EXTENSION[mimeType]}`;

// Every extension this store can produce, for the id -> file lookup. The stored
// mime type is not part of the id (the id is caller + digest), so finding an
// asset means trying the extensions rather than being told which one it is.
const ASSET_EXTENSIONS = [...new Set(Object.values(FEDERATED_MEDIA_ASSET_EXTENSION))];
const MIME_BY_EXTENSION = Object.fromEntries(
  FEDERATED_MEDIA_ASSET_MIME_TYPES.map((mime) => [FEDERATED_MEDIA_ASSET_EXTENSION[mime], mime]),
);

const expiresAtFor = (mtimeMs) => new Date(mtimeMs + FEDERATED_MEDIA_ASSET_TTL_MS).toISOString();

/**
 * Locate one staged asset for a caller.
 *
 * @returns {Promise<{path: string, mimeType: string, sizeBytes: number, expiresAt: string}|null>}
 *   `null` for absent, unreadable, expired, or belonging to another caller —
 *   all four are "you cannot use this", and distinguishing them to the caller
 *   would confirm the existence of another peer's asset.
 */
export async function findFederatedMediaAsset(callerId, assetId, { now = Date.now() } = {}) {
  const parsed = federatedMediaAssetIdSchema.safeParse(assetId);
  if (!parsed.success) return null;
  if (!parsed.data.startsWith(`${callerAssetPrefix(callerId)}-`)) return null;

  for (const extension of ASSET_EXTENSIONS) {
    // Through the shared resolver, not join(): it basenames and re-anchors at
    // the inbox root, so this stays a single containment check shared with the
    // image runner's own re-validation of the same path.
    const path = resolveFederatedMediaAsset(`${parsed.data}.${extension}`);
    if (!path) continue;
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) continue;
    if (now - info.mtimeMs > FEDERATED_MEDIA_ASSET_TTL_MS) continue;
    return {
      path,
      mimeType: MIME_BY_EXTENSION[extension],
      sizeBytes: info.size,
      expiresAt: expiresAtFor(info.mtimeMs),
    };
  }
  return null;
}

/**
 * Accept one uploaded conditioning image.
 *
 * `declaredSha256` is the caller's claim and is checked against a digest this
 * side computes — a mismatch is a truncated or altered transfer, and rendering
 * from it would produce a plausible image of the wrong thing.
 *
 * @param {object} args
 * @param {string} args.callerId - Authenticated peer instance id.
 * @param {string} args.mimeType - Declared Content-Type.
 * @param {string} args.declaredSha256 - Caller's X-Content-SHA256 header.
 * @param {Buffer} args.body
 */
export async function storeFederatedMediaAsset({ callerId, mimeType, declaredSha256, body }) {
  if (!FEDERATED_MEDIA_ASSET_MIME_TYPES.includes(mimeType)) {
    reject(
      `Unsupported conditioning image type: ${mimeType || 'none'}`,
      'MEDIA_PROVIDER_ASSET_TYPE_UNSUPPORTED',
      415,
      { supported: FEDERATED_MEDIA_ASSET_MIME_TYPES },
    );
  }
  if (!Buffer.isBuffer(body) || body.length === 0) {
    reject('Conditioning image upload was empty', 'MEDIA_PROVIDER_ASSET_EMPTY');
  }
  if (body.length > FEDERATED_MEDIA_ASSET_MAX_BYTES) {
    reject('Conditioning image exceeds the provider limit', 'MEDIA_PROVIDER_ASSET_TOO_LARGE', 413, {
      maxBytes: FEDERATED_MEDIA_ASSET_MAX_BYTES,
    });
  }
  // Magic bytes, not just the declared header. The header is the caller's word
  // for what this is; the bytes are what the generator will actually open.
  const detected = detectImageFormat(body);
  if (!detected || detected.mime !== mimeType) {
    reject(
      `Conditioning image bytes are not ${mimeType}`,
      'MEDIA_PROVIDER_ASSET_TYPE_MISMATCH',
      415,
      { declared: mimeType, detected: detected?.mime || null },
    );
  }
  // sha256Text takes a Buffer as well as a string — see its doc comment.
  const sha256 = sha256Text(body);
  if (typeof declaredSha256 !== 'string' || declaredSha256.toLowerCase() !== sha256) {
    reject('Conditioning image digest does not match its bytes', 'MEDIA_PROVIDER_ASSET_INTEGRITY');
  }

  const assetId = `${callerAssetPrefix(callerId)}-${sha256}`;
  await ensureDir(PATHS.federatedMediaInbox);
  const path = join(PATHS.federatedMediaInbox, assetFilename(assetId, mimeType));
  // Unconditional write, even when the same bytes are already staged: the
  // content is identical by construction (the name IS the digest), and
  // rewriting is what refreshes the TTL for a replayed submission.
  await writeFile(path, body);
  return {
    wireVersion: FEDERATED_MEDIA_WIRE_VERSION,
    assetId,
    sha256,
    sizeBytes: body.length,
    mimeType,
    expiresAt: expiresAtFor(Date.now()),
  };
}

/**
 * Metadata for one staged asset, so a consumer can skip a re-upload after a
 * restart. 404 covers absent, expired, and another caller's — see
 * findFederatedMediaAsset.
 */
export async function describeFederatedMediaAsset(callerId, assetId) {
  const found = await findFederatedMediaAsset(callerId, assetId);
  if (!found) {
    reject('Conditioning image is not staged for this peer', 'MEDIA_PROVIDER_ASSET_NOT_FOUND', 404);
  }
  return {
    wireVersion: FEDERATED_MEDIA_WIRE_VERSION,
    assetId,
    // Re-read off the id rather than re-hashing the file: the id half IS the
    // digest this provider computed when it accepted the bytes.
    sha256: assetId.slice(-64),
    sizeBytes: found.sizeBytes,
    mimeType: found.mimeType,
    expiresAt: found.expiresAt,
  };
}

/**
 * Drop expired staged assets. Called opportunistically from the provider's
 * admission path rather than on a timer — a provider that receives no federated
 * work has nothing to sweep, and one that does gets swept on every submission.
 *
 * Never throws: a sweep failure must not fail the job that triggered it.
 *
 * @returns {Promise<number>} files removed
 */
export async function sweepFederatedMediaAssets({ now = Date.now() } = {}) {
  const entries = await readdir(PATHS.federatedMediaInbox).catch(() => null);
  if (!entries) return 0;
  let removed = 0;
  for (const name of entries) {
    const path = join(PATHS.federatedMediaInbox, name);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile() || now - info.mtimeMs <= FEDERATED_MEDIA_ASSET_TTL_MS) continue;
    if (await rm(path, { force: true }).then(() => true, () => false)) removed += 1;
  }
  if (removed) console.log(`🧹 Federated media inbox: swept ${removed} expired conditioning image(s)`);
  return removed;
}
