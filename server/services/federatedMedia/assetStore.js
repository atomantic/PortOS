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

import { readdir, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { ServerError } from '../../lib/errorHandler.js';
import {
  atomicWrite,
  detectImageFormat,
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
  federatedMediaAssetId,
  federatedMediaAssetIdSchema,
  federatedMediaAssetOwner,
} from '../../lib/federatedMediaWire.js';

const reject = (message, code, status = 400, context) => {
  throw new ServerError(message, { status, code, ...(context ? { context } : {}) });
};

const assetFilename = (assetId, mimeType) => `${assetId}.${FEDERATED_MEDIA_ASSET_EXTENSION[mimeType]}`;

// The stored mime type is not part of the id (the id is caller + digest), so
// finding an asset means trying the extensions rather than being told which one.
const MIME_BY_EXTENSION = Object.fromEntries(
  FEDERATED_MEDIA_ASSET_MIME_TYPES.map((mime) => [FEDERATED_MEDIA_ASSET_EXTENSION[mime], mime]),
);
const ASSET_EXTENSIONS = Object.keys(MIME_BY_EXTENSION);

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
  if (!parsed.data.startsWith(`${federatedMediaAssetOwner(callerId)}-`)) return null;

  // The mime type is not encoded in the id, so the extension has to be probed.
  // Concurrently: a webp asset would otherwise always pay for two misses first,
  // and the not-found path (the 410 a consumer acts on) always pays for all of
  // them.
  const found = await Promise.all(ASSET_EXTENSIONS.map(async (extension) => {
    // Through the shared resolver, not join(): it basenames and re-anchors at
    // the inbox root, so this stays a single containment check shared with the
    // image runner's own re-validation of the same path.
    const path = resolveFederatedMediaAsset(`${parsed.data}.${extension}`);
    if (!path) return null;
    const info = await stat(path).catch(() => null);
    if (!info?.isFile() || now - info.mtimeMs > FEDERATED_MEDIA_ASSET_TTL_MS) return null;
    return {
      path,
      mimeType: MIME_BY_EXTENSION[extension],
      sizeBytes: info.size,
      expiresAt: expiresAtFor(info.mtimeMs),
    };
  }));
  return found.find(Boolean) || null;
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

  const assetId = federatedMediaAssetId(callerId, sha256);
  const path = join(PATHS.federatedMediaInbox, assetFilename(assetId, mimeType));
  // Already staged? The bytes are identical by construction (the name IS the
  // digest), so a replay only needs its TTL refreshed — one utimes rather than
  // rewriting up to 32 MiB to change a timestamp.
  //
  // atomicWrite (temp + rename) on the miss, not a plain writeFile: this file's
  // NAME asserts a digest that findFederatedMediaAsset trusts without re-hashing,
  // so a torn write would leave a file claiming a hash its bytes do not have —
  // and the runner would render from a truncated image. It ensures the directory
  // itself, so no separate ensureDir.
  const existing = await stat(path).catch(() => null);
  if (existing?.isFile() && existing.size === body.length) {
    await utimes(path, new Date(), new Date());
  } else {
    await atomicWrite(path, body);
  }
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

// The queue params a federated job reaches its conditioning through — the same
// four the provider writes in `buildQueueParams`. Listed here because this is
// where they have to be READ back to keep them alive.
const CONDITIONING_PARAMS = ['initImagePath', 'referenceImagePaths', 'sourceImagePath', 'lastImagePath'];

/**
 * Basenames any queued or running job still depends on.
 *
 * The age gate alone is a BACKSTOP, not the safety property — the same lesson
 * `imageCleanTmpGc.js` records for the structurally identical `image-clean-tmp`
 * dir. A federated job queued behind a long render or a first-run model
 * download can easily sit past the TTL, and deleting its staged init image
 * leaves the runner unable to open a file the consumer already committed to and
 * is waiting on. Nothing re-uploads it: the ids were resolved at admission, and
 * the provider never tells the consumer the bytes went away.
 *
 * Pure over its argument so it is testable without the real queue, and shared
 * with the Data Manager purge probe so a one-click purge can never be more
 * permissive than the automatic sweep.
 *
 * @param {object[]} jobs
 * @returns {Set<string>}
 */
export function collectActiveFederatedAssetBasenames(jobs = []) {
  const keep = new Set();
  for (const job of Array.isArray(jobs) ? jobs : []) {
    // Only in-flight work pins bytes; a terminal job has already rendered.
    if (job?.status !== 'queued' && job?.status !== 'running') continue;
    for (const key of CONDITIONING_PARAMS) {
      const value = job.params?.[key];
      for (const path of Array.isArray(value) ? value : [value]) {
        if (typeof path !== 'string' || !path) continue;
        const base = path.split(/[/\\]/).pop();
        if (base) keep.add(base);
      }
    }
  }
  return keep;
}

// A sweep only ever finds different files across a TTL boundary, so running one
// per submission is pure duplicate work when several jobs arrive together.
// Throttling is a redundancy guard here, not a concurrency control.
const SWEEP_MIN_INTERVAL_MS = 5 * 60 * 1000;
let lastSweptAt = 0;

/** @internal — lets a test drive consecutive sweeps without waiting out the throttle. */
export const __resetFederatedAssetSweepForTests = () => { lastSweptAt = 0; };

/**
 * Drop expired staged assets that no in-flight job still needs.
 *
 * Called opportunistically from the provider's admission path rather than on a
 * timer: a provider that receives no federated work has nothing to sweep, and
 * one that does gets swept as work arrives.
 *
 * Never throws — a sweep failure must not fail the job that triggered it.
 *
 * @param {object} [options]
 * @param {object[]} [options.jobs] - live queue jobs, for the active-job pin
 * @returns {Promise<number>} files removed
 */
export async function sweepFederatedMediaAssets({ jobs = [], now = Date.now(), force = false } = {}) {
  if (!force && now - lastSweptAt < SWEEP_MIN_INTERVAL_MS) return 0;
  lastSweptAt = now;
  const entries = await readdir(PATHS.federatedMediaInbox).catch(() => null);
  if (!entries) return 0;
  const pinned = collectActiveFederatedAssetBasenames(jobs);
  const candidates = entries.filter((name) => !pinned.has(name));
  const stats = await Promise.all(candidates.map(async (name) => {
    const path = join(PATHS.federatedMediaInbox, name);
    return { path, info: await stat(path).catch(() => null) };
  }));
  const expired = stats.filter(({ info }) =>
    info?.isFile() && now - info.mtimeMs > FEDERATED_MEDIA_ASSET_TTL_MS);
  const results = await Promise.all(expired.map(({ path }) =>
    rm(path, { force: true }).then(() => true, () => false)));
  const removed = results.filter(Boolean).length;
  if (removed) console.log(`🧹 Federated media inbox: swept ${removed} expired conditioning image(s)`);
  return removed;
}
