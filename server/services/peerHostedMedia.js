/**
 * Peer-hosted media index — the "host" half of the Media Collections sync mode.
 *
 * A peer whose `mediaSyncMode` is `host` never has its collection image/video
 * bytes copied into this install's `data/`. Instead the receiver records, per
 * `<kind>:<filename>`, WHICH peer hosts the file, and the local static mounts
 * (`/data/images`, `/data/videos`, `/data/video-thumbnails`,
 * `/data/image-thumbnails`) fall back to streaming that file from the peer when
 * the local copy is absent (`streamHostedAsset`, wired in assetMounts.js). Every
 * existing `<img src="/data/images/x.png">` therefore renders unchanged.
 *
 * Machine-local (`file-primary`, docs/STORAGE.md): it describes where THIS
 * machine fetches bytes from, so it never federates. A local file always wins —
 * once bytes exist on disk (copied, generated, or "Copy locally") the entry is
 * ignored and pruned lazily.
 */
import { join, extname, basename } from 'path';
import { existsSync } from 'fs';
import { pipeline } from 'stream/promises';
import { randomUUID } from 'crypto';
import { PATHS, readJSONFile, atomicWrite } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { isPlainObject } from '../lib/objects.js';
import { isStr } from '../lib/textUtils.js';
import { peerBaseUrl } from '../lib/peerUrl.js';
import { peerStreamRequest } from '../lib/peerHttpClient.js';
import { withAbortTimeout } from '../lib/abortTimeout.js';
import { sanitizeAssetFilename } from './sharing/buckets.js';
import { getPeers } from './instances.js';

const HOSTED_FILE = () => join(PATHS.data, 'peer-hosted-media.json');
const SCHEMA_VERSION = 1;
const queueWrite = createFileWriteQueue();
const STREAM_TIMEOUT_MS = 30000;
// A thumbnail is only a preview: fail promptly so the card can try the
// original, while leaving large original-media streams their longer deadline.
const THUMBNAIL_TIMEOUT_MS = 3000;

// kind → { local dir thunk, peer static-mount prefix }. Only kinds a collection
// can hold. Thumbnails are derived views of these two, resolved below.
const KIND_DIRS = {
  image: () => PATHS.images,
  video: () => PATHS.videos,
};
const KIND_PREFIX = { image: '/data/images', video: '/data/videos' };
const VIDEO_EXTS = ['.mp4', '.webm', '.mov', '.m4v', '.ogv'];

export const hostedKey = (kind, filename) => `${kind}:${filename}`;
const hostsOf = (entry) => Array.isArray(entry?.hosts) ? entry.hosts : (entry?.peerId ? [{ peerId: entry.peerId, at: entry.at, revision: entry.revision }] : []);
const hostEntry = (hosts) => ({ peerId: hosts[0].peerId, at: hosts[0].at, revision: hosts[0].revision, hosts });


// STRICT: an unreadable index must never be written back as an empty one that
// wipes every entry (absent file → real empty). Rendering-side readers use
// `readEntriesOrEmpty` — an unreadable index just means "nothing is hosted".
async function readEntries() {
  const raw = await readJSONFile(HOSTED_FILE(), null, { strict: true });
  return isPlainObject(raw) && isPlainObject(raw.entries) ? raw.entries : {};
}
const readEntriesOrEmpty = () => readEntries().catch(() => ({}));

/** The `{ '<kind>:<filename>': { peerId } }` index, or `{}` when unreadable. */
export const listHostedEntries = () => readEntriesOrEmpty();

const writeEntries = (entries) => atomicWrite(HOSTED_FILE(), { version: SCHEMA_VERSION, entries });

/**
 * Record that `peerInstanceId` hosts these `{ kind, filename }` files. A file
 * already on local disk is never recorded (local copy wins). Returns the number
 * of entries added or re-pointed.
 */
export function markHosted(peerInstanceId, assets) {
  if (!isStr(peerInstanceId) || !Array.isArray(assets) || assets.length === 0) return Promise.resolve(0);
  return queueWrite(async () => {
    const entries = await readEntries();
    let changed = 0;
    const at = new Date().toISOString();
    for (const asset of assets) {
      const dir = KIND_DIRS[asset?.kind]?.();
      const filename = isStr(asset?.filename) ? sanitizeAssetFilename(asset.filename) : null;
      if (!dir || !filename) continue;
      if (existsSync(join(dir, filename))) continue;
      const key = hostedKey(asset.kind, filename);
      const hosts = hostsOf(entries[key]);
      const index = hosts.findIndex((host) => host.peerId === peerInstanceId);
      if (index >= 0) hosts[index] = { peerId: peerInstanceId, at, revision: randomUUID() };
      else hosts.push({ peerId: peerInstanceId, at, revision: randomUUID() });
      entries[key] = hostEntry(hosts);
      changed++;
    }
    if (changed > 0) await writeEntries(entries);
    return changed;
  });
}

/** Reconcile one peer's authoritative local-file inventory, without touching other hosts. */
export function reconcileHostedMedia(peerInstanceId, kind, filenames, checked) {
  if (!KIND_DIRS[kind] || !isStr(peerInstanceId) || !Array.isArray(filenames) || !Array.isArray(checked) ||
      [...filenames, ...checked].some((name) => !isStr(name) || sanitizeAssetFilename(name) !== name)) return Promise.resolve();
  return queueWrite(async () => {
    const entries = await readEntries();
    const present = new Set(filenames);
    const examined = new Set(checked);
    if (filenames.some((name) => !examined.has(name))) return;
    let changed = false;
    for (const [key, entry] of Object.entries(entries)) {
      if (key.startsWith(`${kind}:`) && examined.has(key.slice(kind.length + 1)) && !present.has(key.slice(kind.length + 1))) {
        const hosts = hostsOf(entry);
        const remaining = hosts.filter((host) => host.peerId !== peerInstanceId);
        if (remaining.length === hosts.length) continue;
        if (remaining.length) entries[key] = hostEntry(remaining);
        else delete entries[key];
        changed = true;
      }
    }
    for (const filename of present) {
      if (existsSync(join(KIND_DIRS[kind](), filename))) continue;
      const key = hostedKey(kind, filename);
      // A legacy single-host entry may be the old metadata-derived mistake.
      // Keep it as a fallback, but put newly verified evidence first.
      const legacy = !Array.isArray(entries[key]?.hosts) ? hostsOf(entries[key]) : [];
      const hosts = legacy.length ? [] : hostsOf(entries[key]);
      const index = hosts.findIndex((host) => host.peerId === peerInstanceId);
      const evidence = { peerId: peerInstanceId, at: new Date().toISOString(), revision: randomUUID() };
      if (index >= 0) hosts[index] = evidence;
      else hosts.push(evidence);
      for (const host of legacy) if (host.peerId !== peerInstanceId) hosts.push(host);
      entries[key] = hostEntry(hosts);
      changed = true;
    }
    if (changed) await writeEntries(entries);
  });
}

/**
 * Host-mode split of a push's missing-asset list. Collection-owned entries whose
 * bytes are ABSENT locally are recorded as hosted by `peerInstanceId` and
 * dropped from the pull list; everything else (non-collection assets, or a file
 * that exists locally but differs) still flows through the normal copy path.
 * `collectionKeys` is a Set of `<kind>:<filename>`. Returns the assets to pull.
 */
export async function takeHostedAssets(peerInstanceId, missingAssets, collectionKeys) {
  const hosted = [];
  const remaining = [];
  for (const entry of missingAssets) {
    const dir = KIND_DIRS[entry?.kind]?.();
    // A digest-less manifest is metadata, not evidence of local bytes.
    // Legacy manifests still use the normal copy path.
    const verified = /^[a-f0-9]{64}$/i.test(entry.sha256 || '');
    const owned = verified && dir && collectionKeys.has(hostedKey(entry.kind, entry.filename));
    if (owned && !existsSync(join(dir, entry.filename))) hosted.push(entry);
    else remaining.push(entry);
  }
  if (hosted.length > 0) await markHosted(peerInstanceId, hosted);
  return remaining;
}

function forgetHosted(kind, filename, peerId, revision) {
  return queueWrite(async () => {
    const entries = await readEntries();
    const key = hostedKey(kind, filename);
    const hosts = hostsOf(entries[key]);
    const remaining = hosts.filter((host) => host.peerId !== peerId || host.revision !== revision);
    if (remaining.length === hosts.length) return;
    if (remaining.length) entries[key] = hostEntry(remaining);
    else delete entries[key];
    await writeEntries(entries);
  }).catch(() => {});
}

/** Forget a hosted entry outright (its host deleted the file). */
export function dropHostedEntry(kind, filename) {
  return queueWrite(async () => {
    const entries = await readEntries();
    const key = hostedKey(kind, filename);
    if (!(key in entries)) return false;
    delete entries[key];
    await writeEntries(entries);
    return true;
  });
}

/** Drop a hosted entry once its bytes are local; a still-absent file keeps its entry. */
export function unmarkHosted(kind, filename) {
  return queueWrite(async () => {
    const dir = KIND_DIRS[kind]?.();
    if (!dir || !existsSync(join(dir, filename))) return false;
    const entries = await readEntries();
    const key = hostedKey(kind, filename);
    if (!(key in entries)) return false;
    delete entries[key];
    await writeEntries(entries);
    return true;
  });
}

/** Where does this media file live? `local` | `remote` (hosted by a peer) | `missing`. */
export async function resolveMediaLocations(items) {
  const entries = await readEntriesOrEmpty();
  const peers = await getPeers().catch(() => []);
  const peerName = new Map(peers.map((p) => [p.instanceId, p.name || null]));
  // A hosted image's pending delete lives in the delete queue, not a sidecar.
  const queued = await import('./mediaRemoteDelete.js').then((m) => m.listQueuedImageDeletes()).catch(() => new Map());
  return (Array.isArray(items) ? items : []).map((item) => {
    const kind = item?.kind === 'video' ? 'video' : 'image';
    const filename = kind === 'video' ? videoRefToFilename(item.ref) : item?.ref;
    const safe = isStr(filename) ? sanitizeAssetFilename(filename) : null;
    if (!safe) return { location: 'missing' };
    if (existsSync(join(KIND_DIRS[kind](), safe))) return { location: 'local' };
    const hosted = entries[hostedKey(kind, safe)];
    if (!hosted) return { location: 'missing' };
    const pendingDelete = kind === 'image' ? queued.get(safe) : null;
    return {
      location: 'remote', hostPeerId: hosted.peerId, hostPeerName: peerName.get(hosted.peerId) ?? null,
      ...(pendingDelete ? { pendingDelete } : {}),
    };
  });
}

// Collection video refs are bare ids; on disk they are `<id>.<ext>` (mp4 today).
// Mirrors collectionVideoRefToFilename in sharing/peerSyncAssets.js without
// importing it (that module would drag the whole peer-sync graph in here).
const videoRefToFilename = (ref) => (isStr(ref) ? (/\.[a-z0-9]+$/i.test(ref) ? ref : `${ref}.mp4`) : null);

/** The registered, ENABLED peer behind a hosted entry (a disabled peer stops every direction). */
export async function findHostPeer(instanceId) {
  const peers = await getPeers().catch(() => []);
  return peers.find((p) => p.instanceId === instanceId && p.enabled !== false) || null;
}

async function lookupHosted(kind, filename) {
  const entries = await readEntriesOrEmpty();
  return entries[hostedKey(kind, filename)] || null;
}

// Poster filenames can differ from the video stem (custom posters, stitched
// renders). Reuse the immutable compact history and rebuild this lookup only
// when its underlying history changes.
let thumbnailHistory;
let thumbnailVideos = new Map();
async function videoFilenamesForThumbnail(filename) {
  const { loadCompactHistory } = await import('./videoGen/history.js');
  const rows = await loadCompactHistory();
  if (rows !== thumbnailHistory) {
    const next = new Map();
    for (const row of rows) {
      const thumbnail = isStr(row?.thumbnail) ? sanitizeAssetFilename(row.thumbnail) : null;
      const video = isStr(row?.filename) ? sanitizeAssetFilename(row.filename) : null;
      if (!thumbnail || !video) continue;
      if (!next.has(thumbnail)) next.set(thumbnail, []);
      next.get(thumbnail).push(video);
    }
    thumbnailHistory = rows;
    thumbnailVideos = next;
  }
  return thumbnailVideos.get(filename) || [];
}

/**
 * Resolve a request for a local static path to `{ peerId, url }`
 * when a peer hosts it and the local file is absent; otherwise null.
 * `mount` is the static route the request arrived on.
 */
async function resolveHostedRequest(mount, filename) {
  const safe = sanitizeAssetFilename(filename);
  if (!safe) return null;
  if (mount === '/data/images') {
    const hosted = await lookupHosted('image', safe);
    return hosted && { peerId: hosted.peerId, hosts: hostsOf(hosted), url: `${KIND_PREFIX.image}/${encodeURIComponent(safe)}`, drop: { kind: 'image', filename: safe } };
  }
  if (mount === '/data/videos') {
    const hosted = await lookupHosted('video', safe);
    return hosted && { peerId: hosted.peerId, hosts: hostsOf(hosted), url: `${KIND_PREFIX.video}/${encodeURIComponent(safe)}`, drop: { kind: 'video', filename: safe } };
  }
  if (mount === '/data/image-thumbnails') {
    // `<stem>.webp` is derived from `<stem>.png`; the peer serves its own
    // thumbnail from the same path, so ask it for the thumbnail directly.
    const hosted = await lookupHosted('image', `${safe.replace(/\.webp$/i, '')}.png`);
    return hosted && { peerId: hosted.peerId, hosts: hostsOf(hosted), url: `/data/image-thumbnails/${encodeURIComponent(safe)}` };
  }
  if (mount === '/data/video-thumbnails') {
    const entries = await readEntriesOrEmpty();
    const videos = await videoFilenamesForThumbnail(safe).catch(() => []);
    for (const video of videos) {
      const hosted = entries[hostedKey('video', video)];
      if (hosted) return { peerId: hosted.peerId, hosts: hostsOf(hosted), url: `/data/video-thumbnails/${encodeURIComponent(safe)}` };
    }
    // If history names this poster, don't substitute an unrelated same-stem
    // video. The stem fallback is for older records with no poster mapping.
    if (videos.length > 0) return null;
    const stem = basename(safe, extname(safe));
    for (const ext of VIDEO_EXTS) {
      const hosted = entries[hostedKey('video', `${stem}${ext}`)];
      if (hosted) return { peerId: hosted.peerId, hosts: hostsOf(hosted), url: `/data/video-thumbnails/${encodeURIComponent(safe)}` };
    }
  }
  return null;
}

// After a failure the peer is skipped for a short cooldown, so a burst of cards
// (and browser retries) fails fast instead of each holding a socket for the full
// stream timeout against a peer that is down.
const PEER_COOLDOWN_MS = 30000;
const peerCooldownUntil = new Map();
export const __resetPeerCooldown = () => { peerCooldownUntil.clear(); failureLog.clear(); };
const peerCoolingDown = (peer) => (peerCooldownUntil.get(peer.instanceId) ?? 0) > Date.now();
// An unreachable or slow peer is an expected degraded state, not a defect, and a
// page of remote video cards fans out one failing request per card. Log it on
// stdout, once per peer+mount+reason per window, with the count it absorbed.
const FAILURE_LOG_WINDOW_MS = 60000;
const failureLog = new Map();
// A thumbnail's short deadline says little about the peer, so only an original's failure cools it.
function logStreamFailure(peer, mount, err, isThumbnail) {
  if (!isThumbnail) peerCooldownUntil.set(peer.instanceId, Date.now() + PEER_COOLDOWN_MS);
  const reason = err?.name === 'AbortError' || err?.message === 'peer media stream idle timeout' ? 'timeout' : 'transport error';
  const key = `${peer.instanceId}|${mount}|${reason}`;
  const now = Date.now();
  const entry = failureLog.get(key);
  if (entry && now - entry.at < FAILURE_LOG_WINDOW_MS) { entry.suppressed++; return; }
  const suppressed = entry?.suppressed ?? 0;
  failureLog.set(key, { at: now, suppressed: 0 });
  console.log(`🐢 peerHostedMedia: stream ${mount} from peer failed (${reason})${suppressed ? `; ${suppressed} similar suppressed` : ''}`);
}

/**
 * Express fallback mounted AFTER a static mount: when the local file is absent
 * and a peer hosts it, stream it from the peer (Range forwarded so video
 * scrubbing works). Anything else falls through to the mount's 404.
 */
export function hostedAssetFallback(mount) {
  return async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let filename;
    try { filename = decodeURIComponent(req.path.replace(/^\//, '')); } catch { return next(); }
    // Fast reject: only flat basenames are ever hosted.
    if (!filename || filename.includes('/')) return next();
    const target = await resolveHostedRequest(mount, filename).catch(() => null);
    if (!target) return next();
    const peers = await getPeers().catch(() => []);
    const candidates = target.hosts.map((host) => ({ host, peer: peers.find((p) => p.instanceId === host.peerId && p.enabled !== false) })).filter((candidate) => candidate.peer);
    if (!candidates.length) return next();
    const clientGone = new AbortController();
    res.on('close', () => { if (!res.writableFinished) clientGone.abort(); });
    const isThumbnail = mount === '/data/image-thumbnails' || mount === '/data/video-thumbnails';
    const timeoutMs = isThumbnail ? THUMBNAIL_TIMEOUT_MS : STREAM_TIMEOUT_MS;
    for (let i = 0; i < candidates.length; i++) {
      const { peer, host } = candidates[i];
      const last = i === candidates.length - 1;
      if (peerCoolingDown(peer)) {
        if (last) { res.status(502).end(); return; }
        continue;
      }
      try {
        const drop = target.drop && { ...target.drop, revision: host.revision };
        if (await streamFromPeer(peer, target.url, req, res, drop, timeoutMs, last, clientGone.signal)) return;
      } catch (err) {
        // The viewer navigated away: the abort is theirs, not the peer's fault.
        if (clientGone.signal.aborted) return;
        logStreamFailure(peer, mount, err, isThumbnail);
        if (res.headersSent) { res.destroy(); return; }
        if (last) { res.status(502).end(); return; }
      }
    }
  };
}

async function streamFromPeer(peer, path, req, res, drop, timeoutMs, last, clientSignal) {
  const headers = {};
  if (isStr(req.headers.range)) headers.Range = req.headers.range;
  const upstream = await withAbortTimeout(timeoutMs, (signal) =>
    peerStreamRequest(`${peerBaseUrl(peer)}${path}`, { signal: AbortSignal.any([signal, clientSignal]), headers }, peer));
  if (upstream.status !== 200 && upstream.status !== 206) {
    // The error body is unused; do not keep a socket open for a peer that
    // never finishes it (or sends an unbounded body).
    upstream.stream.destroy();
    // The peer no longer has it (deleted, or a snapshot referenced bytes it never
    // held): forget the entry so the collection stops advertising it as hosted.
    if (upstream.status === 404 && drop) await forgetHosted(drop.kind, drop.filename, peer.instanceId, drop.revision);
    if (!last) return false;
    res.status(upstream.status === 404 ? 404 : 502).end();
    return true;
  }
  res.status(upstream.status);
  if (res.locals.assetDownload) res.attachment(decodeURIComponent(basename(path)));
  for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
    const value = upstream.headers[name];
    if (value) res.setHeader(name, value);
  }
  // Same hardening as the local static mounts: peer bytes must never execute
  // with the PortOS origin's privileges.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self' data: blob:; media-src 'self'; style-src 'unsafe-inline'");
  res.setHeader('X-PortOS-Media-Location', 'remote');
  if (req.method === 'HEAD') {
    upstream.stream.destroy();
    res.end();
    return true;
  }
  // The header-wait timer is spent by now; bound a stalled body too.
  upstream.stream.setTimeout?.(timeoutMs, () => upstream.stream.destroy(new Error('peer media stream idle timeout')));
  await pipeline(upstream.stream, res);
  return true;
}
