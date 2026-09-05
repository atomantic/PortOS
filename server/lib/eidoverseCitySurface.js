/** Deterministic paving and physical signs, uploaded through Eidoverse's GLB door. */
import { createHash } from 'node:crypto';
import { eidoverseDistrictPoint, eidoverseDistrictYaw } from './eidoverseCityLayout.js';

// A small architectural stencil. Geometry, not a font download or raster asset.
const GLYPHS = {
  A: '01110/10001/10001/11111/10001/10001/10001', B: '11110/10001/10001/11110/10001/10001/11110',
  C: '01111/10000/10000/10000/10000/10000/01111', D: '11110/10001/10001/10001/10001/10001/11110',
  E: '11111/10000/10000/11110/10000/10000/11111', F: '11111/10000/10000/11110/10000/10000/10000',
  G: '01111/10000/10000/10111/10001/10001/01111', H: '10001/10001/10001/11111/10001/10001/10001',
  I: '11111/00100/00100/00100/00100/00100/11111', J: '00111/00010/00010/00010/10010/10010/01100',
  K: '10001/10010/10100/11000/10100/10010/10001', L: '10000/10000/10000/10000/10000/10000/11111',
  M: '10001/11011/10101/10101/10001/10001/10001', N: '10001/11001/10101/10011/10001/10001/10001',
  O: '01110/10001/10001/10001/10001/10001/01110', P: '11110/10001/10001/11110/10000/10000/10000',
  Q: '01110/10001/10001/10001/10101/10010/01101', R: '11110/10001/10001/11110/10100/10010/10001',
  S: '01111/10000/10000/01110/00001/00001/11110', T: '11111/00100/00100/00100/00100/00100/00100',
  U: '10001/10001/10001/10001/10001/10001/01110', V: '10001/10001/10001/10001/10001/01010/00100',
  W: '10001/10001/10001/10101/10101/10101/01010', X: '10001/10001/01010/00100/01010/10001/10001',
  Y: '10001/10001/01010/00100/00100/00100/00100', Z: '11111/00001/00010/00100/01000/10000/11111',
  '-': '00000/00000/00000/11111/00000/00000/00000',
};

const linearColor = (hex) => [1, 3, 5].map((start) => {
  const s = parseInt(hex.slice(start, start + 2), 16) / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
});

function surfaceGeometry(districts) {
  const groups = [{ positions: [], normals: [], colors: [], indices: [] },
    { positions: [], normals: [], colors: [], indices: [] }];
  let districtFrame = null;
  const quad = (points, normal, color, material = 0) => {
    if (districtFrame) {
      points = points.map(([x, y, z]) => eidoverseDistrictPoint(districtFrame, x, y, z));
      const yaw = eidoverseDistrictYaw(districtFrame);
      normal = [Math.cos(yaw) * normal[0] + Math.sin(yaw) * normal[2], normal[1], -Math.sin(yaw) * normal[0] + Math.cos(yaw) * normal[2]];
    }
    const group = groups[material];
    const start = group.positions.length / 3;
    const rgb = linearColor(color);
    for (const point of points) {
      group.positions.push(...point); group.normals.push(...normal); group.colors.push(...rgb);
    }
    group.indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
  };
  const floor = (x0, z0, x1, z1, y, color) => quad(
    [[x0, y, z0], [x0, y, z1], [x1, y, z1], [x1, y, z0]], [0, 1, 0], color);
  const sign = (x0, y0, x1, y1, z, color) => quad(
    [[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]], [0, 0, 1], color, 1);
  const ring = (cx, cz, inner, outer, y, color, steps = 96) => {
    for (let i = 0; i < steps; i += 1) {
      const a = i / steps * Math.PI * 2, b = (i + 1) / steps * Math.PI * 2;
      quad([[cx + Math.sin(a) * inner, y, cz + Math.cos(a) * inner],
        [cx + Math.sin(a) * outer, y, cz + Math.cos(a) * outer],
        [cx + Math.sin(b) * outer, y, cz + Math.cos(b) * outer],
        [cx + Math.sin(b) * inner, y, cz + Math.cos(b) * inner]], [0, 1, 0], color);
    }
  };
  // A shared pedestrian promenade encircles the grassy arrival park.
  ring(0, 0, 27.7, 32.3, 0.015, '#dad3bd');
  ring(0, 0, 28, 32, 0.02, '#b7b59f');
  for (const district of districts) {
    districtFrame = district;
    const x = 0, y = 0, z = 0;
    // Rounded forecourts leave planted ground between neighboring halls.
    ring(0, 3, 0, 10.8, 0.018, '#d0c7b1', 48);
    floor(-8.4, -12.4, 8.4, -3.4, 0.02, '#d0c7b1');
    const distance = Math.hypot(district.anchor[0], district.anchor[2]);
    floor(-1.8, 3, 1.8, Math.max(4, distance - 30), 0.025, '#e1d9c3');
    // Low flower beds and timber seats frame the gathering terrace.
    for (const side of [-1, 1]) {
      ring(side * 8.5, 7, 0, 1.6, 0.03, '#527449', 20);
      for (let flower = 0; flower < 12; flower += 1) {
        const angle = flower / 12 * Math.PI * 2;
        ring(side * 8.5 + Math.sin(angle), 7 + Math.cos(angle), 0, 0.16, 0.09,
          flower % 2 ? '#e5c677' : district.accent, 6);
      }
      floor(side * 6 - 1.2, 7, side * 6 + 1.2, 7.6, 0.48, '#977654');
      sign(side * 6 - 1.2, 0.48, side * 6 + 1.2, 0.95, 7.62, '#977654');
      sign(side * 6 - 1, 0, side * 6 - 0.85, 0.48, 7.3, '#4a5147');
      sign(side * 6 + 0.85, 0, side * 6 + 1, 0.48, 7.3, '#4a5147');
    }
    const text = String(district.label).toUpperCase().replace(/[^A-Z -]/g, '').slice(0, 24);
    const cell = Math.min(0.12, 12 / Math.max(1, text.length * 6));
    const width = text.length * 6 * cell;
    const bottom = y + (district.id === 'nexus' ? 4.05 : 2.75);
    const faceZ = z - 3.86;
    sign(x - width / 2 - 0.35, bottom - 0.15, x + width / 2 + 0.35, bottom + 7 * cell + 0.15, faceZ, '#172c3e');
    sign(x - width / 2 - 0.35, bottom - 0.22, x + width / 2 + 0.35, bottom - 0.16, faceZ + 0.002, district.accent);
    [...text].forEach((letter, index) => {
      for (const [row, bits] of (GLYPHS[letter] || '').split('/').entries()) {
        for (const [column, bit] of [...bits].entries()) {
          if (bit !== '1') continue;
          const left = x - width / 2 + (index * 6 + column) * cell;
          const base = bottom + (6 - row) * cell;
          sign(left, base, left + cell * 0.9, base + cell * 0.9, faceZ + 0.005, '#e3f4ef');
        }
      }
    });
  }
  districtFrame = null;
  return groups;
}

/** Minimal standard glTF 2.0: two meshes, vertex colors, no external resources. */
export function buildEidoverseCitySurface(districts) {
  if (!Array.isArray(districts) || !districts.length || districts.length > 12
    || districts.some(({ anchor }) => !Array.isArray(anchor) || anchor.length !== 3
      || anchor.some((n) => !Number.isFinite(n) || Math.abs(n) > 10_000))) {
    throw new RangeError('City districts need finite anchors within 10,000 metres.');
  }
  const ordered = [...districts].sort((a, b) => a.id.localeCompare(b.id));
  const geometry = surfaceGeometry(ordered);
  const chunks = [], bufferViews = [], accessors = [];
  let byteOffset = 0;
  const attribute = (values, components, integer = false) => {
    const bytes = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => integer ? bytes.writeUInt32LE(value, index * 4) : bytes.writeFloatLE(value, index * 4));
    const min = Array(components).fill(Infinity), max = Array(components).fill(-Infinity);
    values.forEach((value, index) => { const axis = index % components; const encoded = integer ? value : Math.fround(value); min[axis] = Math.min(min[axis], encoded); max[axis] = Math.max(max[axis], encoded); });
    chunks.push(bytes);
    bufferViews.push({ buffer: 0, byteOffset, byteLength: bytes.length, target: integer ? 34963 : 34962 });
    byteOffset += bytes.length;
    accessors.push({ bufferView: bufferViews.length - 1, componentType: integer ? 5125 : 5126,
      count: values.length / components, type: components === 1 ? 'SCALAR' : 'VEC3', min, max });
    return accessors.length - 1;
  };
  const meshes = geometry.map((group, material) => ({ primitives: [{
    attributes: { POSITION: attribute(group.positions, 3), NORMAL: attribute(group.normals, 3), COLOR_0: attribute(group.colors, 3) },
    indices: attribute(group.indices, 1, true), material,
  }] }));
  const gltf = { asset: { version: '2.0', generator: 'PortOS Commons' }, scene: 0,
    scenes: [{ nodes: [0, 1] }], nodes: [{ mesh: 0, name: 'Paving' }, { mesh: 1, name: 'District signs' }], meshes,
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 } },
      { pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 }, extensions: { KHR_materials_unlit: {} } }],
    extensionsUsed: ['KHR_materials_unlit'], buffers: [{ byteLength: byteOffset }], bufferViews, accessors };
  const json = Buffer.from(JSON.stringify(gltf));
  const jsonLength = Math.ceil(json.length / 4) * 4;
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4);
  header.writeUInt32LE(28 + jsonLength + byteOffset, 8);
  header.writeUInt32LE(jsonLength, 12); header.writeUInt32LE(0x4e4f534a, 16);
  const binHeader = Buffer.alloc(8); binHeader.writeUInt32LE(byteOffset, 0); binHeader.writeUInt32LE(0x004e4942, 4);
  const bytes = Buffer.concat([header, json, Buffer.alloc(jsonLength - json.length, 0x20), binHeader, ...chunks]);
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  return { bytes, path: `store/${hash}.glb`, fingerprint: hash };
}
