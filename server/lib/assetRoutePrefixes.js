/**
 * The URL prefixes the SERVER owns, as data — deliberately a leaf module with
 * zero imports, so anything (a Vite config, a drift guard, a build script) can
 * read it without dragging express or a service into its graph.
 *
 * Two lists, for two different jobs:
 *
 *   - `ASSET_ROUTE_PREFIXES` is every `/data/**` static mount. Under
 *     `npm run dev` the browser talks to Vite on :5554, and an UNPROXIED path
 *     does not 404 — Vite's SPA fallback answers it with index.html and a 200,
 *     so a binary loader parses HTML and fails far from the cause. The dev
 *     proxy covers the namespace with one `'^/data/'` wildcard rather than a
 *     list that can fall behind; this is what
 *     `scripts/dev-proxy-drift.test.js` checks that wildcard against, mount by
 *     mount, so a future mount added OUTSIDE `/data/` still fails loudly.
 *
 *   - `SERVER_OWNED_PREFIXES` is what must never reach the SPA fallback in
 *     PRODUCTION. That fallback skips a request only when its path carries a
 *     file extension (`/\.\w+$/`), which held only because every asset happened
 *     to have one: an extensionless `/data/image-to-3d/<id>/model` fell through
 *     to the stamped index.html with a 200 — the same HTML-instead-of-bytes
 *     failure as the dev-proxy hole, on the other side of the deployment
 *     (#4688). `/api` and `/sdapi` have the identical hole for a mistyped path,
 *     where the symptom is worse: a client asking for JSON gets HTML and a 200.
 *
 * Keeping the two beside each other is the point: a new server namespace is
 * one edit, not two half-remembered ones.
 */
/** Every `/data/**` static mount, in the order `server/index.js` mounts them. */
export const ASSET_ROUTE_PREFIXES = [
  '/data/images',
  '/data/image-refs',
  '/data/lora-datasets',
  '/data/videos',
  '/data/video-thumbnails',
  '/data/sprites',
  '/data/image-to-3d',
  '/data/audio',
  '/data/voice-profiles',
  '/data/music',
  '/data/brain-imports',
  '/data/writers-room/works',
];

/**
 * Namespaces that belong to the API, never to the client router. A request
 * under one of these that matched no route is a 404, not a page.
 *
 * `spaPaths` names the exact paths inside a prefix that ARE client routes and
 * must still reach the SPA — `/data` itself is the Data Manager page. Exact
 * paths only, not prefixes: `nav.data` has no children (`/devtools/datadog` is
 * a sibling, not a child), and `scripts/dev-proxy-drift.test.js` fails if a
 * client route is ever added under one of these prefixes without being listed
 * here — reading both `NAV_COMMANDS` and `App.jsx`'s own nested `<Route>` tree,
 * since a `:id` detail route is only ever declared in the latter.
 */
export const SERVER_OWNED_PREFIXES = [
  { prefix: '/data', spaPaths: ['/data'] },
  { prefix: '/api', spaPaths: [] },
  { prefix: '/sdapi', spaPaths: [] },
];
