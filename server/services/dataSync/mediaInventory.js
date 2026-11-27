/** Exchanges bounded peer inventories and reconciles media holders and origins. */

import { stat, readdir } from 'fs/promises';
import { join } from 'path';
import { PATHS } from '../../lib/fileUtils.js';
import { isPlainObject } from '../../lib/objects.js';
import { mapWithConcurrency } from '../../lib/mapWithConcurrency.js';
import { buildPortosMeta } from '../../lib/schemaVersions.js';
import { getPeers, resolveEffectiveCategories } from '../instances.js';
import { reconcileHostedMedia } from '../peerHostedMedia.js';
import { sanitizeAssetFilename } from '../sharing/buckets.js';
import { diffAssetManifestAgainstLocal, pullMissingAssetsFromPeer } from '../sharing/peerSyncAssets.js';
import { collectionVideoRefToFilename, loadCollectionVideoFilenames, resolveCollectionVideoFilename } from '../collectionVideoFiles.js';
import { getWireCollections, mediaCollectionsChecksumSources } from './categories/mediaCollections.js';
import { readSyncableVideoRows } from './categories/videoHistory.js';
import { readFingerprintMap, fingerprintsEqual } from './checksumFingerprints.js';

let collectionInventoryCache;

async function getCollectionInventoryReferences(kind, { alternateNamesOnly = false } = {}) {
  const fingerprints = await readFingerprintMap(mediaCollectionsChecksumSources);
  let cached = collectionInventoryCache;
  if (!cached || !fingerprintsEqual(cached.fingerprints, fingerprints)) {
    // A failed parent read cannot safely classify these collections for a peer.
    const collections = await getWireCollections(undefined, { strictParents: true });
    const items = collections.filter((collection) => !collection.deleted).flatMap((collection) => collection.items);
    cached = {
      fingerprints,
      images: items.filter((item) => item.kind === 'image').map((item) => item.ref),
      videoItems: items.filter((item) => item.kind === 'video'),
    };
    collectionInventoryCache = cached;
  }
  if (kind === 'image') return cached.images;

  // The filename index has stable identity until its video history changes.
  const history = await loadCollectionVideoFilenames(cached.videoItems);
  if (!history) return [];
  if (cached.videos?.history !== history) {
    const filenames = [];
    const alternateNames = [];
    for (const { ref } of cached.videoItems) {
      const filename = resolveCollectionVideoFilename(ref, history);
      if (!filename) continue;
      filenames.push(filename);
      if (filename !== collectionVideoRefToFilename(ref)) alternateNames.push(filename);
    }
    cached.videos = { history, filenames, alternateNames };
  }
  return alternateNamesOnly ? cached.videos.alternateNames : cached.videos.filenames;
}

async function inventoryFileMtimes(dir, filenames) {
  const entries = await mapWithConcurrency(filenames, 16, async (name) => {
    const info = await stat(join(dir, name)).catch(() => null);
    return info ? [name, info.mtimeMs] : null;
  });
  return Object.fromEntries(entries.filter(Boolean));
}

// This separate inventory describes only bytes on this machine, never the
// unioned history or files streamed from another peer. It is refreshed even
// when history is unchanged and is absent on older peers.
export async function getHostedMediaInventory(category = 'videoHistory', kind = 'video') {
  const references = category === 'mediaCollections'
    ? await getCollectionInventoryReferences(kind)
    : (await readSyncableVideoRows()).map((row) => row.filename);
  const dir = kind === 'image' ? PATHS.images : PATHS.videos;
  const names = await readdir(dir, { withFileTypes: true }).catch((err) => {
    if (err.code === 'ENOENT') return [];
    throw err;
  });
  const local = new Set(names.filter((entry) => entry.isFile()).map((entry) => entry.name));
  const checked = [...new Set(references.filter((name) =>
    typeof name === 'string' && sanitizeAssetFilename(name) === name))];
  const filenames = checked.filter((name) => local.has(name));
  // File times let paired peers settle who made an unattributed copy
  // (mediaOriginReconcile.js); an older peer ignores the extra field.
  const mtimes = await inventoryFileMtimes(dir, filenames);
  return { version: 1, filenames, checked, mtimes, portosMeta: await buildPortosMeta() };
}

// The regular inventory is refreshed even when record checksums are unchanged.
// It also exists on peers whose collection manifests only contain legacy names.
// A stored collection ref and a separately synced history row must both match
// before an inventory can fill a missing alternate-named copy.
async function recoverCollectionVideoCopies(peer, filenames, checked) {
  if (!resolveEffectiveCategories(peer).mediaCollections || filenames.length === 0) return;
  const examined = new Set(checked);
  const names = new Set(await getCollectionInventoryReferences('video', { alternateNamesOnly: true }));
  const references = [...new Set(filenames)].filter((name) => examined.has(name) && names.has(name))
    .map((filename) => ({ kind: 'video', filename }));
  const missing = await diffAssetManifestAgainstLocal(references, { includeMismatched: false });
  if (missing.length > 0) {
    pullMissingAssetsFromPeer(peer.instanceId, missing, { includeMismatched: false }).catch((error) => {
      console.error(`❌ Collection video copy failed: ${error.message}`);
    });
  }
}

async function scopeMediaInventory(category, kind, filenames, checked) {
  if ([...filenames, ...checked].some((name) => sanitizeAssetFilename(name) === null)) return null;
  const examined = new Set(checked);
  if (filenames.some((name) => !examined.has(name))) return null;
  if (category !== 'mediaCollections' || kind !== 'video') return { filenames, checked };
  const referenced = new Set(await getCollectionInventoryReferences(kind));
  return {
    filenames: filenames.filter((name) => referenced.has(name)),
    checked: checked.filter((name) => referenced.has(name)),
  };
}

// Unlike the collection inventory, this lists every gallery image on disk, so a name
// absent from it is genuinely not held (`complete`). Older peers 404 it.
export async function getImageLibraryInventory() {
  const entries = await readdir(PATHS.images, { withFileTypes: true }).catch((err) => {
    if (err.code === 'ENOENT') return [];
    throw err;
  });
  const filenames = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.png') && sanitizeAssetFilename(e.name) === e.name).map((e) => e.name).sort();
  const mtimes = await inventoryFileMtimes(PATHS.images, filenames);
  return { version: 1, filenames, checked: filenames, complete: true, mtimes, portosMeta: await buildPortosMeta() };
}

export async function applyMediaInventory(category, remoteData, source, options) {
  const peer = (await getPeers()).find((p) => p.instanceId === source.peerId && p.enabled !== false);
  if (peer && remoteData?.version === 1 && Array.isArray(remoteData.filenames) && Array.isArray(remoteData.checked)) {
    const kind = options.inventoryKind === 'image' ? 'image' : 'video';
    const inventory = await scopeMediaInventory(category, kind, remoteData.filenames, remoteData.checked);
    if (!inventory) return { applied: false, count: 0 };
    const { filenames, checked } = inventory;
    // Every report of held bytes feeds the holders list (services/mediaHolders.js).
    if (kind === 'video' || category === 'mediaCollections') {
      const { recordPeerInventory } = await import('../mediaHolders.js');
      await recordPeerInventory(peer.instanceId, kind, filenames, checked);
    }
    if (options.inventoryScope === 'library') {
      // File times only: a whole-library listing must not drive host-mode reconciliation.
      if (kind === 'image' && category === 'mediaCollections' && isPlainObject(remoteData.mtimes)) {
        const { recordPeerHoldings, hasMediaOriginCandidates, reconcileMediaOrigins } = await import('../mediaOriginReconcile.js');
        const changed = await recordPeerHoldings(peer.instanceId, kind, 'imageLibrary', { mtimes: remoteData.mtimes, checked, complete: remoteData.complete === true });
        if (changed || await hasMediaOriginCandidates(kind)) await reconcileMediaOrigins(kind);
      }
    } else if (kind === 'video' || category === 'mediaCollections') {
      if (peer.mediaSyncMode === 'host') await reconcileHostedMedia(peer.instanceId, kind, filenames, checked);
      else if (category === 'videoHistory') {
        await recoverCollectionVideoCopies(peer, filenames, checked);
      }
      if (isPlainObject(remoteData.mtimes)) {
        const { recordPeerHoldings, hasMediaOriginCandidates, reconcileMediaOrigins } = await import('../mediaOriginReconcile.js');
        const mtimes = Object.fromEntries(filenames.filter((name) => Object.hasOwn(remoteData.mtimes, name))
          .map((name) => [name, remoteData.mtimes[name]]));
        const changed = await recordPeerHoldings(peer.instanceId, kind, category, { mtimes, checked });
        if (changed || await hasMediaOriginCandidates(kind)) await reconcileMediaOrigins(kind);
      }
    }
  }
  return { applied: false, count: 0 };
}
