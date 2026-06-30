/**
 * Federated peer-sync — asset manifests + receiver-side asset transfer.
 *
 * Builds the per-record asset manifests the push pipeline ships (`[{ filename,
 * kind, sha256 }]`), diffs an incoming manifest against local disk, and runs
 * the receiver-side pull worker that fetches missing bytes over the sender's
 * static `/data/{images,image-refs,videos,...}/` mounts. The media-library and
 * CoS-history sync modules reuse the diff + pull primitives here.
 *
 * Split out of the former 4,004-line peerSync.js (#1830).
 */
import { join } from 'path';
import { existsSync } from 'fs';
import { createHash } from 'crypto';
import { PATHS, atomicWrite, readJSONFile, ensureDir, sha256File } from '../../lib/fileUtils.js';
import { isStr } from '../../lib/storyBible.js';
import { isPlainObject } from '../../lib/objects.js';
import { peerBaseUrl } from '../../lib/peerUrl.js';
import { peerFetch } from '../../lib/peerHttpClient.js';
import { withAbortTimeout } from '../../lib/abortTimeout.js';
import { getOrComputeImageSha256, sidecarGenParamsHash } from '../../lib/assetHash.js';
import { generateThumbnail } from '../../lib/ffmpeg.js';
import { sanitizeRecordForWire } from '../../lib/syncWire.js';
import { collectAssetReferences } from './exporter.js';
import { imageSidecarName, sanitizeAssetFilename } from './buckets.js';
import { pullSidecarForImage } from './sidecarSync.js';
import { parseKey } from '../../lib/mediaItemKey.js';
import { listIssues } from '../pipeline/issues.js';
import { findCollectionBySeriesId } from '../mediaCollections.js';
import { headshotImageFilename } from '../authors/index.js';
import { portraitImageFilename } from '../artists/index.js';
import { coverImageFilename } from '../albums/index.js';
import { trackAudioFilename, getTrack } from '../tracks/index.js';
import { startingImageFilename } from '../creativeDirector/local.js';
import { imageUrlToAppAsset } from '../moodBoard/index.js';
import { WRITERS_ROOM_DRAFT_ASSET_KIND } from '../writersRoom/syncLogic.js';
import { WORK_ID_RE, DRAFT_ID_RE, wrWorkDir, wrDraftPath } from '../writersRoom/_shared.js';
import { getWorkForSync } from '../writersRoom/sync.js';
import { peerSyncEvents, findPeerById, isNonEmptyStr } from './peerSyncShared.js';


// --- Asset manifest -----------------------------------------------------

/**
 * Given a record, produce a flat manifest `[{ filename, kind, sha256 }]`
 * the receiver can diff against its local `data/images/` (and friends).
 *
 * Stage 2 scope: direct asset filenames only (`imageRefs`, character sheet
 * pointers, `videoPath`). Job-id resolution (looking up media-job records
 * to find their result filenames) lands alongside the HTTP route wiring in
 * Stage 3 — pulling in the media-job-queue dependency would broaden this
 * module's import graph without a corresponding push-path consumer yet.
 *
 * Assets with no readable SHA (file missing, unreadable) are skipped
 * silently: a sender can't ship bytes it doesn't have on disk, and
 * including a null-hash entry in the manifest would make every receiver
 * diff report the asset as missing even though the sender can't fulfill.
 */
export async function buildAssetManifest(record) {
  const refs = collectAssetReferences(record);
  const out = [];
  // Each kind maps to a different on-disk directory. We compute SHA only
  // for images via the sidecar cache (the canonical content-addressed path);
  // image-refs + videos use `sha256File` on demand and DON'T persist a
  // sidecar — they don't carry the gen-params provenance images do, and
  // adding cache writes here would surprise the broader system.
  for (const filename of refs.directImageFilenames) {
    const entry = await hashImageForManifest(filename);
    if (entry) out.push(entry);
  }
  for (const filename of refs.directImageRefFilenames) {
    const entry = await hashSimpleAsset(filename, 'image-ref', PATHS.imageRefs);
    if (entry) out.push(entry);
  }
  for (const filename of refs.directVideoFilenames) {
    const entry = await hashSimpleAsset(filename, 'video', PATHS.videos);
    if (entry) out.push(entry);
  }
  return out;
}

/**
 * Map a collection's items array to the `{ directImageFilenames,
 * directImageRefFilenames, directVideoFilenames }` shape consumed by the
 * per-item manifest hashers. Collections store items as
 * `{ kind:'image'|'video', ref, addedAt }` and carry no image-ref kind.
 */
export function collectCollectionAssetReferences(collection) {
  const items = Array.isArray(collection?.items) ? collection.items : [];
  const directImageFilenames = [];
  const directVideoFilenames = [];
  for (const it of items) {
    if (it?.kind === 'image' && typeof it.ref === 'string') directImageFilenames.push(it.ref);
    else if (it?.kind === 'video' && typeof it.ref === 'string') directVideoFilenames.push(it.ref);
  }
  return { directImageFilenames, directImageRefFilenames: [], directVideoFilenames };
}

// Video collection items store the BARE video id (e.g. a UUID), while the
// on-disk file is `<id>.mp4` (today every PortOS-managed video is mp4 —
// confirmed by inspecting video-history.json). The image side stores refs
// WITH the extension already. Append `.mp4` unless the ref already carries an
// extension (defensive — older state may have stamped a filename instead of an
// id, and a future video format would land as `.webm` etc.). Shared by BOTH
// collection manifest builders (`buildCollectionAssetManifest` for standalone
// mediaCollection pushes, `buildAssetManifestForCollection` for the
// linkedCollection bundle) so the two can't diverge on the extension rule.
export function collectionVideoRefToFilename(ref) {
  return /\.[a-z0-9]+$/i.test(ref) ? ref : `${ref}.mp4`;
}

export async function buildCollectionAssetManifest(collection) {
  const refs = collectCollectionAssetReferences(collection);
  const out = [];
  for (const filename of refs.directImageFilenames) {
    const entry = await hashImageForManifest(filename);
    if (entry) out.push(entry);
  }
  for (const ref of refs.directVideoFilenames) {
    const entry = await hashSimpleAsset(collectionVideoRefToFilename(ref), 'video', PATHS.videos);
    if (entry) out.push(entry);
  }
  return out;
}

function summarizeAssetManifest(manifest) {
  const entries = Array.isArray(manifest) ? manifest : [];
  return {
    assetHashes: entries.map((e) => e.sha256).filter(Boolean).sort(),
    metadataMissing: entries.some((e) => e?.kind === 'image' && !isNonEmptyStr(e.sidecarSha256)),
  };
}

async function buildIntegrityAssetManifest(kind, record) {
  if (kind === 'mediaCollection') return buildCollectionAssetManifest(record);
  if (kind === 'author') return buildAuthorAssetManifest(record);
  if (kind === 'artist') return buildArtistAssetManifest(record);
  if (kind === 'album') return buildAlbumAssetManifest(record);
  if (kind === 'track') return buildTrackAssetManifest(record);
  if (kind === 'creativeDirectorProject') return buildProjectAssetManifest(record);
  if (kind === 'musicVideoProject') return buildMusicVideoAssetManifest(record);
  if (kind === 'moodBoard') return buildBoardAssetManifest(record);
  if (kind === 'series') {
    const childIssues = await listIssues({ seriesId: record?.id, includeDeleted: true }).catch(() => []);
    const manifestIssues = childIssues.filter(
      (i) => i?.deleted !== true && i?.ephemeral !== true,
    );
    const linkedCollection = await findCollectionBySeriesId(record?.id).catch(() => null);
    return buildAssetManifestForSeries(record, manifestIssues, linkedCollection);
  }
  return buildAssetManifest(record);
}

/**
 * Returns the integrity-facing asset summary for a record: sorted file hashes
 * plus whether any hashed image lacks a gen-params sidecar. `series` mirrors
 * the push manifest path so child issue assets participate in integrity.
 *
 * @param {'universe'|'series'|'mediaCollection'} kind
 * @param {object} record
 * @returns {Promise<{assetHashes:string[], metadataMissing:boolean}>}
 */
export async function assetIntegrityForRecord(kind, record) {
  const manifest = await buildIntegrityAssetManifest(kind, record);
  return summarizeAssetManifest(manifest);
}

/**
 * Back-compat helper for callers/tests that only need hashes.
 *
 * @param {'universe'|'series'|'mediaCollection'} kind
 * @param {object} record
 * @returns {Promise<string[]>} sorted sha256 strings (falsy hashes omitted)
 */
export async function assetShaListForRecord(kind, record) {
  const { assetHashes } = await assetIntegrityForRecord(kind, record);
  return assetHashes;
}

export async function hashImageForManifest(filename) {
  // Sanitize before join — a record with `imageRefs` containing a path-
  // traversal filename (peer-pushed via linkedCollection, hand-edited,
  // or import bug) would otherwise let us stat/hash files outside
  // PATHS.images. The share exporter has the same `base !== filename`
  // posture (services/sharing/exporter.js); peer-sync needs to match.
  const safeName = sanitizeAssetFilename(filename);
  if (!safeName) return null;
  const fullPath = join(PATHS.images, safeName);
  const result = await getOrComputeImageSha256(fullPath);
  if (!result) return null;
  // Advertise a sidecarSha256 only when the sidecar carries gen-params beyond
  // the `sha256` cache block. CRITICAL: we hash the GEN-PARAMS ONLY (sorted-key
  // canonical form, `sha256` cache key stripped) via `sidecarGenParamsHash` —
  // NOT the raw sidecar file. The `sha256` block embeds the LOCAL image's
  // mtime+size, so hashing the whole file would never converge across machines
  // (the receiver re-stamps its own mtime after every pull and re-diverges,
  // re-pulling the sidecar every sync cycle). `sidecarGenParamsHash` returns
  // null when there are no gen-params, so we never advertise a hash for a
  // pure cache-only sidecar.
  const sidecarSha256 = sidecarGenParamsHash(result.sidecar);
  return { filename: safeName, kind: 'image', sha256: result.hash, ...(sidecarSha256 ? { sidecarSha256 } : {}) };
}

export async function hashSimpleAsset(filename, kind, sourceDir) {
  if (!isStr(sourceDir)) return null;
  const safeName = sanitizeAssetFilename(filename);
  if (!safeName) return null;
  const fullPath = join(sourceDir, safeName);
  if (!existsSync(fullPath)) return null;
  const hash = await sha256File(fullPath).catch(() => null);
  if (!hash) return null;
  return { filename: safeName, kind, sha256: hash };
}

// --- Receiver-side asset diff -------------------------------------------

/**
 * Given an incoming asset manifest, return the subset the local instance
 * does NOT have on disk OR whose local hash differs (peer has a newer
 * render under the same UUID — rare but possible during concurrent edits).
 *
 * The receiver will background-fetch each missing asset from the sender's
 * `/data/{images,image-refs,videos}/<filename>` static mount.
 */
export async function diffAssetManifestAgainstLocal(manifest) {
  if (!Array.isArray(manifest)) return [];
  const missing = [];
  for (const entry of manifest) {
    if (!isPlainObject(entry) || !isStr(entry.filename) || !isStr(entry.kind)) continue;
    const dir = directoryForAssetKind(entry.kind);
    if (!dir) continue;
    // Peer-supplied filenames go straight into a local `join(dir, name)` here
    // and via the receiver's reverse-pull GET in Stage 3 — a malicious peer
    // could probe / hash arbitrary local files with a `../etc/passwd` style
    // entry. Reject anything that isn't a bare basename before any FS op.
    const safeName = sanitizeAssetFilename(entry.filename);
    if (!safeName) continue;
    // Build a sanitized projection: only the known fields the receiver needs
    // to pull. Echoing the raw peer-supplied entry would amplify any
    // junk fields it shipped (large strings, extra kinds, prototype-pollution
    // attempts) into the response — wire-symmetry should not let untrusted
    // input round-trip through our process untouched.
    const sanitizedEntry = {
      filename: safeName,
      kind: entry.kind,
      ...(isStr(entry.sha256) ? { sha256: entry.sha256 } : {}),
      ...(isStr(entry.sidecarSha256) ? { sidecarSha256: entry.sidecarSha256 } : {}),
    };
    const fullPath = join(dir, safeName);
    if (!existsSync(fullPath)) {
      missing.push(sanitizedEntry);
      continue;
    }
    // For images, compute the hash result once up front: it carries both the
    // sha256 AND the parsed sidecar JSON, so the sidecarSha256 comparison below
    // reuses it instead of re-reading the same file (one sidecar read per image
    // instead of two). Only touch the cache machinery when a comparison will
    // actually use it (sha256 or sidecarSha256 advertised by the peer).
    let imageHashResult = null;
    if (entry.kind === 'image' && (isStr(entry.sha256) || isStr(entry.sidecarSha256))) {
      imageHashResult = await getOrComputeImageSha256(fullPath);
    }
    // Compare SHA when the manifest carries one — for ALL kinds, not just
    // images. The image path uses the sidecar cache (fast for the common
    // ~200-asset universe case); image-ref/video stream-hash on demand.
    // Existence-only would let a renamed-in-place asset on the receiver
    // silently mismatch the sender, and the snapshot-sync fallback is the
    // ONLY thing that would catch it 60s later — better to detect on push.
    if (isStr(entry.sha256)) {
      const localHash = entry.kind === 'image'
        ? imageHashResult?.hash ?? null
        : await sha256File(fullPath).catch(() => null);
      if (localHash !== entry.sha256) {
        missing.push(sanitizedEntry);
        continue;
      }
    }
    // Sidecar-only divergence: image bytes are already present and hash-match,
    // but the peer has a gen-params sidecar we're missing or have stale.
    // Pull the entry so the worker can fetch ONLY the sidecar (it checks the
    // image hash before deciding whether to re-pull the image bytes).
    //
    // We MUST recompute the local sidecar hash the SAME way the sender did
    // (`sidecarGenParamsHash` — gen-params only, sorted-key canonical, `sha256`
    // cache block stripped). Hashing the raw sidecar file would never match the
    // sender's gen-params-only hash and would re-flag the image every cycle.
    if (entry.kind === 'image' && isStr(entry.sidecarSha256)) {
      // Reuse the sidecar already loaded by getOrComputeImageSha256; only fall
      // back to a direct read if that result was unavailable (e.g. the image
      // became unreadable between the existsSync check and the stat).
      const localSidecar = imageHashResult?.sidecar
        ?? await readJSONFile(join(PATHS.images, imageSidecarName(safeName)), null, { logError: false });
      const localSidecarHash = sidecarGenParamsHash(localSidecar);
      if (localSidecarHash !== entry.sidecarSha256) missing.push(sanitizedEntry);
    }
  }
  return missing;
}

export function directoryForAssetKind(kind) {
  if (kind === 'image') return PATHS.images;
  if (kind === 'image-ref') return PATHS.imageRefs;
  if (kind === 'video') return PATHS.videos;
  if (kind === 'music') return PATHS.music;
  if (kind === 'audio') return PATHS.audio; // #1566 standalone media-library sweep
  return null;
}

/**
 * Hash an author's referenced headshot image (if any) so the receiver can pull
 * the bytes from `/data/images/`. `headshotImageFilename` returns null for an
 * external URL / non-local path, so those never ship as assets (the receiver
 * resolves the same URL itself). A missing local file is skipped silently by
 * `hashImageForManifest` — can't ship bytes we don't have.
 */
export async function buildAuthorAssetManifest(author) {
  const filename = headshotImageFilename(author?.headshotImageUrl);
  if (!filename) return [];
  const entry = await hashImageForManifest(filename);
  return entry ? [entry] : [];
}

export async function buildArtistAssetManifest(artist) {
  const filename = portraitImageFilename(artist?.portraitImageUrl);
  if (!filename) return [];
  const entry = await hashImageForManifest(filename);
  return entry ? [entry] : [];
}

export async function buildAlbumAssetManifest(album) {
  const filename = coverImageFilename(album?.coverImageUrl);
  if (!filename) return [];
  const entry = await hashImageForManifest(filename);
  return entry ? [entry] : [];
}

export async function buildTrackAssetManifest(track) {
  // A track now carries a render history — every render's audio must ride the
  // manifest, not just the active pointer, so a peer can play any received card.
  // Union the active filename with each render's; de-dup (the active render's
  // bytes are also in renders[]).
  const filenames = new Set();
  const active = trackAudioFilename(track?.audioFilename);
  if (active) filenames.add(active);
  for (const r of Array.isArray(track?.renders) ? track.renders : []) {
    const f = trackAudioFilename(r?.audioFilename);
    if (f) filenames.add(f);
  }
  const entries = await Promise.all(
    [...filenames].map((filename) => hashSimpleAsset(filename, 'music', PATHS.music)),
  );
  return entries.filter(Boolean);
}

/**
 * Hash a Creative Director project's direct image input (`startingImageFile`) so
 * the receiver can pull the bytes from `/data/images/`. `startingImageFilename`
 * returns null for an external URL / non-local path, so those never ship (the
 * receiver resolves the same URL itself). Scene VIDEO renders are NOT hashed
 * here: they live in the project's linked media collection, which federates as
 * its own record and ships its bytes via that collection's manifest — duplicating
 * them here would double the transfer. This mirrors buildAuthorAssetManifest:
 * one direct asset, missing-local-file skipped silently.
 */
export async function buildProjectAssetManifest(project) {
  const filename = startingImageFilename(project?.startingImageFile);
  if (!filename) return [];
  const entry = await hashImageForManifest(filename);
  return entry ? [entry] : [];
}

// `data/video-history.json` is a FLAT array of video-generation rows
// (`{ id, filename, ... }`). The same store dataSync's `videoHistory` category
// federates as metadata; here we read it only to resolve a scene's
// `videoHistoryId` to its on-disk basename under PATHS.videos. Mirrors
// dataSync's direct readJSONFile (no videoGen import — that drags in
// ffmpeg/spawn machinery we don't need on the manifest path).
async function videoHistoryFilenamesById() {
  const raw = await readJSONFile(join(PATHS.data, 'video-history.json'), []);
  const map = new Map();
  for (const row of Array.isArray(raw) ? raw : []) {
    if (isStr(row?.id) && isStr(row?.filename)) map.set(row.id, row.filename);
  }
  return map;
}

/**
 * Build a Music Video project's asset manifest (#1772). Unlike the Creative
 * Director store, a music video project has NO auto-linked media collection, so
 * its referenced media has no other federation channel — this manifest is the
 * only way a selectively-subscribed peer receives the bytes. Covers the two
 * media kinds a shipped project actually references:
 *   - the master audio. A project stores EITHER an uploaded basename
 *     (`uploadedAudioFilename`) OR a `trackId` pointing at a music-library track
 *     whose `audioFilename` lives under the same PATHS.music dir; the create UI's
 *     normal path is the latter. We bundle whichever one carries the bytes (#1858)
 *     so a peer subscribed to `musicVideoProjects` ONLY — not the music/tracks
 *     category — still receives playable audio instead of `resolveMasterAudioPath()`
 *     later failing with `Linked track not found` / `AUDIO_MISSING`. When the
 *     linked track ALSO federates (the peer has the music category), dedup by
 *     `music:<filename>` ships it exactly once. The track is dynamic-resolved via
 *     `getTrack`; a deleted/missing track or a track with no `audioFilename` simply
 *     contributes nothing (a missing file is skipped, same as every other ref).
 *   - per-scene rendered clips (`scene.videoHistoryId` → a video-history row →
 *     `<filename>` under PATHS.videos). The row METADATA union-merges via the
 *     `videoHistory` dataSync category; this adds the bytes. Falls back to the
 *     `<id>.mp4` convention (`collectionVideoRefToFilename`) when the row hasn't
 *     synced yet — a missing file is skipped, so a wrong guess never ships.
 *   - per-scene reference-frame stills (`scene.referenceImageId`, #1760 Phase 1b
 *     — a gallery basename under PATHS.images, the same store every other gen'd
 *     image uses). Hashed sidecar-aware via `hashImageForManifest` so a peer that
 *     receives the synced scene record also gets the thumbnail bytes instead of a
 *     dangling `/data/images/<file>` reference.
 *
 * All three kinds are path-traversal-guarded + missing-file-skipped (a wrong/
 * stale reference never forces a peer to re-request bytes the sender lacks);
 * dedup by `<kind>:<filename>` so two scenes pointing at the same render ship once.
 */
export async function buildMusicVideoAssetManifest(project) {
  const dedup = new Map();
  // Master audio: the uploaded basename and/or the linked track's audioFilename
  // (the create-UI path stores trackId with uploadedAudioFilename: null, so a
  // music-video-only subscriber gets no audio unless we resolve+bundle it here).
  const audioNames = [];
  if (isStr(project?.uploadedAudioFilename)) audioNames.push(project.uploadedAudioFilename);
  if (isStr(project?.trackId)) {
    const track = await getTrack(project.trackId).catch(() => null);
    if (isStr(track?.audioFilename)) audioNames.push(track.audioFilename);
  }
  for (const name of [...new Set(audioNames)]) {
    const audio = await hashSimpleAsset(name, 'music', PATHS.music);
    if (audio) dedup.set(`${audio.kind}:${audio.filename}`, audio);
  }
  const scenes = Array.isArray(project?.scenes) ? project.scenes : [];
  const videoIds = [...new Set(
    scenes.map((s) => (isStr(s?.videoHistoryId) ? s.videoHistoryId : null)).filter(Boolean),
  )];
  if (videoIds.length) {
    const byId = await videoHistoryFilenamesById();
    const entries = await Promise.all(videoIds.map((id) =>
      hashSimpleAsset(byId.get(id) || collectionVideoRefToFilename(id), 'video', PATHS.videos),
    ));
    for (const entry of entries) {
      if (entry) dedup.set(`${entry.kind}:${entry.filename}`, entry);
    }
  }
  const imageNames = [...new Set(
    scenes.map((s) => (isStr(s?.referenceImageId) ? s.referenceImageId : null)).filter(Boolean),
  )];
  if (imageNames.length) {
    const entries = await Promise.all(imageNames.map((name) => hashImageForManifest(name)));
    for (const entry of entries) {
      if (entry) dedup.set(`${entry.kind}:${entry.filename}`, entry);
    }
  }
  return [...dedup.values()];
}

/**
 * Hash the local image bytes a mood board's items reference so the receiver can
 * pull them from `/data/{images,image-refs,videos}/`. An image item points at
 * local bytes two ways: a media-key (`image:<ref>` / `video:<ref>`) into the
 * gallery, or an app-path `imageUrl` — a gallery render (`/data/images/...`) OR a
 * character/canon reference sheet (`/data/image-refs/...`, the form
 * PinToMoodBoardMenu pins synthetic `canon-sheet:`/`noun:` sources under).
 * External URLs (http(s)/data/blob) resolve on the receiver itself → skipped.
 * Mirrors `buildAssetManifestForCollection`: path-traversal-guarded,
 * missing-local-file skipped silently (including a null-hash entry would make
 * every receiver re-request bytes the sender can't fulfill),
 * dedup-by-`<kind>:<filename>` so a media-key and imageUrl pointing at the same
 * file ship once. Text items carry no bytes.
 */
export async function buildBoardAssetManifest(board) {
  const dedup = new Map();
  for (const it of board?.items || []) {
    if (!it || it.type !== 'image') continue;
    const pending = [];
    if (typeof it.mediaKey === 'string') {
      const parsed = parseKey(it.mediaKey);
      if (parsed) {
        const safeName = sanitizeAssetFilename(parsed.ref);
        if (safeName) {
          pending.push(parsed.kind === 'video'
            ? hashSimpleAsset(collectionVideoRefToFilename(safeName), 'video', PATHS.videos)
            : hashImageForManifest(safeName));
        }
      }
    }
    if (typeof it.imageUrl === 'string') {
      const asset = imageUrlToAppAsset(it.imageUrl);
      const safeName = asset ? sanitizeAssetFilename(asset.filename) : null;
      if (safeName) {
        // `image-ref` bytes stream-hash from PATHS.imageRefs (same kind/dir the
        // universe-canon manifest uses); gallery `image` bytes go through the
        // sidecar-aware hashImageForManifest.
        pending.push(asset.kind === 'image-ref'
          ? hashSimpleAsset(safeName, 'image-ref', PATHS.imageRefs)
          : hashImageForManifest(safeName));
      }
    }
    for (const entry of await Promise.all(pending)) {
      if (entry) dedup.set(`${entry.kind}:${entry.filename}`, entry);
    }
  }
  return [...dedup.values()];
}

export async function buildAssetManifestForSeries(series, issues, linkedCollection = null) {
  const seriesAssets = await buildAssetManifest(series);
  const dedup = new Map(seriesAssets.map((a) => [`${a.kind}:${a.filename}`, a]));
  for (const issue of issues) {
    const issueAssets = await buildAssetManifest(issue);
    for (const a of issueAssets) {
      dedup.set(`${a.kind}:${a.filename}`, a);
    }
  }
  if (linkedCollection) {
    const collectionAssets = await buildAssetManifestForCollection(linkedCollection);
    for (const a of collectionAssets) {
      dedup.set(`${a.kind}:${a.filename}`, a);
    }
  }
  return [...dedup.values()];
}

/**
 * Combined record + collection asset manifest for the universe push. Same
 * dedup-by-`<kind>:<filename>` semantics as the series path so a render that
 * lives in both the universe's canon (`imageRefs`) and the collection's
 * `items[]` only ships once.
 */
export async function buildAssetManifestWithCollection(record, linkedCollection) {
  const recordAssets = await buildAssetManifest(record);
  const dedup = new Map(recordAssets.map((a) => [`${a.kind}:${a.filename}`, a]));
  if (linkedCollection) {
    const collectionAssets = await buildAssetManifestForCollection(linkedCollection);
    for (const a of collectionAssets) {
      dedup.set(`${a.kind}:${a.filename}`, a);
    }
  }
  return [...dedup.values()];
}

/**
 * Hash each item in a media collection so the receiver can pull missing
 * bytes from `/data/images/` (or `/data/videos/`) via the existing asset-pull
 * worker. Collections are append-mostly and items refer to filenames the
 * sender has on disk; an item whose file is missing (e.g. half-imported
 * from another peer) is skipped silently — including a null-hash entry
 * would make every receiver re-request bytes the sender can't fulfill.
 *
 * Items with `kind: 'video'` route through the video PATHS dir; other kinds
 * (today only 'image') route through the image PATHS dir. This mirrors
 * `collectAssetReferences` and the `directoryForAssetKind` map.
 */
export async function buildAssetManifestForCollection(collection) {
  const out = [];
  for (const it of collection?.items || []) {
    if (!it || typeof it.ref !== 'string') continue;
    // Path-traversal guard: collection items can arrive from a peer (via
    // `linkedCollection` push or the snapshot-sync mediaCollections
    // category), and a malicious `ref` like `../etc/passwd` would otherwise
    // let `join(PATHS, ref)` read arbitrary local files when THIS instance
    // is the sender — leaking the hash of the targeted file to peers. Same
    // posture as the receiver-side `diffAssetManifestAgainstLocal`.
    // `sanitizeItem` in mediaCollections.js also rejects path-traversal
    // refs on the inbound merge boundary; this is defense in depth.
    const safeName = sanitizeAssetFilename(it.ref);
    if (!safeName) continue;
    if (it.kind === 'video') {
      // Bare videoId → `<id>.mp4` via the shared helper (see
      // collectionVideoRefToFilename). `sanitizeAssetFilename` already ran on
      // `it.ref` above; the extension append is purely the on-disk naming rule.
      const entry = await hashSimpleAsset(collectionVideoRefToFilename(safeName), 'video', PATHS.videos);
      if (entry) out.push(entry);
    } else {
      // Treat 'image' (and any unknown kind that isn't 'video') as a gallery
      // image — the receiver's diff path will only accept entries whose kind
      // maps to a known directory in `directoryForAssetKind`, so a junk kind
      // gets filtered there without polluting disk.
      const entry = await hashImageForManifest(safeName);
      if (entry) out.push(entry);
    }
  }
  return out;
}

// --- Receiver-side asset pull worker ------------------------------------

const ASSET_KIND_TO_URL_PREFIX = Object.freeze({
  image: '/data/images',
  'image-ref': '/data/image-refs',
  video: '/data/videos',
  music: '/data/music',
  // `audio` (#1566) — pipeline TTS / generated audio under data/audio, pulled by
  // the standalone media-library sweep. (video-thumbnails are NOT pulled: a video
  // pull regenerates its thumbnail locally — see doPullOneAsset's video branch.)
  audio: '/data/audio',
});

export const ASSET_PULL_TIMEOUT_MS = 60000;
const ASSET_PULL_MAX_BYTES = 100 * 1024 * 1024; // 100MB hard cap per asset

// In-flight pull dedup. A peer can push multiple records that reference the
// same asset in quick succession (universe edit → child collection re-link
// → series under that universe), and without this guard we'd kick off
// duplicate downloads of the same UUID-named PNG — wasting bandwidth,
// doubling the 100MB memory ceiling per asset, and racing on the same
// destination filename. Key on (peerId, kind, filename) so concurrent
// pushes from DIFFERENT peers for the same filename are still allowed
// (e.g. peer-A re-renders and peer-B caches the old bytes — we want the
// newer-pushing peer to win, and the snapshot-sync safety net catches
// any divergence).
export const inflightPulls = new Set();
export function inflightKey(peerId, kind, filename) {
  return `${peerId}:${kind}:${filename}`;
}

/**
 * Background-fetch every asset in `missingAssets` from the named peer's
 * static `/data/{kind-dir}/` mount, writing each to the local PATHS dir for
 * that kind. Emits `peerSyncEvents 'asset-arrived'` per file so the client's
 * MediaImage placeholder can swap to the live asset.
 *
 * Each fetch is best-effort: a single failure does NOT abort the others, and
 * the asset will be retried on the next push cycle (since the receiver will
 * still report it as missing). The 60s loop's snapshot path also catches
 * up if push-driven pulls keep failing — defense in depth.
 *
 * Stage 4 keeps this simple — sequential per-asset fetches, no parallelism
 * cap. A future enhancement could pool 2-4 concurrent fetches if individual
 * universes routinely ship hundreds of assets.
 */
export async function pullMissingAssetsFromPeer(senderInstanceId, missingAssets) {
  if (!isStr(senderInstanceId) || !Array.isArray(missingAssets) || missingAssets.length === 0) return;
  // Trust posture: `senderInstanceId` arrives in the push payload (the route
  // is Tailnet-only per the project's documented threat model — see
  // CLAUDE.md "Security Model"). We DON'T derive it from the TCP origin
  // because Express behind Tailscale loses that fidelity to the SO_REUSEADDR
  // socket. The guard below means even a payload that *spoofs* a different
  // peer's id can only redirect the asset pull at one of our OWN registered
  // peers — `findPeerById` returns null for any unknown id, aborting the
  // pull. So the worst case is fetching from peer-B when peer-A actually
  // pushed; both are trusted Tailnet peers, the fetch either succeeds (we
  // get the bytes peer-A wanted us to have) or 404s (we re-request next
  // push cycle). Outside the Tailnet trust boundary, the right answer is
  // mutual TLS or an HMAC over the payload — explicitly out of scope for
  // PortOS's stated security model.
  const peer = await findPeerById(senderInstanceId);
  if (!peer) {
    console.log(`⚠️ peerSync: can't pull assets — peer ${senderInstanceId} not in registry`);
    return;
  }
  const base = peerBaseUrl(peer);
  for (const entry of missingAssets) {
    await pullOneAsset(peer, base, entry).catch((err) => {
      console.log(`⚠️ peerSync: asset pull ${entry.filename} from ${peer.name || senderInstanceId} failed: ${err.message}`);
    });
  }
}

/**
 * Fetch a peer's static-mount asset URL into a size-capped Buffer, or null on
 * any failure. Centralizes the content-length guards shared by the generic
 * asset pull (`doPullOneAsset`) and the Writers Room draft-body pull
 * (`pullOneWorkBody`): REQUIRE a trustworthy content-length header up front
 * (Express serve-static always sets it) so a hostile peer can't OOM us by
 * shipping a huge body under a small filename before the `.arrayBuffer()` cap
 * runs. `label` is the filename used in log lines.
 */
export async function fetchCappedAssetBuffer(peer, url, label, maxBytes, { allowEmpty = false } = {}) {
  // maxBytes propagates into the HTTPS shim's streaming cap (see
  // server/lib/httpClient.js); the plain-HTTP path falls back to the
  // post-resolve content-length checks below (serve-static always sets it).
  const res = await withAbortTimeout(ASSET_PULL_TIMEOUT_MS, (signal) =>
    peerFetch(url, { signal, maxBytes }, peer))
    .catch((err) => {
      if (err?.message?.includes('exceed')) {
        console.log(`⚠️ peerSync: ${label} exceeded asset size cap — ${err.message}`);
      }
      return null;
    });
  if (!res || !res.ok) return null;
  // Use has() to distinguish "header missing" from "header is '0'" — without it
  // `Number(null)` is 0 and slips past the finite-non-negative guard.
  if (!res.headers.has('content-length')) {
    console.log(`⚠️ peerSync: asset ${label} has no content-length — refusing pull`);
    return null;
  }
  const contentLength = Number(res.headers.get('content-length'));
  // Writers Room draft bodies can legitimately be EMPTY (a brand-new or cleared
  // draft is a 0-byte .md), so they pass `allowEmpty` to permit Content-Length: 0;
  // for every other asset kind a 0-byte body is meaningless and stays rejected.
  const lengthOk = Number.isFinite(contentLength) && (allowEmpty ? contentLength >= 0 : contentLength > 0);
  if (!lengthOk) {
    console.log(`⚠️ peerSync: asset ${label} has invalid content-length (${res.headers.get('content-length')}) — refusing pull`);
    return null;
  }
  if (contentLength > maxBytes) {
    console.log(`⚠️ peerSync: asset ${label} too large (${contentLength}) — refusing pull`);
    return null;
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  // Defense in depth: the server claimed length X but actually sent more.
  if (buffer.length > maxBytes || buffer.length !== contentLength) {
    console.log(`⚠️ peerSync: asset ${label} length mismatch (header=${contentLength}, body=${buffer.length}) — refusing pull`);
    return null;
  }
  return buffer;
}

// --- Receiver-side Writers Room draft-body pull -------------------------
// Bodies live at works/<workId>/drafts/<draftId>.md (nested), not a flat
// basename under one dir, so they ride a dedicated manifest + pull instead of
// the generic flat-asset pipeline. The sender serves them from its
// /data/writers-room/works static mount (server/index.js).
const WORK_BODY_PULL_MAX_BYTES = 16 * 1024 * 1024; // bodies are ≤5MB (validated); 16MB is generous

export async function pullMissingWorkBodies(senderInstanceId, missingBodies) {
  if (!isStr(senderInstanceId) || !Array.isArray(missingBodies) || missingBodies.length === 0) return;
  const peer = await findPeerById(senderInstanceId);
  if (!peer) {
    console.log(`⚠️ peerSync: can't pull draft bodies — peer ${senderInstanceId} not in registry`);
    return;
  }
  const base = peerBaseUrl(peer);
  for (const entry of missingBodies) {
    await pullOneWorkBody(peer, base, entry).catch((err) => {
      console.log(`⚠️ peerSync: draft-body pull ${entry?.draftId} from ${peer.name || senderInstanceId} failed: ${err.message}`);
    });
  }
}

async function pullOneWorkBody(peer, base, entry) {
  const { workId, draftId } = entry || {};
  // Re-validate the path segments here even though diffWorkBodyManifest already
  // did — belt-and-suspenders against a future refactor that bypasses the diff.
  if (typeof workId !== 'string' || !WORK_ID_RE.test(workId)) return;
  if (typeof draftId !== 'string' || !DRAFT_ID_RE.test(draftId)) return;
  const safeLabel = `${workId}/${draftId}.md`;
  const key = inflightKey(peer.instanceId, WRITERS_ROOM_DRAFT_ASSET_KIND, safeLabel);
  if (inflightPulls.has(key)) return;
  inflightPulls.add(key);
  try {
    const url = `${base}/data/writers-room/works/${encodeURIComponent(workId)}/drafts/${encodeURIComponent(draftId)}.md`;
    const buffer = await fetchCappedAssetBuffer(peer, url, safeLabel, WORK_BODY_PULL_MAX_BYTES, { allowEmpty: true });
    if (!buffer) return;
    // Integrity: the bytes must hash to the advertised sha256 (discard a corrupt
    // or wrong download instead of writing it over the draft).
    const bufHash = createHash('sha256').update(buffer).digest('hex');
    if (bufHash !== entry.sha256) {
      console.log(`⚠️ peerSync: draft body ${safeLabel} hash mismatch — discarding (got ${bufHash.slice(0, 8)}, want ${String(entry.sha256).slice(0, 8)})`);
      return;
    }
    // Compare-and-swap against a local save that landed DURING this slow pull:
    // the draft's merged metadata `contentHash` equals entry.sha256 right after
    // the merge, but a local saveDraftBody bumps it (+ updatedAt) to the newer
    // prose. If it no longer matches, the local copy is newer/authoritative (and
    // will re-push) — don't clobber it with the older peer bytes. A vanished
    // draft/work (deleted mid-pull) also skips. (sha256File of the .md equals
    // contentHash(text) since the body is the file verbatim.)
    const current = await getWorkForSync(workId).catch(() => null);
    const draft = Array.isArray(current?.drafts) ? current.drafts.find((d) => d?.id === draftId) : null;
    if (!draft || draft.contentHash !== entry.sha256) {
      console.log(`⚠️ peerSync: draft body ${safeLabel} target moved since diff — skipping write`);
      return;
    }
    await ensureDir(join(wrWorkDir(workId), 'drafts'));
    await atomicWrite(wrDraftPath(workId, draftId), buffer);
    peerSyncEvents.emit('asset-arrived', {
      filename: `${draftId}.md`,
      kind: WRITERS_ROOM_DRAFT_ASSET_KIND,
      peerId: peer.instanceId,
    });
    console.log(`📥 peerSync: pulled draft body ${safeLabel} from ${peer.name || peer.instanceId} (${buffer.length} bytes)`);
  } finally {
    inflightPulls.delete(key);
  }
}

async function pullOneAsset(peer, base, entry) {
  const urlPrefix = ASSET_KIND_TO_URL_PREFIX[entry.kind];
  const localDir = directoryForAssetKind(entry.kind);
  // Re-validate the filename here even though the receiver already
  // sanitized it in diffAssetManifestAgainstLocal — belt-and-suspenders
  // against any future refactor that bypasses the diff path.
  const safeName = sanitizeAssetFilename(entry.filename);
  if (!urlPrefix || !localDir || !safeName) return;
  // Dedup in-flight pulls — if the same (peer, kind, filename) is already
  // being downloaded, skip rather than starting a second concurrent pull.
  // The first pull's `asset-arrived` event will resolve the UI for both
  // the original triggering push AND any subsequent push that wanted the
  // same bytes.
  const key = inflightKey(peer.instanceId, entry.kind, safeName);
  if (inflightPulls.has(key)) return;
  inflightPulls.add(key);
  try {
    await doPullOneAsset(peer, base, entry, urlPrefix, localDir, safeName);
  } finally {
    inflightPulls.delete(key);
  }
}

async function doPullOneAsset(peer, base, entry, urlPrefix, localDir, safeName) {
  // Sidecar-only divergence: image bytes are already present and hash-match
  // the sender's manifest (diffAssetManifestAgainstLocal still returned this
  // entry because the local sidecar is absent or stale). Skip the image
  // re-pull and go straight to the sidecar fetch — avoids re-downloading a
  // potentially large PNG for a metadata-only update.
  if (entry.kind === 'image' && isStr(entry.sha256)) {
    const localFullPath = join(localDir, safeName);
    if (existsSync(localFullPath)) {
      const localHash = (await getOrComputeImageSha256(localFullPath))?.hash ?? null;
      if (localHash === entry.sha256) {
        // Image bytes already up-to-date — pull sidecar only.
        await pullSidecarForImage(peer, base, safeName).catch(() => {});
        return;
      }
    }
  }

  const url = `${base}${urlPrefix}/${encodeURIComponent(safeName)}`;
  const buffer = await fetchCappedAssetBuffer(peer, url, safeName, ASSET_PULL_MAX_BYTES);
  if (!buffer) return;
  await ensureDir(localDir);
  const fullPath = join(localDir, safeName);
  // atomicWrite (temp + rename) so a crash mid-write doesn't leave a
  // half-written file that subsequent `diffAssetManifestAgainstLocal`
  // calls would see as "present" and stop re-requesting.
  await atomicWrite(fullPath, buffer);
  peerSyncEvents.emit('asset-arrived', {
    filename: safeName,
    kind: entry.kind,
    peerId: peer.instanceId,
  });
  console.log(`📥 peerSync: pulled ${entry.kind}/${safeName} from ${peer.name || peer.instanceId} (${buffer.length} bytes)`);
  // After a successful image pull, also fetch the gen-params sidecar if present
  // on the sender. Best-effort: the image is already safely written above;
  // a missing sidecar just means the image lands in Unsorted without a prompt.
  if (entry.kind === 'image') {
    await pullSidecarForImage(peer, base, safeName).catch(() => {});
  }
  // After a video pull, regenerate the thumbnail LOCALLY rather than pulling it
  // as a sibling asset. Cheaper end-to-end: no new asset kind / URL-prefix /
  // manifest-diff plumbing, and the thumbnail filename is deterministic
  // (`<jobId>.jpg`, where jobId === the video filename minus `.mp4`). The
  // synced video-history row already carries `thumbnail: '<jobId>.jpg'`, so
  // once this file exists on disk `normalizeVideo` renders the collection
  // tile. Best-effort: if ffmpeg is missing the row still syncs (the item
  // stops being filtered as "missing"); the tile just falls back to no
  // preview. Mirrors generateThumbnail's null-on-failure contract.
  if (entry.kind === 'video') {
    const jobId = safeName.replace(/\.[a-z0-9]+$/i, '');
    const videoPath = join(localDir, safeName);
    await generateThumbnail(videoPath, jobId).catch(() => null);
  }
}