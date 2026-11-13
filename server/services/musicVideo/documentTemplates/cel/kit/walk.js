// A walk locked to the beat: one footfall on every beat, the left foot on even beats.
//
// The drawing changes on twos but the body travels on ones: `beat` is the real (fractional) beat
// for where the root is, `drawBeat` the held beat the pose is drawn from. The planted foot stays where
// it landed, so it never slides against the ground while a drawing is held.
import { clamp, lerp, smooth, easeInOut, rotY, apply, add, DEG } from './core.js';
import { STAND } from './skeleton.js';

const STANCE = 0.62; // share of a foot's cycle spent on the ground

/**
 * opts: { stride (metres per step), heading (radians, 0 walks toward +Z), origin [x, z], base (foot spacing),
 *         bounce, sway, armSwing, mood 0..1 (0 dreamy and loose, 1 brisk) }
 * Returns a pose for skeleton.solve plus { skirtLag, hairSway, ground: [x, z] under the pelvis }.
 */
export function walkPose(beat, drawBeat, opts = {}) {
  const { stride = 0.56, heading = 0, origin = [0, 0], base = 0.045, bounce = 0.02, sway = 0.022, armSwing = 0.46, lean = 0.045 } = opts;
  const R = rotY(heading);
  const along = (d, side = 0, y = 0) => add([origin[0], y, origin[1]], apply(R, [side, 0, d]));
  const travel = beat * stride;            // where the pelvis really is
  const drawTravel = drawBeat * stride;    // where the held drawing was made
  const p = ((drawBeat / 2) % 1 + 1) % 1;  // cycle phase: 0 left heel strike, 0.5 right heel strike

  const foot = (side) => {
    // This foot's own phase: 0 at its heel strike.
    const q = side > 0 ? p : (p + 0.5) % 1;
    const cycle = Math.floor(drawBeat / 2 + (side > 0 ? 0 : -0.5));
    const strikeBeat = (cycle + (side > 0 ? 0 : 0.5)) * 2;     // the beat this foot last landed on
    const planted = strikeBeat * stride + stride * 0.5;          // it lands half a step ahead of the pelvis
    const next = planted + stride * 2;
    let d, y, pitch;
    if (q < STANCE) {
      const k = q / STANCE;
      d = planted;
      // Heel strike, flat, then the heel peels off while the toe stays down.
      const strike = clamp(1 - k / 0.16);
      const peel = smooth(clamp((k - 0.62) / 0.38));
      pitch = -0.3 * strike + 0.75 * peel; // toe up at the strike, toe down as the heel peels
      y = 0.07 + 0.012 * strike + 0.075 * peel;
      d += 0.02 * strike + 0.055 * peel;
    } else {
      const k = (q - STANCE) / (1 - STANCE);
      const e = easeInOut(k, 2);
      d = lerp(planted + 0.055, next + 0.02, e);
      y = 0.07 + lerp(0.075, 0.012, k) + 0.07 * Math.sin(Math.PI * clamp(k * 1.08)) ** 1.3;
      pitch = lerp(0.75, -0.3, smooth(clamp(k * 1.25)));
      // A swinging foot rides with the drawing, not with the ground.
      d += travel - drawTravel;
    }
    return { foot: along(d, side * base, y), yaw: heading, pitch };
  };

  const c = Math.cos(2 * Math.PI * p), s = Math.sin(2 * Math.PI * p);
  const twice = Math.cos(4 * Math.PI * p);
  const pelvisY = STAND - 0.028 - bounce * twice;       // lowest as each heel lands, highest passing over the foot
  const pos = along(travel, sway * s, pelvisY);
  const pose = {
    pos, yaw: heading - 0.1 * c, pitch: lean, roll: -0.05 * s,
    spine: [0.05, 0.27 * c, 0.035 * s],
    neck: [0.02, -0.09 * c, 0], head: [-0.04 + 0.012 * twice, -0.1 * c, -0.015 * s],
    armL: { swing: -armSwing * c + 0.04, raise: 0.1, twist: 0.25, bend: 0.2 + 0.36 * Math.max(0, -c) },
    armR: { swing: armSwing * c + 0.04, raise: 0.1, twist: 0.25, bend: 0.2 + 0.36 * Math.max(0, c) },
    handL: [0.1, 0, 0], handR: [0.1, 0, 0],
    legL: foot(1), legR: foot(-1),
  };
  // Cloth and hair trail the body: back along the heading, and down after each landing.
  const back = apply(R, [0, 0, -1]);
  const lagK = 0.034 + 0.016 * twice;
  const skirtLag = [back[0] * lagK + 0.012 * s * R[0], 0.004 * twice, back[2] * lagK + 0.012 * s * R[6]];
  const hairSway = [back[0] * 0.012 - 0.008 * s * R[0], -0.004 * twice, back[2] * 0.012 - 0.008 * s * R[6]];
  return { pose, skirtLag, hairSway, ground: [pos[0], pos[2]], phase: p };
}

export { DEG };
