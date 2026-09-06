// Wireframe "core assembly" — the rotating icosahedron the Kestrel Neon theme
// concept draws in its telemetry panel, rendered on a plain 2D canvas so it
// needs no WebGL context (unlike the three.js CoS avatars).
//
// Geometry is pure and exported so the projection math can be pinned without
// a canvas; `drawWireframeCore` is the one imperative entry point and takes
// every color as an `[r, g, b]` triple so callers can source them from the
// state enum (`AGENT_STATES`) or from resolved theme tokens.

const PHI = (1 + Math.sqrt(5)) / 2;

// The 12 vertices of a unit-ish icosahedron: cyclic permutations of (0, ±1, ±φ).
export const ICOSAHEDRON_VERTICES = Object.freeze([
  [-1, PHI, 0], [1, PHI, 0], [-1, -PHI, 0], [1, -PHI, 0],
  [0, -1, PHI], [0, 1, PHI], [0, -1, -PHI], [0, 1, -PHI],
  [PHI, 0, -1], [PHI, 0, 1], [-PHI, 0, -1], [-PHI, 0, 1],
].map(Object.freeze));

// Every vertex pair exactly one edge length (2) apart — 30 edges.
export const ICOSAHEDRON_EDGES = Object.freeze((() => {
  const edges = [];
  const V = ICOSAHEDRON_VERTICES;
  for (let i = 0; i < V.length; i++) {
    for (let j = i + 1; j < V.length; j++) {
      const dx = V[i][0] - V[j][0];
      const dy = V[i][1] - V[j][1];
      const dz = V[i][2] - V[j][2];
      if (Math.abs(Math.sqrt(dx * dx + dy * dy + dz * dz) - 2) < 0.01) edges.push(Object.freeze([i, j]));
    }
  }
  return edges;
})());

/** Rotate a point about Y by `ay`, then about X by `ax`. */
export function rotatePoint([x, y, z], ax, ay) {
  const cy = Math.cos(ay);
  const sy = Math.sin(ay);
  const x1 = x * cy - z * sy;
  const z1 = x * sy + z * cy;
  const cx = Math.cos(ax);
  const sx = Math.sin(ax);
  return [x1, y * cx - z1 * sx, y * sx + z1 * cx];
}

const CAMERA_DISTANCE = 3.2;

/**
 * Rotate + perspective-project the icosahedron onto a canvas.
 * Returns `[sx, sy, depth]` per vertex; `depth` is the rotated z (negative =
 * toward the viewer), kept so edges can be shaded by how far back they sit.
 */
export function projectIcosahedron({ ax, ay, cx, cy, scale }) {
  return ICOSAHEDRON_VERTICES.map((p) => {
    const q = rotatePoint(p, ax, ay);
    const perspective = CAMERA_DISTANCE / (CAMERA_DISTANCE + q[2]);
    return [cx + q[0] * scale * perspective, cy + q[1] * scale * perspective, q[2]];
  });
}

const rgba = ([r, g, b], a) => `rgba(${r},${g},${b},${a.toFixed(3)})`;

const TWO_PI = Math.PI * 2;

/**
 * Draw one frame of the core assembly.
 *
 * @param {CanvasRenderingContext2D} ctx  transform already set for the DPR
 * @param {object} frame
 * @param {number} frame.width   CSS px
 * @param {number} frame.height  CSS px
 * @param {number} frame.ax      tilt (radians)
 * @param {number} frame.ay      spin (radians)
 * @param {number} frame.phase   ring-orbit phase (radians), advances independently of spin
 * @param {number} frame.pulse   0..1 — scales the glow and the dashed ring's stride
 * @param {number[]} frame.edgeRgb   edge + glow color
 * @param {number[]} frame.nodeRgb   vertex + ring color
 * @param {number[]} frame.dimRgb    corner readout color
 * @param {string}  [frame.font]     readout font family
 */
export function drawWireframeCore(ctx, {
  width, height, ax, ay, phase, pulse = 0, edgeRgb, nodeRgb, dimRgb, font = 'monospace',
}) {
  ctx.clearRect(0, 0, width, height);
  const cx = width / 2;
  const cy = height / 2;
  const scale = Math.min(width, height) * 0.24 * (1 + pulse * 0.05);
  const proj = projectIcosahedron({ ax, ay, cx, cy, scale });

  // Outer rings: a steady orbit plus a dashed arc that sweeps with `phase`.
  ctx.lineWidth = 1;
  ctx.strokeStyle = rgba(nodeRgb, 0.35);
  ctx.beginPath();
  ctx.arc(cx, cy, scale * 1.55, 0, TWO_PI);
  ctx.stroke();
  ctx.setLineDash([4, 10 - pulse * 4]);
  ctx.beginPath();
  ctx.arc(cx, cy, scale * 1.75, -phase, -phase + Math.PI * 1.4);
  ctx.stroke();
  ctx.setLineDash([]);

  // Edges, depth-shaded: near edges are brighter, thicker, and glow.
  ctx.shadowColor = rgba(edgeRgb, 0.8);
  for (const [a, b] of ICOSAHEDRON_EDGES) {
    const pa = proj[a];
    const pb = proj[b];
    const depth = (pa[2] + pb[2]) / 2 / PHI;
    const near = depth < 0;
    const alpha = 0.35 + 0.55 * (1 - (depth + 1) / 2);
    ctx.strokeStyle = rgba(edgeRgb, alpha);
    ctx.lineWidth = near ? 1.4 : 0.7;
    ctx.shadowBlur = near ? 6 + pulse * 6 : 0;
    ctx.beginPath();
    ctx.moveTo(pa[0], pa[1]);
    ctx.lineTo(pb[0], pb[1]);
    ctx.stroke();
  }
  ctx.shadowBlur = 0;

  // Vertices: solid in front, faded behind.
  for (const [x, y, depth] of proj) {
    const near = depth < 0;
    ctx.fillStyle = rgba(nodeRgb, near ? 1 : 0.4);
    ctx.beginPath();
    ctx.arc(x, y, near ? 2.4 : 1.4, 0, TWO_PI);
    ctx.fill();
  }

  // Corner readout — only when there is room for it under the rings.
  if (width >= 120 && height >= 120) {
    const degrees = ((ay % TWO_PI + TWO_PI) % TWO_PI) * (180 / Math.PI);
    ctx.fillStyle = rgba(dimRgb, 0.9);
    ctx.font = `10px ${font}`;
    ctx.fillText(`ICO-12 · ${degrees.toFixed(0).padStart(3, '0')}°`, 8, height - 8);
  }
}
