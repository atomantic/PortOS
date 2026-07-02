// Procedural window-grid layout for CyberCity buildings that use the
// InteriorMappingMaterial interior-mapping material (parallax fake-3D rooms
// behind flat window panes). The geometry/material live in
// `client/src/components/city/BuildingWindows.jsx`; this module is the pure,
// side-effect-free math it consumes so the placement is unit-testable without a
// WebGL context (headless GL can't render the city — see the city visual
// verification notes).
//
// A building's four vertical faces are each tiled with a centered grid of square
// panes. Each pane becomes one InstancedMesh instance carrying a deterministic
// `windowId` (vec3) the shader hashes to pick an interior room cell and to decide
// lit/unlit + warm/cool, so a building keeps the exact same lit rooms forever
// (same determinism contract as the flat window texture and rooftop kits).

// Pane + spacing geometry, in building-local world units. Tuned so a default
// 2.0-wide face reads as ~4 columns of distinct windows and a 5-tall online
// tower as ~7 stacked floors.
export const INTERIOR_WINDOW = {
  size: 0.26, // square pane edge
  gapX: 0.14, // horizontal gap between panes
  gapY: 0.22, // vertical gap (taller → reads as stacked floors)
  inset: 0.015, // how far the pane sits proud of the wall (avoids z-fighting)
  edgePad: 0.2, // horizontal margin kept clear at each face edge
  marginBottom: 0.5, // skip the ground-floor / base-glow band
  marginTop: 0.5, // skip the roof cap + crown floor band
  // Below this building height there isn't enough clear facade for a readable
  // grid, so the building keeps just its flat emissive window texture.
  minHeight: 3,
};

// Which buildings get interior-mapped windows. Kept deliberately narrow ("some
// of the buildings"): online, non-archived towers tall enough for a real grid.
// Stopped/idle/short buildings stay on the cheaper flat texture. Height is read
// from the already-resolved value (getBuildingHeight) rather than recomputed.
export function buildingHasInteriorWindows(app, height) {
  if (!app || app.archived) return false;
  if (!(height >= INTERIOR_WINDOW.minHeight)) return false;
  return app.overallStatus === 'online';
}

// Count panes that fit along a span, centered, given pane size + gap. Returns 0
// when not even one pane fits in the usable span.
function fitCount(span, size, gap) {
  if (!(span > 0)) return 0;
  return Math.max(0, Math.floor((span + gap) / (size + gap)));
}

// The four vertical faces, as (faceIndex, rotationY about the building's up axis,
// outward normal axis + sign). PlaneGeometry faces +Z at rotation 0.
const FACES = [
  { index: 0, axis: 'z', sign: 1, rotationY: 0 }, // front  (+Z)
  { index: 1, axis: 'z', sign: -1, rotationY: Math.PI }, // back   (-Z)
  { index: 2, axis: 'x', sign: 1, rotationY: Math.PI / 2 }, // right  (+X)
  { index: 3, axis: 'x', sign: -1, rotationY: -Math.PI / 2 }, // left   (-X)
];

// Compute every window instance for a building. Returns a flat array of
// `{ position: [x,y,z], rotationY, windowId: [a,b,c] }`. `planeSize` (the square
// pane edge) is uniform across all panes, so the material's `planeSize` uniform
// is just `INTERIOR_WINDOW.size`.
export function computeWindowGrid({ width, depth, height, seed = 0 }) {
  const { size, gapX, gapY, inset, edgePad, marginBottom, marginTop } = INTERIOR_WINDOW;
  const usableH = height - marginBottom - marginTop;
  const rows = fitCount(usableH, size, gapY);
  if (rows <= 0) return [];

  const gridH = rows * size + (rows - 1) * gapY;
  const startY = marginBottom + (usableH - gridH) / 2 + size / 2;
  const stepY = size + gapY;

  const windows = [];
  for (const face of FACES) {
    // The horizontal extent of this face: building width for front/back, depth
    // for the sides. The pane plane is always normal to the face's axis.
    const faceWidth = face.axis === 'z' ? width : depth;
    const usableW = faceWidth - 2 * edgePad;
    const cols = fitCount(usableW, size, gapX);
    if (cols <= 0) continue;

    const gridW = cols * size + (cols - 1) * gapX;
    const startH = -gridW / 2 + size / 2;
    const stepX = size + gapX;
    // Distance from center out to the (slightly proud) face plane.
    const offset = (face.axis === 'z' ? depth : width) / 2 + inset;

    for (let r = 0; r < rows; r++) {
      const y = startY + r * stepY;
      for (let c = 0; c < cols; c++) {
        const h = startH + c * stepX; // position along the face's horizontal axis
        const position = face.axis === 'z'
          ? [h, y, face.sign * offset]
          : [face.sign * offset, y, h];
        // Deterministic, well-spread seed per pane so the shader hash varies
        // per window, per face, and per building. Keep every component SMALL: the
        // IDs round-trip through a Float32Array for the instanced attribute, and
        // float32 loses sub-integer precision past ~16.7M — a raw app-name hash
        // (hundreds of millions) would swamp the c/r offsets and collapse every
        // pane on a face to one room. A bounded per-building phase shifts the
        // hash input without dominating the per-pane column/row offsets.
        const phase = seed % 360;
        const windowId = [
          c + face.index * 2.3 + phase * 0.11,
          r + face.index * 1.7 + phase * 0.07,
          face.index + (seed % 17) * 0.13,
        ];
        windows.push({ position, rotationY: face.rotationY, windowId });
      }
    }
  }
  return windows;
}
