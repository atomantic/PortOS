// OpenWorld's master archipelago plan — THE single source of truth for its geography.
// Every district helper anchors its parcel here (instead of each module hardcoding its own
// compass position), so streets, the transit loop, the waterfront, and the overlap/shoreline
// invariant tests all read the same map. No three.js / React imports — the whole plan is
// plain data + pure math, unit-testable in node (mirrors openWorldDistrictLayout.js).
//
// The Port sits at the center; Memory Wilds and Maker Reach branch north, Signal Cape
// carries their trails to Data Harbor, and Archive Rise branches south into the Focus
// Gardens and Wellness Grove. Open water makes those regions readable at a glance.

export const WORLD = {
  bound: 180, // hard XZ world bound (matches PlayerController)
  shorelineZ: -56, // land for z > shorelineZ; water (the bay) beyond
  landHalf: 60, // half-extent of the paved city ground plane (x ±landHalf, z shoreline→+landHalf)
  // The new world is a chain of raised islands. Live landmarks still sit at y=0,
  // while the ocean and distant terrain sit well below the playable shelves.
  terrainY: -2.8,
  waterY: -2.55,
  groundY: 0,
  waterSpan: 520, // how far the water plane extends past the shoreline / to each side
};

// OpenWorld is an authored archipelago rather than a rectangular city slab. Each
// island owns a recognizable PortOS biome; bridges make a continuous Signal Trail
// through all of them. The same data drives rendering, collision, and the mini-map.
// Radii are deliberately generous around landmark anchors so a live-data structure
// never appears to float off the terrain when its own footprint grows slightly.
export const ARCHIPELAGO_ISLANDS = [
  // The street-level game now reads as one cozy valley rather than eight empty plates.
  // Overlap is deliberate: the named neighborhoods remain legible on the map, while the
  // playable ground joins into an Animal-Crossing-like village with no dead ocean gaps.
  { id: 'core', label: 'The Port', center: [0, -4], radiusX: 56, radiusZ: 51, seed: 111, biome: 'port' },
  { id: 'memory', label: 'Memory Wilds', center: [-39, -33], radiusX: 29, radiusZ: 24, seed: 223, biome: 'memory' },
  { id: 'forge', label: 'Maker Reach', center: [39, -29], radiusX: 29, radiusZ: 24, seed: 337, biome: 'forge' },
  { id: 'signal', label: 'Signal Cape', center: [7, -48], radiusX: 20, radiusZ: 15, seed: 449, biome: 'signal' },
  { id: 'harbor', label: 'Data Harbor', center: [0, -66], radiusX: 31, radiusZ: 18, seed: 557, biome: 'harbor' },
  { id: 'archive', label: 'Archive Rise', center: [0, 40], radiusX: 46, radiusZ: 28, seed: 661, biome: 'archive' },
  { id: 'garden', label: 'Focus Gardens', center: [-45, 32], radiusX: 23, radiusZ: 20, seed: 773, biome: 'garden' },
  { id: 'wellness', label: 'Wellness Grove', center: [45, 30], radiusX: 23, radiusZ: 20, seed: 887, biome: 'wellness' },
];

// The close game renders one continuous valley shelf. Named neighborhood islands remain
// as semantic geography for orbital view and compatibility, while this outline is the
// street-level ground and the Village Map silhouette.
export const VILLAGE_GROUND = {
  id: 'village-ground',
  label: 'PortOS Village',
  center: [0, -5],
  radiusX: 74,
  radiusZ: 80,
  seed: 1061,
  biome: 'port',
};

// Causeways use explicit waypoints so the visual path can arc around landmarks.
// `width` is the full rendered deck width and also the ground-collision corridor.
export const ARCHIPELAGO_LINKS = [
  { id: 'core-memory', from: 'core', to: 'memory', width: 5.2, points: [[-18, -11], [-28, -22]] },
  { id: 'core-forge', from: 'core', to: 'forge', width: 5.2, points: [[18, -10], [28, -19]] },
  { id: 'core-signal', from: 'core', to: 'signal', width: 5.6, points: [[2, -27], [5, -35]] },
  { id: 'signal-harbor', from: 'signal', to: 'harbor', width: 5.6, points: [[5, -50], [2, -57]] },
  { id: 'core-archive', from: 'core', to: 'archive', width: 6.2, points: [[0, 26], [0, 31]] },
  { id: 'archive-garden', from: 'archive', to: 'garden', width: 4.8, points: [[-18, 39], [-32, 36]] },
  { id: 'archive-wellness', from: 'archive', to: 'wellness', width: 4.8, points: [[18, 38], [32, 34]] },
  { id: 'memory-signal', from: 'memory', to: 'signal', width: 4.4, points: [[-23, -39], [-9, -42]] },
  { id: 'forge-signal', from: 'forge', to: 'signal', width: 4.4, points: [[24, -36], [15, -41]] },
];

const islandById = (id) => ARCHIPELAGO_ISLANDS.find((island) => island.id === id);

export const archipelagoLinkPoints = (link) => {
  const from = islandById(link?.from);
  const to = islandById(link?.to);
  if (!from || !to) return [];
  return [from.center, ...(link.points || []), to.center];
};

const pointNearSegment = (x, z, start, end, radius) => {
  const dx = end[0] - start[0];
  const dz = end[1] - start[1];
  const lengthSq = dx * dx + dz * dz;
  if (lengthSq <= 1e-9) return Math.hypot(x - start[0], z - start[1]) <= radius;
  const t = Math.max(0, Math.min(1, ((x - start[0]) * dx + (z - start[1]) * dz) / lengthSq));
  return Math.hypot(x - (start[0] + dx * t), z - (start[1] + dz * t)) <= radius;
};

export const isOnArchipelagoIsland = (x, z, inset = 0) => ARCHIPELAGO_ISLANDS.some((island) => {
  const safeX = Math.max(0.5, island.radiusX - inset);
  const safeZ = Math.max(0.5, island.radiusZ - inset);
  const nx = (x - island.center[0]) / safeX;
  const nz = (z - island.center[1]) / safeZ;
  return nx * nx + nz * nz <= 1;
});

// Street-level rendering uses one continuous valley shelf rather than the orbital
// archipelago plates. Keep its collision outline beside the authored ground descriptor so
// the rover never hits an invisible island boundary while still visibly on village grass.
export const isOnVillageGround = (x, z, inset = 0) => {
  const safeX = Math.max(0.5, VILLAGE_GROUND.radiusX - inset);
  const safeZ = Math.max(0.5, VILLAGE_GROUND.radiusZ - inset);
  const nx = (x - VILLAGE_GROUND.center[0]) / safeX;
  const nz = (z - VILLAGE_GROUND.center[1]) / safeZ;
  return nx * nx + nz * nz <= 1;
};

export const isOnArchipelagoLink = (x, z, padding = 0) => ARCHIPELAGO_LINKS.some((link) => {
  const points = archipelagoLinkPoints(link);
  const radius = link.width / 2 + padding;
  for (let index = 1; index < points.length; index += 1) {
    if (pointNearSegment(x, z, points[index - 1], points[index], radius)) return true;
  }
  return false;
});

// Land parcels. `anchor` is the district's center on the ground; `w`/`d` are the static
// footprint (x-width / z-depth) used by the invariant tests and the tinted ground pads.
// `dynamic: true` marks data-driven grids (downtown/warehouse) whose extent grows with the
// install — they're excluded from static-footprint checks. Anchors mirror the hand-tuned
// pre-plan positions except: the voice beacon steps aside for the harbor avenue, and the
// Data Harbor is new — piers over the bay, straight ahead of the default camera.
export const PARCELS = {
  // noPad: the plaza paints its own sidewalk ring — no tinted ground pad.
  aiCore: { anchor: [0, 0, 0], w: 24, d: 24, noPad: true, label: 'AI CORE PLAZA' },
  downtown: { anchor: [0, 0, 0], w: 60, d: 60, dynamic: true, label: 'DOWNTOWN' },
  warehouse: { anchor: [0, 0, 30], w: 60, d: 60, dynamic: true, label: 'ARCHIVE DISTRICT' },
  backupVault: { anchor: [-34, 0, -10], w: 7, d: 7, label: 'BACKUP VAULT' },
  taskQueue: { anchor: [34, 0, -10], w: 8, d: 8, label: 'TASK QUEUE' },
  memory: { anchor: [-44, 0, -30], w: 22, d: 22, label: 'MEMORY QUARTER' },
  jira: { anchor: [-20, 0, -44], w: 18, d: 12, label: 'SPRINT YARD' },
  // Goal monuments + the artifact hall grow toward each other with enough earned
  // milestones (a pre-plan, visually-tolerated rarity) — footprints reflect typical installs.
  goals: { anchor: [30, 0, -40], w: 66, d: 5, label: 'GOAL MONUMENTS' },
  artifacts: { anchor: [44, 0, -28], w: 16, d: 14, label: 'HALL OF ACHIEVEMENTS' },
  // Stepped off the avenue centerline (was [0,0,-40]) so the plaza→harbor avenue runs clear.
  voice: { anchor: [9, 0, -38], w: 5, d: 5, label: 'VOICE BEACON' },
  productivity: { anchor: [-48, 0, 28], w: 10, d: 10, label: 'PRODUCTIVITY' },
  health: { anchor: [48, 0, 28], w: 8, d: 8, label: 'WELLNESS TOWER' },
  easterEggs: { anchor: [-46, 0, 40], w: 8, d: 10, label: 'QUIET CORNER' },
  // Over the water: a pier district between the shoreline and the federation horizon.
  dataHarbor: { anchor: [0, 0, -64], w: 40, d: 16, water: true, label: 'DATA HARBOR' },
};

export const PLAZA = { center: [0, 0, 0], radius: 12, sidewalkOuter: 14.5 };

// Street-level cottage footprints. Rendering, rover collision, and camera avoidance all
// share these envelopes so the cozy village is a physical place instead of set dressing
// the player can ghost through. The central pavilion stays open; only its floating core
// is solid so the rover can still circle between the benches and arches.
export const VILLAGE_COLLIDERS = [
  { id: 'core', shape: 'circle', x: 0, z: 0, radius: 2.35, height: 5.2 },
  ...[
    'memory', 'backupVault', 'taskQueue', 'warehouse', 'health', 'productivity',
    'jira', 'easterEggs', 'goals', 'voice', 'artifacts', 'dataHarbor',
  ].map((parcelId) => {
    const [x, , z] = PARCELS[parcelId].anchor;
    return { id: parcelId, shape: 'box', x, z, halfWidth: 3.1, halfDepth: 2.6, height: 6.4 };
  }),
];

// Curved village lanes are the visual and play rhythm of street-level OpenWorld. The
// broad heart loop keeps a landmark or garden entering the frame every few seconds; short
// branches terminate at real PortOS destinations. Curves are rendered from this registry,
// so art direction and vehicle route composition cannot drift apart.
export const VILLAGE_ROUTES = [
  {
    id: 'heart-loop',
    kind: 'road',
    width: 5.4,
    closed: true,
    points: [[0, 36], [-16, 32], [-27, 18], [-29, 1], [-20, -14], [-5, -22], [13, -20], [28, -8], [29, 11], [19, 28]],
  },
  { id: 'harbor-lane', kind: 'road', width: 5.2, points: [[-5, -22], [0, -36], [3, -50], [0, -64]] },
  { id: 'memory-lane', kind: 'path', width: 3.8, points: [[-20, -14], [-31, -22], [-44, -30]] },
  { id: 'maker-lane', kind: 'path', width: 3.8, points: [[13, -20], [28, -26], [43, -28]] },
  { id: 'garden-lane', kind: 'path', width: 3.6, points: [[-16, 32], [-30, 34], [-47, 31]] },
  { id: 'wellness-lane', kind: 'path', width: 3.6, points: [[19, 28], [32, 30], [47, 28]] },
  { id: 'arrival-lane', kind: 'road', width: 5.4, points: [[0, 50], [0, 43], [0, 36]] },
];

// Managed apps become a little market around the Common in exploration mode. The first
// ring reads from the main road; a staggered second ring lets larger installs keep their
// identity without rebuilding the village around app count. Archived apps belong to the
// Archive Lodge and are summarized there instead of occupying active market stalls.
export const VILLAGE_APP_MARKET = {
  innerRadius: 12.8,
  outerRadius: 17.2,
  innerCapacity: 8,
  maxKiosks: 18,
  halfWidth: 1.28,
  halfDepth: 0.92,
  height: 3.25,
};

const APP_STATUS_ORDER = { online: 0, stopped: 1, not_started: 2, unknown: 3, not_found: 4 };

export function computeVillageAppLayout(apps = []) {
  const active = (Array.isArray(apps) ? apps : [])
    .filter((app) => app?.id && !app.archived)
    .sort((a, b) => {
      const statusDelta = (APP_STATUS_ORDER[a.overallStatus] ?? 5) - (APP_STATUS_ORDER[b.overallStatus] ?? 5);
      if (statusDelta !== 0) return statusDelta;
      return String(a.name || a.id).localeCompare(String(b.name || b.id));
    })
    .slice(0, VILLAGE_APP_MARKET.maxKiosks);

  const positions = new Map();
  active.forEach((app, index) => {
    const outer = index >= VILLAGE_APP_MARKET.innerCapacity;
    const ringIndex = outer ? index - VILLAGE_APP_MARKET.innerCapacity : index;
    const ringCount = outer
      ? Math.max(1, active.length - VILLAGE_APP_MARKET.innerCapacity)
      : Math.min(active.length, VILLAGE_APP_MARKET.innerCapacity);
    const radius = outer ? VILLAGE_APP_MARKET.outerRadius : VILLAGE_APP_MARKET.innerRadius;
    const stagger = outer ? Math.PI / Math.max(3, ringCount) : 0;
    // Begin in the Common's front-right quarter so even a one-app install presents a
    // storefront on arrival instead of hiding its only kiosk behind the pavilion.
    const angle = (ringIndex / ringCount) * Math.PI * 2 + stagger + Math.PI / 4;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    positions.set(app.id, {
      x,
      z,
      yaw: Math.atan2(x, z),
      district: 'village-market',
      height: VILLAGE_APP_MARKET.height,
      halfWidth: VILLAGE_APP_MARKET.halfWidth,
      halfDepth: VILLAGE_APP_MARKET.halfDepth,
      compact: true,
    });
  });
  return positions;
}

const smoothstep = (edge0, edge1, value) => {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

// Pure height function shared by the terrain mesh, player grounding, camera, and rover
// suspension. Broad rolls establish a toy-diorama silhouette; fine ripples are deliberately
// small enough for a Kabsch-fitted chassis to reveal them without making the route bumpy.
export function openWorldTerrainHeight(x, z) {
  let influence = 0;
  let seed = 0;
  for (const island of ARCHIPELAGO_ISLANDS) {
    const nx = (x - island.center[0]) / island.radiusX;
    const nz = (z - island.center[1]) / island.radiusZ;
    const radius = Math.hypot(nx, nz);
    if (radius >= 1) continue;
    const nextInfluence = smoothstep(1, 0.18, radius);
    if (nextInfluence > influence) {
      influence = nextInfluence;
      seed = island.seed;
    }
  }
  if (influence <= 0) return 0;

  const broad = Math.sin((x + seed * 0.01) * 0.075) * 0.28
    + Math.cos((z - seed * 0.006) * 0.09) * 0.22;
  const fine = Math.sin(x * 0.31 + z * 0.19) * 0.055;
  const arrivalHump = 0.48 * Math.exp(-((x * x) + ((z - 42) * (z - 42)) * 0.55) / 34);
  const harborDip = -0.28 * Math.exp(-((x * x) + ((z + 56) * (z + 56))) / 95);

  // Keep the immediate doorstep of every destination calm so cottages and live-data
  // monuments share a dependable foundation in both game and orbital modes.
  const nearestParcel = Object.values(PARCELS).reduce((nearest, parcel) => {
    const distance = Math.hypot(x - parcel.anchor[0], z - parcel.anchor[2]);
    return Math.min(nearest, distance);
  }, Infinity);
  const doorstep = smoothstep(3.5, 9, nearestParcel);

  return (broad + fine + arrivalHump + harborDip) * influence * (0.28 + doorstep * 0.72);
}

// Elevated transit loop — a closed ride through every quarter, rendered as a glowing tube
// with trams orbiting it. District stops are DERIVED from their parcel anchors (pulled 10%
// toward the city center so the track skims districts instead of impaling their monuments)
// — move a parcel and its tram stop follows. The harbor-gate stop (on the shoreline, since
// the track stays over land) is the one explicit point.
const TRANSIT_Y = 9; // track height — above street props, below most rooftops
const TRANSIT_STOP_PULL = 0.1;
const districtStop = (id) => {
  const [x, , z] = PARCELS[id].anchor;
  return { id, point: [x * (1 - TRANSIT_STOP_PULL), TRANSIT_Y, z * (1 - TRANSIT_STOP_PULL)] };
};
export const TRANSIT = {
  y: TRANSIT_Y,
  stopPull: TRANSIT_STOP_PULL,
  stops: [
    districtStop('productivity'),
    districtStop('backupVault'),
    districtStop('memory'),
    districtStop('jira'),
    { id: 'harborGate', point: [0, TRANSIT_Y, WORLD.shorelineZ + 9] },
    districtStop('goals'),
    districtStop('artifacts'),
    districtStop('taskQueue'),
    districtStop('health'),
    districtStop('warehouse'),
  ],
  tramCount: 3,
  tramSpeed: 0.012, // loop fraction per second — a leisurely orbit (~80s per lap)
};

// True when a ground position sits in the bay (used by the skyline ring to skip silhouettes
// that would otherwise stand in the water, and by the player controller to keep walking
// players on land). `margin` extends the water zone toward land (positive = stricter).
export const isInWater = (_x, z, margin = 0) => z < WORLD.shorelineZ + margin;

// True where a ground-level player may stand: inside the continuous village shelf or on
// an authored causeway. Flying players (above rooftop height) ignore this entirely.
export const isWalkable = (x, z) => {
  // Pull the collision boundary slightly inside the decorative village rim so the
  // rover cannot balance over open water on its outside wheels. Causeways get a
  // small forgiving shoulder for analog controls and high-speed boost entries.
  return isOnVillageGround(x, z, 0.75) || isOnArchipelagoLink(x, z, 0.45);
};

// ---------------------------------------------------------------------------
// Streets: ring road + spokes + the harbor avenue, as flat rotated rectangles.
// ---------------------------------------------------------------------------

const RING_RADIUS = 30; // octagonal ring road just outside the downtown grid
const ROAD_WIDTH = 3.2;
// Exported: the Data Harbor's pier gangway continues the avenue over the water, so the
// two widths must agree or the shoreline joint shows a seam.
export const AVENUE_WIDTH = 4.6;
const SPOKE_CLEARANCE = 6; // stop a spoke this short of the district anchor

// Static parcels that get a street spoke from the ring road. The harbor is served by the
// avenue; downtown/warehouse sit inside/astride the ring; aiCore is the plaza itself.
const SPOKE_PARCELS = [
  'backupVault', 'taskQueue', 'memory', 'jira', 'goals',
  'artifacts', 'productivity', 'health', 'easterEggs',
];

// A street segment is a centered rectangle: rotate a [length × width] quad by `angle`
// (radians, around Y) at ground position [x, z].
const segment = (x1, z1, x2, z2, width) => {
  const dx = x2 - x1;
  const dz = z2 - z1;
  return {
    x: (x1 + x2) / 2,
    z: (z1 + z2) / 2,
    length: Math.hypot(dx, dz),
    angle: Math.atan2(dz, dx),
    width,
  };
};

// The full street network, derived from the plan. Pure + deterministic; the component
// merges every rectangle into one geometry, so count here is free.
export function computeStreets() {
  const segments = [];

  // Octagonal ring road around downtown.
  const ringPoints = [];
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + Math.PI / 8; // flat edges face the compass directions
    ringPoints.push([Math.cos(a) * RING_RADIUS, Math.sin(a) * RING_RADIUS]);
  }
  for (let k = 0; k < 8; k++) {
    const [x1, z1] = ringPoints[k];
    const [x2, z2] = ringPoints[(k + 1) % 8];
    segments.push({ ...segment(x1, z1, x2, z2, ROAD_WIDTH), kind: 'ring' });
  }

  // Spokes: ring → each served district, stopping short of the anchor.
  const crosswalks = [];
  for (const id of SPOKE_PARCELS) {
    const [ax, , az] = PARCELS[id].anchor;
    const dist = Math.hypot(ax, az);
    if (dist <= RING_RADIUS + SPOKE_CLEARANCE) continue; // hugs the ring already
    const ux = ax / dist;
    const uz = az / dist;
    const inner = RING_RADIUS - ROAD_WIDTH / 2; // tuck under the ring edge — no gap at the joint
    const outer = dist - SPOKE_CLEARANCE;
    segments.push({ ...segment(ux * inner, uz * inner, ux * outer, uz * outer, ROAD_WIDTH), kind: 'spoke', to: id });
    // Crosswalk band where the spoke meets the ring.
    crosswalks.push({ x: ux * RING_RADIUS, z: uz * RING_RADIUS, angle: Math.atan2(uz, ux), length: ROAD_WIDTH * 1.4, width: 2.0 });
  }

  // The grand avenue: plaza edge → shoreline, straight up the city's axis to the harbor.
  segments.push({
    ...segment(0, -(PLAZA.radius - 1), 0, WORLD.shorelineZ + 1, AVENUE_WIDTH),
    kind: 'avenue',
  });

  // A short southern arrival lane gives the rover a deliberate place to enter the
  // world when the install has no app data yet. It connects the downtown ring to
  // the default drop-in area without cutting through the central plaza.
  segments.push({
    ...segment(0, PLAZA.sidewalkOuter + 15, 0, WORLD.landHalf + 12, AVENUE_WIDTH),
    kind: 'arrival',
  });

  return { segments, crosswalks, plazaRing: { inner: PLAZA.radius, outer: PLAZA.sidewalkOuter } };
}

// ---------------------------------------------------------------------------
// Street props: lamp posts along every street, planting trees ringing the plaza.
// ---------------------------------------------------------------------------

const LAMP_SPACING = 11; // world units between lamp pairs along a street
const LAMP_SIDE_OFFSET = 2.6; // lateral distance from the street centerline

// Lamp + tree positions for a given street layout. `density` scales counts (quality
// presets): 0 → no props, 1 → full. Deterministic — same input, same town furniture.
export function computeStreetProps(streets, density = 1) {
  const lamps = [];
  const trees = [];
  if (!streets || density <= 0) return { lamps, trees };

  const spacing = LAMP_SPACING / Math.min(1.5, Math.max(0.25, density));
  for (const seg of streets.segments) {
    const count = Math.floor(seg.length / spacing);
    const cos = Math.cos(seg.angle);
    const sin = Math.sin(seg.angle);
    for (let i = 0; i < count; i++) {
      // March along the segment; alternate which side of the street the lamp stands on.
      const t = (i + 0.5) / count - 0.5;
      const side = i % 2 === 0 ? 1 : -1;
      const along = t * seg.length;
      const off = side * (seg.width / 2 + LAMP_SIDE_OFFSET - 1);
      lamps.push({
        x: seg.x + cos * along - sin * off,
        z: seg.z + sin * along + cos * off,
      });
    }
  }

  // Trees around the plaza sidewalk, skipping the avenue mouth (north) so the walkway
  // to the harbor stays open. The stable scale variation keeps the grove from reading
  // as a repeated ring of identical icons.
  const treeCount = Math.round(10 * Math.min(1.5, density));
  const treeRadius = (streets.plazaRing.inner + streets.plazaRing.outer) / 2 + 0.6;
  for (let i = 0; i < treeCount; i++) {
    const a = (i / treeCount) * Math.PI * 2 + Math.PI / 2; // start at the south point
    const x = Math.cos(a) * treeRadius;
    const z = Math.sin(a) * treeRadius;
    if (z < -treeRadius * 0.86) continue; // the avenue mouth
    trees.push({ x, z, seed: i, scale: 0.86 + ((i * 7) % 5) * 0.07 });
  }

  return { lamps, trees };
}
