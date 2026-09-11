/**
 * The server's static asset mounts, as data, plus the terminator that stops a
 * server-owned path from being answered with the SPA index.
 *
 * `server/index.js` used to spell each `app.use('/data/…', express.static(…))`
 * out inline, so nothing could enumerate what was served without regexing the
 * source. This is the `server/lib/navManifest.js` pattern the root AGENTS.md
 * recommends for exactly that drift problem: one table, iterated by the thing
 * that mounts and read as data by the guard. The route strings themselves live
 * one level down in `assetRoutePrefixes.js`, alongside the namespaces the
 * terminator closes, so a new server prefix is one edit rather than two.
 *
 * `dir` is a thunk, not a string: `wrWorksDir()` derives its path at call time,
 * and a test that re-roots `PATHS.data` at a temp tree needs every entry to
 * resolve after the mock, not at import.
 */
import express from 'express';
import { join } from 'path';
import { PATHS } from '../lib/fileUtils.js';
import { ServerError, sendErrorResponse } from '../lib/errorHandler.js';
import { ASSET_ROUTE_PREFIXES, SERVER_OWNED_PREFIXES } from '../lib/assetRoutePrefixes.js';
import { wrWorksDir, WORK_ID_RE } from './writersRoom/_shared.js';
import { escapeRegExp } from '../lib/textUtils.js';

// `acceptRanges: true` is the serve-static default already, but we set it
// explicitly because the federated peer-sync receiver
// (services/sharing/peerSync.js) background-pulls missing assets from these
// URLs and relies on HTTP Range to resume partial downloads over flaky
// Tailnet links — losing range support here would silently force every
// retry to restart from byte 0 on a multi-MB PNG / video.
const ASSET_STATIC_OPTS = { acceptRanges: true };

// Vite names every chunk, entry, stylesheet and imported asset it emits under
// `dist/assets/` by content hash (`index-B5J1S4I5.js`), so the bytes behind one
// of those URLs can never change — a rebuild produces new names, and the
// `no-cache` index.html (served by the SPA fallback in `server/index.js`) is
// what points the browser at them. Say so with `immutable` and the one-year
// ceiling, and the browser stops asking. Without it serve-static's default
// `max-age=0` made every hashed chunk stale the moment it landed: measured on
// the dashboard with no service worker (the default plain-HTTP tailnet posture,
// where none can register), a warm page load re-sent all 186 chunks as
// conditional GETs and got 186 `304`s back — pure round trips, at HTTP/1.1's
// six-per-host, before the app could start. The rest of `dist/` is
// `client/public/` copied verbatim under STABLE names (`sw.js`, `manifest.json`,
// `fonts/`, `sky/`, `hdri/`), whose bytes do change under the same URL, so
// those keep the default and revalidate by ETag per load.
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

// Keyed by route so the mount ORDER stays owned by `ASSET_ROUTE_PREFIXES` rather
// than being restated here. A key present here but missing there would never be
// mounted at all — silently — so `assetMounts.test.js` pins the two together.
const ASSET_DIRS = {
  '/data/images': () => PATHS.images,
  // Reference images (multi-ref upload inputs + generated character reference
  // sheets) — served read-only so the UI can render thumbnails by URL.
  '/data/image-refs': () => PATHS.imageRefs,
  // LoRA training dataset images (lora-datasets/<id>/images/*.png).
  '/data/lora-datasets': () => PATHS.loraDatasets,
  // Generated videos + thumbnails, so the Media UI and tailnet clients can pull
  // them by URL without going through an explicit download route.
  '/data/videos': () => PATHS.videos,
  '/data/video-thumbnails': () => PATHS.videoThumbnails,
  // Sprite Manager library previews (anchors, strips, atlases) render inline
  // via <img src="/data/sprites/<id>/<rel>"> (#2895).
  '/data/sprites': () => PATHS.sprites,
  // Image-to-3D GLB meshes (#2952) — the /3d R3F viewer loads them inline
  // via drei useGLTF from <model.assetPath> (/data/image-to-3d/<id>/model.glb).
  '/data/image-to-3d': () => PATHS.imageTo3d,
  // Voice-over WAVs rendered by the pipeline audio stage — the AudioStage UI
  // pulls them inline via <audio src="/data/audio/<filename>">.
  '/data/audio': () => PATHS.audio,
  // Machine-local voice-profile benchmarks and managed engine artifacts. The
  // character editor exposes benchmark WAVs only; profile metadata remains
  // behind its authenticated API.
  '/data/voice-profiles': () => PATHS.voiceProfiles,
  // Background-music tracks (uploaded today, generated locally tomorrow). The
  // AudioStage music picker plays them inline via <audio src="/data/music/...">.
  '/data/music': () => PATHS.music,
  // Extracted third-party import assets (ChatGPT export images/audio/PDFs). The
  // Brain Memory conversation viewer renders these inline (`![](/data/brain-
  // imports/...)`) and as asset links. Read-only; range support for large PDFs.
  '/data/brain-imports': () => PATHS.brainImportAssets,
  // Writers Room file-primary draft prose bodies (works/<workId>/drafts/<draftId>.md).
  // Federation (#1565) pulls them peer→peer from this mount: a receiver that merged
  // a work record GETs each missing body's bytes by its nested path. Read-only;
  // range support for large drafts. (Tailnet-only per the project's threat model.)
  '/data/writers-room/works': wrWorksDir,
};

const ASSET_GATES = { '/data/writers-room/works': writersRoomAssetsOnly };

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
 * A `spaPaths` entry as a predicate over a REQUEST path.
 *
 * Not a string compare: an entry is a route PATTERN, and the client router's own
 * convention produces parameterized ones (`/data/:category`). Comparing literals
 * would 404 every concrete `/data/images` while the declaration sat in the list
 * looking correct — and `scripts/dev-proxy-drift.test.js` points people at this
 * list when it fails, so it has to mean what it appears to mean.
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
 * The terminators are the point. The SPA fallback skips a request only when its
 * path carries a file extension (`/\.\w+$/`), so an EXTENSIONLESS server path —
 * `/data/image-to-3d/<id>/model`, or a mistyped `/api/…` — used to fall through
 * to the stamped index.html with a 200. A binary loader then parses HTML and
 * dies on a JSON syntax error naming a `<` token, nowhere near the real cause
 * (#4688); an API client gets HTML where it expects JSON, with a success
 * status. The envelope comes from `sendErrorResponse` so this 404 is the same
 * shape as every other one PortOS emits.
 *
 * `ownedPrefixes` defaults to the real list; a test overrides it to exercise a
 * `spaPaths` shape the app does not happen to use yet.
 */
export function mountAssetRoutes(app, ownedPrefixes = SERVER_OWNED_PREFIXES) {
  ASSET_MOUNTS.forEach(({ route, dir, gate }) => {
    app.use(route, ...(gate ? [gate] : []), express.static(dir(), ASSET_STATIC_OPTS));
  });
  ownedPrefixes.forEach(({ prefix, spaPaths }) => {
    const spaMatchers = spaPaths.map(toRouteMatcher);
    app.use(prefix, (req, res, next) => {
      // `app.use('/data', …)` reduces the page's own request to `req.path === '/'`.
      // The trailing slash is stripped because `express.static` 301s a directory
      // request to one (`/data/images` → `/data/images/`), and the redirect lands
      // back here — an entry that matched the first form would miss the second.
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
 * `index: false` on both keeps express.static from short-circuiting `/` (and
 * any bare directory) with the raw index.html — that request has to reach the
 * SPA fallback in `server/index.js`, which serves the build-id-stamped copy
 * with `Cache-Control: no-cache`. A chunk the current build no longer ships
 * (a browser reloading across a rebuild) misses both tiers and falls through
 * to that fallback's extension guard, which 404s it rather than answering with
 * HTML — the stale-chunk reload in the client relies on that 404.
 */
export function mountClientDist(app, distDir) {
  app.use('/assets', express.static(join(distDir, 'assets'), CLIENT_ASSET_STATIC_OPTS));
  app.use(express.static(distDir, { index: false }));
}
