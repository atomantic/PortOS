import { useMemo, useEffect } from 'react';
import * as THREE from 'three';
import { InteriorMappingMaterial } from './InteriorMappingMaterial';
import { computeWindowGrid, INTERIOR_WINDOW } from '../../utils/cityInteriorWindows';
import { mixHex, seededRand } from './cityConstants';

// Interior-mapped window panes for a building, using the in-tree
// InteriorMappingMaterial — a parallax shader that fakes furnished 3D rooms
// behind flat window planes (no real interior geometry). Selected towers get a
// grid of these panes proud of each face so you can "look into" lit rooms as the
// camera moves, instead of the flat emissive window texture alone.
//
// Every pane of every building is ONE InstancedMesh draw call: the grid math
// (cityInteriorWindows.computeWindowGrid) places each pane, and a deterministic
// per-pane `instanceWindowId` drives the shader's room-cell pick + lit/unlit and
// warm/cool variation entirely on the GPU. Night-only + high-quality-preset
// gated by the callers (Building / Borough), since the ray-march costs more than
// the flat texture.

const ATLAS_COLS = 4;
const ATLAS_ROWS = 4;

// Shared, palette-neutral interior-room atlas (4×4 = 16 room variants). Built
// once and reused by every building — the per-building warm/cool tint comes from
// the material's emissiveVariation, not the atlas, so a single grayscale-ish
// atlas serves the whole city (and never needs disposing, like the rooftop-kit
// singletons). Lazy so importing this module stays side-effect-free; returns
// null under headless/jsdom where canvas has no 2d context.
let _atlas = null;
function getInteriorAtlas() {
  if (_atlas) return _atlas;
  const cell = 128;
  const canvas = document.createElement('canvas');
  canvas.width = cell * ATLAS_COLS;
  canvas.height = cell * ATLAS_ROWS;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  for (let row = 0; row < ATLAS_ROWS; row++) {
    for (let col = 0; col < ATLAS_COLS; col++) {
      const ox = col * cell;
      const oy = row * cell;
      const rand = seededRand(row * ATLAS_COLS + col + 1);

      // Back wall, floor band, ceiling band — neutral warm-gray so the emissive
      // tint reads as the room's light color rather than fighting a hue.
      ctx.fillStyle = '#3a3a42';
      ctx.fillRect(ox, oy, cell, cell);
      ctx.fillStyle = '#2b2b32';
      ctx.fillRect(ox, oy, cell, cell * 0.12);
      ctx.fillStyle = '#4c4c55';
      ctx.fillRect(ox, oy + cell * 0.7, cell, cell * 0.3);

      // 1–3 furniture silhouettes standing on the floor (desk/shelf/monitor).
      const pieces = 1 + Math.floor(rand() * 3);
      for (let p = 0; p < pieces; p++) {
        const w = cell * (0.18 + rand() * 0.24);
        const h = cell * (0.18 + rand() * 0.34);
        const x = ox + cell * 0.08 + rand() * (cell * 0.84 - w);
        const y = oy + cell * 0.7 - h;
        const shade = 35 + Math.floor(rand() * 45);
        ctx.fillStyle = `rgb(${shade},${shade},${shade + 8})`;
        ctx.fillRect(x, y, w, h);
      }

      // Occasional lit focal element (screen/lamp) — a small near-white block
      // that the warm/cool emissive turns into the visible "lights on" glow.
      if (rand() > 0.3) {
        const w = cell * (0.1 + rand() * 0.14);
        const h = cell * (0.08 + rand() * 0.12);
        const x = ox + cell * 0.12 + rand() * (cell * 0.68);
        const y = oy + cell * 0.3 + rand() * (cell * 0.3);
        ctx.fillStyle = '#dfe6f0';
        ctx.fillRect(x, y, w, h);
      }
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  _atlas = tex;
  return _atlas;
}

// Hex → HDR-ish THREE.Color: emissive contributions want values >1 to read as a
// glow under tone mapping, mirroring InteriorMappingMaterial's warm/cool defaults.
function emissiveColor(hex, scale) {
  return new THREE.Color(hex).multiplyScalar(scale);
}

export default function BuildingWindows({
  width,
  depth,
  height,
  seed = 0,
  accentColor,
  edgeColor,
  neonBrightness = 1.2,
  dimMul = 1,
}) {
  const atlas = getInteriorAtlas();

  // Geometry + per-pane instance data. Independent of palette/dim so a theme or
  // proximity-dim change doesn't rebuild the (potentially hundreds of) panes.
  const built = useMemo(() => {
    if (!atlas) return null;
    const windows = computeWindowGrid({ width, depth, height, seed });
    if (windows.length === 0) return null;

    const size = INTERIOR_WINDOW.size;
    const geo = new THREE.PlaneGeometry(size, size);
    const count = windows.length;
    const ids = new Float32Array(count * 3);
    const lods = new Float32Array(count).fill(1);
    const fades = new Float32Array(count).fill(1);
    const matrices = new Array(count);

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const v = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    windows.forEach((w, i) => {
      e.set(0, w.rotationY, 0);
      q.setFromEuler(e);
      v.set(w.position[0], w.position[1], w.position[2]);
      m.compose(v, q, one);
      matrices[i] = m.clone();
      ids[i * 3] = w.windowId[0];
      ids[i * 3 + 1] = w.windowId[1];
      ids[i * 3 + 2] = w.windowId[2];
    });

    geo.setAttribute('instanceWindowId', new THREE.InstancedBufferAttribute(ids, 3));
    geo.setAttribute('instanceLod', new THREE.InstancedBufferAttribute(lods, 1));
    geo.setAttribute('instanceFade', new THREE.InstancedBufferAttribute(fades, 1));
    return { geo, matrices, count };
  }, [atlas, width, depth, height, seed]);

  // Palette-driven material — emissiveVariation gives per-window lit/unlit and
  // warm/cool rooms, with the cool tone pulled toward the building's neon accent
  // so the windows stay in-family with the rest of the scene.
  const material = useMemo(() => {
    if (!atlas) return null;
    const nb = neonBrightness;
    return new InteriorMappingMaterial({
      backAtlas: atlas,
      backAtlasCols: ATLAS_COLS,
      backAtlasRows: ATLAS_ROWS,
      planeSize: new THREE.Vector2(INTERIOR_WINDOW.size, INTERIOR_WINDOW.size),
      instanced: true,
      depth: 0.7,
      backScale: 0.6,
      roughness: 0.18,
      metalness: 0,
      transparent: true,
      glassFresnelStrength: 0.35,
      glassFresnelColor: emissiveColor(mixHex('#e8f0ff', accentColor, 0.2), 1),
      emissiveVariation: {
        litRatio: 0.55,
        warm: emissiveColor(mixHex('#ffd9a8', accentColor, 0.1), 1.6 * nb),
        cool: emissiveColor(accentColor, 1.4 * nb),
        coolChance: 0.5,
        brightMin: 0.35,
        brightRange: 0.5,
        dim: emissiveColor(edgeColor, 0.08),
      },
    });
  }, [atlas, accentColor, edgeColor, neonBrightness]);

  const mesh = useMemo(() => {
    if (!built || !material) return null;
    const im = new THREE.InstancedMesh(built.geo, material, built.count);
    for (let i = 0; i < built.count; i++) im.setMatrixAt(i, built.matrices[i]);
    im.instanceMatrix.needsUpdate = true;
    // Derive the bounding sphere from the instance matrices (the geometry's own
    // sphere is a single pane at the origin) so off-screen towers still cull.
    im.computeBoundingSphere();
    return im;
  }, [built, material]);

  // Proximity dim scales each pane's output alpha via instanceFade — done live so
  // a dim toggle never rebuilds the mesh. Re-applied whenever the mesh is rebuilt
  // too, since a fresh InstancedMesh starts with every fade at 1.
  useEffect(() => {
    if (!mesh) return;
    const attr = mesh.geometry.getAttribute('instanceFade');
    for (let i = 0; i < attr.count; i++) attr.setX(i, dimMul);
    attr.needsUpdate = true;
  }, [mesh, dimMul]);

  // R3F only auto-disposes objects it created via JSX; these are built
  // imperatively, so free their GPU buffers on replace/unmount ourselves. The
  // mesh is recreated whenever the material is rebuilt (theme/brightness change),
  // so its instanceMatrix buffer must be freed too — <primitive> won't.
  useEffect(() => (mesh ? () => mesh.dispose() : undefined), [mesh]);
  useEffect(() => (built ? () => built.geo.dispose() : undefined), [built]);
  useEffect(() => (material ? () => material.dispose() : undefined), [material]);

  if (!mesh) return null;
  return <primitive object={mesh} />;
}
