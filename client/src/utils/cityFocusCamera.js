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

// Ground-footprint radius of a single borough: the process ring (BOROUGH_PARAMS.processRingRadius
// = 3) plus a process building's half-footprint and a little breathing room. Buildings never spread
// wider than this on the ground, so a sphere of this radius (grown by the tower height) bounds the
// entire borough.
export const BOROUGH_GROUND_RADIUS = 4.5;

// Empty space left around the framed borough (1 = edge-to-edge, 1.35 = 35% margin).
const FRAMING_MARGIN = 1.35;

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

  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const safeFov = Number.isFinite(fovDeg) && fovDeg > 0 ? fovDeg : CITY_CAMERA_FOV_DEG;

  // Bounding radius: the wider of the borough's ground footprint and half its tower height, so both
  // a tall skinny tower and a short wide cluster stay fully in frame.
  const radius = Math.max(BOROUGH_GROUND_RADIUS, height * 0.6) * FRAMING_MARGIN;

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
  const distance = Math.max(distV, distH);

  // Pan the framed region so the borough sits in the clear area: push it left of a right-edge panel
  // and up above a bottom-edge panel. Panning moves camera + target by the same world delta.
  const visHalfW = distance * halfH;
  const visHalfH = distance * halfV;
  const shiftX = right * visHalfW;
  const shiftY = bottom * visHalfH;

  const targetY = height * 0.45;
  const target = [bx + shiftX, targetY - shiftY, bz];

  // Camera above + on the +Z side (like the overview camera), pitched down by PITCH_RAD.
  const position = [
    target[0],
    target[1] + distance * Math.sin(PITCH_RAD),
    bz + distance * Math.cos(PITCH_RAD),
  ];

  return { position, target, distance, radius };
}
