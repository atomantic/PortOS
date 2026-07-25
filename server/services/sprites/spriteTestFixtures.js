/**
 * Shared fixture helpers for the sprite test suites (reference.test.js,
 * walk.test.js, atlas.test.js, atlasGrid.test.js, atlasLayout.test.js,
 * publish.test.js). The candidate-writing helpers are parameterized on the
 * calling suite's TEST_ROOT rather than closing over a module-level constant,
 * so every suite keeps its own tmpdir and isolation.
 *
 * The grid fixtures at the bottom are here because four suites were each
 * spelling out the same track-span shape and two were spelling out the same
 * synthetic registry row: a new span field (or a new required registry field)
 * would otherwise be a six-file edit, and any file that missed it would go
 * green on a stale shape.
 */
import { join } from 'path';
import sharp from 'sharp';
import { mkdir, writeFile } from 'fs/promises';
import { SPRITE_DIRECTIONS } from './prompts.js';

// A green/teal character rectangle on a magenta background — the legacy
// Pioneer shape, so auto chroma-key selection keeps magenta.
export async function writeCandidatePng(path, {
  bg = { r: 255, g: 0, b: 255 },
  fg = { r: 23, g: 107, b: 101 },
  rect = { x0: 20, x1: 30, y0: 10, y1: 40 },
} = {}) {
  const w = 64; const h = 64;
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inRect = x >= rect.x0 && x < rect.x1 && y >= rect.y0 && y < rect.y1;
      const c = inRect ? fg : bg;
      const i = (y * w + x) * 3;
      buf[i] = c.r; buf[i + 1] = c.g; buf[i + 2] = c.b;
    }
  }
  await mkdir(join(path, '..'), { recursive: true });
  await sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png().toFile(path);
}

export async function placeCandidate(testRoot, recordId, target, name, opts = {}) {
  const candDir = join(testRoot, 'sprites', recordId, 'reference', 'candidates');
  await writeCandidatePng(join(candDir, name), opts);
  await writeFile(join(candDir, `${name.replace(/\.png$/, '')}.generation.json`), JSON.stringify({
    schemaVersion: 1, target, chromaKey: opts.sidecarKey ?? '#FF00FF',
  }));
  return `reference/candidates/${name}`;
}

// Locks the turnaround sheet, then 'main', then every other direction in
// `directions` — the shape shared by walk.test.js's characterWithLockedAnchors
// and atlas.test.js's lockAllAnchors (which only differ in which directions
// they pass and how they name/create the character beforehand). The turnaround
// comes first because anchors are gated on it (#2979).
export async function lockAllAnchors(testRoot, recordId, { lockReference, directions }) {
  await lockReference(recordId, {
    target: 'turnaround',
    candidate: await placeCandidate(testRoot, recordId, 'turnaround', 'turnaround-candidate-01.png'),
  });
  await lockReference(recordId, {
    target: 'main',
    candidate: await placeCandidate(testRoot, recordId, 'main', 'walk-south-candidate-01.png'),
  });
  for (const dir of directions.filter((d) => d !== 'south')) {
    await lockReference(recordId, {
      target: dir,
      candidate: await placeCandidate(testRoot, recordId, dir, `walk-${dir}-candidate-01.png`),
    });
  }
}

/**
 * A track's column span as `buildAtlasGrid` and the layout sidecar emit it.
 * `rows` defaults to the full grid height, which is what every shipped track
 * (walk, idle) and every grid compiled before #3017 has — spelled out rather
 * than omitted so a span that quietly lost its row count reads as a failure.
 */
export const trackSpan = (start, count, rows = SPRITE_DIRECTIONS.length) => ({ start, count, rows });

/**
 * A synthetic NON-directional registry row (#3017), shaped like an ambient
 * loop: a tree moving in the wind, water, a flickering lamp. Three frames —
 * below walk's floor of 6 — and no facing at all, so it occupies row 0 and
 * leaves the other seven transparent. It lists `place`/`object`, the record
 * kinds that had no animation path whatsoever before the gate became registry
 * data.
 *
 * Synthetic on purpose: the shipped registry's only track is directional and
 * character-only, so a test written against it alone could not tell "reads the
 * row" from "hardcodes 8 / hardcodes 'character'". Same injected-table idiom
 * `assertAnimationTrackRows(tracks)` uses. Shipping the real row is #3045.
 */
export const AMBIENT_TRACK_ROW = Object.freeze({
  id: 'ambient',
  label: 'Ambient loop',
  directional: false,
  kinds: Object.freeze(['place', 'object']),
  minFrameCount: 2,
  maxFrameCount: 6,
  defaultFrameCount: 3,
  minFps: 2,
  maxFps: 12,
  defaultFps: 4,
  contractFrameCountField: 'ambientFrameCount',
  contractFpsField: null,
});
