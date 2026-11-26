// Pure presentation math for the 3D goal tree scene (#3280): node geometry, the
// persistent per-node title labels, and framing the camera to the whole graph so
// nothing starts off-screen. No React / three.js imports — GoalsTreeView and the
// tests share these, and jsdom can't run WebGL, so all the reasoning lives here.

const APEX_RADIUS = 1.6;
const SUB_APEX_RADIUS = 1.1;
const DEFAULT_URGENCY = 0.3;

// Sphere/octahedron radius a node renders at. Drives the scene mesh scale, the
// selection halo, the label offset AND the camera fit, so it lives in one place.
export function goalNodeRadius(node) {
  if (node?.goalType === 'apex') return APEX_RADIUS;
  if (node?.goalType === 'sub-apex') return SUB_APEX_RADIUS;
  return 0.5 + (node?.urgency ?? DEFAULT_URGENCY) * 0.6;
}

export const LABEL_FONT_SIZE = { apex: 1.4, 'sub-apex': 1, standard: 0.72 };

export function goalLabelFontSize(node) {
  return LABEL_FONT_SIZE[node?.goalType] ?? LABEL_FONT_SIZE.standard;
}

// Tinted toward the node's own colour but kept light — a label has to be READ
// against the dark canvas, so the category hex (which the sphere already carries)
// would cost too much contrast.
export const LABEL_COLORS = { apex: '#fde68a', 'sub-apex': '#e9d5ff', standard: '#e5e7eb' };

export function goalLabelColor(node) {
  return LABEL_COLORS[node?.goalType] ?? LABEL_COLORS.standard;
}

export const LABEL_MAX_CHARS = 32;

// A goal title is free text and can run for a sentence; an unbounded label turns
// the graph into a wall of words. Clip to a readable stem — the hover tooltip and
// the detail panel still carry the full title.
export function goalLabelText(title, maxChars = LABEL_MAX_CHARS) {
  const text = typeof title === 'string' ? title.trim() : '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(maxChars - 1, 0)).trimEnd()}…`;
}

// Sit the label clear of the node it names (anchored at its bottom edge).
export function goalLabelOffsetY(node) {
  return goalNodeRadius(node) + goalLabelFontSize(node) * 0.75;
}

// A single node (or a tight cluster) shouldn't slam the camera into the geometry.
export const MIN_BOUNDS_RADIUS = 4;

// Axis-aligned extents of the laid-out graph, padded by each node's own radius so
// the outermost sphere is fully inside the box rather than tangent to it.
export function computeGraphBounds(nodes) {
  const list = Array.isArray(nodes) ? nodes.filter(Boolean) : [];
  if (!list.length) return null;

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  for (const node of list) {
    const radius = goalNodeRadius(node);
    const coords = [node.x, node.y, node.z];
    for (let axis = 0; axis < 3; axis++) {
      // A layout bug (or a NaN horizon) must not poison the whole fit into NaN
      // and blank the view — treat a non-finite coordinate as the origin.
      const value = Number.isFinite(coords[axis]) ? coords[axis] : 0;
      if (value - radius < min[axis]) min[axis] = value - radius;
      if (value + radius > max[axis]) max[axis] = value + radius;
    }
  }

  const center = min.map((lo, i) => (lo + max[i]) / 2);
  const size = min.map((lo, i) => max[i] - lo);
  const radius = Math.max(Math.hypot(...size) / 2, MIN_BOUNDS_RADIUS);
  return { center, size, radius };
}

export const CAMERA_FIT_PADDING = 1.2;
export const MIN_FIT_DISTANCE = 12;
// Slightly above the graph looking down the +Z axis — the same three-quarter
// framing the old hardcoded [0, 15, 40] camera used, now scaled to the graph.
const VIEW_DIRECTION = [0, 0.35, 1];

// Where to put the camera so the whole bounding sphere is inside the frustum.
// Both the vertical AND horizontal half-angles are solved and the LARGER distance
// wins, so a portrait phone (aspect < 1, narrow horizontal FOV) pulls back far
// enough instead of clipping the graph's left and right edges.
export function fitCameraToBounds(bounds, { fov = 60, aspect = 1, padding = CAMERA_FIT_PADDING } = {}) {
  if (!bounds) return null;

  const safeFov = Number.isFinite(fov) && fov > 0 && fov < 180 ? fov : 60;
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const safePadding = Number.isFinite(padding) && padding > 0 ? padding : CAMERA_FIT_PADDING;

  const verticalHalf = (safeFov * Math.PI) / 360;
  const horizontalHalf = Math.atan(Math.tan(verticalHalf) * safeAspect);

  const distance = safePadding * Math.max(
    bounds.radius / Math.sin(verticalHalf),
    bounds.radius / Math.sin(horizontalHalf),
    MIN_FIT_DISTANCE
  );

  const length = Math.hypot(...VIEW_DIRECTION);
  const direction = VIEW_DIRECTION.map(component => component / length);

  return {
    distance,
    target: [...bounds.center],
    position: bounds.center.map((component, axis) => component + direction[axis] * distance)
  };
}

// Orbit limits derived from the graph itself rather than the fitted camera, so a
// graph wider than the old fixed 150 ceiling can't be clamped back in on the very
// first controls.update() — which would undo the fit we just applied.
export function orbitDistanceLimits(bounds) {
  const radius = bounds?.radius ?? MIN_BOUNDS_RADIUS;
  return { min: Math.min(5, radius * 0.5), max: Math.max(150, radius * 8) };
}

export const LABEL_FADE_NEAR_SCALE = 1.15;
export const LABEL_FADE_FAR_SCALE = 2.2;

// Labels stay fully legible at (and inside) the framed distance and fade out as
// the user pulls back, so a zoomed-out graph doesn't become label soup.
export function labelFadeRange(fitDistance) {
  const distance = Number.isFinite(fitDistance) && fitDistance > 0 ? fitDistance : MIN_FIT_DISTANCE;
  return { near: distance * LABEL_FADE_NEAR_SCALE, far: distance * LABEL_FADE_FAR_SCALE };
}

export function labelOpacityForDistance(distance, range) {
  const { near, far } = range ?? labelFadeRange();
  if (!Number.isFinite(distance)) return 1;
  if (distance <= near) return 1;
  if (!(far > near) || distance >= far) return 0;
  return (far - distance) / (far - near);
}

// A label on a node the selection dimmed keeps just enough presence to read the
// surrounding structure without competing with the selected branch.
export const DIMMED_LABEL_OPACITY = 0.2;
