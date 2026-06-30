/**
 * Federated peer-sync — standalone media-library sync (#1566).
 *
 * Advertises a library-level manifest (every generated image/video, pipeline
 * audio, uploaded music) at `GET /api/peer-sync/library-manifest`, and (for
 * full-sync peers) diffs a peer's manifest against local disk + pulls the
 * missing bytes via the shared asset-pull primitives. Independent of the
 * per-record subscription pipeline.
 *
 * Split out of the former 4,004-line peerSync.js (#1830).
 */
import { join } from 'path';
import { readdir, stat } from 'fs/promises';
import { createHash } from 'crypto';
import { PATHS } from '../../lib/fileUtils.js';
import { isStr } from '../../lib/storyBible.js';
import { isPlainObject } from '../../lib/objects.js';
import { peerBaseUrl } from '../../lib/peerUrl.js';
import { peerFetch } from '../../lib/peerHttpClient.js';
import { withAbortTimeout } from '../../lib/abortTimeout.js';
import { sanitizeAssetFilename } from './buckets.js';
import { PORTOS_SCHEMA_VERSIONS } from '../../lib/schemaVersions.js';
import { getPeers } from '../instances.js';
import { peerLibraryManifestSchema } from '../../lib/validation.js';
import {
  hashSimpleAsset,
  hashImageForManifest,
  diffAssetManifestAgainstLocal,
  pullMissingAssetsFromPeer,
  ASSET_PULL_TIMEOUT_MS,
} from './peerSyncAssets.js';
import { findPeerById, isNonEmptyStr, FORCE_REVALIDATE_EVERY } from './peerSyncShared.js';


// --- Standalone media-library federation (#1566) ------------------------
//
// The per-record pipeline above replicates only the bytes a SYNCED creative
// record references. For a declared full-sync peer pair we ALSO mirror the
// STANDALONE media library — every generated image/video, pipeline audio, and
// user-uploaded music — so each peer's Media tab is a complete replica.
//
// Shape: the sender advertises a library-level manifest (filename + sha256 per
// asset) at GET /api/peer-sync/library-manifest; a receiver (only for peers it
// has flagged fullSync) fetches it, diffs vs local disk via the SAME
// diffAssetManifestAgainstLocal + pullOneAsset machinery the per-record path
// uses, and rebuilds the derived media_assets index once bytes land. Notably:
//   - video THUMBNAILS are regenerated locally on each video pull
//     (doPullOneAsset's video branch), not byte-federated;
//   - video-history METADATA already union-merges via the `videoHistory`
//     dataSync category — the bytes are what this adds;
//   - the generic data/history.jsonl action log is machine-local and never
//     federated (it's app activity, not media gen history).

// The on-disk media kinds the library manifest covers, resolved at CALL TIME
// (not frozen at module load) so a redirected PATHS — the test-suite tmpdir
// pattern, and consistent with directoryForAssetKind reading PATHS live — is
// honored. `image` carries a gen-params sidecar (rides via hashImageForManifest);
// the rest are flat bytes. image-refs are EXCLUDED (ephemeral FLUX multi-ref
// scratch); video-thumbnails are EXCLUDED (regenerated locally on video pull).
function mediaLibraryDirs() {
  return [
    { kind: 'image', dir: PATHS.images },
    { kind: 'video', dir: PATHS.videos },
    { kind: 'audio', dir: PATHS.audio },
    { kind: 'music', dir: PATHS.music },
  ];
}

// Stable data-root-relative basename per kind, used only to match backup
// exclude patterns. Independent of PATHS so a redirected path can't change which
// exclude pattern applies.
const MEDIA_LIBRARY_KIND_DIRNAMES = Object.freeze({
  image: 'images', video: 'videos', audio: 'audio', music: 'music',
});

// Cap so a pathologically large library can't build an unbounded manifest. 100k
// assets is far beyond any realistic single-user library; when exceeded we LOG
// and truncate (per CLAUDE.md "no silent caps") rather than ship an open-ended
// list. Pagination is a clean follow-up if ever hit. Kept in sync with the
// `assets` array cap in peerLibraryManifestSchema.
const MEDIA_LIBRARY_MANIFEST_CAP = 100_000;

/**
 * Pure matcher: given a list of effective rsync exclude patterns, return the Set
 * of media-library KINDS the user has excluded from backup (and therefore from
 * federation, per the #1566 acceptance criterion). Checked at DIRECTORY
 * granularity — recognizes a whole-dir exclude (`/videos`, `/videos/`,
 * `/videos/**`, or the bare `videos/` form). Per-file glob granularity is out of
 * scope: none of the media dirs are excluded by DEFAULT_EXCLUDES, so this only
 * fires on a custom user exclude like `/music/`, and excluding individual files
 * from federation isn't a supported control.
 *
 * Exported for unit testing without mocking the settings/backup IO.
 */
export function libraryKindsExcludedByPatterns(effectiveExcludes) {
  const excluded = new Set();
  const patterns = Array.isArray(effectiveExcludes) ? effectiveExcludes : [];
  // Normalize each pattern to its bare anchored segment in one pass: strip
  // leading slashes, a trailing `/**`/`/*`, or a trailing slash → `/videos/**`
  // and `videos/` both collapse to `videos`.
  const normalized = patterns.map((p) => String(p).replace(/^\/+|\/+\*+$|\/+$/g, ''));
  for (const [kind, name] of Object.entries(MEDIA_LIBRARY_KIND_DIRNAMES)) {
    if (normalized.includes(name)) excluded.add(kind);
  }
  return excluded;
}

// Honor the backup exclusion contract (#1566 acceptance). Best-effort: a
// settings/backup read failure federates everything (the prior behavior), never
// throws. Composes the IO (read settings, compute effective excludes) with the
// pure `libraryKindsExcludedByPatterns` matcher above.
async function excludedLibraryKinds() {
  const settingsMod = await import('../settings.js').catch(() => null);
  const backupMod = await import('../backup.js').catch(() => null);
  if (!settingsMod?.getSettings || !backupMod?.computeEffectiveExcludes) return new Set();
  const settings = await settingsMod.getSettings().catch(() => null);
  const excludePaths = Array.isArray(settings?.backup?.excludePaths) ? settings.backup.excludePaths : [];
  const disabledDefaultExcludes = Array.isArray(settings?.backup?.disabledDefaultExcludes) ? settings.backup.disabledDefaultExcludes : [];
  const effective = backupMod.computeEffectiveExcludes({ excludePaths, disabledDefaultExcludes });
  return libraryKindsExcludedByPatterns(effective);
}

// In-memory hash cache for the flat (non-image) library kinds, keyed by full
// path → { mtimeMs, size, entry }. The manifest is rebuilt on every poll (each
// full-sync peer fetches it ~every 60s), and video/music files can be large —
// re-`sha256File`-ing a multi-GB library every poll is real, avoidable disk I/O.
// Images already cache their sha in the sidecar (getOrComputeImageSha256), so
// this only covers video/audio/music. Invalidated on (mtimeMs, size) change —
// the same cheap signal the image sidecar cache uses; a re-render writes a new
// file (new mtime), so staleness isn't a concern.
const libraryFlatHashCache = new Map(); // fullPath → { mtimeMs, size, entry }

async function hashCachedLibraryAsset(name, kind, dir) {
  const safeName = sanitizeAssetFilename(name);
  if (!safeName) return null;
  const fullPath = join(dir, safeName);
  const st = await stat(fullPath).catch(() => null);
  if (!st || !st.isFile()) return null;
  const cached = libraryFlatHashCache.get(fullPath);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.entry;
  const entry = await hashSimpleAsset(safeName, kind, dir);
  if (entry) libraryFlatHashCache.set(fullPath, { mtimeMs: st.mtimeMs, size: st.size, entry });
  return entry;
}

/**
 * Build the standalone media-library manifest this instance advertises to
 * full-sync peers. Walks each media dir, hashes every file (reusing the
 * per-record hashers so the wire shape is identical), and stamps a `manifestHash`
 * over the sorted entries so a receiver can short-circuit an unchanged library.
 *
 * @returns {Promise<{ schemaVersion:number, manifestHash:string, assets:Array }>}
 */
export async function buildMediaLibraryManifest() {
  const excluded = await excludedLibraryKinds();
  const assets = [];
  let truncated = false;
  for (const { kind, dir } of mediaLibraryDirs()) {
    if (truncated) break;
    if (excluded.has(kind)) continue;
    const names = await readdir(dir).catch(() => []); // missing dir → empty (nothing of that kind yet)
    for (const name of names) {
      // Image sidecars are metadata, not standalone assets — they ride the image
      // entry's sidecarSha256 + the receiver's pullSidecarForImage, so skip the
      // `.json` files in the images dir.
      if (kind === 'image' && name.endsWith('.json')) continue;
      const entry = kind === 'image'
        ? await hashImageForManifest(name)        // sidecar-cached
        : await hashCachedLibraryAsset(name, kind, dir); // (mtime,size)-cached
      if (!entry) continue;
      if (assets.length >= MEDIA_LIBRARY_MANIFEST_CAP) { truncated = true; break; }
      assets.push(entry);
    }
  }
  if (truncated) {
    console.log(`⚠️ peerSync: media-library manifest hit the ${MEDIA_LIBRARY_MANIFEST_CAP}-asset cap — truncating (some assets won't federate; pagination is a follow-up)`);
  }
  // Deterministic order (sort by filename) so the manifestHash converges across
  // machines regardless of readdir order / filesystem.
  const sorted = assets.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
  const manifestHash = createHash('sha256')
    .update(sorted.map((e) => `${e.kind}:${e.filename}:${e.sha256 || ''}:${e.sidecarSha256 || ''}`).join('\n'))
    .digest('hex');
  return { schemaVersion: PORTOS_SCHEMA_VERSIONS.mediaLibrary, manifestHash, assets: sorted };
}

// Receiver-side: last manifestHash fully processed per peer, so an unchanged
// library skips the diff entirely. In-memory (rebuilt on restart — the first
// post-boot sweep just re-confirms disk, cheap because the diff finds everything
// present and pulls nothing).
const lastLibraryManifestHash = new Map(); // peerInstanceId → manifestHash
// Consecutive unchanged-manifest ticks per peer; after FORCE_REVALIDATE_EVERY we
// force a full re-diff even though the remote manifest is unchanged, so a local
// file loss self-heals without waiting for a restart or a remote library change.
const libraryUnchangedSkips = new Map(); // peerInstanceId → count
// Per-peer re-entrancy guard so a slow sweep (large pull) can't overlap itself
// when the periodic tick fires again before it finishes.
const librarySweepInFlight = new Set(); // peerInstanceId
// The manifest JSON itself (not the bytes — those ride the per-asset 100MB cap).
const MEDIA_LIBRARY_MANIFEST_MAX_BYTES = 32 * 1024 * 1024;

async function reconcileMediaLibraryIndex() {
  // Dynamic import keeps the DB-backed index module out of peerSync's static
  // graph (it no-ops under the file/test backend). image+video rows are rebuilt
  // from disk; audio/music aren't indexed (served from disk directly).
  const mod = await import('../mediaAssetIndex/index.js').catch(() => null);
  if (!mod?.reconcileMediaAssets) return;
  await mod.reconcileMediaAssets().catch((err) => {
    console.log(`⚠️ peerSync: media_assets reconcile after library sweep failed: ${err.message}`);
  });
}

/**
 * Receiver-pull the standalone media library from ONE full-sync peer: fetch its
 * manifest, gate on schema version, diff vs local disk, pull missing bytes, then
 * rebuild the derived media_assets index. No-op for a non-full-sync peer.
 *
 * Best-effort + idempotent: every guard returns rather than throws so a periodic
 * caller can fire it unconditionally.
 *
 * @param {object} peer  a peer entry from getPeers()
 * @returns {Promise<{ pulled:number, skipped?:string }>}
 */
export async function syncMediaLibraryFromPeer(peer) {
  if (!isPlainObject(peer) || peer.fullSync !== true || !isStr(peer.instanceId)) {
    return { pulled: 0, skipped: 'not-fullsync' };
  }
  if (librarySweepInFlight.has(peer.instanceId)) return { pulled: 0, skipped: 'in-flight' };
  librarySweepInFlight.add(peer.instanceId);
  try {
    const url = `${peerBaseUrl(peer)}/api/peer-sync/library-manifest`;
    const res = await withAbortTimeout(ASSET_PULL_TIMEOUT_MS, (signal) =>
      peerFetch(url, { signal, maxBytes: MEDIA_LIBRARY_MANIFEST_MAX_BYTES }, peer))
      .catch(() => null);
    if (!res || !res.ok) return { pulled: 0, skipped: 'unreachable' };
    // Enforce the manifest cap before buffering the body. peerFetch's `maxBytes`
    // only streams-caps the HTTPS (host) shim; for a plain-HTTP (address) peer it
    // delegates to native fetch, which ignores `maxBytes`, so `res.json()` would
    // otherwise buffer an unbounded body. Express on the sender sets Content-Length
    // for the JSON response, so a content-length check here is the real cap (mirrors
    // the record-pull path's RECORD_PAYLOAD_MAX_BYTES guard). A peer that omits it
    // is a trusted tailnet peer per the threat model.
    const declaredLen = Number(res.headers?.get?.('content-length'));
    if (Number.isFinite(declaredLen) && declaredLen > MEDIA_LIBRARY_MANIFEST_MAX_BYTES) {
      console.log(`⚠️ peerSync: media-library manifest from ${peer.name || peer.instanceId} too large (${declaredLen} > ${MEDIA_LIBRARY_MANIFEST_MAX_BYTES}) — skipping`);
      return { pulled: 0, skipped: 'too-large' };
    }
    const body = await res.json().catch(() => null);
    const parsed = peerLibraryManifestSchema.safeParse(body);
    if (!parsed.success) {
      console.log(`⚠️ peerSync: media-library manifest from ${peer.name || peer.instanceId} failed validation — skipping`);
      return { pulled: 0, skipped: 'invalid' };
    }
    const manifest = parsed.data;
    // Schema gate — GENTLE skip (not reject): the sender's manifest envelope is
    // newer than this instance understands. Wait for the local PortOS to upgrade
    // rather than mis-pull against a contract we can't read. (Bytes are
    // version-agnostic, but a manifest-SHAPE bump means a new field we'd mishandle.)
    if (manifest.schemaVersion > PORTOS_SCHEMA_VERSIONS.mediaLibrary) {
      console.log(`⏸️ peerSync: ${peer.name || peer.instanceId} media-library manifest is schema v${manifest.schemaVersion} > local v${PORTOS_SCHEMA_VERSIONS.mediaLibrary} — skipping until this instance updates`);
      return { pulled: 0, skipped: 'schema-ahead' };
    }
    // Unchanged-library short-circuit — but force a full re-diff every
    // FORCE_REVALIDATE_EVERY consecutive unchanged ticks so a LOCAL file loss /
    // corruption self-heals even while the REMOTE manifest stays put. (The
    // recorded hash is in-memory, so a process restart also re-diffs; this covers
    // the mid-session window between restarts.)
    if (lastLibraryManifestHash.get(peer.instanceId) === manifest.manifestHash) {
      const skips = (libraryUnchangedSkips.get(peer.instanceId) || 0) + 1;
      if (skips < FORCE_REVALIDATE_EVERY) {
        libraryUnchangedSkips.set(peer.instanceId, skips);
        return { pulled: 0, skipped: 'unchanged' };
      }
      libraryUnchangedSkips.set(peer.instanceId, 0); // periodic forced re-diff — fall through
    }
    const missing = await diffAssetManifestAgainstLocal(manifest.assets);
    if (missing.length === 0) {
      lastLibraryManifestHash.set(peer.instanceId, manifest.manifestHash);
      return { pulled: 0 };
    }
    const requested = missing.length;
    // Reuse the per-record pull worker (in-flight dedup, image-sidecar fetch,
    // video-thumbnail regen).
    await pullMissingAssetsFromPeer(peer.instanceId, missing);
    // `pullMissingAssetsFromPeer` swallows per-asset failures (peer drops
    // mid-sweep, 404, size-cap reject) and always resolves — so a resolved pull
    // does NOT mean every byte landed. Re-diff against disk to see what actually
    // arrived; this is the authoritative signal, not the pull's resolution.
    const stillMissing = await diffAssetManifestAgainstLocal(manifest.assets);
    const pulled = requested - stillMissing.length;
    // Rebuild the derived media_assets index when any image/video bytes landed so
    // the gallery/Media tab reflects them. Idempotent; best-effort.
    if (pulled > 0) await reconcileMediaLibraryIndex();
    if (stillMissing.length === 0) {
      // Full sweep — safe to short-circuit future ticks on this manifestHash.
      lastLibraryManifestHash.set(peer.instanceId, manifest.manifestHash);
      console.log(`📥 peerSync: media-library sweep from ${peer.name || peer.instanceId} — pulled ${pulled} asset(s)`);
    } else {
      // Partial pull — do NOT record the hash, so the next tick re-diffs and
      // retries the still-missing assets instead of being marked done.
      console.log(`⚠️ peerSync: media-library sweep from ${peer.name || peer.instanceId} — pulled ${pulled}/${requested}, ${stillMissing.length} still missing; retrying next tick`);
    }
    return { pulled, missing: stillMissing.length };
  } finally {
    librarySweepInFlight.delete(peer.instanceId);
  }
}

/**
 * Periodic driver: sweep the standalone media library from every full-sync peer.
 * Called on a timer from initSharing. Each peer's sweep is independent and
 * best-effort; the per-peer re-entrancy guard + manifestHash short-circuit keep
 * an unchanged library cheap.
 */
export async function syncMediaLibraryWithAllPeers() {
  const peers = await getPeers().catch(() => []);
  const fullSyncPeers = peers.filter((p) => p?.fullSync === true && p?.enabled !== false && isStr(p.instanceId));
  for (const peer of fullSyncPeers) {
    await syncMediaLibraryFromPeer(peer).catch((err) => {
      console.log(`⚠️ peerSync: media-library sweep for ${peer.name || peer.instanceId} failed: ${err.message}`);
    });
  }
}