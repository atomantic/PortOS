import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  REACTOR_MAX_PROMPT_LENGTH, REACTOR_CLIP_FPS, REACTOR_MIN_CLIP_SECONDS,
  REACTOR_MAX_CLIP_SECONDS, REACTOR_CLIP_LENGTHS, REACTOR_DEFAULT_CLIP_LENGTH,
  REACTOR_CANVASES, REACTOR_ASPECTS, REACTOR_DEFAULT_ASPECT,
  reactorCanvas, nearestReactorAspect,
  reactorClipLengthLabel,
} from './reactorVideoClip.js';

describe('reactorVideoClip', () => {
  it('offers only lengths fast-h3 accepts, in ascending order', () => {
    expect(Object.isFrozen(REACTOR_CLIP_LENGTHS)).toBe(true);
    expect([...REACTOR_CLIP_LENGTHS]).toEqual([...REACTOR_CLIP_LENGTHS].sort((a, b) => a - b));
    for (const seconds of REACTOR_CLIP_LENGTHS) {
      expect(seconds).toBeGreaterThanOrEqual(REACTOR_MIN_CLIP_SECONDS);
      expect(seconds).toBeLessThanOrEqual(REACTOR_MAX_CLIP_SECONDS);
    }
    expect(REACTOR_CLIP_LENGTHS).toContain(REACTOR_MIN_CLIP_SECONDS);
    expect(REACTOR_CLIP_LENGTHS).toContain(REACTOR_MAX_CLIP_SECONDS);
    expect(REACTOR_CLIP_LENGTHS).toContain(REACTOR_DEFAULT_CLIP_LENGTH);
  });

  // The whole reason a picker replaced a free-text seconds box is that every
  // offered value has to be one the API can actually render. Anything between
  // the endpoints must land on a whole frame at 24fps.
  it('offers only frame-aligned interior lengths', () => {
    const interior = REACTOR_CLIP_LENGTHS
      .filter((s) => s !== REACTOR_MIN_CLIP_SECONDS && s !== REACTOR_MAX_CLIP_SECONDS);
    expect(interior.length).toBeGreaterThan(0);
    for (const seconds of interior) {
      expect(Number.isInteger(seconds * REACTOR_CLIP_FPS)).toBe(true);
    }
    expect(Number.isInteger(REACTOR_MAX_CLIP_SECONDS * REACTOR_CLIP_FPS)).toBe(true);
  });

  // fast-h3 renders at a 768px short edge on every canvas, so a canvas whose
  // short edge drifted would be a resolution PortOS asks for and the API does
  // not render.
  it('offers only canvases fast-h3 renders, each on a 768px short edge', () => {
    expect(REACTOR_ASPECTS).toEqual(['16:9', '4:3', '1:1', '9:16']);
    for (const canvas of REACTOR_CANVASES) {
      expect(Math.min(canvas.width, canvas.height)).toBe(768);
      expect(canvas.label).toContain(`${canvas.width}\u00d7${canvas.height}`);
    }
    expect(REACTOR_ASPECTS).toContain(REACTOR_DEFAULT_ASPECT);
    expect(reactorCanvas('9:16')).toMatchObject({ width: 768, height: 1344 });
  });

  // The whole bug: a portrait starting frame used to open a 1344x768 session.
  it('derives the canvas closest to a starting frame, and never guesses one it cannot measure', () => {
    expect(nearestReactorAspect(3024, 4032)).toBe('9:16');
    expect(nearestReactorAspect(1080, 1920)).toBe('9:16');
    expect(nearestReactorAspect(1920, 1080)).toBe('16:9');
    expect(nearestReactorAspect(1000, 1000)).toBe('1:1');
    expect(nearestReactorAspect(1600, 1200)).toBe('4:3');
    for (const bad of [[0, 100], [100, 0], [NaN, 100], [undefined, undefined], [-16, -9]]) {
      expect(nearestReactorAspect(...bad)).toBe(REACTOR_DEFAULT_ASPECT);
    }
  });

  // An unknown aspect must land on a real canvas rather than `undefined`, or
  // the caller reads `.width` off nothing while fitting a frame.
  it('falls back to the default canvas for an aspect it does not render', () => {
    expect(reactorCanvas('21:9')).toMatchObject({ aspect: REACTOR_DEFAULT_ASPECT });
    expect(reactorCanvas(undefined)).toMatchObject({ aspect: REACTOR_DEFAULT_ASPECT });
  });

  it('names the endpoints so the odd numbers read as bounds, not typos', () => {
    expect(reactorClipLengthLabel(REACTOR_MIN_CLIP_SECONDS)).toBe('5.167 seconds (min)');
    expect(reactorClipLengthLabel(REACTOR_MAX_CLIP_SECONDS)).toBe('14.375 seconds (max)');
    expect(reactorClipLengthLabel(8)).toBe('8 seconds');
  });
});

// scripts/reactor-render.py opens the session and cannot import this module, so
// its canvas table is a hand-written copy — the "kept in sync by a comment"
// shape. A canvas added here and not there fails at `set_canvas` AFTER a paid
// session is already open; one removed here and not there renders on a canvas
// the picker no longer offers.
describe('reactorVideoClip renderer mirror', () => {
  it('matches the canvas table in scripts/reactor-render.py', async () => {
    const source = await readFile(fileURLToPath(new URL('../../scripts/reactor-render.py', import.meta.url)), 'utf8');
    const table = source.match(/^CANVASES = \{(.+)\}$/m);
    expect(table, 'CANVASES table not found in scripts/reactor-render.py').toBeTruthy();
    const entries = [...table[1].matchAll(/"([^"]+)": \((\d+), (\d+)\)/g)]
      .map(([, aspect, width, height]) => ({ aspect, width: Number(width), height: Number(height) }));
    expect(entries).toEqual(REACTOR_CANVASES.map(({ aspect, width, height }) => ({ aspect, width, height })));
    expect(source).toMatch(new RegExp(`^DEFAULT_ASPECT = "${REACTOR_DEFAULT_ASPECT}"$`, 'm'));
  });
});

describe('reactorVideoClip client mirror', () => {
  it('matches client/src/lib/reactorVideoClip.js', async () => {
    // The VideoGen prompt counter and clip-length picker build from the client
    // mirror, which can't import server code. Without this guard the form could
    // go on accepting an 800+ character prompt the API rejects, or offering a
    // clip length the service refuses — exactly the drift that made a long
    // prompt fail at Generate instead of in the field.
    const clientMirror = await import('../../client/src/lib/reactorVideoClip.js');
    expect(clientMirror.REACTOR_MAX_PROMPT_LENGTH).toBe(REACTOR_MAX_PROMPT_LENGTH);
    expect(clientMirror.REACTOR_MIN_CLIP_SECONDS).toBe(REACTOR_MIN_CLIP_SECONDS);
    expect(clientMirror.REACTOR_MAX_CLIP_SECONDS).toBe(REACTOR_MAX_CLIP_SECONDS);
    expect(clientMirror.REACTOR_DEFAULT_CLIP_LENGTH).toBe(REACTOR_DEFAULT_CLIP_LENGTH);
    expect([...clientMirror.REACTOR_CLIP_LENGTHS]).toEqual([...REACTOR_CLIP_LENGTHS]);
    for (const seconds of REACTOR_CLIP_LENGTHS) {
      expect(clientMirror.reactorClipLengthLabel(seconds)).toBe(reactorClipLengthLabel(seconds));
    }
    // The canvas picker builds from the mirror, so a canvas that drifted would
    // offer a resolution the service refuses (or omit one it renders).
    expect(clientMirror.REACTOR_DEFAULT_ASPECT).toBe(REACTOR_DEFAULT_ASPECT);
    expect([...clientMirror.REACTOR_ASPECTS]).toEqual([...REACTOR_ASPECTS]);
    expect(clientMirror.REACTOR_CANVASES.map((c) => ({ ...c })))
      .toEqual(REACTOR_CANVASES.map((c) => ({ ...c })));
    for (const [w, h] of [[3024, 4032], [1920, 1080], [768, 768], [0, 0]]) {
      expect(clientMirror.nearestReactorAspect(w, h)).toBe(nearestReactorAspect(w, h));
    }
  });
});
