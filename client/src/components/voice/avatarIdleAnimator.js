/**
 * Living idle portrait animator for the Voice Call radio operator portrait.
 *
 * Keeps the avatar naturally alive whenever AvatarForcing is not actively
 * streaming speech frames — breathing, occasional sighs, randomized single and
 * double blinks using sampled eyelid skin texture, subtle eye gaze saccades,
 * gentle head micro-sway, and stage-aware attentive posture (listening / thinking).
 *
 * Coordinates are calibrated to the bundled 640x640 `call-portrait.webp`.
 */

export const PORTRAIT_SIZE = 640;

export const PORTRAIT_LANDMARKS = Object.freeze({
  headPivot: { x: 326, y: 318 },
  torsoStartY: 424,
  eyes: [
    // Viewer's left eye (operator's right eye)
    {
      outerX: 232,
      outerY: 237,
      innerX: 301,
      innerY: 240,
      topX: 266,
      topY: 224,
      bottomX: 267,
      bottomY: 247,
      // Clean warm sunlit skin sample matching this eye's exact lighting & grain
      lidPatch: { sx: 246, sy: 260, sw: 42, sh: 12 },
    },
    // Viewer's right eye (operator's left eye)
    {
      outerX: 358,
      outerY: 238,
      innerX: 426,
      innerY: 233,
      topX: 392,
      topY: 221,
      bottomX: 392,
      bottomY: 245,
      lidPatch: { sx: 372, sy: 258, sw: 42, sh: 12 },
    },
  ],
});

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const smoothstep = (t) => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

// Lightweight deterministic-friendly PRNG fallback so callers/tests can inject Math.random or a seed.
const randRange = (rng, min, max) => min + rng() * (max - min);

export function createIdleMotionState(rng = Math.random) {
  return {
    t: 0,
    // Blink scheduling
    nextBlinkAt: randRange(rng, 1.8, 3.8),
    blinkElapsed: -1,
    doubleBlinkPending: false,
    // Gaze saccades (normalized -1..1)
    gazeX: 0,
    gazeY: 0,
    targetGazeX: 0,
    targetGazeY: 0,
    nextGazeAt: randRange(rng, 2.2, 4.4),
    // Sigh scheduling
    nextSighAt: randRange(rng, 11, 18),
    sighElapsed: -1,
    // Listening micro-nod
    nextNodAt: randRange(rng, 2.5, 5.0),
    nodElapsed: -1,
    // Smoothed stage posture blend
    listenBlend: 0,
    thinkBlend: 0,
    lastStage: 'idle',
  };
}

const BLINK_DURATION = 0.21;
const SIGH_DURATION = 3.0;
const NOD_DURATION = 0.55;

function evalBlink(elapsed) {
  if (elapsed < 0 || elapsed >= BLINK_DURATION) return 0;
  // Asymmetric natural blink: fast close (70ms), brief hold (25ms), softer open (115ms)
  if (elapsed < 0.07) return smoothstep(elapsed / 0.07);
  if (elapsed < 0.095) return 1;
  return 1 - smoothstep((elapsed - 0.095) / 0.115);
}

function evalSigh(elapsed) {
  if (elapsed < 0 || elapsed >= SIGH_DURATION) return { inhale: 0, exhale: 0 };
  if (elapsed < 1.05) {
    return { inhale: smoothstep(elapsed / 1.05), exhale: 0 };
  }
  if (elapsed < 1.3) {
    return { inhale: 1, exhale: 0 };
  }
  const p = (elapsed - 1.3) / (SIGH_DURATION - 1.3);
  const decay = 1 - smoothstep(p);
  const exhale = Math.sin(clamp(p, 0, 1) * Math.PI);
  return { inhale: decay, exhale };
}

function pickGazeTarget(stage, rng) {
  if (stage === 'thinking') {
    const dir = rng() < 0.65 ? 1 : -1;
    return { x: dir * randRange(rng, 0.55, 0.9), y: -randRange(rng, 0.45, 0.85) };
  }
  if (stage === 'listening' || stage === 'capturing' || stage === 'handsfree') {
    if (rng() < 0.78) return { x: randRange(rng, -0.16, 0.16), y: randRange(rng, -0.1, 0.1) };
    return { x: randRange(rng, -0.45, 0.45), y: randRange(rng, -0.25, 0.2) };
  }
  // Idle waiting: warm direct eye contact ~50%, gentle natural glances otherwise
  if (rng() < 0.52) return { x: randRange(rng, -0.14, 0.14), y: randRange(rng, -0.1, 0.1) };
  const presets = [
    { x: -0.82, y: -0.12 },
    { x: 0.82, y: -0.12 },
    { x: 0.65, y: -0.58 },
    { x: -0.6, y: -0.48 },
    { x: -0.5, y: 0.42 },
    { x: 0.52, y: 0.36 },
  ];
  const base = presets[Math.floor(rng() * presets.length)];
  return {
    x: clamp(base.x + randRange(rng, -0.12, 0.12), -1, 1),
    y: clamp(base.y + randRange(rng, -0.1, 0.1), -1, 1),
  };
}

/**
 * Advance the living idle motion simulation by `dt` seconds and return the
 * current pose parameters for rendering.
 */
export function stepIdleMotion(state, dtSeconds, stage = 'idle', rng = Math.random) {
  const dt = clamp(dtSeconds, 0, 0.1);
  state.t += dt;
  const listening = stage === 'listening' || stage === 'capturing' || stage === 'handsfree';
  const thinking = stage === 'thinking';

  // React immediately when entering thinking/listening so gaze feels responsive
  if (stage !== state.lastStage) {
    state.lastStage = stage;
    const next = pickGazeTarget(stage, rng);
    state.targetGazeX = next.x;
    state.targetGazeY = next.y;
    state.nextGazeAt = state.t + randRange(rng, 1.8, 3.6);
  }

  // Smooth posture blends
  const blendRate = 1 - Math.exp(-dt * 3.5);
  state.listenBlend += ((listening ? 1 : 0) - state.listenBlend) * blendRate;
  state.thinkBlend += ((thinking ? 1 : 0) - state.thinkBlend) * blendRate;

  // Blink state machine
  if (state.blinkElapsed >= 0) {
    state.blinkElapsed += dt;
    if (state.blinkElapsed >= BLINK_DURATION) {
      state.blinkElapsed = -1;
      if (state.doubleBlinkPending) {
        state.doubleBlinkPending = false;
        state.nextBlinkAt = state.t + randRange(rng, 0.16, 0.28);
      } else {
        state.nextBlinkAt = state.t + randRange(rng, listening ? 3.2 : 2.6, listening ? 6.2 : 5.6);
      }
    }
  } else if (state.t >= state.nextBlinkAt) {
    state.blinkElapsed = 0;
    state.doubleBlinkPending = rng() < 0.18;
  }

  // Gaze saccade scheduling
  if (state.t >= state.nextGazeAt) {
    const prevX = state.targetGazeX;
    const next = pickGazeTarget(stage, rng);
    state.targetGazeX = next.x;
    state.targetGazeY = next.y;
    state.nextGazeAt = state.t + randRange(rng, thinking ? 1.5 : 2.0, thinking ? 3.2 : 4.8);
    // Natural human oculomotor coupling: large gaze shifts often trigger a blink
    if (Math.abs(next.x - prevX) > 0.7 && state.blinkElapsed < 0 && rng() < 0.4) {
      state.blinkElapsed = 0;
      state.doubleBlinkPending = false;
    }
  }

  const saccadeRate = 1 - Math.exp(-dt * 16);
  state.gazeX += (state.targetGazeX - state.gazeX) * saccadeRate;
  state.gazeY += (state.targetGazeY - state.gazeY) * saccadeRate;

  // Periodic natural sigh (relaxed waiting only)
  if (state.sighElapsed >= 0) {
    state.sighElapsed += dt;
    if (state.sighElapsed >= SIGH_DURATION) {
      state.sighElapsed = -1;
      state.nextSighAt = state.t + randRange(rng, 14, 24);
    }
  } else if (!listening && !thinking && state.t >= state.nextSighAt) {
    state.sighElapsed = 0;
  }

  // Subtle attentive micro-nod while listening
  if (state.nodElapsed >= 0) {
    state.nodElapsed += dt;
    if (state.nodElapsed >= NOD_DURATION) {
      state.nodElapsed = -1;
      state.nextNodAt = state.t + randRange(rng, 3.2, 6.2);
    }
  } else if (listening && state.t >= state.nextNodAt) {
    state.nodElapsed = 0;
  }

  const blink = evalBlink(state.blinkElapsed);
  const sigh = evalSigh(state.sighElapsed);
  const nod = state.nodElapsed >= 0
    ? Math.sin((state.nodElapsed / NOD_DURATION) * Math.PI)
    : 0;

  // Asymmetric organic breath wave (~4.1s cycle)
  const breathPhase = (state.t * (Math.PI * 2)) / 4.15;
  const baseBreath = 0.5 + 0.5 * Math.sin(breathPhase - 0.35 * Math.sin(breathPhase));
  const breath = clamp(baseBreath * 0.65 + sigh.inhale * 0.65, 0, 1.3);

  // Subtle multi-harmonic head micro-sway
  const swayX = Math.sin(state.t * 0.53) * 1.6 + Math.sin(state.t * 1.17 + 1.2) * 0.65;
  const swayY = Math.sin(state.t * 0.71 + 0.6) * 0.9 - breath * 1.9 + sigh.exhale * 1.4 + nod * 2.6;
  const tiltDeg = Math.sin(state.t * 0.41 + 0.4) * 0.48
    + Math.sin(state.t * 0.93) * 0.18
    + state.thinkBlend * 1.05
    - sigh.exhale * 0.42;

  return {
    breath,
    sighExhale: sigh.exhale,
    blink,
    gazeX: state.gazeX,
    gazeY: state.gazeY,
    swayX,
    swayY,
    tiltRad: (tiltDeg * Math.PI) / 180,
    scale: 1.032 + state.listenBlend * 0.014 + breath * 0.004,
  };
}

// Quadratic Bezier passes through midpoint Y when controlY = 2*Y - avg(endY).
const quadControlY = (targetApexY, y0, y2) => 2 * targetApexY - (y0 + y2) * 0.5;

function traceEyeAperture(ctx, eye, lowerLift = 0) {
  const topCtrlY = quadControlY(eye.topY - 1, eye.outerY, eye.innerY);
  const botCtrlY = quadControlY(eye.bottomY + 1 - lowerLift, eye.outerY, eye.innerY);
  ctx.beginPath();
  ctx.moveTo(eye.outerX, eye.outerY);
  ctx.quadraticCurveTo(eye.topX, topCtrlY, eye.innerX, eye.innerY);
  ctx.quadraticCurveTo(eye.bottomX, botCtrlY, eye.outerX, eye.outerY);
  ctx.closePath();
}

function drawAnimatedEye(ctx, img, eye, gazeX, gazeY, blink) {
  const openHeight = eye.bottomY - eye.topY;
  const shiftX = gazeX * 3.8;
  const shiftY = gazeY * 2.1;

  // 1. Subtle gaze shift inside the clipped almond eye aperture
  if (Math.abs(shiftX) > 0.08 || Math.abs(shiftY) > 0.08) {
    ctx.save();
    traceEyeAperture(ctx, eye);
    ctx.clip();
    // Soft warm sclera backstop prevents exposed gaps along the trailing lid edge
    ctx.fillStyle = '#c9b7a6';
    ctx.fillRect(eye.outerX - 2, eye.topY - 3, (eye.innerX - eye.outerX) + 4, openHeight + 6);
    const pad = 10;
    const sx = eye.outerX - pad;
    const sy = eye.topY - pad;
    const sw = (eye.innerX - eye.outerX) + pad * 2;
    const sh = openHeight + pad * 2;
    ctx.drawImage(img, sx, sy, sw, sh, sx + shiftX, sy + shiftY, sw, sh);
    // Soft inner-corner shadow keeps the shifted eye naturally seated in the socket
    const shadow = ctx.createLinearGradient(0, eye.topY - 2, 0, eye.topY + 6);
    shadow.addColorStop(0, 'rgba(22, 12, 8, 0.34)');
    shadow.addColorStop(1, 'rgba(22, 12, 8, 0)');
    ctx.fillStyle = shadow;
    ctx.fillRect(eye.outerX - 2, eye.topY - 2, (eye.innerX - eye.outerX) + 4, 9);
    ctx.restore();
  }

  // 2. Photorealistic blink using the portrait's own sampled upper-eyelid skin patch
  if (blink > 0.015) {
    const lowerLift = openHeight * 0.1 * blink;
    const closedApexY = eye.bottomY + 1 - lowerLift;
    const lidApexY = eye.topY - 1 + (closedApexY - (eye.topY - 1)) * blink;
    const lidCtrlY = quadControlY(lidApexY, eye.outerY, eye.innerY);
    const coverH = Math.max(4, lidApexY - (eye.topY - 5));

    ctx.save();
    traceEyeAperture(ctx, eye);
    ctx.clip();

    // Clip the descending upper eyelid curtain cleanly down to the exact Bezier rim
    ctx.beginPath();
    ctx.moveTo(eye.outerX - 4, eye.topY - 8);
    ctx.lineTo(eye.innerX + 4, eye.topY - 8);
    ctx.lineTo(eye.innerX + 4, eye.innerY + 2);
    ctx.quadraticCurveTo(eye.topX, lidCtrlY, eye.outerX - 4, eye.outerY + 2);
    ctx.closePath();
    ctx.clip();

    // Paint the sampled warm eyelid skin texture smoothly across the closed dome
    const { sx, sy, sw, sh } = eye.lidPatch;
    ctx.drawImage(
      img,
      sx,
      sy,
      sw,
      sh,
      eye.outerX - 4,
      eye.topY - 6,
      (eye.innerX - eye.outerX) + 8,
      coverH + 10,
    );

    // Match the warm recessed orbital shadow tone so closed lids blend seamlessly into the eye socket
    const lidShade = ctx.createLinearGradient(0, eye.topY - 3, 0, lidApexY + 2);
    lidShade.addColorStop(0, 'rgba(42, 20, 12, 0.56)');
    lidShade.addColorStop(0.45, 'rgba(62, 30, 16, 0.34)');
    lidShade.addColorStop(0.82, 'rgba(54, 25, 14, 0.32)');
    lidShade.addColorStop(1, 'rgba(26, 13, 8, 0.48)');
    ctx.fillStyle = lidShade;
    ctx.fillRect(eye.outerX - 4, eye.topY - 6, (eye.innerX - eye.outerX) + 8, coverH + 10);

    // Delicate natural upper-lash rim along the closing curve
    ctx.strokeStyle = `rgba(24, 13, 9, ${0.62 * Math.min(1, blink * 1.2)})`;
    ctx.lineWidth = 1.7;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(eye.outerX, eye.outerY + 0.5);
    ctx.quadraticCurveTo(eye.topX, lidCtrlY - 0.5, eye.innerX, eye.innerY + 0.5);
    ctx.stroke();

    ctx.restore();
  }
}

/**
 * Render one frame of the living waiting portrait onto a 640x640 Canvas 2D context.
 */
export function renderLivingPortrait(ctx, img, pose) {
  const size = PORTRAIT_SIZE;
  const { headPivot, torsoStartY, eyes } = PORTRAIT_LANDMARKS;

  ctx.clearRect(0, 0, size, size);

  // Layer 1: Head & background with subtle organic sway, breathing float, and tilt
  ctx.save();
  ctx.translate(headPivot.x + pose.swayX, headPivot.y + pose.swayY);
  ctx.rotate(pose.tiltRad);
  ctx.scale(pose.scale, pose.scale);
  ctx.translate(-headPivot.x, -headPivot.y);
  ctx.drawImage(img, 0, 0, size, size);

  // Animated eyes (gaze saccades + natural blinking) in the exact head coordinate space
  for (const eye of eyes) {
    drawAnimatedEye(ctx, img, eye, pose.gazeX, pose.gazeY, pose.blink);
  }
  ctx.restore();

  // Layer 2: Soft breathing shoulder/collar rise via overlapping horizontal slices
  // Anchored cleanly across the neck below the chin with zero vertical seam
  const shoulderLift = -(pose.breath * 4.2) + pose.sighExhale * 2.0;
  if (Math.abs(shoulderLift) > 0.08) {
    const slices = 28;
    const span = size - torsoStartY;
    const step = span / slices;
    ctx.save();
    for (let i = 0; i < slices; i += 1) {
      const y = torsoStartY + i * step;
      const weight = smoothstep(i / (slices * 0.65));
      const dy = pose.swayY * (1 - weight) + shoulderLift * weight;
      const scaleX = pose.scale + pose.breath * 0.006 * weight;
      const drawW = size * scaleX;
      const drawX = (size - drawW) / 2 + pose.swayX * (1 - weight * 0.65);
      // Slight +2px overlap prevents subpixel seams between horizontal bands
      ctx.drawImage(img, 0, y, size, step + 2, drawX, y + dy, drawW, step + 2);
    }
    ctx.restore();
  }
}
