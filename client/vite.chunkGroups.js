import { resolve } from 'node:path';

// Vendor chunk groups for rolldown's `output.codeSplitting.groups` (Vite 8).
//
// Declared as package NAMES rather than as hand-written regexes so the grouping
// can be checked against what is actually installed. A group regex naming a
// package nobody installs matches nothing and quietly stops guaranteeing
// chunk placement.
//
// Conventions for a `packages` entry:
//   'three'        an exact package name
//   '@xterm'       a scope — every package published under it
//   'd3-*'         a family prefix — every `d3-<something>` package
// `buildGroupTest` renders them back into the module-id regex rolldown matches
// with. Use `[\\/]` (not `/`) for the separator so the regexes match on Windows.

const PATH_SEP = '[\\\\/]';

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const packagePattern = (name) =>
  name.endsWith('*')
    ? `${escapeRegex(name.slice(0, -1))}[^\\\\/]+`
    : escapeRegex(name);

/** Module-id regex capturing every module published by one of `packages`. */
const buildGroupTest = (packages, suffix = '') =>
  new RegExp(`${PATH_SEP}node_modules${PATH_SEP}(${packages.map(packagePattern).join('|')})${PATH_SEP}${suffix}`);

const VENDOR_CHUNK_GROUPS = [
  { name: 'vendor-react', packages: ['react', 'react-dom', 'react-router', 'use-sync-external-store'] },
  // Socket dependencies
  { name: 'vendor-realtime', packages: ['socket.io-client'] },
  // Icon library (largest dependency)
  { name: 'vendor-icons', packages: ['lucide-react'] },
  // Keep asset-only addons (GLTF, Draco, HDR, USDZ) in their importers'
  // lazy closures. Procedural scenes need only the shared renderer.
  { name: 'vendor-three', packages: ['three', '@react-three'], test: buildGroupTest(['three', '@react-three'], `(?!examples${PATH_SEP})`) },
  // Terminal emulator (xterm) — Shell page only
  { name: 'vendor-term', packages: ['@xterm'] },
].map((group) => ({
  ...group,
  test: group.test ?? buildGroupTest(group.packages),
  // `output.codeSplitting.minSize` is the fallback for a group that omits
  // `minSize`. These named vendor chunks must still emit when they are smaller
  // than the shared-app floor; `0` is rolldown's own default and opts out of
  // that fallback (#17620).
  minSize: 0,
}));

// Application modules (anything that is not a dependency). Vendor groups keep
// priority 0, so a node_modules module they name is never absorbed here.
// `app-initial` is only the cold-load graph (`$initial`): one chunk instead of
// a modulepreload per shared helper, without pulling a lazy route into the
// shell. `app-shared` then folds helpers that two or more lazy entries share
// into chunks of at least `minSize`, capped near `maxSize` so a coalesced
// chunk stays under `chunkSizeWarningLimit`. Priority -20 loses to
// `app-initial`, so a module the shell already loads is not duplicated into
// the lazy shared chunks. `entriesAware` splits shared modules by the set of
// lazy entries that use them, so a route loads only chunks some module of its
// own reaches. A size-only split makes every consumer load a whole grab-bag
// chunk and chains them into one closure that reaches `vendor-three` from nearly every page. `entriesAwareMergeThreshold` folds a
// consumer-set chunk below it into a neighbour; it stays small because each
// merge widens a route's closure (15_000 still reached three.js from the 404
// page). The cost is more, smaller files; the build test bounds both. Recursive capture stays off: a shared helper must
// not drag a page-only dependency into every consumer.
const APP_MODULE = /\.(?:jsx?|tsx?|mjs|cjs|json)(?:\?.*)?$/;
// Anchor to this checkout. A build that loads vite.config.js with a scratch
// root (the bundle-report fixture) is not the PortOS graph and must keep its
// own single entry chunk.
const REPO_ROOT = resolve(import.meta.dirname, '..');
// Escape each segment on its own. Replacing separators after escaping the
// whole path also rewrites the backslash in `\.`, so `github.com` never matches.
const IN_REPO = new RegExp(`^${REPO_ROOT.split(/[\\/]/).map(escapeRegex).join('[\\\\/]')}[\\\\/]`);

const isAppModule = (id) =>
  APP_MODULE.test(id) && IN_REPO.test(id) && !/[\\/]node_modules[\\/]/.test(id) && !id.startsWith('\0');

const APP_CHUNK_GROUPS = [
  {
    name: 'app-initial',
    test: isAppModule,
    tags: ['$initial'],
    priority: -10,
    minSize: 0,
    includeDependenciesRecursively: false,
  },
  {
    name: 'app-shared',
    test: isAppModule,
    minShareCount: 2,
    entriesAware: true,
    entriesAwareMergeThreshold: 3_000,
    minSize: 15_000,
    maxSize: 500_000,
    priority: -20,
    includeDependenciesRecursively: false,
  },
];

export const CHUNK_GROUPS = [...VENDOR_CHUNK_GROUPS, ...APP_CHUNK_GROUPS];
