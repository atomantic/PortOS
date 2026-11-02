import { describe, expect, it } from 'vitest';
import { greyboxSequenceSchema, greyboxSequenceFrames, evaluateGreyboxSequence } from './greyboxSequence.js';

const input = () => ({
  version: 1, durationSec: 20, fps: 24,
  scene: {
    parts: [{ id: 'floor', type: 'box', size: [20, 0.1, 12] }],
    anchors: [{ id: 'skater', label: 'Example skater', kind: 'figure', position: [0, 0, 0] }],
    shots: [
      { id: 'wide', label: 'Wide', position: [0, 8, 18], target: [0, 1, 0] },
      { id: 'reverse', label: 'Reverse', position: [0, 8, -18], target: [0, 1, 0] },
    ],
  },
  anchorTracks: [{ anchorId: 'skater', keys: [{ timeSec: 0, position: [-8, 0, 0], facingDegrees: 350 }, { timeSec: 20, position: [8, 0, 0], facingDegrees: 370 }] }],
  shots: [{ shotId: 'wide', startSec: 0, endSec: 10 }, { shotId: 'reverse', startSec: 10, endSec: 20 }],
});

describe('offline greybox sequence contract', () => {
  it('samples one continuous performance across cuts, repeatably and without mutating the layout', () => {
    const plan = greyboxSequenceSchema.parse(input());
    const original = JSON.stringify(plan);
    const end = evaluateGreyboxSequence(plan, 'reverse', 20);
    const reverse = evaluateGreyboxSequence(plan, 'reverse', 10);
    const wide = evaluateGreyboxSequence(plan, 'wide', 10);
    expect(reverse.scene.anchors).toEqual(wide.scene.anchors);
    expect(reverse.scene.anchors[0]).toMatchObject({ position: [0, 0, 0], facingDegrees: 0 });
    expect(end.scene.anchors[0]).toMatchObject({ position: [8, 0, 0], facingDegrees: 10 });
    expect(evaluateGreyboxSequence(plan, 'reverse', 10)).toEqual(reverse);
    expect(JSON.stringify(plan)).toBe(original);
    expect(reverse.shot.position).not.toEqual(wide.shot.position);
  });

  it('uses absolute key times for moving cameras, holding endpoint values outside their keys', () => {
    const raw = input();
    raw.shots[1].keys = [
      { timeSec: 10, position: [0, 6, -18], target: [0, 1, 0], focalLengthMm: 28 },
      { timeSec: 18, position: [8, 6, -18], target: [8, 1, 0], focalLengthMm: 44 },
    ];
    const plan = greyboxSequenceSchema.parse(raw);
    expect(evaluateGreyboxSequence(plan, 'reverse', 14).shot).toMatchObject({ position: [4, 6, -18], target: [4, 1, 0], focalLengthMm: 36 });
    expect(evaluateGreyboxSequence(plan, 'reverse', 20).shot.position).toEqual([8, 6, -18]);
  });

  it('assigns every global frame once at a fractional cut and omits unrequested gaps', () => {
    const raw = input();
    raw.shots[0].endSec = 10.03;
    raw.shots[1].startSec = 10.03;
    const frames = greyboxSequenceFrames(greyboxSequenceSchema.parse(raw));
    expect(frames).toHaveLength(480);
    expect(frames.map((f) => f.frame)).toEqual(Array.from({ length: 480 }, (_, i) => i));
    expect(frames[241]).toMatchObject({ shotId: 'reverse', shotFrame: 0, timeSec: 241 / 24 });
    raw.shots[1].startSec = 12;
    const gapped = greyboxSequenceFrames(greyboxSequenceSchema.parse(raw));
    expect(gapped.filter((f) => f.shotId === 'reverse')[0].frame).toBe(288);
  });

  it('reuses one saved camera for more than sixty separately named cuts', () => {
    const raw = input();
    raw.durationSec = 70;
    raw.shots = Array.from({ length: 70 }, (_, index) => ({ id: `clip-${index}`, shotId: 'wide', startSec: index, endSec: index + 1 }));
    const plan = greyboxSequenceSchema.parse(raw);
    const frames = greyboxSequenceFrames(plan);
    expect(new Set(frames.map((frame) => frame.clipId)).size).toBe(70);
    expect(evaluateGreyboxSequence(plan, 'clip-69', 69).shot.id).toBe('wide');
    expect(frames.at(-1)).toMatchObject({ clipId: 'clip-69', shotId: 'wide', shotFrame: 23 });
  });

  it.each([
    ['unknown anchor', (p) => { p.anchorTracks[0].anchorId = 'missing'; }],
    ['duplicate track', (p) => { p.anchorTracks.push(p.anchorTracks[0]); }],
    ['unordered keys', (p) => { p.anchorTracks[0].keys.reverse(); }],
    ['out-of-bounds keys', (p) => { p.anchorTracks[0].keys[1].timeSec = 21; }],
    ['overlapping shots', (p) => { p.shots[1].startSec = 9; }],
    ['missing camera', (p) => { p.shots[0].shotId = 'missing'; }],
    ['subframe shot', (p) => { p.shots[0].startSec = 0.001; p.shots[0].endSec = 0.002; }],
    ['GLB capture', (p) => { p.scene.source = 'glb'; }],
  ])('refuses %s before capture', (_name, alter) => {
    const raw = input(); alter(raw);
    expect(greyboxSequenceSchema.safeParse(raw).success).toBe(false);
  });
});
