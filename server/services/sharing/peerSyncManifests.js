/** Build federated asset manifests and compare incoming references with local files. */

import { join } from 'path';
import { existsSync } from 'fs';
import { PATHS, readJSONFile } from '../../lib/fileUtils.js';
import { isPlainObject } from '../../lib/objects.js';
import { getOrComputeImageSha256, sidecarGenParamsHash, sidecarMatchesGenParamsHash, imageLiveStamp } from '../../lib/assetHash.js';
import { collectAssetReferences } from './exporter.js';
import { imageSidecarName, sanitizeAssetFilename } from './buckets.js';
import { heldImageAdoptsOrigin } from './sidecarSync.js';
import { parseKey } from '../../lib/mediaItemKey.js';
import { musicVideoCameoImageIds } from '../../lib/musicVideo/musicVideoCameos.js';
import { headshotImageFilename } from '../authors/index.js';
import { portraitImageFilename } from '../artists/index.js';
import { coverImageFilename } from '../albums/index.js';
import { trackAudioFilename, getTrack } from '../tracks/index.js';
import { startingImageFilename } from '../creativeDirector/local.js';
import { imageUrlToAppAsset } from '../moodBoard/index.js';
import { isStr } from '../../lib/textUtils.js';
import { mapWithConcurrency } from '../../lib/mapWithConcurrency.js';
import { collectionVideoRefToFilename, loadCollectionVideoFilenames, resolveCollectionVideoFilename } from '../collectionVideoFiles.js';
import {
  blockedByImageTombstone,
  blockedByVideoTombstone,
  deletedImageStamps,
  deletedVideoIds,
  directoryForAssetKind,
  hasAllowedAssetExtension,
  readVideoHistoryRows,
  sha256FileCached
} from './peerSyncAssetMetadata.js';

// Bound file hashing to avoid starving unrelated filesystem work when a
// large record (especially a deck) advertises hundreds of images.
const ASSET_HASH_CONCURRENCY = 8;


// Filename-only references are shared by the sender builders and receiver
// admission. Never hash local files to decide whether a missing asset is owed.
function assetReference(filename, kind) {
  const safeName = sanitizeAssetFilename(filename);
  return safeName ? { filename: safeName, kind } : null;
}

function imageAssetReference(filename) {
  return assetReference(filename, 'image');
}

async function hashAssetReferences(references) {
  const entries = await mapWithConcurrency(references, ASSET_HASH_CONCURRENCY, (entry) => (
    entry.kind === 'image'
      ? hashImageForManifest(entry.filename)
      : hashSimpleAsset(entry.filename, entry.kind, directoryForAssetKind(entry.kind))
  ));
  return entries.filter(Boolean);
}

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
  return hashAssetReferences(referenceAssetManifest(record));
}

function referenceAssetManifest(record) {
  const refs = collectAssetReferences(record);
  const out = [];
  for (const filename of refs.directImageFilenames) {
    const entry = imageAssetReference(filename);
    if (entry) out.push(entry);
  }
  for (const filename of refs.directImageRefFilenames) {
    const entry = assetReference(filename, 'image-ref');
    if (entry) out.push(entry);
  }
  for (const filename of refs.directVideoFilenames) {
    const entry = assetReference(filename, 'video');
    if (entry) out.push(entry);
  }
  return out;
}

export async function buildCollectionAssetManifest(collection) {
  const history = await loadCollectionVideoFilenames(collection?.items);
  return hashAssetReferences(referenceCollectionAssetManifest(collection, history));
}

/** Collection items have gallery image names and video refs, with no image-ref kind. */
export function collectCollectionAssetReferences(collection) {
  const directImageFilenames = [];
  const directVideoFilenames = [];
  for (const item of Array.isArray(collection?.items) ? collection.items : []) {
    if (typeof item?.ref !== 'string') continue;
    if (item.kind === 'image') directImageFilenames.push(item.ref);
    else if (item.kind === 'video') directVideoFilenames.push(item.ref);
  }
  return { directImageFilenames, directImageRefFilenames: [], directVideoFilenames };
}

// The diagnostic pairs files across peer versions by the legacy reference
// name, even when one peer knows the history filename and the other doesn't.
export async function buildCollectionIntegrityAssets(collection) {
  const items = Array.isArray(collection?.items) ? collection.items : [];
  const history = await loadCollectionVideoFilenames(items);
  const videoFilenames = Object.fromEntries(items.flatMap((item) => {
    if (item?.kind !== 'video') return [];
    const filename = resolveCollectionVideoFilename(item.ref, history);
    if (!filename) return [];
    const fallback = collectionVideoRefToFilename(item.ref);
    return filename !== fallback ? [[fallback, filename]] : [];
  }));
  const assets = referenceCollectionAssetManifest(collection, history);
  const [assetManifest, hostedBy] = await Promise.all([
    hashAssetReferences(assets),
    import('../peerHostedMedia.js').then((m) => m.hostedByForCollectionItems(items)),
  ]);
  return { assetManifest, videoFilenames, hostedBy };
}

export function referenceCollectionAssetManifest(collection, videoFilenames) {
  const { directImageFilenames, directVideoFilenames } = collectCollectionAssetReferences(collection);
  return [
    ...directImageFilenames.map(imageAssetReference),
    ...directVideoFilenames.map((ref) => assetReference(resolveCollectionVideoFilename(ref, videoFilenames), 'video')),
  ].filter(Boolean);
}

// assetIntegrityForRecord / assetShaListForRecord (per-kind integrity-hash
// dispatch) moved to recordKinds.js (#6843) — its dispatch reads RECORD_KINDS,
// and this module must never import that table (recordKinds.js ->
// peerSyncManifests.js is the only allowed direction between the two).

/**
 * `withCreatedAt` adds the image's live stamp (imageLiveStamp) so a receiver
 * holding a tombstone for a re-used name can tell a newer image from the
 * deleted one. Only the library manifest asks for it, and only from receivers
 * that understand it (see PEER_LIBRARY_TOMBSTONES_HEADER).
 */
export async function hashImageForManifest(filename, { withCreatedAt = false, localInstanceId = null, fileStat } = {}) {
  // Sanitize before join — a record with `imageRefs` containing a path-
  // traversal filename (peer-pushed via linkedCollection, hand-edited,
  // or import bug) would otherwise let us stat/hash files outside
  // PATHS.images. The share exporter has the same `base !== filename`
  // posture (services/sharing/exporter.js); peer-sync needs to match.
  const safeName = sanitizeAssetFilename(filename);
  if (!safeName) return null;
  const fullPath = join(PATHS.images, safeName);
  const result = await getOrComputeImageSha256(fullPath, fileStat);
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
  // A pulled copy without a sidecar stamp advertises none, so receivers keep a
  // tombstoned name blocked rather than taking its pull time as new.
  const createdAt = withCreatedAt ? imageLiveStamp(result.sidecar, result.fileStat, { localInstanceId }) : null;
  return { filename: safeName, kind: 'image', sha256: result.hash, ...(sidecarSha256 ? { sidecarSha256 } : {}), ...(createdAt ? { createdAt } : {}) };
}

// The receiver advertises the capability in its health details (see
// PORTOS_SCHEMA_VERSIONS.peerAssetStamps); an older one never does.
export const peerAcceptsAssetStamps = (peer) => peer?.lastHealth?.assetStamps?.version >= 1;

/**
 * Add each image entry's live stamp to a per-record push manifest so a receiver
 * holding a tombstone for a re-used name can tell a re-made image from the
 * deleted one. Call only for a receiver that advertised it accepts the field
 * (its strict entry schema refuses it otherwise). An image with no stamp keeps
 * its entry unchanged and stays blocked there.
 */
export async function stampImageManifestEntries(manifest, { localInstanceId = null } = {}) {
  return mapWithConcurrency(manifest, ASSET_HASH_CONCURRENCY, async (entry) => {
    if (entry?.kind !== 'image') return entry;
    const stamped = await hashImageForManifest(entry.filename, { withCreatedAt: true, localInstanceId });
    return stamped?.createdAt ? { ...entry, createdAt: stamped.createdAt } : entry;
  });
}

export async function hashSimpleAsset(filename, kind, sourceDir) {
  if (!isStr(sourceDir)) return null;
  const safeName = sanitizeAssetFilename(filename);
  if (!safeName) return null;
  const fullPath = join(sourceDir, safeName);
  const hash = await sha256FileCached(fullPath);
  if (!hash) return null;
  return { filename: safeName, kind, sha256: hash };
}

// --- Receiver-side asset diff -------------------------------------------

/**
 * Given an incoming asset manifest, return the subset the local instance
 * does NOT have on disk OR whose local hash differs (peer has a newer
 * render under the same UUID — rare but possible during concurrent edits).
 *
 * `includeMismatched: false` admits only absent files, preserving existing
 * image bytes AND sidecars after a rejected record merge.
 *
 * The receiver will background-fetch each missing asset from the sender's
 * `/data/{images,image-refs,videos}/<filename>` static mount.
 */
export async function diffAssetManifestAgainstLocal(manifest, { includeMismatched = true, senderInstanceId = null } = {}) {
  if (!Array.isArray(manifest)) return [];
  // A gallery image deleted here (or by its owner) is never pulled back.
  const deletedImages = await deletedImageStamps(manifest);
  const deletedVideos = await deletedVideoIds(manifest);
  // Released to a Make-primary host (services/mediaHolders.js): streamed from
  // there on purpose, so an absent copy is not missing. Read only when needed.
  let releasedPromise = null;
  const isReleased = async (kind, name) => {
    if (kind !== 'image' && kind !== 'video') return false;
    releasedPromise ??= import('../peerHostedMedia.js').then((m) => m.releasedHostedKeys()).catch(() => new Set());
    return (await releasedPromise).has(`${kind}:${name}`);
  };
  let hostedIndexPromise = null;
  const getHostedIndex = () => {
    hostedIndexPromise ??= import('../peerHostedMedia.js').then((m) => m.listHostedEntries());
    return hostedIndexPromise;
  };
  const results = await mapWithConcurrency(manifest, ASSET_HASH_CONCURRENCY, async (entry) => {
    if (!isPlainObject(entry) || !isStr(entry.filename) || !isStr(entry.kind)) return null;
    if (blockedByImageTombstone(deletedImages, entry) || blockedByVideoTombstone(deletedVideos, entry)) return null;
    const dir = directoryForAssetKind(entry.kind);
    if (!dir) return null;
    // Peer-supplied filenames go straight into a local `join(dir, name)` here
    // and via the receiver's reverse-pull GET in Stage 3 — a malicious peer
    // could probe / hash arbitrary local files with a `../etc/passwd` style
    // entry. Reject anything that isn't a bare basename before any FS op.
    const safeName = sanitizeAssetFilename(entry.filename);
    if (!safeName) return null;
    if (!hasAllowedAssetExtension(entry.kind, safeName)) return null;
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
      ...(entry.kind === 'image' && isStr(entry.createdAt) ? { createdAt: entry.createdAt } : {}),
    };
    const fullPath = join(dir, safeName);
    if (!existsSync(fullPath)) {
      return (await isReleased(entry.kind, safeName)) ? null : sanitizedEntry;
    }
    if (!includeMismatched) return null;
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
    // images. Images use the sidecar cache; flat assets use the stat-keyed
    // sha256FileCached map so large videos/audio/models are not re-hashed on
    // every diff or post-pull re-diff when unchanged on disk.
    if (isStr(entry.sha256)) {
      const localHash = entry.kind === 'image'
        ? imageHashResult?.hash ?? null
        : await sha256FileCached(fullPath);
      if (localHash !== entry.sha256) return sanitizedEntry;
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
      // A copy this sender may name the origin of must pull the sidecar to adopt it.
      const hostedIndex = await getHostedIndex();
      const adopts = heldImageAdoptsOrigin(localSidecar, { instanceId: senderInstanceId }, safeName, hostedIndex);
      if (!sidecarMatchesGenParamsHash(localSidecar, entry.sidecarSha256, { originCandidates: adopts ? [] : [senderInstanceId] })) return sanitizedEntry;
    }
    return null;
  });
  return results.filter(Boolean);
}

/**
 * Hash an author's referenced headshot image (if any) so the receiver can pull
 * the bytes from `/data/images/`. `headshotImageFilename` returns null for an
 * external URL / non-local path, so those never ship as assets (the receiver
 * resolves the same URL itself). A missing local file is skipped silently by
 * `hashImageForManifest` — can't ship bytes we don't have.
 */
export async function buildAuthorAssetManifest(author) {
  return hashAssetReferences(referenceAuthorAssetManifest(author));
}

export function referenceAuthorAssetManifest(author) {
  const filename = headshotImageFilename(author?.headshotImageUrl);
  if (!filename) return [];
  const entry = imageAssetReference(filename);
  return entry ? [entry] : [];
}

export async function buildArtistAssetManifest(artist) {
  return hashAssetReferences(referenceArtistAssetManifest(artist));
}

export function referenceArtistAssetManifest(artist) {
  const filename = portraitImageFilename(artist?.portraitImageUrl);
  if (!filename) return [];
  const entry = imageAssetReference(filename);
  return entry ? [entry] : [];
}

export async function buildAlbumAssetManifest(album) {
  return hashAssetReferences(referenceAlbumAssetManifest(album));
}

export function referenceAlbumAssetManifest(album) {
  const filename = coverImageFilename(album?.coverImageUrl);
  if (!filename) return [];
  const entry = imageAssetReference(filename);
  return entry ? [entry] : [];
}

export async function buildTrackAssetManifest(track) {
  return hashAssetReferences(referenceTrackAssetManifest(track));
}

export function referenceTrackAssetManifest(track) {
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
  const entries = [...filenames].map((filename) => assetReference(filename, 'music'));
  return entries.filter(Boolean);
}

/**
 * Hash a Creative Director project's direct image input (`startingImageFile`)
 * and first-pass music bed (`musicBed.filename`, #1928) so the receiver can
 * pull the bytes from `/data/images/` and `/data/music/` respectively.
 * `startingImageFilename` returns null for an external URL / non-local path,
 * so those never ship (the receiver resolves the same URL itself). Scene
 * VIDEO renders are NOT hashed here: they live in the project's linked media
 * collection, which federates as its own record and ships its bytes via that
 * collection's manifest — duplicating them here would double the transfer.
 * Directive-plan render steps do not enter that collection, so their settled
 * image/video job ids are bundled directly. The music bed has no alternate
 * channel either, so without bundling it a subscribed peer would receive a
 * dangling `musicBed.filename` reference — mirrors how `buildTrackAssetManifest`
 * / `buildMusicVideoAssetManifest` bundle their `PATHS.music` audio. Each direct
 * asset is missing-local-file skipped silently (mirrors buildAuthorAssetManifest).
 */
export async function buildProjectAssetManifest(project) {
  return hashAssetReferences(referenceProjectAssetManifest(project));
}

export function referenceProjectAssetManifest(project) {
  const entries = [];
  const imageFilename = startingImageFilename(project?.startingImageFile);
  if (imageFilename) {
    const imageEntry = imageAssetReference(imageFilename);
    if (imageEntry) entries.push(imageEntry);
  }
  const musicBedFilename = project?.musicBed?.filename;
  if (isStr(musicBedFilename)) {
    const musicEntry = assetReference(musicBedFilename, 'music');
    if (musicEntry) entries.push(musicEntry);
  }
  const planSteps = Array.isArray(project?.plan?.steps) ? project.plan.steps : [];
  const renderEntries = planSteps.map((step) => {
    const jobId = step?.status === 'done' && isStr(step?.result?.jobId) && step.result.jobId.trim()
      ? step.result.jobId.trim()
      : null;
    if (!jobId) return null;
    if (step.toolName === 'media_enqueueImageJob') {
      return imageAssetReference(`${jobId}.png`);
    }
    if (step.toolName === 'media_enqueueVideoJob') {
      return assetReference(`${jobId}.mp4`, 'video');
    }
    return null;
  });
  const seen = new Set(entries.map((entry) => `${entry.kind}:${entry.filename}`));
  for (const entry of renderEntries) {
    const key = entry && `${entry.kind}:${entry.filename}`;
    if (entry && !seen.has(key)) {
      seen.add(key);
      entries.push(entry);
    }
  }
  return entries;
}

// Resolve a scene's `videoHistoryId` to its on-disk basename.
async function videoHistoryFilenamesById() {
  const map = new Map();
  for (const row of await readVideoHistoryRows()) {
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
 *     The project's MuScriptor MIDI transcription (`midiTranscription.filename`)
 *     also lives under PATHS.music and ships through the same `music` entries.
 *   - per-scene rendered clips (`scene.videoHistoryId` → a video-history row →
 *     `<filename>` under PATHS.videos). The row METADATA union-merges via the
 *     `videoHistory` dataSync category; this adds the bytes. Falls back to the
 *     `<id>.mp4` convention (`collectionVideoRefToFilename`) when the row hasn't
 *     synced yet — a missing file is skipped, so a wrong guess never ships.
 *   - every scene take (`scene.takes[]`, #8965) of either kind, and the visual
 *     spec's reference images (`visualSpec.references[].imageId`), so a peer can
 *     review and select any candidate, not only the current selection.
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
  return hashAssetReferences(await referenceMusicVideoAssetManifest(project));
}

export async function referenceMusicVideoAssetManifest(project, { linkedTrack } = {}) {
  const dedup = new Map();
  // Master audio: the uploaded basename and/or the linked track's audioFilename
  // (the create-UI path stores trackId with uploadedAudioFilename: null, so a
  // music-video-only subscriber gets no audio unless we resolve+bundle it here).
  const audioNames = [];
  if (isStr(project?.uploadedAudioFilename)) audioNames.push(project.uploadedAudioFilename);
  if (isStr(project?.trackId)) {
    const track = linkedTrack?.id === project.trackId
      ? linkedTrack
      : await getTrack(project.trackId).catch(() => null);
    if (isStr(track?.audioFilename)) audioNames.push(track.audioFilename);
  }
  // MuScriptor MIDI transcription of the master audio — lands under PATHS.music
  // precisely so it rides this manifest; without it a subscribed peer receives
  // a `midiTranscription.filename` pointer whose bytes never arrive.
  if (isStr(project?.midiTranscription?.filename)) audioNames.push(project.midiTranscription.filename);
  // The optional vocal stem (#8977) conditions performance shots and lives
  // under PATHS.music beside the master, so it rides the same entries.
  if (isStr(project?.vocalStemFilename)) audioNames.push(project.vocalStemFilename);
  // Timeline audio layers (musicVideo/audioLayers.js) are uploads under PATHS.music too.
  for (const layer of Array.isArray(project?.audioLayers) ? project.audioLayers : []) {
    if (isStr(layer?.filename)) audioNames.push(layer.filename);
  }
  for (const revision of project?.audioTimingRevisions || []) {
    if (isStr(revision.before?.audioFilename)) audioNames.push(revision.before.audioFilename);
    if (isStr(revision.before?.vocalStemFilename)) audioNames.push(revision.before.vocalStemFilename);
    if (isStr(revision.before?.midiTranscription?.filename)) audioNames.push(revision.before.midiTranscription.filename);
  }
  for (const name of [...new Set(audioNames)]) {
    const audio = assetReference(name, 'music');
    if (audio) dedup.set(`${audio.kind}:${audio.filename}`, audio);
  }
  const scenes = Array.isArray(project?.scenes) ? project.scenes : [];
  // Every scene take (#8965) is a candidate the director can select on any
  // peer, so its bytes ride along with the selected slot's. Take kinds are
  // peer-supplied data — only the two known kinds contribute.
  const takeIds = (kind) => scenes.flatMap((s) => (Array.isArray(s?.takes) ? s.takes : [])
    .filter((t) => t?.kind === kind && isStr(t.assetId))
    .map((t) => t.assetId));
  const videoIds = [...new Set([
    ...scenes.map((s) => (isStr(s?.videoHistoryId) ? s.videoHistoryId : null)).filter(Boolean),
    ...takeIds('video'),
    ...(project?.audioTimingRevisions || []).map((revision) => revision.before?.renderHistoryId).filter(isStr),
  ])];
  if (videoIds.length) {
    const byId = await videoHistoryFilenamesById();
    const entries = videoIds.map((id) =>
      assetReference(byId.get(id) || collectionVideoRefToFilename(id), 'video'));

    for (const entry of entries) {
      if (entry) dedup.set(`${entry.kind}:${entry.filename}`, entry);
    }
  }
  // Reference frames, image takes, and the visual spec's moodboard/reference
  // images (#8965) all live in the gallery under the `image` asset kind.
  const specRefs = Array.isArray(project?.visualSpec?.references) ? project.visualSpec.references : [];
  const imageNames = [...new Set([
    ...scenes.map((s) => (isStr(s?.referenceImageId) ? s.referenceImageId : null)).filter(Boolean),
    ...takeIds('image'),
    // Style-break end frames (#11173) are gallery stills too.
    ...scenes.map((s) => (isStr(s?.endImageId) ? s.endImageId : null)).filter(Boolean),
    ...scenes.flatMap(s => s?.photoSequence?.imageIds || []).filter(isStr),
    ...takeIds('endImage'),
    ...scenes.flatMap((scene) => (scene.takes || []).flatMap((take) => [take.sourceImageId, ...(take.inputAssets || []).map((input) => input.assetId)]).filter(isStr)),
    ...specRefs.map((r) => (isStr(r?.imageId) ? r.imageId : null)).filter(Boolean),
    ...(Array.isArray(project?.styleReferences) ? project.styleReferences : []).map((r) => (isStr(r?.imageId) ? r.imageId : null)).filter(Boolean),
    // The cameo roster's photos, stills and variants (#14821).
    ...musicVideoCameoImageIds(project),
    // A shot's Research and seed photos (#14822).
    ...scenes.flatMap((s) => (Array.isArray(s?.researchReferences) ? s.researchReferences : []).map((r) => r?.imageId)).filter(isStr),
    // The printable flyer's picked gallery image.
    ...(isStr(project?.publishKit?.flyer?.imageFile) ? [project.publishKit.flyer.imageFile] : []),
    // The X story reply's picked gallery image (a Publish row answer).
    ...(isStr(project?.publishKit?.postOptions?.x?.storyImageFile) ? [project.publishKit.postOptions.x.storyImageFile] : []),
  ])];
  if (imageNames.length) {
    const entries = imageNames.map(imageAssetReference);
    for (const entry of entries) {
      if (entry) dedup.set(`${entry.kind}:${entry.filename}`, entry);
    }
  }
  return [...dedup.values()];
}

/**
 * Hash every rendered scene asset referenced by a FableLoom story. Scene stills
 * are gallery basenames; clips point at video-history ids and the FableLoom
 * player resolves them directly as managed `<id>.mp4` files.
 */
export async function buildFableLoomAssetManifest(loom) {
  return hashAssetReferences(referenceFableLoomAssetManifest(loom));
}

export function referenceFableLoomAssetManifest(loom) {
  const nodes = (Array.isArray(loom?.episodes) ? loom.episodes : [])
    .flatMap((episode) => (Array.isArray(episode?.nodes) ? episode.nodes : []));
  const dedup = new Map();
  const imageNames = [...new Set(
    nodes.flatMap((node) => [node?.image, ...(Array.isArray(node?.visualCanon?.characterAppearances) ? node.visualCanon.characterAppearances : []).map((appearance) => appearance.referenceImage)]).filter(isStr),
  )];
  for (const entry of imageNames.map(imageAssetReference)) {
    if (entry) dedup.set(`${entry.kind}:${entry.filename}`, entry);
  }
  // Typed playback assets (hold loops, transition exit clips, and an explicit
  // entry clip) live under node.playbackAssets alongside the legacy single
  // node.videoHistoryId — all reference on-disk <id>.mp4 files under
  // PATHS.videos and must all be advertised, or a receiving peer never
  // requests them and playback breaks post-sync (#6006).
  const videoIds = [...new Set(
    nodes.flatMap((node) => {
      const ids = [node?.videoHistoryId, node?.playbackAssets?.entryVideoHistoryId];
      if (Array.isArray(node?.playbackAssets?.holdLoopVideoHistoryIds)) {
        ids.push(...node.playbackAssets.holdLoopVideoHistoryIds);
      }
      if (node?.playbackAssets?.exitByTransition && typeof node.playbackAssets.exitByTransition === 'object') {
        ids.push(...Object.values(node.playbackAssets.exitByTransition));
      }
      return ids.filter(isStr);
    }),
  )];
  if (videoIds.length > 0) {
    const entries = videoIds.map((id) =>
      assetReference(collectionVideoRefToFilename(id), 'video'));
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
 * Like a collection manifest, this is path-traversal-guarded,
 * missing-local-file skipped silently (including a null-hash entry would make
 * every receiver re-request bytes the sender can't fulfill),
 * dedup-by-`<kind>:<filename>` so a media-key and imageUrl pointing at the same
 * file ship once. Text items carry no bytes.
 */
export async function buildBoardAssetManifest(board) {
  return hashAssetReferences(referenceBoardAssetManifest(board));
}

export function referenceBoardAssetManifest(board) {
  const dedup = new Map();
  // The canonical poster is a gallery still, same as a pinned image. A poster
  // that is also pinned dedups onto one manifest entry. A missing local file
  // is dropped later by the hash step, same as any other image ref.
  const poster = imageAssetReference(board?.posterImageRef);
  if (poster) dedup.set(`${poster.kind}:${poster.filename}`, poster);
  const collage = imageAssetReference(board?.collageImageRef);
  if (collage) dedup.set(`${collage.kind}:${collage.filename}`, collage);
  for (const it of Array.isArray(board?.items) ? board.items : []) {
    // `video` items (#4188) carry a `video:<filename>` mediaKey (the ref IS
    // the on-disk filename, so collectionVideoRefToFilename passes it through
    // untouched) plus an optional poster-thumbnail imageUrl. Thumbnails under
    // /data/video-thumbnails are NOT shipped — the receiver's video pull
    // regenerates `<stem>.jpg` locally (see doPullOneAsset's video branch).
    if (!it || (it.type !== 'image' && it.type !== 'video')) continue;
    const pending = [];
    if (typeof it.mediaKey === 'string') {
      const parsed = parseKey(it.mediaKey);
      if (parsed) {
        const safeName = sanitizeAssetFilename(parsed.ref);
        if (safeName) {
          pending.push(parsed.kind === 'video'
            ? assetReference(collectionVideoRefToFilename(safeName), 'video')
            : imageAssetReference(safeName));
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
          ? assetReference(safeName, 'image-ref')
          : imageAssetReference(safeName));
      }
    }
    for (const entry of pending) {
      if (entry) dedup.set(`${entry.kind}:${entry.filename}`, entry);
    }
  }
  return [...dedup.values()];
}

/**
 * Hash every gallery image a deck (#decks) references so a subscribed peer can
 * pull the bytes and actually SEE the deck: each card's render history
 * (`imageRefs`, which already includes `primaryImageRef`) plus the style
 * samples the vision step analyzed (`samples[].imageRef`). De-duped by
 * filename — the same render can be a card ref and a sample — and each
 * missing-local-file entry is skipped silently (mirrors buildBoardAssetManifest:
 * a null-hash entry would make every receiver re-request bytes the sender
 * cannot fulfil).
 *
 * Hashing is bounded rather than a bare `Promise.all`: a deck is by far the
 * widest asset fan-out in the system — 78 tarot cards x DECK_CARD_IMAGE_REFS_MAX
 * (24) render-history refs is ~1.9k gallery files, and each hash stats and may
 * stream-read the file. Firing those at once exhausts libuv's 4-thread fs pool
 * (and the fd table), which stalls every other fs call in the process including
 * the one serving the UI bundle. The other builders here need no cap because
 * their fan-out is bounded by construction (one headshot, one cover, two refs
 * per mood-board item).
 */
export async function buildDeckAssetManifest(deck) {
  return hashAssetReferences(referenceDeckAssetManifest(deck));
}

export function referenceDeckAssetManifest(deck) {
  const filenames = new Set();
  for (const card of Array.isArray(deck?.cards) ? deck.cards : []) {
    for (const ref of Array.isArray(card?.imageRefs) ? card.imageRefs : []) {
      const safe = sanitizeAssetFilename(ref);
      if (safe) filenames.add(safe);
    }
    const primary = sanitizeAssetFilename(card?.primaryImageRef);
    if (primary) filenames.add(primary);
  }
  for (const sample of Array.isArray(deck?.samples) ? deck.samples : []) {
    const safe = sanitizeAssetFilename(sample?.imageRef);
    if (safe) filenames.add(safe);
  }
  const entries = [...filenames].map(imageAssetReference);
  return entries.filter(Boolean);
}

/**
 * Hash every gallery image a storyboard's panel takes reference so a peer pulls
 * the bytes and sees the board's art. A `sketch:` take has no gallery image
 * (`image` is null) — its sidecars in data/media-sketches stay machine-local.
 */
export async function buildStoryboardAssetManifest(board) {
  return hashAssetReferences(referenceStoryboardAssetManifest(board));
}

export function referenceStoryboardAssetManifest(board) {
  const filenames = new Set();
  for (const beat of Array.isArray(board?.beats) ? board.beats : []) {
    for (const panel of Array.isArray(beat?.panels) ? beat.panels : []) {
      for (const take of Array.isArray(panel?.takes) ? panel.takes : []) {
        const safe = sanitizeAssetFilename(take?.image);
        if (safe) filenames.add(safe);
      }
    }
  }
  return [...filenames].map(imageAssetReference).filter(Boolean);
}

export async function buildAssetManifestForSeries(series, issues, linkedCollection = null) {
  const history = await loadCollectionVideoFilenames(linkedCollection?.items);
  return hashAssetReferences(referenceAssetManifestForSeries(series, issues, linkedCollection, history));
}

export function referenceAssetManifestForSeries(series, issues, linkedCollection, videoFilenames) {
  const seriesAssets = referenceAssetManifest(series);
  const dedup = new Map(seriesAssets.map((a) => [`${a.kind}:${a.filename}`, a]));
  for (const issue of issues) {
    const issueAssets = referenceAssetManifest(issue);
    for (const a of issueAssets) {
      dedup.set(`${a.kind}:${a.filename}`, a);
    }
  }
  if (linkedCollection) {
    const collectionAssets = referenceCollectionAssetManifest(linkedCollection, videoFilenames);
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
  const history = await loadCollectionVideoFilenames(linkedCollection?.items);
  return hashAssetReferences(referenceAssetManifestWithCollection(record, linkedCollection, history));
}

export function referenceAssetManifestWithCollection(record, linkedCollection, videoFilenames) {
  const recordAssets = referenceAssetManifest(record);
  const dedup = new Map(recordAssets.map((a) => [`${a.kind}:${a.filename}`, a]));
  if (linkedCollection) {
    const collectionAssets = referenceCollectionAssetManifest(linkedCollection, videoFilenames);
    for (const a of collectionAssets) {
      dedup.set(`${a.kind}:${a.filename}`, a);
    }
  }
  return [...dedup.values()];
}
