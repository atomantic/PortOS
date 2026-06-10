// CyberCity's master town plan — THE single source of truth for the city's geography.
// Every district helper anchors its parcel here (instead of each module hardcoding its own
// compass position), so streets, the transit loop, the waterfront, and the overlap/shoreline
// invariant tests all read the same map. No three.js / React imports — the whole plan is
// plain data + pure math, unit-testable in node (mirrors cityDistrictLayout.js).
//
// Geography at a glance (top-down, default camera looks from +Z toward -Z):
//
//            ~ ~ ~  BAY (water, z < shoreline)  ~ ~ ~
//        [federation peers on the far horizon, radius 76+]
//                 ════ DATA HARBOR (piers) ════
//   ── shoreline z = -56 ──────────────────────────────────
//      jira yard        voice beacon        goal monuments
//      memory quarter        │ avenue │         artifacts hall
//      backup vault      ╭── plaza ──╮       task queue
//                        │  AI CORE  │
//      productivity      ╰─ downtown ╯       health tower
//      + heatmap                                   easter eggs
//                     warehouse (archived, grows +Z)
//
// The bay sits NORTH (-Z) on purpose: the default camera at [0,25,45] faces it, the archive
// warehouse grows the opposite way (+Z) so it can never reach the water, and the federation
// horizon's distant peers read as sister cities across the bay.

export const WORLD = {
  bound: 180, // hard XZ world bound (matches PlayerController)
  shorelineZ: -56, // land for z > shorelineZ; water (the bay) beyond
  landHalf: 60, // half-extent of the paved city ground plane (x ±landHalf, z shoreline→+landHalf)
  // The ground y-stack, bottom to top: terrain shader < water plane < city ground.
  terrainY: -0.08,
  waterY: -0.04,
  groundY: -0.02,
  waterSpan: 520, // how far the water plane extends past the shoreline / to each side
};

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
export const isInWater = (x, z, margin = 0) => z < WORLD.shorelineZ + margin;

// True where a ground-level player may stand: any land, plus the Data Harbor's piers —
// the one parcel built over the water (reached by the avenue gangway). Flying players
// (above rooftop height) ignore this entirely.
export const isWalkable = (x, z) => {
  if (!isInWater(x, z)) return true;
  const harbor = PARCELS.dataHarbor;
  return Math.abs(x - harbor.anchor[0]) <= harbor.w / 2
    && z >= harbor.anchor[2] - harbor.d / 2;
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

  return { segments, crosswalks, plazaRing: { inner: PLAZA.radius, outer: PLAZA.sidewalkOuter } };
}

// ---------------------------------------------------------------------------
// Street props: lamp posts along every street, holo-trees ringing the plaza.
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

  // Holo-trees around the plaza sidewalk, skipping the avenue mouth (north) so the
  // walkway to the harbor stays open.
  const treeCount = Math.round(10 * Math.min(1.5, density));
  const treeRadius = (streets.plazaRing.inner + streets.plazaRing.outer) / 2 + 0.6;
  for (let i = 0; i < treeCount; i++) {
    const a = (i / treeCount) * Math.PI * 2 + Math.PI / 2; // start at the south point
    const x = Math.cos(a) * treeRadius;
    const z = Math.sin(a) * treeRadius;
    if (z < -treeRadius * 0.86) continue; // the avenue mouth
    trees.push({ x, z, seed: i });
  }

  return { lamps, trees };
}
