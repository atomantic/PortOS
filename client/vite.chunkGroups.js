import { resolve } from 'node:path';

// Vendor chunk groups for rolldown's `output.codeSplitting.groups` (Vite 8).
//
// Declared as package NAMES rather than as hand-written regexes so the grouping
// can be checked against what is actually installed. A group regex naming a
// package nobody installs matches nothing and quietly stops guaranteeing
// anything: `vendor-three` listed `three-fenestra` — removed from the tree when
// `openworld/InteriorMappingMaterial.js` ported the material in — while the two
// three-* packages that DO ship (`three-stdlib` and `three-mesh-bvh`, both pulled
// in by @react-three/drei) fell outside the pattern, because `three` had to be
// followed immediately by a path separator (#5725).
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
const buildGroupTest = (packages) =>
  new RegExp(`${PATH_SEP}node_modules${PATH_SEP}(${packages.map(packagePattern).join('|')})${PATH_SEP}`);

// Rolldown's `includeDependenciesRecursively` defaults to true: a group also
// captures every transitive dependency of a module it directly matches, not
// just the modules its own `test` names. Left at its default, `vendor-three`
// matching `@react-three` (drei) recursively pulls in ALL of `three-stdlib` as
// drei's dependency — silently defeating the `vendor-three-loaders` split
// below, because that group is declared (and thus processed) second and never
// sees those modules to claim; rolldown removes a module from every other
// group once one group has captured it (first-declared wins on a tie). Turning
// recursion off HERE, and declaring `vendor-three-loaders` first, makes it the
// one that claims `three-stdlib`'s own modules before `vendor-three`'s walk
// can reach them — while `vendor-three` keeps its default recursive capture,
// which is what pulls drei/fiber's OTHER transitive runtime deps (troika text
// rendering, camera-controls, meshline, zustand, …) into the shared chunk
// instead of duplicating them into every individual page that uses drei.
const DIRECT_MATCH_ONLY = { includeDependenciesRecursively: false };

const VENDOR_CHUNK_GROUPS = [
  // Core React dependencies
  { name: 'vendor-react', packages: ['react', 'react-dom', 'react-router'] },
  // Socket dependencies
  { name: 'vendor-realtime', packages: ['socket.io-client'] },
  // Drag and drop library (only used in CoS)
  { name: 'vendor-dnd', packages: ['@dnd-kit'] },
  // Icon library (largest dependency)
  { name: 'vendor-icons', packages: ['lucide-react'] },
  // GLTF/DRACO/Meshopt/KTX2/HDR loaders and the USDZ exporter — all published
  // from `three-stdlib` — split out of `vendor-three` (#8146). Declared BEFORE
  // `vendor-three` so it claims these modules directly; see the
  // `DIRECT_MATCH_ONLY` note above for why order and recursion matter here.
  // They are pulled in only by pages that load an actual asset (Model Detail,
  // AR export, HDRI environments, and the CoS avatars that call `useGLTF`);
  // the procedural graph surfaces (Brain/Memory graph, Goals tree, GraphScene)
  // never import them and previously paid for this chunk anyway because
  // rolldown grouped every three-stdlib module into one package-wide chunk.
  { name: 'vendor-three-loaders', packages: ['three-stdlib'], ...DIRECT_MATCH_ONLY },
  // 3D stack — only pulled into lazy 3D pages (CyberCity, avatars, BrainGraph).
  // Naming it gives the chunk a stable identity instead of an opaque
  // `OrbitControls-*.js`, and listing drei's own three-* dependencies pins
  // them to that chunk instead of leaving their placement to the bundler's
  // derivation.
  { name: 'vendor-three', packages: ['three', 'three-mesh-bvh', '@react-three'] },
  // Charting (recharts) — lazy chart pages only
  { name: 'vendor-charts', packages: ['recharts', 'd3-*', 'victory-*'] },
  // Terminal emulator (xterm) — Shell page only
  { name: 'vendor-term', packages: ['@xterm'] },
].map((group) => ({
  ...group,
  test: buildGroupTest(group.packages),
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
// the lazy shared chunks. Recursive capture stays off: a shared helper must
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
    minSize: 15_000,
    maxSize: 500_000,
    priority: -20,
    includeDependenciesRecursively: false,
  },
];

export const CHUNK_GROUPS = [...VENDOR_CHUNK_GROUPS, ...APP_CHUNK_GROUPS];
