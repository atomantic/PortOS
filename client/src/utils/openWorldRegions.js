// OpenWorld's fast-travel region registry — the list of named places you can warp to and
// the PortOS page each one stands for. This is what turns the world from "one city you pan
// around" into an open world you teleport across (Breath-of-the-Wild style): every region is
// a real destination with a name, a one-line pitch, and a door back into the 2D app.
//
// Geography is NOT re-declared here. Each region names a parcel in the master town plan
// (`openWorldPlan.js` PARCELS) and reads its anchor/footprint from there, so moving a district on
// the plan moves its fast-travel marker too — the same no-drift rule the mini-map follows.
//
// No React / three.js imports so the registry stays unit-testable in node (mirrors
// openWorldMiniMap.js / openWorldFocusCamera.js). `OPEN_WORLD_REGIONS` is ALSO the source of truth for
// the `/openworld/region/:regionId` nav-manifest entries — `server/lib/navManifest.test.js`
// scrapes the `id:` values out of this array and fails if a region has no ⌘K / voice command
// (or vice versa), so a new region can't ship unreachable.

import { PARCELS } from './openWorldPlan';

// Ordered for the fast-travel list: the two places you look at most first, then a clockwise
// sweep of the outer districts, then the far shore. `parcel` keys into PARCELS for geography;
// `appPath` is semantic metadata for the PortOS area the region visualizes (null for pure set
// dressing). OpenWorld uses the region id for in-world travel and never follows this path.
//
// `district` marks a region whose real extent is DATA-DRIVEN — the downtown and archive grids
// grow with the install's app count, so their PARCELS footprint is only a nominal size. It
// names the district key in `computeOpenWorldLayout`'s output, which the camera uses to measure the
// buildings actually on the ground instead of framing a fixed rectangle and clipping the
// outer towers.
export const OPEN_WORLD_REGIONS = [
  { id: 'downtown', parcel: 'downtown', district: 'downtown', label: 'Downtown', blurb: 'Every managed app, one tower each.', appPath: '/apps', aliases: ['downtown', 'apps district', 'app towers'] },
  { id: 'ai-core', parcel: 'aiCore', label: 'AI Core Plaza', blurb: 'The reactor at the center — live AI provider activity.', appPath: '/ai', aliases: ['ai core', 'core plaza', 'the core', 'reactor'] },
  { id: 'task-queue', parcel: 'taskQueue', label: 'Task Queue', blurb: 'Chief of Staff work stacked up and moving.', appPath: '/cos/tasks', aliases: ['task queue', 'queue', 'cos queue'] },
  { id: 'wellness', parcel: 'health', label: 'Wellness Tower', blurb: 'System vitals — CPU, memory, disk.', appPath: '/system-resources/overview', aliases: ['wellness tower', 'health tower', 'vitals tower'] },
  { id: 'archive', parcel: 'warehouse', district: 'warehouse', label: 'Archive District', blurb: 'Cold storage for archived apps.', appPath: '/apps', aliases: ['archive district', 'warehouse', 'cold storage'] },
  { id: 'quiet-corner', parcel: 'easterEggs', label: 'Quiet Corner', blurb: 'The odd little things the world keeps to itself.', appPath: null, aliases: ['quiet corner', 'easter eggs'] },
  { id: 'productivity', parcel: 'productivity', label: 'Productivity Terrace', blurb: 'Streaks, throughput, and the activity heatmap.', appPath: '/insights/overview', aliases: ['productivity terrace', 'productivity', 'streak district'] },
  { id: 'backup-vault', parcel: 'backupVault', label: 'Backup Vault', blurb: 'The sealed door — last backup and its health.', appPath: '/settings/backup', aliases: ['backup vault', 'the vault'] },
  { id: 'memory', parcel: 'memory', label: 'Memory Quarter', blurb: 'Crystal clusters of long-term memory and the inbox well.', appPath: '/brain/inbox', aliases: ['memory quarter', 'memory district', 'knowledge district'] },
  { id: 'sprint-yard', parcel: 'jira', label: 'Sprint Yard', blurb: 'The current sprint, laid out as a yard of tickets.', appPath: '/devtools/jira', feature: 'jira', aliases: ['sprint yard', 'jira yard', 'sprint district'] },
  { id: 'voice', parcel: 'voice', label: 'Voice Beacon', blurb: 'Lights up while the voice agent is listening.', appPath: '/digital-twin/voice', aliases: ['voice beacon', 'the beacon'] },
  { id: 'goals', parcel: 'goals', label: 'Goal Monuments', blurb: 'One monument per life goal, height by progress.', appPath: '/goals/tree', aliases: ['goal monuments', 'monuments', 'goals district'] },
  { id: 'artifacts', parcel: 'artifacts', label: 'Hall of Achievements', blurb: 'Earned artifacts on display.', appPath: '/character', aliases: ['hall of achievements', 'artifact hall', 'achievements hall'] },
  { id: 'data-harbor', parcel: 'dataHarbor', label: 'Data Harbor', blurb: 'Piers over the bay — database tables and data domains.', appPath: '/data', aliases: ['data harbor', 'the harbor', 'piers'] },
];

// Route prefix the fast-travel deep links live under. Exported so callers build the URL from
// one constant instead of re-typing it (and so the nav-manifest guard can name the prefix).
export const OPEN_WORLD_REGION_PREFIX = '/openworld/region';

export const regionPath = (id) => `${OPEN_WORLD_REGION_PREFIX}/${id}`;

const REGIONS_BY_ID = new Map(OPEN_WORLD_REGIONS.map((r) => [r.id, r]));

// Optional feature tags follow the caller's shared navigation gate. Untagged entries
// and callers without a gate remain visible; tagged entries follow the gate's answer.
export const isOpenWorldEntryVisible = (entry, isFeatureEnabled) => (
  !entry?.feature
  || typeof isFeatureEnabled !== 'function'
  || isFeatureEnabled(entry.feature)
);

// A region with its geography resolved from the master town plan: `anchor` is the ground
// center [x, y, z], `w`/`d` the parcel footprint. The registry's `label` is what the UI
// shows; the plan's own label rides along as `planLabel` for anything that wants the
// in-world signage wording. Returns null for an unknown id — and for a region naming a
// parcel that no longer exists, which the tests fail on rather than rendering at the origin.
export function getRegion(id) {
  const region = REGIONS_BY_ID.get(id);
  if (!region) return null;
  const parcel = PARCELS[region.parcel];
  if (!parcel) return null;
  return {
    ...region,
    anchor: parcel.anchor,
    w: parcel.w,
    d: parcel.d,
    planLabel: parcel.label,
  };
}

// Every region, geography resolved, in fast-travel order. Regions whose parcel has vanished
// from the plan are dropped rather than rendered at [0,0,0].
export function listRegions(isFeatureEnabled) {
  return OPEN_WORLD_REGIONS
    .filter((region) => isOpenWorldEntryVisible(region, isFeatureEnabled))
    .map((r) => getRegion(r.id))
    .filter(Boolean);
}

// Case/punctuation-insensitive lookup over labels + aliases, for the fast-travel filter box.
// Returns regions in registry order so the list never jumps around as you type.
export function searchRegions(query, isFeatureEnabled) {
  const q = (query || '').trim().toLowerCase();
  const all = listRegions(isFeatureEnabled);
  if (!q) return all;
  return all.filter((r) =>
    r.label.toLowerCase().includes(q)
    || r.id.includes(q)
    || (r.blurb || '').toLowerCase().includes(q)
    || (r.aliases || []).some((a) => a.includes(q)));
}

// Where a walking player lands when they warp in. Ground level at the parcel's near (+Z)
// edge, pulled back far enough to see the district rather than spawning inside a monument.
// Regions over the water (the harbor) land on the pier itself, which `isWalkable` allows.
export const REGION_ARRIVAL_SETBACK = 6;

export function regionArrivalPoint(region) {
  if (!region) return null;
  const [x, , z] = region.anchor;
  return { x, z: z + region.d / 2 + REGION_ARRIVAL_SETBACK };
}

// The arrival point is also the physical location of a region's warp pad. Keeping the
// pad and the walking spawn on one projection prevents a diegetic warp from landing the
// player somewhere different from the marker they walked to.
export function regionWarpPadPosition(region) {
  const arrival = regionArrivalPoint(region);
  return arrival ? [arrival.x, 0.12, arrival.z] : null;
}
