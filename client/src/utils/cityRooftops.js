// Pure, deterministic helpers for CyberCity's rooftop fixtures: small antennas, water
// tanks, AC units, and dish arrays scattered on app-building roofs so the skyline reads
// as a lived-in game city instead of bare boxes. Fixtures are seeded from the app name
// (same determinism as the procedural window textures in Building.jsx) so a building
// keeps its roof across refetches, theme switches, and installs. No three.js / React
// imports so the kit is unit-testable (mirrors cityTaskQueue.js etc.).

import { hashString } from './hashString';

export const ROOFTOP_TYPES = ['antenna', 'tank', 'ac', 'dish'];

const MAX_FIXTURES = 3;
const EDGE_MARGIN = 0.45; // keep fixtures off the roof edge (relative to a width-2 roof)

// Successive bit-slices of the name hash drive each pick — cheap, allocation-free
// determinism without a generator.
const pick = (hash, shift, mod) => Math.abs(hash >> shift) % mod;

// 0–3 fixtures for a roof of `width`×`width` (buildings are square). Positions are
// offsets from the roof center; `scale` tracks the building width so kits read
// proportionate on the rare wider structure.
export function computeRooftopKit(name, width = 2) {
  const hash = hashString(String(name || ''));
  const count = pick(hash, 0, MAX_FIXTURES + 1); // 0..3 — some roofs stay bare
  const half = Math.max(0.2, width / 2 - EDGE_MARGIN);
  const fixtures = [];
  for (let i = 0; i < count; i++) {
    const shift = 3 + i * 7;
    const type = ROOFTOP_TYPES[pick(hash, shift, ROOFTOP_TYPES.length)];
    // Two more slices position the fixture on a 5×5 roof grid (deterministic, clamped).
    const gx = pick(hash, shift + 2, 5) / 4 - 0.5; // -0.5..0.5
    const gz = pick(hash, shift + 4, 5) / 4 - 0.5;
    fixtures.push({
      type,
      x: gx * 2 * half,
      z: gz * 2 * half,
      scale: 0.8 + pick(hash, shift + 5, 3) * 0.2, // 0.8 / 1.0 / 1.2
      rotation: pick(hash, shift + 6, 8) * (Math.PI / 4),
    });
  }
  // Two fixtures on the same grid cell read as one mangled prop — drop duplicates.
  const seen = new Set();
  return fixtures.filter((f) => {
    const key = `${Math.round(f.x * 10)},${Math.round(f.z * 10)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
