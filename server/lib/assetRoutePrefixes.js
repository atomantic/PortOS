/**
 * Import-free leaf listing server-owned URL prefixes: `ASSET_ROUTE_PREFIXES` (static `/data/**`
 * mounts) and `SERVER_OWNED_PREFIXES` (never served by the SPA fallback).
 *
 * Zero imports so a Vite config, drift guard or build script can read it.
 * `server/test/guards/repo/dev-proxy-drift.test.js` checks both lists: the dev proxy's `^/data/` wildcard
 * against the mounts, route-registration order in `server/index.js`, and that no client
 * route lands under a server-owned prefix undeclared.
 *
 * Why both exist: an unproxied/unowned path does not 404, the SPA fallback answers it with
 * index.html and a 200, so a binary or JSON loader fails far from the cause. In dev, Vite
 * does this; in production the fallback only skips paths with a file extension, so
 * extensionless ones (`/data/image-to-3d/<id>/model`, a mistyped `/api`) leaked through.
 */
/** Every `/data/**` static mount, in the order `server/index.js` mounts them. */
export const ASSET_ROUTE_PREFIXES = [
  '/data/images',
  '/data/image-thumbnails',
  '/data/image-refs',
  '/data/lora-datasets',
  '/data/videos',
  '/data/video-thumbnails',
  '/data/sprites',
  '/data/image-to-3d',
  '/data/audio',
  '/data/models',
  '/data/voice-profiles',
  '/data/music',
  '/data/brain-imports',
  '/data/writers-room/works',
];

/**
 * Namespaces that belong to the server, never the client router: an unmatched request
 * under one is a 404, not a page. `spaPaths` lists the EXACT paths that ARE client routes
 * (`/data` is the Data Manager page); exact, not prefixes, since `nav.data` has no children.
 */
export const SERVER_OWNED_PREFIXES = [
  { prefix: '/data', spaPaths: ['/data'] },
  { prefix: '/api', spaPaths: [] },
  { prefix: '/sdapi', spaPaths: [] },
  // Same-origin Eidoverse iframe mount (reverse-proxied while the host is active).
  { prefix: '/eidoverse-host', spaPaths: [] },
];
