/**
 * Backfill `originInstanceId` on video history rows and gallery image sidecars
 * made before media ownership was recorded (#14089), on an install that has
 * never federated media: each held file there was made (or imported) on this
 * machine, so it is this machine's own.
 *
 * Anything else stays origin-less ("owner unknown", which the delete and
 * tombstone rules already handle):
 *
 * - A federated install claims nothing. Supplier ids were first recorded in the
 *   same release as origins, so an older copy pulled from a peer has the same
 *   fields as local media, and no pairing history survives a peer's removal or
 *   re-adding to date its arrival. Its creator is resolved across machines
 *   instead (#14133).
 * - A supplier or host names a machine that held the media, not its creator, so
 *   it never becomes an origin; any such id marks the install as federated.
 *   Media tombstones carry no machine id, so an install whose every peer was
 *   removed before this release leaves no trace and its old pulls are claimed
 *   here; #14133 settles such a claim against an earlier holder.
 * - A record whose bytes are not on this machine is not claimed.
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

// The two sidecar spellings readImageSidecar resolves, in its order.
const sidecarPaths = (dir, filename) => [
  join(dir, filename.replace(/\.png$/i, '.metadata.json')),
  join(dir, `${filename}.metadata.json`),
];

const isHeldFile = (path) => stat(path).then((s) => s.isFile(), (err) => {
  if (err.code === 'ENOENT') return false;
  throw err;
});

/** Gallery `.png` names in data/images: each image file, plus each sidecar whose bytes are elsewhere. */
async function galleryNames(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch((err) => {
    if (err.code === 'ENOENT') return [];
    throw err;
  });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  // `<stem>.metadata.json` beside a non-gallery image is that image's sidecar.
  const otherStems = new Set(files.filter((name) => /\.(jpe?g|webp|gif|avif)$/i.test(name)).map((name) => name.replace(/\.[^.]+$/, '')));
  const names = new Set();
  for (const name of files) {
    if (/\.png$/i.test(name)) names.add(name);
    else if (/\.png\.metadata\.json$/i.test(name)) names.add(name.slice(0, -'.metadata.json'.length));
    else if (/\.metadata\.json$/i.test(name)) {
      const stem = name.slice(0, -'.metadata.json'.length);
      if (!/\.(jpe?g|webp|gif|avif)$/i.test(stem) && !otherStems.has(stem)) names.add(`${stem}.png`);
    }
  }
  return [...names].sort();
}

export default {
  async up({ rootDir }) {
    const dataDir = join(rootDir, 'data');
    const historyPath = join(dataDir, 'video-history.json');
    const imagesDir = join(dataDir, 'images');
    if (!existsSync(historyPath) && !existsSync(imagesDir)) return { videos: 0, images: 0, reason: 'no-media' };

    const instances = await readJsonOrNull(join(dataDir, 'instances.json'));
    const localId = isId(instances?.self?.instanceId) ? instances.self.instanceId : null;
    // Unreadable identity or registry: federation cannot be ruled out.
    if (!localId || (instances.peers !== undefined && !Array.isArray(instances.peers))) return { videos: 0, images: 0, reason: 'no-identity' };
    const hosted = await readJsonOrNull(join(dataDir, 'peer-hosted-media.json'));
    let federated = instances.peers?.length > 0 || (isPlainObject(hosted?.entries) && Object.keys(hosted.entries).length > 0);
    const foreign = (record) => [record.originInstanceId, record.suppliedByInstanceId].some((id) => isId(id) && id !== localId);

    // Absent or unreadable history is left alone; an unreadable one is never rewritten.
    const history = await readJsonOrNull(historyPath);
    const rows = Array.isArray(history) ? history : [];
    const videoClaims = [];
    for (const row of rows) {
      if (!isPlainObject(row)) continue;
      if (foreign(row)) federated = true;
      // A row's filename may have come from a peer: only a bare name addresses data/videos.
      else if (!isId(row.originInstanceId) && isId(row.filename) && basename(row.filename) === row.filename) videoClaims.push(row);
    }

    const imageClaims = [];
    for (const filename of await galleryNames(imagesDir)) {
      const existing = sidecarPaths(imagesDir, filename).find((path) => existsSync(path));
      const sidecar = existing ? await readJsonOrNull(existing) : {};
      // An unparseable sidecar is never overwritten.
      if (!isPlainObject(sidecar)) continue;
      if (foreign(sidecar)) federated = true;
      else if (!isId(sidecar.originInstanceId)) imageClaims.push({ filename, path: existing || sidecarPaths(imagesDir, filename)[0], sidecar });
    }
    if (federated) return { videos: 0, images: 0, reason: 'federated' };

    let videos = 0;
    for (const row of videoClaims) {
      if (!await isHeldFile(join(dataDir, 'videos', row.filename))) continue;
      row.originInstanceId = localId;
      videos++;
    }
    if (videos > 0) await writeJsonAtomic(historyPath, history);
    let images = 0;
    for (const { filename, path, sidecar } of imageClaims) {
      if (!await isHeldFile(join(imagesDir, filename))) continue;
      // No createdAt is invented: a local origin makes the file's modify time the live stamp.
      await writeJsonAtomic(path, { ...sidecar, originInstanceId: localId });
      images++;
    }
    if (videos + images > 0) console.log(`🏷️ Media origin backfill: ${videos} video row(s), ${images} image(s)`);
    return { videos, images };
  },
};
