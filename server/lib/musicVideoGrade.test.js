import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findFfmpeg } from './ffmpeg.js';
import { musicVideoCompositionSchema } from './musicVideoValidation.js';
import { normalizeComposition } from '../services/musicVideo/composition.js';
import { musicVideoGradeFilter } from './musicVideoGrade.js';
import { _wipePixel, wipeDefinition, wipeProgress } from './musicVideoWipes.js';

const ffmpeg = await findFfmpeg();

// Serialization/validation boundary: no unbounded filter values from peers or PATCH.
describe('Music Video grade contract', () => {
  it('keeps legacy and explicit neutral manifests a true bypass and rejects invalid settings', () => {
    const sections = [{ sceneId: 'a', startSec: 0, endSec: 2 }];
    expect(normalizeComposition({ mode: 'composed' })).not.toHaveProperty('grade');
    expect(musicVideoGradeFilter(null, sections)).toBeNull();
    expect(musicVideoGradeFilter({ preset: 'neutral' }, sections)).toBeNull();
    for (const grade of [{ preset: 'injected-filter' }, { grain: 0.031 }, { grain: -1 }, { grain: Infinity }]) {
      expect(musicVideoCompositionSchema.safeParse({ grade }).success).toBe(false);
    }
    expect(normalizeComposition({ grade: { preset: 'unknown', grain: 100 } }).grade).toEqual({ preset: 'neutral', grain: 0.03, sections: [] });
    expect(musicVideoCompositionSchema.parse({ grade: { preset: 'teal-night', grain: 0.02 } }).grade.preset).toBe('teal-night');
  });
});

// Grade tables on real ffmpeg, against the per-pixel definition they replaced (#14853).
describe.skipIf(!ffmpeg)('grade tables', () => {
  const FPS = 24;
  const CURVES = { 'teal-night': [-0.22, 0.05, 0.2], 'golden-hour': [0.22, 0.07, -0.18], monochrome: [0, 0, 0] };
  // The frozen per-pixel definition: every table must stay within one code value of it.
  const perPixelGrade = ({ preset, grain }, { offsetSec = 0 } = {}) => {
    const noise = `(mod(pow(mod(X*73+Y*151+floor((T+${offsetSec})*${FPS}+0.5)*199,4093),2)*157,4093)/4093-0.5)`;
    const channels = ['r', 'g', 'b'].map((channel, i) => {
      const value = preset === 'monochrome' ? '(0.2126*r(X,Y)+0.7152*g(X,Y)+0.0722*b(X,Y))/255' : `${channel}(X,Y)/255`;
      return `${channel}='st(0,${value});255*clip(ld(0)+${CURVES[preset][i]}*ld(0)*(1-ld(0))+0.16*ld(0)*(1-ld(0))*(2*ld(0)-1)+${grain}*${noise}*4*ld(0)*(1-ld(0)),0,1)'`;
    });
    return `format=gbrp,geq=${channels.join(':')}`;
  };
  const rawFrames = (source, filter) => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', source, '-vf', filter, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1e9 });
  const worstDifference = (a, b) => {
    expect(a.length).toBe(b.length);
    return a.reduce((worst, value, i) => Math.max(worst, Math.abs(value - b[i])), 0);
  };
  const graded = (grade, frame, options = {}) => musicVideoGradeFilter(grade, [{ sceneId: 'a', startSec: 0, endSec: 1e6 }], { fps: FPS, frame, ...options });

  // Catches a swapped plane, a wrong curve or a noise code off the old hash.
  it.each([
    [{ preset: 'teal-night', grain: 0 }, 0],
    [{ preset: 'golden-hour', grain: 0.03 }, 0],
    [{ preset: 'monochrome', grain: 0 }, 0],
    [{ preset: 'monochrome', grain: 0.012 }, 0],
    [{ preset: 'teal-night', grain: 0.02 }, 0.5],
  ])('keeps %j at song offset %d within one code value of the per-pixel grade', (grade, offsetSec) => {
    const frame = { width: 160, height: 90 };
    const source = `testsrc2=s=160x90:r=${FPS}:d=0.5,format=rgb24`;
    expect(worstDifference(rawFrames(source, graded(grade, frame, { offsetSec })), rawFrames(source, perPixelGrade(grade, { offsetSec })))).toBeLessThanOrEqual(1);
  });

  // Catches a noise shift leaving the drawn plane, where crop would clamp and repeat grain.
  it('follows the noise through its whole 4093-frame cycle', () => {
    const grade = { preset: 'teal-night', grain: 0.03 };
    const source = `color=0x808080:s=24x12:r=${FPS}:d=${4100 / FPS},format=rgb24`;
    const raw = rawFrames(source, graded(grade, { width: 24, height: 12 }));
    expect(worstDifference(raw, rawFrames(source, perPixelGrade(grade)))).toBeLessThanOrEqual(1);
    expect(new Set(raw).size).toBeGreaterThan(3);
  });

  // Catches grain falling a frame behind where a filter upstream rounds time, as concat does to the
  // microsecond: a whole-film render would differ from the shot-by-shot one that has no concat.
  it('takes the nearest song frame\'s grain when a frame\'s time was rounded', () => {
    const frame = { width: 64, height: 36 };
    const grade = { preset: 'golden-hour', grain: 0.03 };
    const source = `testsrc2=s=64x36:r=${FPS}:d=1,format=rgb24`;
    expect(worstDifference(rawFrames(source, `settb=1/1000,${graded(grade, frame)}`), rawFrames(source, perPixelGrade(grade)))).toBeLessThanOrEqual(1);
  });

  // Catches a neutral image taking a colour cast, and the endpoints documents depend on.
  it('keeps monochrome neutral and preserves black and white', () => {
    const frame = { width: 16, height: 8 };
    const shown = (color, grain) => [...new Set(rawFrames(`color=${color}:s=16x8:r=${FPS}:d=0.25,format=rgb24`, graded({ preset: 'monochrome', grain }, frame)))];
    expect(shown('white', 0.03)).toEqual([255]);
    expect(shown('black', 0.03)).toEqual([0]);
    expect(shown('0xd02020', 0)).toHaveLength(1);
  });

  // Catches grain depending on where a render starts, which would make an excerpt differ from its export.
  it('draws identical grain in a full export and an excerpt, outside the grade too', () => {
    const frame = { width: 96, height: 54 };
    const source = `testsrc2=s=96x54:r=${FPS}:d=1,format=rgb24`;
    const grade = { preset: 'neutral', grain: 0.03, sections: [{ sceneId: 'a', preset: 'monochrome' }, { sceneId: 'b', preset: 'golden-hour' }] };
    const sections = [{ sceneId: 'a', startSec: 0, endSec: 0.25 }, { sceneId: 'b', startSec: 0.25, endSec: 0.5 }];
    const size = 96 * 54 * 3;
    const whole = rawFrames(source, musicVideoGradeFilter(grade, sections, { fps: FPS, frame }));
    for (const first of [3, 7, 17]) {
      const excerpt = rawFrames(source, `trim=start_frame=${first},setpts=PTS-STARTPTS,${musicVideoGradeFilter(grade, sections, { fps: FPS, frame, offsetSec: first / FPS })}`);
      expect(excerpt.equals(whole.subarray(first * size))).toBe(true);
    }
    const untouched = rawFrames(source, 'null').subarray(12 * size);
    expect(whole.subarray(12 * size).equals(untouched)).toBe(true);
  });
});

// Filter contract on real ffmpeg: a captured document's wipes are already painted, so
// only a mask tells the encoder which pixels belong to which scene (#14835).
describe('grading a captured wipe', () => {
  const FPS = 24;
  const [W, H, FRAMES, CUT] = [320, 180, 6, 6];
  const frame = { width: W, height: H };
  const scenes = (style, color = null) => [
    { sceneId: 'a', startSec: 0, endSec: CUT / FPS },
    { sceneId: 'b', startSec: CUT / FPS, endSec: 1, wipe: { style, frames: FRAMES, cutFrame: CUT, fromSceneId: 'a', color } },
  ];
  const monochromeOut = { preset: 'neutral', grain: 0, sections: [{ sceneId: 'a', preset: 'monochrome' }] };

  // Catches the regression the issue names: same-preset wipes must not change a frame.
  it('leaves a wipe between shots with one grade out of the filter, and a capture past the wipe', () => {
    const same = { preset: 'teal-night', grain: 0.02, sections: [{ sceneId: 'a', preset: 'golden-hour' }, { sceneId: 'b', preset: 'golden-hour' }] };
    const plain = scenes('iris').map(({ wipe, ...section }) => section);
    expect(musicVideoGradeFilter(same, scenes('iris'), { fps: FPS, frame })).toBe(musicVideoGradeFilter(same, plain, { fps: FPS, frame }));
    const past = { fps: FPS, frame, offsetSec: 1 };
    expect(musicVideoGradeFilter(monochromeOut, scenes('iris'), past)).toBeNull();
    const before = { fps: FPS, frame, durationSec: CUT / FPS };
    expect(musicVideoGradeFilter(monochromeOut, scenes('iris'), before)).toBe(musicVideoGradeFilter(monochromeOut, scenes('iris').slice(0, 1), { fps: FPS }));
  });

  // Catches ffmpeg refusing a long edit at filter init: it caps expression depth near 100,
  // which one preset's windows reach at about 100 shots.
  it.skipIf(!ffmpeg)('renders a long edit with hundreds of shots on one grade and a wipe on every cut', () => {
    const count = 300;
    const styles = ['iris', 'paw', 'heart', 'star', 'clock', 'checker', 'push-up', 'card-flip', 'spin-in'];
    const shots = Array.from({ length: count }, (_, i) => ({
      sceneId: `s${i}`, startSec: i / 4, endSec: (i + 1) / 4,
      ...(i ? { wipe: { style: styles[i % styles.length], frames: 2, cutFrame: i * 6, fromSceneId: `s${i - 1}`, color: null } } : {}),
    }));
    const grade = { preset: 'monochrome', grain: 0, sections: shots.filter((_, i) => i % 2).map(({ sceneId }) => ({ sceneId, preset: 'teal-night' })) };
    const filter = musicVideoGradeFilter(grade, shots, { fps: FPS, frame: { width: 64, height: 36 }, durationSec: count / 4 });
    const dir = mkdtempSync(join(tmpdir(), 'grade-long-edit-'));
    try {
      const graph = join(dir, 'graph.txt');
      writeFileSync(graph, filter);
      const raw = execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=red:s=64x36:r=${FPS}:d=${count / 4},format=rgb24`,
        '-/vf', graph, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1e9 });
      expect(raw.length / (64 * 36 * 3)).toBe(count * 6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe.skipIf(!ffmpeg)('on the rendered frames', () => {
    const render = (grade, sections, { offsetFrames = 0, frames = FPS } = {}) => {
      const filter = musicVideoGradeFilter(grade, sections, { fps: FPS, frame, offsetSec: offsetFrames / FPS, durationSec: frames / FPS });
      const raw = execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=0xd02020:s=${W}x${H}:r=${FPS}:d=${frames / FPS},format=rgb24`,
        '-vf', filter, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1e9 });
      expect(raw.length / (W * H * 3)).toBe(frames);
      return (n, x, y) => {
        const at = ((n * H + y) * W + x) * 3;
        return raw[at] - raw[at + 1] > 60 ? 'color' : Math.abs(raw[at] - raw[at + 1]) < 8 ? 'gray' : '?';
      };
    };

    // Compare each region with the painter's own definition, away from the grid's soft boundary.
    const expectRegions = (shown, style, { offsetFrames = 0, inGray = false, color = null } = {}) => {
      const definition = wipeDefinition(style, W / H);
      const want = (songFrame, x, y) => _wipePixel(definition, { u: (x + 0.5) / W, v: (y + 0.5) / H, p: wipeProgress(songFrame - CUT, FRAMES), aspect: W / H, edged: Boolean(color) });
      let checked = 0;
      let wrong = 0;
      for (let songFrame = Math.max(CUT, offsetFrames); songFrame < CUT + FRAMES; songFrame++) {
        for (let y = 3; y < H; y += 6) {
          for (let x = 3; x < W; x += 6) {
            const region = want(songFrame, x, y);
            const near = [[6, 0], [-6, 0], [0, 6], [0, -6]].some(([dx, dy]) => x + dx >= 0 && y + dy >= 0 && x + dx < W && y + dy < H && want(songFrame, x + dx, y + dy) !== region);
            if (near || region === 'black') continue;
            const expected = (region === 'out') === inGray ? 'color' : 'gray';
            checked += 1;
            if (shown(songFrame - offsetFrames, x, y) !== expected) wrong += 1;
          }
        }
      }
      expect(checked).toBeGreaterThan(200);
      expect(wrong / checked).toBeLessThan(0.01);
    };

    it.each(['iris', 'paw', 'blinds-v', 'push-left', 'card-flip', 'spin-in'])('keeps the outgoing region of %s on its own grade', (style) => {
      const shown = render(monochromeOut, scenes(style));
      expectRegions(shown, style);
      // Only the wipe's frames mix: the shots keep their own grade on either side.
      expect(shown(CUT - 1, 3, 3)).toBe('gray');
      expect(shown(CUT + FRAMES, 3, 3)).toBe('color');
      expect(shown(FPS - 1, 3, 3)).toBe('color');
    });

    it('holds the wipe on the song clock when the capture starts inside it, and grades a neutral outgoing shot', () => {
      const offsetFrames = CUT + 2;
      expectRegions(render(monochromeOut, scenes('iris'), { offsetFrames, frames: 12 }), 'iris', { offsetFrames });
      const monochromeIn = { preset: 'neutral', grain: 0, sections: [{ sceneId: 'b', preset: 'monochrome' }] };
      expectRegions(render(monochromeIn, scenes('iris', '#ffff00')), 'iris', { inGray: true, color: '#ffff00' });
    });
  });
});
