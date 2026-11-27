import { describe, it, expect, vi } from 'vitest';
import {
  PORTRAIT_SIZE,
  createIdleMotionState,
  stepIdleMotion,
  renderLivingPortrait,
} from './avatarIdleAnimator';

const fixedRng = (values) => {
  let i = 0;
  return () => {
    const value = values[i % values.length];
    i += 1;
    return value;
  };
};

describe('avatarIdleAnimator', () => {
  it('advances breathing, blinking, gaze shifts, and sighs over idle time', () => {
    const rng = fixedRng([0.1, 0.2, 0.05, 0.1, 0.9, 0.3, 0.8, 0.2]);
    const state = createIdleMotionState(rng);

    let sawBlink = false;
    let sawGazeShift = false;
    let sawSigh = false;
    let minBreath = Infinity;
    let maxBreath = -Infinity;

    for (let i = 0; i < 400; i += 1) {
      const pose = stepIdleMotion(state, 0.05, 'idle', rng);
      if (pose.blink > 0.5) sawBlink = true;
      if (Math.abs(pose.gazeX) > 0.3 || Math.abs(pose.gazeY) > 0.2) sawGazeShift = true;
      if (pose.sighExhale > 0.4) sawSigh = true;
      minBreath = Math.min(minBreath, pose.breath);
      maxBreath = Math.max(maxBreath, pose.breath);
    }

    expect(sawBlink).toBe(true);
    expect(sawGazeShift).toBe(true);
    expect(sawSigh).toBe(true);
    expect(maxBreath - minBreath).toBeGreaterThan(0.4);
  });

  it('shifts posture and gaze attentively for listening and thinking stages', () => {
    const rng = fixedRng([0.3, 0.4, 0.2, 0.5]);
    const idleState = createIdleMotionState(rng);
    const listenState = createIdleMotionState(rng);
    const thinkState = createIdleMotionState(rng);

    let idlePose;
    let listenPose;
    let thinkPose;
    for (let i = 0; i < 40; i += 1) {
      idlePose = stepIdleMotion(idleState, 0.05, 'idle', rng);
      listenPose = stepIdleMotion(listenState, 0.05, 'listening', rng);
      thinkPose = stepIdleMotion(thinkState, 0.05, 'thinking', rng);
    }

    expect(listenPose.scale).toBeGreaterThan(idlePose.scale);
    expect(thinkPose.gazeY).toBeLessThan(-0.3);
    expect(thinkPose.tiltRad).toBeGreaterThan(idlePose.tiltRad);
  });

  it('renders a living portrait frame cleanly with gaze, blink, and shoulder breathing', () => {
    const grad = { addColorStop: vi.fn() };
    const ctx = {
      clearRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      scale: vi.fn(),
      drawImage: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      quadraticCurveTo: vi.fn(),
      closePath: vi.fn(),
      clip: vi.fn(),
      fillRect: vi.fn(),
      stroke: vi.fn(),
      createLinearGradient: vi.fn(() => grad),
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      lineCap: 'butt',
    };
    const img = { width: PORTRAIT_SIZE, height: PORTRAIT_SIZE };

    renderLivingPortrait(ctx, img, {
      breath: 0.9,
      sighExhale: 0.4,
      blink: 0.85,
      gazeX: 0.7,
      gazeY: -0.25,
      swayX: 1.2,
      swayY: -1.5,
      tiltRad: 0.01,
      scale: 1.035,
    });

    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, PORTRAIT_SIZE, PORTRAIT_SIZE);
    // Draws base portrait + shifted eyes + sampled eyelid patches + breathing torso slices
    expect(ctx.drawImage.mock.calls.length).toBeGreaterThan(25);
    expect(ctx.stroke).toHaveBeenCalledTimes(2);
  });
});
