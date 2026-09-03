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

export const CHUNK_GROUPS = [
  // Core React dependencies
  { name: 'vendor-react', packages: ['react', 'react-dom', 'react-router'] },
  // Socket dependencies
  { name: 'vendor-realtime', packages: ['socket.io-client'] },
  // Drag and drop library (only used in CoS)
  { name: 'vendor-dnd', packages: ['@dnd-kit'] },
  // Icon library (largest dependency)
  { name: 'vendor-icons', packages: ['lucide-react'] },
  // 3D stack — only pulled into lazy 3D pages (CyberCity, avatars, BrainGraph).
  // Naming it gives the ~1 MB chunk a stable identity instead of an opaque
  // `OrbitControls-*.js`, and listing drei's own three-* dependencies pins them
  // to that chunk instead of leaving their placement to the bundler's derivation.
  { name: 'vendor-three', packages: ['three', 'three-stdlib', 'three-mesh-bvh', '@react-three'] },
  // Charting (recharts) — lazy chart pages only
  { name: 'vendor-charts', packages: ['recharts', 'd3-*', 'victory-*'] },
  // Terminal emulator (xterm) — Shell page only
  { name: 'vendor-term', packages: ['@xterm'] },
].map((group) => ({ ...group, test: buildGroupTest(group.packages) }));
