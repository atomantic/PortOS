// Painted terraces are independent planes; only the figure is rasterized in true depth.
import { rotX, norm, DEG, stepped, rng } from '../kit/core.js';
import { makeView } from '../kit/solid.js';
import { solve } from '../kit/skeleton.js';
import { buildFigure, drawFigure, DEFAULT_PALETTE } from '../kit/figure.js';
import { walkPose } from '../kit/walk.js';
import { finish } from '../kit/stage.js';

export function makeGardenShot({ stage, song, cel, fps }) {
  const { W, H } = stage;
  const scale = H / 1080;
  const sky = stage.cached('garden-sky', W, H, (g) => {
    const gradient = g.createLinearGradient(0, 0, 0, H);
    gradient.addColorStop(0, '#8ba8a6'); gradient.addColorStop(0.7, '#f2dfb8'); gradient.addColorStop(1, '#cfbb97');
    g.fillStyle = gradient; g.fillRect(0, 0, W, H);
    g.fillStyle = '#f6e6ba'; g.beginPath(); g.arc(W * 0.73, H * 0.23, H * 0.065, 0, Math.PI * 2); g.fill();
  });
  const hills = stage.cached('garden-hills', W, H, (g) => {
    for (let layer = 0; layer < 3; layer += 1) {
      g.fillStyle = ['#9ba99b', '#82958a', '#647f75'][layer];
      g.beginPath(); g.moveTo(0, H);
      for (let i = 0; i <= 64; i += 1) {
        const x = i / 64;
        g.lineTo(x * W, H * (0.49 + layer * 0.065 + 0.045 * Math.cos(x * Math.PI * 4) + 0.03 * Math.sin(x * Math.PI * 6)));
      }
      g.lineTo(W, H); g.closePath(); g.fill();
    }
  });
  const ground = stage.cached('garden-ground', W, H, (g) => {
    g.fillStyle = '#b9b495'; g.fillRect(0, H * 0.68, W, H * 0.32);
    g.strokeStyle = '#989b80'; g.lineWidth = scale * 2;
    for (let i = 0; i < 14; i += 1) {
      const x = (i + 0.5) * W / 14;
      g.beginPath(); g.moveTo(x, H * 0.725); g.lineTo(x + W * 0.04, H); g.stroke();
    }
  });
  const terrace = stage.cached('garden-terrace', W, H, (g) => {
    g.fillStyle = '#dbcfab'; g.fillRect(0, H * 0.68, W, H * 0.025);
    g.fillStyle = '#89967d'; g.fillRect(0, H * 0.705, W, H * 0.018);
    const random = rng(41);
    for (let i = 0; i < 7; i += 1) {
      const x = (i + 0.5) * W / 7, y = H * (0.68 + random() * 0.012);
      const tall = H * (0.1 + random() * 0.16);
      g.fillStyle = '#6a6753'; g.fillRect(x - 3 * scale, y - tall, 6 * scale, tall);
      g.fillStyle = i % 2 ? '#536f5e' : '#738568';
      g.beginPath(); g.ellipse(x, y - tall, H * 0.033, tall * 0.62, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#8c9b76'; g.beginPath(); g.ellipse(x - H * 0.01, y - tall * 1.13, H * 0.018, tall * 0.42, -0.1, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#b78c69'; g.beginPath(); g.moveTo(x - H * 0.025, y - H * 0.025); g.lineTo(x + H * 0.025, y - H * 0.025); g.lineTo(x + H * 0.018, y); g.lineTo(x - H * 0.018, y); g.closePath(); g.fill();
    }
  });
  const near = stage.cached('garden-near', W, H, (g) => {
    const random = rng(95);
    for (let i = 0; i < 19; i += 1) {
      const x = i * W / 18, y = H * (1.03 - random() * 0.06);
      g.fillStyle = i % 2 ? '#344e43' : '#49664f';
      g.beginPath(); g.ellipse(x, y, W * 0.06, H * (0.05 + random() * 0.03), -0.3, 0, Math.PI * 2); g.fill();
    }
  });
  const light = norm([-0.6, 0.75, 0.5]);
  const shot = {
    backdrop(g, cameraX = 0, focusBlur = 0) {
      g.drawImage(sky, 0, 0);
      stage.layer(g, hills, { cameraX, parallax: 0.08, blur: (1 + focusBlur) * scale });
      // The contact plane shares the figure's camera translation: a held foot cannot slide over paving.
      stage.layer(g, ground, { cameraX, parallax: 1, blur: focusBlur * scale });
      stage.layer(g, terrace, { cameraX, parallax: 0.55, blur: focusBlur * scale });
    },
    draw(out, t) {
      const tDraw = stepped(t, fps, 2);
      const walk = walkPose(song.beatAt(t), song.beatAt(tDraw), { heading: 90 * DEG });
      const s = H * 0.36;
      const cameraX = walk.ground[0] * s;
      const scene = stage.scratch('scene');
      const g = scene.getContext('2d');
      shot.backdrop(g, cameraX);
      g.fillStyle = 'rgba(40,60,45,0.22)';
      g.beginPath(); g.ellipse(W * 0.44 + H * 0.06, H * 0.88, H * 0.11, H * 0.018, -0.05, 0, Math.PI * 2); g.fill();
      const view = makeView({ V: rotX(3 * DEG), s, cx: W * 0.44 - cameraX, cy: H * 0.88 });
      drawFigure(g, cel, stage, buildFigure(solve(walk.pose), DEFAULT_PALETTE, { skirtLag: walk.skirtLag, hairSway: walk.hairSway }), view, {
        light, lineWidth: 2 * scale, wobble: 0.35 * scale, wobbleSeed: Math.floor(tDraw * fps),
      });
      stage.layer(g, near, { cameraX, parallax: 1.4, blur: 1.8 * scale });
      finish(out, scene, stage, { frame: Math.floor(t * fps), soft: 0.25 * scale, split: 0.45 * scale, bloomSplit: 2 * scale });
    },
  };
  return shot;
}
