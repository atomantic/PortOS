/** Renderer-independent, absolute-time blocking for offline greybox references. */
import { z } from 'zod';
import { greyboxSceneSchema } from './greyboxScene.js';

const time = z.number().finite().min(0).max(3600);
const vec = z.tuple([z.number().finite().min(-1000).max(1000), z.number().finite().min(-1000).max(1000), z.number().finite().min(-1000).max(1000)]);
const anchorKey = z.object({ timeSec: time, position: vec, facingDegrees: z.number().finite().min(-36000).max(36000) }).strict();
const cameraKey = z.object({ timeSec: time, position: vec, target: vec, focalLengthMm: z.number().finite().min(8).max(300) }).strict();

export const greyboxSequenceSchema = z.object({
  version: z.literal(1),
  scene: greyboxSceneSchema,
  durationSec: time.positive(),
  fps: z.number().int().min(1).max(60).default(24),
  anchorTracks: z.array(z.object({ anchorId: z.string(), keys: z.array(anchorKey).min(1).max(2000) }).strict()).max(80).default([]),
  shots: z.array(z.object({ shotId: z.string(), startSec: time, endSec: time, keys: z.array(cameraKey).min(1).max(2000).optional() }).strict()).min(1).max(60),
}).strict().superRefine((plan, ctx) => {
  const fail = (message) => ctx.addIssue({ code: 'custom', message });
  if (plan.scene.source !== 'spec') fail('Sequence capture currently supports primitive layouts only; GLB sequence capture is not available.');
  const used = new Set();
  for (const track of plan.anchorTracks) {
    if (!plan.scene.anchors.some((a) => a.id === track.anchorId)) fail(`Unknown anchor ${track.anchorId}`);
    if (used.has(track.anchorId)) fail(`Duplicate anchor track ${track.anchorId}`);
    used.add(track.anchorId);
  }
  const shotIds = new Set();
  for (const [index, shot] of plan.shots.entries()) {
    if (!plan.scene.shots.some((s) => s.id === shot.shotId)) fail(`Unknown camera ${shot.shotId}`);
    if (shotIds.has(shot.shotId)) fail(`Duplicate sequence shot ${shot.shotId}`);
    shotIds.add(shot.shotId);
    if (shot.endSec <= shot.startSec || shot.endSec > plan.durationSec) fail('Shot ranges must have positive duration within the master timeline.');
    if (index && shot.startSec < plan.shots[index - 1].endSec) fail('Shots must be chronological and must not overlap.');
    if (Math.ceil(shot.endSec * plan.fps - 1e-8) <= Math.ceil(shot.startSec * plan.fps - 1e-8)) fail('Every shot must contain at least one output frame.');
  }
  for (const track of [...plan.anchorTracks, ...plan.shots.filter((s) => s.keys)]) {
    track.keys.forEach((key, index) => {
      if (key.timeSec > plan.durationSec || (index && key.timeSec <= track.keys[index - 1].timeSec)) fail('Key times must strictly increase within the master timeline.');
      if (key.target && key.position.every((v, i) => v === key.target[i])) fail('A camera cannot sit on its target.');
    });
  }
});

function sample(keys, timeSec) {
  const right = keys.findIndex((key) => key.timeSec > timeSec);
  if (right === 0) return keys[0];
  if (right === -1) return keys.at(-1);
  const a = keys[right - 1];
  const b = keys[right];
  const t = (timeSec - a.timeSec) / (b.timeSec - a.timeSec);
  const mix = (x, y) => x + (y - x) * t;
  return Object.fromEntries(Object.keys(a).map((key) => [key, Array.isArray(a[key]) ? a[key].map((v, i) => mix(v, b[key][i])) : mix(a[key], b[key])]));
}

/** Evaluate any frame directly, including out of order. Never resets at a cut. */
export function evaluateGreyboxSequence(plan, shotId, timeSec) {
  if (!Number.isFinite(timeSec) || timeSec < 0 || timeSec > plan.durationSec) throw new Error('Time is outside the master timeline');
  const range = plan.shots.find((shot) => shot.shotId === shotId);
  if (!range) throw new Error('Unknown sequence shot');
  const anchors = plan.scene.anchors.map((anchor) => {
    const track = plan.anchorTracks.find((item) => item.anchorId === anchor.id);
    if (!track) return anchor;
    const { position, facingDegrees } = sample(track.keys, timeSec);
    return { ...anchor, position, facingDegrees: ((facingDegrees % 360) + 540) % 360 - 180 };
  });
  const camera = plan.scene.shots.find((shot) => shot.id === shotId);
  const shot = range.keys ? { ...camera, ...sample(range.keys, timeSec) } : camera;
  if (shot.position.every((v, i) => Math.abs(v - shot.target[i]) < 1e-8)) throw new Error('Interpolated camera sits on its target');
  return { scene: { ...plan.scene, anchors }, shot };
}

/** Half-open ranges on one global frame grid. Gaps are intentional omissions. */
export function greyboxSequenceFrames(plan) {
  return plan.shots.flatMap((shot) => {
    const start = Math.ceil(shot.startSec * plan.fps - 1e-8);
    const end = Math.ceil(shot.endSec * plan.fps - 1e-8);
    return Array.from({ length: end - start }, (_, index) => ({ shotId: shot.shotId, frame: start + index, timeSec: (start + index) / plan.fps, shotFrame: index }));
  });
}
