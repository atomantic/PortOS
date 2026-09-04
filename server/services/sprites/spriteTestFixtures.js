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
 *
 * `writeCandidatePng` / `writeWalkFramePng` cache the Sharp-encoded buffer
 * per unique pixel config so atlas/walk/reference suites don't re-encode the
 * same 64×64 (or 40×40) fixture for every candidate and walk frame.
 */
import { join } from 'path';
import sharp from 'sharp';
import { mkdir, writeFile } from 'fs/promises';
import { SPRITE_DIRECTIONS } from './prompts.js';

/**
 * Cap libvips at one thread per call, for a suite whose images are all tiny.
 * Returns the restore function the caller MUST hand to `afterAll`.
 *
 * Every sprite fixture and every compiled atlas cell is a 40–192px image, so a
 * Sharp call's cost is its per-call overhead, not its pixel count — and the
 * thread pool's setup/join IS most of that overhead at this size. CI already
 * saturates each runner with several Vitest workers, so the pool only
 * oversubscribes the box on top of that; the sprite suites measured markedly
 * less system time with it capped (#6004).
 *
 * `sharp.concurrency` reaches past the module graph into libvips itself, so it
 * is PROCESS state: Vitest resets the module registry between files but reuses
 * the worker process, and an uncapped setting would otherwise stick to every
 * later file in that worker — including the imageGen suites that raster
 * 700–1200px images near their hook timeout. Hence the restore, and hence
 * calling this from a suite rather than running it on import.
 */
export function capSharpThreads() {
  const previous = sharp.concurrency();
  sharp.concurrency(1);
  return () => sharp.concurrency(previous);
}

// Sharp PNG encoding is the expensive part; the same raw pixels show up in
// dozens of tests. Cache the encoded buffer per unique pixel config and
// `writeFile` it — still a real PNG, just not re-encoded every time.
const candidatePngCache = new Map();
const walkFramePngCache = new Map();

function candidateCacheKey({
  bg = { r: 255, g: 0, b: 255 },
  fg = { r: 23, g: 107, b: 101 },
  rect = { x0: 20, x1: 30, y0: 10, y1: 40 },
} = {}) {
  return JSON.stringify({ bg, fg, rect });
}

async function encodeCandidatePng(opts = {}) {
  const key = candidateCacheKey(opts);
  const hit = candidatePngCache.get(key);
  if (hit) return hit;
  const {
    bg = { r: 255, g: 0, b: 255 },
    fg = { r: 23, g: 107, b: 101 },
    rect = { x0: 20, x1: 30, y0: 10, y1: 40 },
  } = opts;
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
  const png = await sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
  candidatePngCache.set(key, png);
  return png;
}

// A green/teal character rectangle on a magenta background — the legacy
// Pioneer shape, so auto chroma-key selection keeps magenta.
export async function writeCandidatePng(path, opts = {}) {
  const png = await encodeCandidatePng(opts);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, png);
}

/**
 * Transparent 40×40 RGBA frame with an opaque 20×30 figure.
 *
 * `armX` (optional) adds a protruding block at that column — a stand-in for a
 * swinging limb, so a direction's frames differ in SILHOUETTE and not just in
 * tint. Registration bugs (#3021) only show up across differing silhouettes:
 * with the identical-shape default, every placement rule agrees and an
 * inter-cell assertion would pass vacuously.
 *
 * `speck` paints a lone opaque pixel below the sole — the despill survivor /
 * dropped shadow that used to drag the whole frame's grounding down with it.
 */
export async function writeWalkFramePng(path, tint, armX = null, speck = false) {
  const key = `${tint}|${armX}|${speck}`;
  let png = walkFramePngCache.get(key);
  if (!png) {
    const w = 40; const h = 40;
    const buf = Buffer.alloc(w * h * 4);
    for (let y = 5; y < 35; y++) {
      for (let x = 10; x < 30; x++) {
        buf.set([tint, 107, 101, 255], (y * w + x) * 4);
      }
    }
    if (armX !== null) {
      for (let y = 12; y < 20; y++) {
        for (let x = armX; x < armX + 6; x++) buf.set([tint, 107, 101, 255], (y * w + x) * 4);
      }
    }
    if (speck) buf.set([tint, 107, 101, 255], (35 * w + 20) * 4);
    png = await sharp(buf, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
    walkFramePngCache.set(key, png);
  }
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, png);
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
 * Assert that `prompt` carries the re-roll correction for `note` (#3216).
 *
 * The routing suites (reference / walk / animationTrackWorkflow / assetPrompt /
 * trackPrompts) are proving that a note reached the builder — NOT what the clause
 * says. They used to each hardcode the full sentence, so a wording change was a
 * six-file edit and the copies drifted. `prompts.js` owns the wording and
 * `prompts.test.js` pins it; everyone else routes through here.
 *
 * Both halves are checked because half a sandwich is the #3216 bug.
 *
 * The assertions stay medium-neutral on purpose: callers span still-image
 * surfaces (reference) and image-to-video ones (walk / tracks), whose wording
 * legitimately differs — a video correction must not tell the model to keep
 * everything identical to the source still. `prompts.test.js` pins each medium.
 */
export function expectCarriesCorrection(expect, prompt, note) {
  const sentence = /[.!?]$/.test(note) ? note : `${note}.`;
  expect(prompt).toContain(`Required fix: ${sentence} Make that fix in the`);
  expect(prompt).toContain(`instruction above): ${sentence}`);
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
 *
 * Deliberately kept as its own literal rather than re-exporting the now-shipped
 * `ANIMATION_TRACKS.ambient`: the injected-table tests exist to prove callers
 * read the row they were HANDED, and sourcing the fixture from the shipped table
 * would let a caller that secretly reads the global registry pass anyway.
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
  // #3136 workflow shape. Its on-disk kinds must not collide with any other row
  // this fixture is combined with, and it is `place`/`object`'s standalone
  // baseline — those kinds have no walk, so this is what they publish off.
  selectionKind: 'reviewed-single-row-ambient-selection',
  setKind: 'finalized-single-row-ambient-set',
  finalErrorCode: 'AMBIENT_SET_FINAL',
  standaloneContract: true,
  // #3152 — `builtin: true` because this fixture stands in for a COMPILED row in
  // the injected-table tests: those exercise the readers' row-handling, not the
  // store's loading, and a `builtin: false` row would additionally have to carry
  // a `promptTemplate` (which `assertAnimationTrackRows` requires of a stored row)
  // for reasons that have nothing to do with what they assert. The store's own
  // user-defined-row shape is exercised in `animationTrackStore.test.js`.
  builtin: true,
});

/**
 * A well-formed USER-DEFINED track row for the store (#3152) — every field
 * `assertAnimationTrackRows` requires of a stored row and nothing more, including
 * the `promptTemplate` a stored row must carry (a compiled row must not).
 *
 * Distinct from `AMBIENT_TRACK_ROW` above, which stands in for a COMPILED row in
 * the injected-table tests. This one is what a user actually authors, and it is
 * shared because #3152 alone added two required row fields — a per-suite literal
 * means the next such change updates one copy and leaves the other suite green on
 * a stale shape.
 *
 * `overrides` is shallow-merged, so a second row in one table renames the fields
 * that must be unique (`id`, `contractFrameCountField`, `selectionKind`, `setKind`,
 * `finalErrorCode`) without restating the rest.
 */
export const storedTrackRow = (overrides = {}) => ({
  id: 'chest-opening',
  label: 'Chest opening',
  directional: false,
  kinds: ['object'],
  minFrameCount: 2,
  maxFrameCount: 8,
  defaultFrameCount: 4,
  minFps: 2,
  maxFps: 12,
  defaultFps: 6,
  contractFrameCountField: 'chestOpeningFrameCount',
  contractFpsField: null,
  selectionKind: 'reviewed-chest-opening-selection',
  setKind: 'finalized-chest-opening-set',
  finalErrorCode: 'CHEST_OPENING_SET_FINAL',
  standaloneContract: true,
  promptTemplate: 'Animate the {{kind}} {{name}} opening once, then hold. Matte on {{chromaKeyPhrase}}.',
  ...overrides,
});

/**
 * Write a track store under a suite's TEST_ROOT, in the on-disk shape
 * `animationTrackStore.js` reads.
 *
 * Accepts either an array of rows or a raw string (for the malformed-JSON cases),
 * so the sentinel tests and the happy path share one writer. Callers must still
 * call `__resetAnimationTrackStore()` — the store caches per process, and making
 * this helper do it would hide the restart boundary the tests exist to assert.
 */
export async function writeAnimationTrackStore(testRoot, tracks) {
  await mkdir(join(testRoot, 'sprites'), { recursive: true });
  await writeFile(
    join(testRoot, 'sprites', 'animation-tracks.json'),
    typeof tracks === 'string' ? tracks : `${JSON.stringify({ schemaVersion: 1, tracks }, null, 2)}\n`,
  );
}
