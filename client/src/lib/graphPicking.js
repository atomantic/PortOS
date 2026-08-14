// Screen-space picking for the 3D brain graph (#4114).
//
// The raw three.js raycast picks a node only when the ray actually hits its
// sphere. A low-importance node projects to roughly a 10px disc on a phone —
// well under the ~44px touch-target guidance — so a tap lands on a neighbour or
// on nothing. On touch we therefore project every node to screen space and take
// the nearest one within a finger-sized radius instead of hitting the mesh.
//
// Pure and three.js-free: it takes the flattened view-projection matrix (the
// 16 column-major elements of `THREE.Matrix4`, i.e. `projectionMatrix *
// matrixWorldInverse`) rather than a camera, so the whole pick is unit-testable
// in jsdom, where no WebGL context (and therefore no raycast) exists.

// Apple HIG / WCAG 2.5.5 both put the comfortable minimum touch target at ~44px.
// Used here as the max distance from the tap point to a node's projected CENTRE,
// which is deliberately more generous than a 44px-wide target: the pick is
// nearest-wins, so a wider net never steals a tap from a closer node, it only
// rescues taps that would otherwise select nothing. It also stays at or above
// the largest radius a node can project to — `OrbitControls minDistance={10}`
// bounds a max-importance sphere (r = 1.2 world units) near ~38px — so a tap
// anywhere inside a node still selects it, exactly as the raycast did.
export const TOUCH_PICK_THRESHOLD_PX = 44;

// A tap that drags further than this is an orbit gesture, not a selection.
export const TAP_SLOP_PX = 8;

/**
 * Project a world-space point to canvas-local screen pixels (y grows downward,
 * matching `clientY - rect.top`).
 *
 * @param {{x:number,y:number,z:number}} point world position
 * @param {ArrayLike<number>} viewProjection 16 column-major matrix elements
 * @param {number} width canvas CSS width
 * @param {number} height canvas CSS height
 * @returns {{x:number,y:number,depth:number}|null} null when the point sits on
 *   or behind the camera plane (clip w <= 0), where the perspective divide
 *   flips the projection and would otherwise report a bogus on-screen position.
 */
export const projectToScreen = (point, viewProjection, width, height) => {
  const e = viewProjection;
  const { x, y, z } = point;
  const w = e[3] * x + e[7] * y + e[11] * z + e[15];
  if (!(w > 0)) return null;
  const ndcX = (e[0] * x + e[4] * y + e[8] * z + e[12]) / w;
  const ndcY = (e[1] * x + e[5] * y + e[9] * z + e[13]) / w;
  const ndcZ = (e[2] * x + e[6] * y + e[10] * z + e[14]) / w;
  return {
    x: (ndcX * 0.5 + 0.5) * width,
    y: (-ndcY * 0.5 + 0.5) * height,
    depth: ndcZ
  };
};

/**
 * Nearest node to a tap, in screen space, within `threshold` pixels.
 *
 * Ranking is by projected-centre distance; an exact tie goes to the node nearer
 * the camera (smaller NDC depth), then to the earlier entry — so the same tap on
 * the same layout always resolves to the same node.
 *
 * @returns {object|null} the picked node from `nodes`, or null when nothing is
 *   within the threshold (the caller treats that as "tapped empty space").
 */
export const pickNearestNodeByScreenDistance = ({
  nodes,
  viewProjection,
  width,
  height,
  point,
  threshold = TOUCH_PICK_THRESHOLD_PX
}) => {
  if (!nodes?.length || !viewProjection || !point || !(width > 0) || !(height > 0)) return null;

  let best = null;
  let bestDistance = Infinity;
  let bestDepth = Infinity;

  for (const node of nodes) {
    const screen = projectToScreen(node, viewProjection, width, height);
    if (!screen) continue;
    const distance = Math.hypot(screen.x - point.x, screen.y - point.y);
    if (distance > threshold) continue;
    if (distance < bestDistance || (distance === bestDistance && screen.depth < bestDepth)) {
      best = node;
      bestDistance = distance;
      bestDepth = screen.depth;
    }
  }

  return best;
};

/**
 * True when a pointer gesture stayed put enough to read as a tap rather than an
 * orbit drag. `start`/`end` are client coordinates.
 */
export const isTapGesture = (start, end, slop = TAP_SLOP_PX) =>
  !!start && !!end
  && Math.abs(end.x - start.x) <= slop
  && Math.abs(end.y - start.y) <= slop;
