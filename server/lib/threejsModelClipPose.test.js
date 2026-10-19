import { describe, expect, it } from 'vitest';
import { evaluateThreejsModelClipPose } from './threejsModelClipPose.js';
import { THREEJS_PLAYER_SOURCE } from './threejsModelPlayerSource.js';

// The preview re-uses this evaluator, so the remaining copy to pin is the one
// shipped inside an exported factory, over every semantic they share:
// each easing curve, the step `visible`, a gap between two windows on one
// channel (the earlier `to` holds), the time before a part's first window (its
// `from` holds), and sequences declared out of time order.
const importEmittedPlayer = () => import(`data:text/javascript;base64,${Buffer.from(
  `const spec = { parts: [] }; const rotation = () => [0, 0, 0];\n${THREEJS_PLAYER_SOURCE}`,
).toString('base64')}`);

const clip = {
  id: 'parity',
  name: 'Parity',
  durationSeconds: 4,
  loop: false,
  sequences: [
    { id: 'late', name: 'Late', partId: 'arm', startSeconds: 2.5, endSeconds: 4, easing: 'easeOut', channels: { rotationDegrees: { from: [0, 90, 0], to: [0, 360, 0] } } },
    { id: 'early', name: 'Early', partId: 'arm', startSeconds: 0.5, endSeconds: 1.5, easing: 'easeIn', channels: { rotationDegrees: { from: [0, 0, 0], to: [0, 90, 0] } } },
    { id: 'lift', name: 'Lift', partId: 'lid', startSeconds: 0, endSeconds: 2, easing: 'easeInOut', channels: { position: { from: [0, 0, 0], to: [0, 2, 0] }, opacity: { from: 1, to: 0.25 } } },
    { id: 'show', name: 'Show', partId: 'prop', startSeconds: 1, endSeconds: 3, easing: 'linear', channels: { visible: { from: false, to: true }, scale: { from: [1, 1, 1], to: [2, 1, 1] } } },
  ],
};

describe('evaluateThreejsModelClipPose', () => {
  it('poses a clip exactly as the exported player does', async () => {
    const { evaluateSculptClipPose } = await importEmittedPlayer();
    for (let step = 0; step <= 32; step += 1) {
      const time = step * 0.125;
      const server = { ...evaluateThreejsModelClipPose(clip, time) };
      expect(server).toEqual({ ...evaluateSculptClipPose(clip, time) });
    }
    // Spot-check the semantics the parity rests on, so two copies that drifted
    // together cannot pass by agreeing with each other.
    expect(evaluateThreejsModelClipPose(clip, 0).arm.rotationDegrees).toEqual([0, 0, 0]);
    expect(evaluateThreejsModelClipPose(clip, 2).arm.rotationDegrees).toEqual([0, 90, 0]);
    expect(evaluateThreejsModelClipPose(clip, 2).prop.visible).toBe(false);
    expect(evaluateThreejsModelClipPose(clip, 3).prop.visible).toBe(true);
  });
});
