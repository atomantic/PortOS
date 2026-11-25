// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { controlBlocked, defaultPose, jointLabel, movedPose, poseClips } from './blenderModelPose.js';

const control = (id, extra = {}) => ({ id, label: id.toUpperCase(), type: 'hinge', min: 0, max: 110, default01: 0, dependsOn: [], ...extra });
const controls = [
  control('roll'),
  control('clip', { type: 'slide', min: -0.1, max: 0.1, default01: 0.5, dependsOn: [{ control: 'roll', atLeast: 1 }] }),
  control('lock', { dependsOn: [{ control: 'clip', atLeast: 0.9, atMost: 1 }] }),
];

describe('blenderModelPose', () => {
  it('starts at the defaults and names the clips', () => {
    expect(defaultPose(controls)).toEqual({ roll: 0, clip: 0.5, lock: 0 });
    expect(poseClips(controls, defaultPose(controls))).toEqual({ 'control:roll': 0, 'control:clip': 0.5, 'control:lock': 0 });
  });

  it('says what holds a control back', () => {
    expect(controlBlocked(controls[1], defaultPose(controls), controls)).toBe('Needs ROLL at least 1');
    expect(controlBlocked(controls[2], { roll: 1, clip: 0.5, lock: 0 }, controls)).toBe('Needs CLIP at least 0.9 and at most 1');
    expect(controlBlocked(controls[1], { roll: 1, clip: 0.5, lock: 0 }, controls)).toBeNull();
  });

  it('returns a whole chain to default when what it stands on moves away, and clamps', () => {
    const closed = { roll: 1, clip: 1, lock: 0.7 };
    expect(movedPose(controls, closed, 'roll', 0.4)).toEqual({ roll: 0.4, clip: 0.5, lock: 0 });
    expect(movedPose(controls, closed, 'lock', 1.3)).toEqual({ roll: 1, clip: 1, lock: 1 });
  });

  it('labels a joint in its own unit', () => {
    expect(jointLabel(controls[0], 0.5)).toBe('55°');
    expect(jointLabel(controls[1], 1)).toBe('0.1 m');
  });
});
