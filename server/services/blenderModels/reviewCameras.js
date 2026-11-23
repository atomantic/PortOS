/**
 * The cameras a build's review renders use. Pure: every number comes from the
 * build's declared `sizeMeters` and the saved camera, never from the built mesh,
 * so two builds of one declared size frame identically even when their bounds
 * differ.
 *
 * The declared box is taken to stand on Z = 0, centered on X = Y = 0. Azimuth 0
 * is the front (the camera on -Y looking along +Y) and turns toward +X; elevation
 * +90 looks straight down. Distances are meters, lenses millimeters on a 36 mm
 * square sensor.
 */

export const BLENDER_MODEL_REVIEW_LOOKS = Object.freeze(['textured', 'clay']);

/** The fixed views, in sheet order; all orthographic and at one scale. */
export const BLENDER_MODEL_FIXED_VIEWS = Object.freeze({
  front: { azimuth: 0, elevation: 0 },
  right: { azimuth: 90, elevation: 0 },
  back: { azimuth: 180, elevation: 0 },
  left: { azimuth: 270, elevation: 0 },
  top: { azimuth: 0, elevation: 90 },
  bottom: { azimuth: 0, elevation: -90 },
  'three-quarter': { azimuth: 35, elevation: 25 },
});

// Room around the box's diagonal, which every fixed view fits inside whatever its direction.
const FRAME_MARGIN = 1.08;

const round = (value) => Number(value.toFixed(6)) + 0;
const radians = (degrees) => (degrees * Math.PI) / 180;

/** The width and height, in meters, every fixed view shows of a model this size. */
export const reviewFrameMeters = ({ x, y, z }) => Math.hypot(x, y, z) * FRAME_MARGIN;
const boxCenter = ({ z }) => [0, 0, z / 2];

/** Camera axes (world space): `right`, `up` and `back` (from the target toward the camera). Defined at the poles too. */
function basis({ azimuth, elevation }) {
  const az = radians(azimuth);
  const el = radians(elevation);
  return {
    right: [Math.cos(az), Math.sin(az), 0].map(round),
    up: [-Math.sin(az) * Math.sin(el), Math.cos(az) * Math.sin(el), Math.cos(el)].map(round),
    back: [Math.sin(az) * Math.cos(el), -Math.cos(az) * Math.cos(el), Math.sin(el)].map(round),
  };
}

const place = (target, back, distance) => target.map((value, axis) => round(value + back[axis] * distance));

function fixedView(id, size) {
  const frame = reviewFrameMeters(size);
  const axes = basis(BLENDER_MODEL_FIXED_VIEWS[id]);
  return {
    id, projection: 'ORTHO', ...axes, location: place(boxCenter(size), axes.back, frame * 2),
    orthoScale: round(frame), clipStart: round(frame / 1000), clipEnd: round(frame * 12),
  };
}

function orbitView({ id, orbit }, size) {
  const axes = basis(orbit);
  const target = orbit.target ?? boxCenter(size);
  return {
    id, projection: 'PERSP', ...axes, location: place(target, axes.back, orbit.distance),
    lens: orbit.lens, clipStart: round(Math.max(orbit.distance / 1000, 1e-5)), clipEnd: round(orbit.distance + reviewFrameMeters(size) * 12),
  };
}

/** Every view a review of a model of `size` renders: the fixed ones, then each saved orbit. */
export function reviewViews(size, cameras = []) {
  return [
    ...Object.keys(BLENDER_MODEL_FIXED_VIEWS).map((id) => fixedView(id, size)),
    ...cameras.filter((camera) => camera.orbit).map((camera) => orbitView(camera, size)),
  ];
}

/** The review image a saved camera shows: its fixed direction, or its own orbit. */
export const cameraViewId = (camera) => (camera.orbit ? camera.id : camera.view);
