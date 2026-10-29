/**
 * Backfill `originInstanceId` on video history rows and gallery image sidecars
 * made before media ownership was recorded (#14089), so deletes of this
 * machine's own media reach its peers.
 *
 * Origin is stamped only from evidence; anything else stays origin-less, which
 * the delete and tombstone rules already treat as "owner unknown":
 *
 * - Peer evidence. The machine-local supplier (`suppliedByInstanceId`) and the
 *   `data/peer-hosted-media.json` hosts of the file name the peers it came
 *   from. Exactly one distinct peer is that origin; several are ambiguous.
 * - Local evidence. Peers' supplier ids were first recorded in the same
 *   release as origins, so an older copy pulled from a peer is
 *   indistinguishable from one made here by its fields alone. A held file with
 *   no peer evidence is this machine's own only when its bytes were written
 *   before the earliest registered peer was added (any file, with no peers):
 *   pulls and bucket imports write fresh bytes, so no peer could have supplied
 *   them. A peer record without a valid `addedAt` disables this rule.
 *
 * An existing origin is never changed, so a re-run is a no-op. Writes go
 * straight to the files: migrations run at boot before any service that
 * queues writes to them, and the frozen transform must not import services.
 */
import { basename, join } from 'node:path';
import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { readJsonOrNull, writeJsonAtomic } from './_lib.js';

export const OWNED_OUTPUT_PATHS = ['video-history.json', 'images'];

const isId = (value) => typeof value === 'string' && value.trim().length > 0;
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

async function readOwnership(dataDir) {
  const instances = await readJsonOrNull(join(dataDir, 'instances.json'));
  const localId = isId(instances?.self?.instanceId) ? instances.self.instanceId : null;
  const peers = Array.isArray(instances?.peers) ? instances.peers.filter(isPlainObject) : [];
  const addedMs = peers.map((peer) => Date.parse(peer.addedAt));
  // Infinity: no peer exists, so every held file predates pairing.
  const pairedSinceMs = addedMs.some((ms) => !Number.isFinite(ms)) ? -Infinity : Math.min(Infinity, ...addedMs);
  const hosted = await readJsonOrNull(join(dataDir, 'peer-hosted-media.json'));
  const hostedEntries = isPlainObject(hosted?.entries) ? hosted.entries : {};
  return { localId, pairedSinceMs, hostedEntries };
}

const hostedPeerIds = (entry) => {
  if (Array.isArray(entry?.hosts)) return entry.hosts.map((host) => host?.peerId);
  return [entry?.peerId];
};

/** The origin evidence supports for one held record, or null. */
async function deriveOrigin({ kind, filename, suppliedBy, dir }, { localId, pairedSinceMs, hostedEntries }) {
  const peerIds = new Set([suppliedBy, ...hostedPeerIds(hostedEntries[`${kind}:${filename}`])]
    .filter((id) => isId(id) && id !== localId));
  if (peerIds.size > 0) return peerIds.size === 1 ? [...peerIds][0] : null;
  if (!localId) return null;
  const fileStat = await stat(join(dir, filename)).catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (!fileStat?.isFile()) return null;
  return fileStat.mtimeMs < pairedSinceMs ? localId : null;
}

async function backfillVideos(dataDir, ownership) {
  const path = join(dataDir, 'video-history.json');
  // Absent or unreadable history is left alone; an unreadable one is never rewritten.
  const history = await readJsonOrNull(path);
  if (!Array.isArray(history)) return 0;
  const dir = join(dataDir, 'videos');
  let stamped = 0;
  for (const row of history) {
    // A synced row's filename is a peer's text: only a bare name addresses data/videos.
    if (!isPlainObject(row) || isId(row.originInstanceId) || !isId(row.filename) || basename(row.filename) !== row.filename) continue;
    const origin = await deriveOrigin({ kind: 'video', filename: row.filename, suppliedBy: row.suppliedByInstanceId, dir }, ownership);
    if (!origin) continue;
    row.originInstanceId = origin;
    stamped++;
  }
  if (stamped > 0) await writeJsonAtomic(path, history);
  return stamped;
}

// The two sidecar spellings readImageSidecar resolves, in its order.
const sidecarPaths = (dir, filename) => [
  join(dir, filename.replace(/\.png$/i, '.metadata.json')),
  join(dir, `${filename}.metadata.json`),
];

async function backfillImages(dataDir, ownership) {
  const dir = join(dataDir, 'images');
  const entries = await readdir(dir, { withFileTypes: true }).catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (!entries) return 0;
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  // Stems of non-gallery images, whose `<stem>.metadata.json` is not a .png's sidecar.
  const otherStems = new Set(files.filter((name) => /\.(jpe?g|webp|gif|avif)$/i.test(name)).map((name) => name.replace(/\.[^.]+$/, '')));
  const names = new Set();
  for (const name of files) {
    if (/\.png$/i.test(name)) names.add(name);
    // A sidecar whose bytes are still on a peer is a gallery record too.
    else if (/\.png\.metadata\.json$/i.test(name)) names.add(name.slice(0, -'.metadata.json'.length));
    else if (/\.metadata\.json$/i.test(name)) {
      const stem = name.slice(0, -'.metadata.json'.length);
      if (!/\.(jpe?g|webp|gif|avif)$/i.test(stem) && !otherStems.has(stem)) names.add(`${stem}.png`);
    }
  }
  let stamped = 0;
  for (const filename of [...names].sort()) {
    const existing = sidecarPaths(dir, filename).find((path) => existsSync(path));
    const sidecar = existing ? await readJsonOrNull(existing) : {};
    // An unparseable sidecar is never overwritten.
    if (!isPlainObject(sidecar) || isId(sidecar.originInstanceId)) continue;
    const origin = await deriveOrigin({ kind: 'image', filename, suppliedBy: sidecar.suppliedByInstanceId, dir }, ownership);
    if (!origin) continue;
    // No createdAt is invented: a local origin makes the file's modify time the live stamp.
    await writeJsonAtomic(existing || sidecarPaths(dir, filename)[0], { ...sidecar, originInstanceId: origin });
    stamped++;
  }
  return stamped;
}

export default {
  async up({ rootDir }) {
    const dataDir = join(rootDir, 'data');
    if (!existsSync(join(dataDir, 'video-history.json')) && !existsSync(join(dataDir, 'images'))) {
      return { videos: 0, images: 0, reason: 'no-media' };
    }
    const ownership = await readOwnership(dataDir);
    const videos = await backfillVideos(dataDir, ownership);
    const images = await backfillImages(dataDir, ownership);
    if (videos + images > 0) console.log(`🏷️ Media origin backfill: ${videos} video row(s), ${images} image(s)`);
    return { videos, images };
  },
};
