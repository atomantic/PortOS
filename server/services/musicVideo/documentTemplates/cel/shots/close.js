// Focus transfers from the painted garden to the figure's face over the first bar.
import { rotX, norm, DEG, stepped, clamp, smooth, seg, lerp } from '../kit/core.js';
import { makeView } from '../kit/solid.js';
import { solve, STAND } from '../kit/skeleton.js';
import { buildFigure, drawFigure, DEFAULT_PALETTE } from '../kit/figure.js';
import { finish } from '../kit/stage.js';

export function makeCloseShot({ stage, song, garden, cel, fps }) {
  const { W, H } = stage;
  const scale = H / 1080;
  return {
    draw(out, t, start, end) {
      const progress = seg(t, start, end);
      const focus = smooth(clamp(progress * 3));
      const tDraw = stepped(t, fps, 2, start);
      const beat = song.beatAt(tDraw);
      const scene = stage.scratch('scene');
      const g = scene.getContext('2d');
      garden.backdrop(g, song.beatAt(start) * H * 0.2 + (t - start) * H * 0.02, 8 * focus);
      const breath = Math.sin(beat * Math.PI / 4);
      const turn = smooth(clamp(progress * 2));
      const blink = clamp(1 - Math.abs((progress - 0.65) / 0.025));
      const sk = solve({
        pos: [0, STAND + 0.003 * breath, 0], yaw: -22 * DEG,
        spine: [0.03 + 0.008 * breath, 0, 0.015],
        neck: [0.03, lerp(-0.1, 0.1, turn), 0.01], head: [0.02, lerp(-0.12, 0.15, turn), -0.02],
        armL: { swing: 0.06, raise: 0.1, twist: 0.2, bend: 0.2 }, armR: { swing: -0.04, raise: 0.1, twist: 0.2, bend: 0.16 },
      });
      const s = H * 1.3 * (1 + 0.025 * progress);
      const view = makeView({ V: rotX(2 * DEG), s, cx: W * 0.54, cy: H * 0.16 + 1.69 * s });
      const figure = stage.scratch('close-figure');
      drawFigure(figure.getContext('2d'), cel, stage, buildFigure(sk, DEFAULT_PALETTE, {
        hairSway: [0.006 * Math.sin(beat * Math.PI / 4 + 1), 0, -0.004], detail: 1.5,
      }), view, {
        light: norm([-0.6, 0.75, 0.5]), lineWidth: 3 * scale, wobble: 0.5 * scale, wobbleSeed: Math.floor(tDraw * fps),
        face: { blink, gaze: [lerp(-0.2, 0.2, turn), 0.1], mouth: 0.1, smile: 0.15 },
      });
      g.filter = `blur(${(1 - focus) * 5 * scale}px)`;
      g.drawImage(figure, 0, 0); g.filter = 'none';
      finish(out, scene, stage, { frame: Math.floor(t * fps), soft: 0.25 * scale, split: 0.45 * scale, bloomSplit: 2 * scale });
    },
  };
}
