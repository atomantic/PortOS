// Pure camera-framing math for CyberCity's building focus mode (issue #2593). Given a single
// borough's ground position + tower height, the current viewport aspect ratio, and the HUD safe
// area, it computes an orbital camera `position` and look-at `target` that frame the WHOLE borough
// without intersecting its geometry and without hiding it under the on-screen detail panel.
//
// No React / three.js imports so the topology stays unit-testable (mirrors cityMiniMap.js). Callers
// (CityFocusCamera) convert the returned `[x, y, z]` tuples into THREE.Vector3 and animate toward
// them.

// Vertical field of view of the city camera (matches CityScene's <Canvas camera={{ fov: 50 }}>).
export const CITY_CAMERA_FOV_DEG = 50;

// How far the orbital camera may sit from its target. CityScene passes this straight to
// OrbitControls as `maxDistance`, and every framing helper here clamps to it — the two MUST
// be the same number. When they weren't, a fast-travel warp to a big district on a phone
// computed ~218 units while the controls capped at 120, so OrbitControls yanked the camera
// in the moment the fly handed control back and the region never fit the frame.
// Sized to fit the widest region (60-unit Downtown) on a narrow portrait viewport, where the
// horizontal extent — not the HUD — is what forces the camera back.
export const CITY_MAX_ORBIT_DISTANCE = 240;

// Ground-footprint radius of a single borough: the process ring (BOROUGH_PARAMS.processRingRadius
// = 3) plus a process building's half-footprint and a little breathing room. Buildings never spread
// wider than this on the ground, so a sphere of this radius (grown by the tower height) bounds the
// entire borough.
export const BOROUGH_GROUND_RADIUS = 4.5;

// Empty space left around the framed borough (1 = edge-to-edge, 1.35 = 35% margin).
const FRAMING_MARGIN = 1.35;

// Extra vertical reach above the tower for the things that float over it — the building hologram
// (~tower + 1.8) and the stacked AgentEntity markers — so a borough with several active agents
// isn't clipped above the frame. A fixed cushion (the pure math only knows the tower `height`, not
// the live agent count) that comfortably covers a typical stack.
const BOROUGH_TOP_CLEARANCE = 3.0;

// How far above the horizon the focus camera sits (~40°). Keeps the shot looking slightly down onto
// the borough like the overview, without going full top-down.
const PITCH_RAD = (40 * Math.PI) / 180;

// A HUD panel can never eat more than this fraction of an axis for framing purposes — a floor that
// stops a degenerate viewport from pushing the camera to infinity.
const MIN_USABLE_FRACTION = 0.35;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const toRad = (deg) => (deg * Math.PI) / 180;
const finiteOr = (v, fallback) => (Number.isFinite(v) ? v : fallback);

// Compute the framing camera for one borough.
//   building — { x, z, height } layout entry (from computeCityLayout). Missing/invalid fields fall
//              back to sane defaults so a not-yet-resolved building can't produce NaNs.
//   aspect   — viewport width / height (portrait < 1 needs the camera farther back).
//   fovDeg   — vertical FOV in degrees (defaults to the city camera's 50).
//   hudSafe  — { right, bottom } fractions (0..1) of the viewport occupied by the HUD, so the
//              borough frames in the CLEAR region rather than under the detail panel.
// Returns { position:[x,y,z], target:[x,y,z], distance, radius }.
export function computeFocusCamera({ building, aspect = 1, fovDeg = CITY_CAMERA_FOV_DEG, hudSafe } = {}) {
  const bx = finiteOr(building?.x, 0);
  const bz = finiteOr(building?.z, 0);
  const heightRaw = finiteOr(building?.height, 4);
  const height = heightRaw > 0 ? heightRaw : 4;

  // Bounding radius: the wider of the borough's ground footprint and half its tower height (plus the
  // hologram/agent clearance above), so a tall skinny tower, a short wide cluster, and a
  // many-agent borough all stay fully in frame.
  const radius = Math.max(BOROUGH_GROUND_RADIUS, height * 0.6 + BOROUGH_TOP_CLEARANCE) * FRAMING_MARGIN;

  return frameFromRadius({
    centerX: bx,
    centerZ: bz,
    targetY: height * 0.45,
    radius,
    aspect,
    fovDeg,
    hudSafe,
    pitchRad: PITCH_RAD,
  });
}

// Shared optics for every framing helper here: given a bounding sphere on the ground plane,
// back the camera off far enough that the sphere fits the HUD-reduced viewport, then pan the
// whole shot clear of the HUD panels. Kept in one place so a borough and a whole district
// can't drift into different framing rules.
function frameFromRadius({ centerX, centerZ, targetY, radius, aspect, fovDeg, hudSafe, pitchRad }) {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const safeFov = Number.isFinite(fovDeg) && fovDeg > 0 ? fovDeg : CITY_CAMERA_FOV_DEG;

  // Usable viewport fraction once the HUD safe area is subtracted, clamped to a floor.
  const right = clamp01(hudSafe?.right ?? 0);
  const bottom = clamp01(hudSafe?.bottom ?? 0);
  const usableW = Math.max(MIN_USABLE_FRACTION, 1 - right);
  const usableH = Math.max(MIN_USABLE_FRACTION, 1 - bottom);

  const halfV = Math.tan(toRad(safeFov) / 2);
  const halfH = halfV * safeAspect;

  // Distance so the bounding sphere fits both the (HUD-reduced) vertical and horizontal extents.
  const distV = radius / (halfV * usableH);
  const distH = radius / (halfH * usableW);
  // Clamped to the ceiling the controls enforce: a fly that ended beyond it would be snapped
  // back by OrbitControls the instant it re-enabled. A subject too large to fit at the cap is
  // framed as well as the cap allows — imperfect, but stable instead of jarring.
  const distance = Math.min(CITY_MAX_ORBIT_DISTANCE, Math.max(distV, distH));

  // Pan the framed region so the subject sits in the clear area: push it left of a right-edge panel
  // and up above a bottom-edge panel. Panning moves camera + target by the same world delta.
  const visHalfW = distance * halfH;
  const visHalfH = distance * halfV;
  const shiftX = right * visHalfW;
  const shiftY = bottom * visHalfH;

  const target = [centerX + shiftX, targetY - shiftY, centerZ];

  // Camera above + on the +Z side (like the overview camera), pitched down by `pitchRad`.
  const position = [
    target[0],
    target[1] + distance * Math.sin(pitchRad),
    centerZ + distance * Math.cos(pitchRad),
  ];

  return { position, target, distance, radius };
}

// --- Region framing (fast travel) -------------------------------------------
// Same optics as computeFocusCamera, but framing a whole district parcel instead of one
// borough: the bounding radius comes from the parcel's [w × d] footprint rather than a
// tower's height. Used by the `/openworld/region/:regionId` warp so every region arrives
// at a consistent, fully-in-frame establishing shot.

// Empty space around a framed region — a touch tighter than a single borough's, since a
// district already reads as a group and doesn't need the extra breathing room.
const REGION_FRAMING_MARGIN = 1.2;

// A parcel with no declared footprint (or a degenerate one) still needs a usable shot.
const MIN_REGION_RADIUS = 10;

// Regions are framed from a little higher than a borough (~46°) so the district's LAYOUT
// reads — you're arriving to see a place, not to inspect one building's facade.
const REGION_PITCH_RAD = (46 * Math.PI) / 180;

// Look slightly above the ground plane so the district's structures, not the pavement,
// sit at the center of frame.
const REGION_TARGET_Y = 3;

// Compute the establishing camera for one fast-travel region.
//   region  — { anchor: [x, y, z], w, d } (from openWorldRegions.getRegion).
//   bounds  — optional { minX, maxX, minZ, maxZ } of what is ACTUALLY on the ground for a
//             data-driven district (downtown / the archive grid, whose extent grows with the
//             install's app count). When given it supersedes the parcel's nominal w/d, so a
//             big install frames its real skyline instead of clipping the outer towers; the
//             parcel is still the floor, so a near-empty install doesn't zoom into one tower.
//   aspect / fovDeg / hudSafe — as computeFocusCamera.
// Returns { position:[x,y,z], target:[x,y,z], distance, radius }.
export function computeRegionCamera({ region, bounds, aspect = 1, fovDeg = CITY_CAMERA_FOV_DEG, hudSafe } = {}) {
  const anchor = Array.isArray(region?.anchor) ? region.anchor : [];
  let cx = finiteOr(anchor[0], 0);
  let cz = finiteOr(anchor[2], 0);
  let w = Math.max(0, finiteOr(region?.w, 0));
  let d = Math.max(0, finiteOr(region?.d, 0));

  const hasBounds = [bounds?.minX, bounds?.maxX, bounds?.minZ, bounds?.maxZ].every(Number.isFinite);
  if (hasBounds) {
    // Center on the live cloud and take the larger of live vs nominal on each axis — a grid
    // that has outgrown its parcel widens the shot, one that hasn't keeps the parcel's.
    cx = (bounds.minX + bounds.maxX) / 2;
    cz = (bounds.minZ + bounds.maxZ) / 2;
    w = Math.max(w, bounds.maxX - bounds.minX + BOROUGH_GROUND_RADIUS * 2);
    d = Math.max(d, bounds.maxZ - bounds.minZ + BOROUGH_GROUND_RADIUS * 2);
  }

  const radius = Math.max(MIN_REGION_RADIUS, Math.hypot(w, d) / 2) * REGION_FRAMING_MARGIN;

  return frameFromRadius({
    centerX: cx,
    centerZ: cz,
    targetY: REGION_TARGET_Y,
    radius,
    aspect,
    fovDeg,
    hudSafe,
    pitchRad: REGION_PITCH_RAD,
  });
}
