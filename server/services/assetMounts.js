/**
 * The server's static asset mounts, as data, plus the terminator that stops a
 * server-owned path from being answered with the SPA index.
 *
 * One table iterated by the mounter and read as data by the guard. The route
 * strings live in `assetRoutePrefixes.js` beside the namespaces the terminator
 * closes, so a new server prefix is one edit.
 *
 * `dir` is a thunk: `wrWorksDir()` derives its path at call time, and a test that
 * re-roots `PATHS.data` needs every entry to resolve after the mock, not at import.
 */
import express from 'express';
import { join } from 'path';
import { z } from 'zod';
import { readFile } from 'fs/promises';
import { PATHS } from '../lib/fileUtils.js';
import { isTopLevelEntryName } from '../lib/pathSafety.js';
import { stripImageSidecarLocalBytes } from '../lib/assetHash.js';
import { ServerError, sendErrorResponse } from '../lib/errorHandler.js';
import { ASSET_ROUTE_PREFIXES, SERVER_OWNED_PREFIXES } from '../lib/assetRoutePrefixes.js';
import { wrWorksDir, WORK_ID_RE } from './writersRoom/_shared.js';
import { escapeRegExp } from '../lib/textUtils.js';
import { ensureImageThumbnail } from '../lib/imageThumbnail.js';
import { hostedAssetFallback } from './peerHostedMedia.js';

// `acceptRanges` is set explicitly: the peer-sync receiver (services/sharing/peerSync.js)
// relies on HTTP Range to resume partial asset downloads.
const ASSET_STATIC_OPTS = {
  acceptRanges: true,
  setHeaders: (res, filePath) => {
    if (res.locals.assetDownload) res.attachment(filePath);
    // A peer can supply asset bytes. Keep even a directly opened HTML/SVG file
    // from executing with the PortOS origin's host-control privileges.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self' data: blob:; media-src 'self'; style-src 'unsafe-inline'");
  },
};
const IMAGE_THUMBNAIL_STATIC_OPTS = { ...ASSET_STATIC_OPTS, maxAge: 24 * 60 * 60 * 1000 };

const assetDownloadQuerySchema = z.object({ download: z.literal('1').optional() }).passthrough();
const markDownloadRequest = (req, res, next) => {
  const query = assetDownloadQuerySchema.safeParse(req.query);
  // Set attachment headers only when a local file or hosted stream succeeds,
  // so a missing/invalid asset still returns the ordinary error response.
  res.locals.assetDownload = query.success && query.data.download === '1';
  next();
};

// Vite names everything under `dist/assets/` by content hash, so those bytes
// never change under a URL (the `no-cache` index.html points at new names after a
// rebuild): `immutable` plus a one-year ceiling avoids a conditional GET per chunk
// per load. The rest of `dist/` is `client/public/` copied under STABLE names
// (`sw.js`, `manifest.json`, `fonts/`...), whose bytes can change, so those keep
// the default and revalidate by ETag.
const IMMUTABLE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
const CLIENT_ASSET_STATIC_OPTS = { immutable: true, maxAge: IMMUTABLE_MAX_AGE_MS, index: false };

// Federation may pull draft prose and the three authored bible siblings only.
// Metadata/import backups and regenerable analysis snapshots stay inaccessible.
const writersRoomAssetsOnly = (req, res, next) => {
  const draft = /^\/[^/]+\/drafts\/[^/]+\.md$/.test(req.path);
  const bibleMatch = /^\/([^/]+)\/(characters|places|objects)\.json$/.exec(req.path);
  const bible = bibleMatch && WORK_ID_RE.test(bibleMatch[1]);
  if (!draft && !bible) return res.status(404).end();
  next();
};

// Keyed by route so the mount ORDER stays owned by `ASSET_ROUTE_PREFIXES`. A key
// missing there would never be mounted, so `assetMounts.test.js` pins the two together.
const ASSET_DIRS = {
  '/data/images': () => PATHS.images,
  '/data/image-thumbnails': () => PATHS.imageThumbnails,
  '/data/image-refs': () => PATHS.imageRefs,
  '/data/lora-datasets': () => PATHS.loraDatasets,
  '/data/videos': () => PATHS.videos,
  '/data/video-thumbnails': () => PATHS.videoThumbnails,
  '/data/sprites': () => PATHS.sprites,
  '/data/image-to-3d': () => PATHS.imageTo3d,
  '/data/audio': () => PATHS.audio,
  '/data/models': () => PATHS.models,
  // Character editor exposes benchmark WAVs only; profile metadata stays behind
  // its authenticated API.
  '/data/voice-profiles': () => PATHS.voiceProfiles,
  '/data/music': () => PATHS.music,
  '/data/brain-imports': () => PATHS.brainImportAssets,
  // Federation pulls draft prose bodies peer→peer by nested path from this mount.
  '/data/writers-room/works': wrWorksDir,
};

const imageThumbnailGate = async (req, res, next) => {
  // Only flat WebP names are valid. The helper also checks the PNG source
  // before an existing derivative can be served.
  if (!/^\/[A-Za-z0-9][A-Za-z0-9._-]*\.webp$/i.test(req.path)) return res.status(404).end();
  const filename = req.path.slice(1);
  const ready = await ensureImageThumbnail(filename);
  // No local source PNG: a peer hosting the collection image serves its own thumbnail.
  if (!ready) return hostedAssetFallback('/data/image-thumbnails')(req, res, () => res.status(404).end());
  res.setHeader('Cache-Control', 'public, max-age=86400');
  next();
};

// A gallery sidecar carries this machine's own fields (hide state, a pending
// delete, the supplying peer), which never go to a peer or anyone else reading
// it from the mount. A sidecar without them is served as-is by the static mount.
// Every name a gallery image may have (spaces, `+`, non-ASCII...) is gated: the
// decoded path must name one entry, the same check gallery names pass (#14064).
// Anything else falls through to the static mount, which refuses traversal.
function sidecarNameOf(path) {
  let name;
  try {
    name = decodeURIComponent(path.slice(1));
  } catch {
    return null;
  }
  return isTopLevelEntryName(name) && name.toLowerCase().endsWith('.metadata.json') ? name : null;
}

const imageSidecarGate = async (req, res, next) => {
  const name = (req.method === 'GET' || req.method === 'HEAD') ? sidecarNameOf(req.path) : null;
  if (!name) return next();
  const raw = await readFile(join(PATHS.images, name)).catch(() => null);
  const shared = raw === null ? raw : stripImageSidecarLocalBytes(raw);
  if (shared === raw) return next();
  ASSET_STATIC_OPTS.setHeaders(res, name);
  res.type('application/json').send(shared);
};

// Mounts whose files a peer may host instead of copying (peerHostedMedia.js).
const HOSTED_FALLBACK_ROUTES = new Set(['/data/images', '/data/videos', '/data/video-thumbnails', '/data/image-refs', '/data/audio', '/data/models']);

const ASSET_GATES = {
  '/data/images': imageSidecarGate,
  '/data/image-thumbnails': imageThumbnailGate,
  '/data/writers-room/works': writersRoomAssetsOnly,
};

/** The routes `ASSET_DIRS` knows a directory for — exported so a key that never
 *  reaches `ASSET_ROUTE_PREFIXES` (and is therefore never mounted) fails a test
 *  instead of silently not being served. */
export const ASSET_DIR_ROUTES = Object.keys(ASSET_DIRS);

/** Every asset mount as `{ route, dir, gate? }`, in mount order. */
export const ASSET_MOUNTS = ASSET_ROUTE_PREFIXES.map((route) => ({
  route,
  dir: ASSET_DIRS[route],
  gate: ASSET_GATES[route],
}));

/**
 * A `spaPaths` entry as a predicate over a REQUEST path. An entry is a route
 * PATTERN (`/data/:category`), so literal comparison would 404 concrete paths.
 */
function toRouteMatcher(pattern) {
  const source = pattern
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) return '[^/]+';
      if (segment === '*') return '.*';
      return escapeRegExp(segment);
    })
    .join('/');
  const regex = new RegExp(`^${source}$`);
  return (path) => regex.test(path);
}

/**
 * Mount every asset route, then close each server-owned namespace with a 404.
 *
 * The SPA fallback skips a request only when its path carries a file extension,
 * so an EXTENSIONLESS server path (`/data/image-to-3d/<id>/model`, a mistyped
 * `/api/…`) would otherwise get index.html with a 200 (#4688). The 404 uses
 * `sendErrorResponse` for the standard envelope.
 *
 * `ownedPrefixes` is overridable so a test can exercise other `spaPaths` shapes.
 */
export function mountAssetRoutes(app, ownedPrefixes = SERVER_OWNED_PREFIXES) {
  ASSET_MOUNTS.forEach(({ route, dir, gate }) => {
    const options = route === '/data/image-thumbnails' ? IMAGE_THUMBNAIL_STATIC_OPTS : ASSET_STATIC_OPTS;
    app.use(route, ...(gate ? [gate] : []), markDownloadRequest, express.static(dir(), options));
    // Media a `host`-mode peer keeps: local file absent → stream from the peer.
    if (HOSTED_FALLBACK_ROUTES.has(route)) app.use(route, hostedAssetFallback(route));
  });
  ownedPrefixes.forEach(({ prefix, spaPaths }) => {
    const spaMatchers = spaPaths.map(toRouteMatcher);
    app.use(prefix, (req, res, next) => {
      // Trailing slash stripped: `express.static` 301s a directory request to
      // `/data/images/`, which lands back here.
      const path = (prefix + (req.path === '/' ? '' : req.path)).replace(/\/+$/, '') || prefix;
      if (spaMatchers.some((matches) => matches(path))) return next();
      return sendErrorResponse(res, new ServerError('Not found', { status: 404 }));
    });
  });
}

/**
 * Serve the built client (`client/dist`) in two tiers — see
 * `CLIENT_ASSET_STATIC_OPTS`: the content-hashed `/assets/**` as immutable, and
 * everything else in `dist/` with serve-static's revalidate-per-load default.
 *
 * `index: false` keeps `/` reaching the SPA fallback in `server/index.js`, which
 * serves the build-id-stamped index.html with `no-cache`. A chunk the current
 * build no longer ships falls through to that fallback's extension guard, which
 * 404s; the client's stale-chunk reload relies on that 404.
 */
export function mountClientDist(app, distDir) {
  app.use('/assets', express.static(join(distDir, 'assets'), CLIENT_ASSET_STATIC_OPTS));
  app.use(express.static(distDir, { index: false }));
}
