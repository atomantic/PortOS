import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { findFfmpeg } from './ffmpeg.js';
import { sceneWipeCuts, transitionGlitchFrames, sceneTransitionSections } from './musicVideoTransitions.js';
import {
  MUSIC_VIDEO_WIPE_GROUPS, MUSIC_VIDEO_WIPES, compileWipeNode, musicVideoWipeFilter, sceneWipe, varyWipes, wipeDefinition, _wipePixel, wipeProgress,
} from './musicVideoWipes.js';

const ffmpeg = await findFfmpeg();
const FPS = 24;

// Shots at fractional times, so a cut rounds to its frame the way every player rounds it.
const shots = (count, extra = () => ({})) => Array.from({ length: count }, (_, i) => ({
  sceneId: `s${i}`, startSec: i * 1.37, endSec: (i + 1) * 1.37, ...extra(i),
}));

describe('sceneWipeCuts', () => {
  it('runs each wipe from its cut frame, with no drift over a long run of shots', () => {
    const scenes = shots(40, () => ({ wipeOut: { style: 'iris' } }));
    const cuts = sceneWipeCuts(scenes, FPS, { endSec: 40 * 1.37 });
    expect(cuts).toHaveLength(39);
    cuts.forEach((cut, i) => {
      expect(cut.cutFrame).toBe(Math.round((i + 1) * 1.37 * FPS));
      expect(cut.frames).toBe(6);
      expect(cut.fromSceneId).toBe(`s${i}`);
      expect(cut.toSceneId).toBe(`s${i + 1}`);
    });
  });

  it('never runs a wipe past the incoming shot, and keeps the length bounds', () => {
    const scenes = [
      { sceneId: 'a', startSec: 0, endSec: 1, wipeOut: { style: 'star', lengthSec: 2 } },
      { sceneId: 'b', startSec: 1, endSec: 1.2, wipeOut: { style: 'push-left', lengthSec: 0.001 } },
      { sceneId: 'c', startSec: 1.2, endSec: 3 },
    ];
    const cuts = sceneWipeCuts(scenes, FPS, { endSec: 3 });
    expect(cuts.map((cut) => cut.frames)).toEqual([Math.round(0.2 * FPS), 1]);
    expect(sceneWipe({ wipeOut: { style: 'star', lengthSec: 9 } }, 'out').lengthSec).toBe(2);
    expect(sceneWipe({ wipeOut: { style: 'star' } }, 'out').lengthSec).toBe(0.25);
  });

  it("gives the cut to the outgoing shot's choice, and never stacks a glitch on a wipe", () => {
    const scenes = [
      { sceneId: 'a', startSec: 0, endSec: 1, transitionOut: 'vhs-glitch' },
      { sceneId: 'b', startSec: 1, endSec: 2, wipeIn: { style: 'heart' }, wipeOut: { style: 'clock' } },
      { sceneId: 'c', startSec: 2, endSec: 3, transitionIn: 'vhs-glitch' },
      { sceneId: 'd', startSec: 3, endSec: 4, cutEffect: { enabled: true, style: 'dissolve' }, wipeOut: { style: 'iris' } },
      { sceneId: 'e', startSec: 4, endSec: 5 },
    ];
    const cuts = sceneWipeCuts(scenes, FPS, { endSec: 5 });
    // a→b: a's glitch out wins over b's wipe in; b→c: b's wipe out wins over c's glitch in;
    // d→e: d's dissolve owns the cut.
    expect(cuts.map((cut) => `${cut.fromSceneId}>${cut.toSceneId}:${cut.style}`)).toEqual(['b>c:clock']);
    const glitched = new Set(transitionGlitchFrames(sceneTransitionSections(scenes, FPS, { endSec: 5 })).map((g) => g.frame));
    expect(glitched.has(FPS)).toBe(true);
    expect([...glitched].some((frame) => frame >= 2 * FPS - 2 && frame <= 2 * FPS + 2)).toBe(false);
  });

  it('keeps projects without wipes unchanged', () => {
    expect(sceneWipeCuts(shots(5, () => ({ transitionOut: 'vhs-glitch' })), FPS)).toEqual([]);
  });
});

describe('wipe definitions', () => {
  const ASPECTS = [16 / 9, 9 / 16, 1];
  const grid = (fn) => {
    for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) fn((x + 0.5) / 24, (y + 0.5) / 24);
  };

  it.each(MUSIC_VIDEO_WIPES)('%s starts on the outgoing shot and ends covering the whole frame', (style) => {
    for (const aspect of ASPECTS) {
      const definition = wipeDefinition(style, aspect);
      const at = (p) => {
        const seen = { in: 0, out: 0, edge: 0, black: 0 };
        grid((u, v) => { seen[_wipePixel(definition, { u, v, p, aspect })] += 1; });
        return seen;
      };
      expect(at(0).out).toBe(24 * 24);
      // The last frame of the wipe (p just under 1) already shows only the incoming shot.
      expect(at(0.999).in).toBe(24 * 24);
      if (definition.kind === 'level') {
        const level = compileWipeNode(definition.level);
        grid((u, v) => expect(level({ u, v, a: aspect, p: 1 })).toBeLessThan(definition.top));
      }
    }
  });

  it('draws an edge only on shape wipes', () => {
    const shape = wipeDefinition('iris', 16 / 9);
    const pattern = wipeDefinition('checker', 16 / 9);
    const edges = (definition) => {
      let n = 0;
      grid((u, v) => { if (_wipePixel(definition, { u, v, p: 0.5, aspect: 16 / 9, edged: true }) === 'edge') n += 1; });
      return n;
    };
    expect(edges(shape)).toBeGreaterThan(0);
    expect(edges(pattern)).toBe(0);
  });
});

describe('varyWipes', () => {
  it('never repeats a style back to back, nor within a run while styles remain', () => {
    const run = varyWipes(60, { previous: 'iris', seed: 7 });
    expect(run).toHaveLength(60);
    expect(run[0]).not.toBe('iris');
    run.slice(1).forEach((style, i) => expect(style).not.toBe(run[i]));
    expect(new Set(run.slice(0, MUSIC_VIDEO_WIPES.length)).size).toBe(MUSIC_VIDEO_WIPES.length);
    expect(varyWipes(60, { previous: 'iris', seed: 7 })).toEqual(run);
  });

  it('keeps to the chosen styles', () => {
    const run = varyWipes(10, { styles: MUSIC_VIDEO_WIPE_GROUPS.shapes, seed: 3 });
    expect(run.every((style) => MUSIC_VIDEO_WIPE_GROUPS.shapes.includes(style))).toBe(true);
  });
});

// The render's filter against the definition every other player paints from.
describe.skipIf(!ffmpeg)('the final render paints the definition', () => {
  // Wide enough that the mask grid (a quarter of the width) resolves the narrow blinds.
  const [W, H, N] = [320, 180, 6];
  const classify = (r, g, b) => (r > 128 && g < 100 ? 'out' : b > 128 && g < 100 ? 'in' : g > 128 ? 'edge' : r + g + b < 120 ? 'black' : '?');
  it.each(['iris', 'paw', 'blinds-v', 'push-left', 'card-flip'])('%s', (style) => {
    const filters = musicVideoWipeFilter({ style, frames: N, color: '00ff00' }, { width: W, height: H, fps: FPS, outgoing: 'o0', incoming: 'i0', out: 'o', key: 't' });
    const graph = ['[0:v]format=yuv420p[o0]', '[1:v]format=yuv420p[i0]', ...filters, '[o]format=rgb24[r]'].join(';');
    const raw = execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `color=red:s=${W}x${H}:r=${FPS}:d=1`, '-f', 'lavfi', '-i', `color=blue:s=${W}x${H}:r=${FPS}:d=1`,
      '-filter_complex', graph, '-map', '[r]', '-f', 'rawvideo', '-'], { maxBuffer: 1e9 });
    // The wipe adds no frames: the incoming shot keeps its length.
    expect(raw.length / (W * H * 3)).toBe(FPS);
    const definition = wipeDefinition(style, W / H);
    const want = (k, x, y) => _wipePixel(definition, { u: (x + 0.5) / W, v: (y + 0.5) / H, p: k < N ? wipeProgress(k, N) : 1, aspect: W / H, edged: true });
    let checked = 0;
    let wrong = 0;
    for (let k = 0; k <= N; k++) {
      for (let y = 0; y < H; y += 6) {
        for (let x = 0; x < W; x += 6) {
          const expected = want(k, x, y);
          // Skip the soft line along a boundary, where the grid's smoothing blends the two.
          const near = [[5, 0], [-5, 0], [0, 5], [0, -5]].some(([dx, dy]) => {
            const xx = x + dx;
            const yy = y + dy;
            return xx >= 0 && yy >= 0 && xx < W && yy < H && want(k, xx, yy) !== expected;
          });
          if (near) continue;
          const o = ((k * H + y) * W + x) * 3;
          checked += 1;
          if (classify(raw[o], raw[o + 1], raw[o + 2]) !== expected) wrong += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(500);
    expect(wrong / checked).toBeLessThan(0.01);
  });
});
