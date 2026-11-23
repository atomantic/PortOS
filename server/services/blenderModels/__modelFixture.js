/**
 * Test double for the Blender tool a model build runs through: an execution
 * report, a `resolveBlenderTool` and a worker that plays the model driver's
 * part without starting Blender. It reads the staged job.json, writes
 * model.blend and model.glb where the real driver would, and prints the driver
 * events recorded from a real Blender 5.3 build of the shipped starter
 * (py/starter/model.py, draft quality) on macOS. `control.edit(events)` alters
 * the recorded events before they are printed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ServerError } from '../../lib/errorHandler.js';

const line = (event) => `PORTOS_MODEL ${JSON.stringify(event)}`;

/** The starter's events as the real driver printed them (output paths are filled in per job). */
export const recordedStarterEvents = () => [
  { event: 'start', blender: '5.3.0', quality: 'draft' },
  { event: 'part', id: 'base', label: 'Weighted base', parent: null },
  { event: 'part', id: 'stem', label: 'Stem', parent: 'base' },
  { event: 'part', id: 'shade', label: 'Shade', parent: 'stem' },
  { event: 'described', title: 'Desk lamp', sizeMeters: { x: 0.22, y: 0.22, z: 0.52 }, triangleBudget: 2000, controls: null, partsTruncated: false },
  { event: 'mesh', name: 'base', parent: null, triangles: 60, min: [-0.09000000357627869, -0.09000000357627869, 0.0], max: [0.09000000357627869, 0.09000000357627869, 0.019999999552965164], scale: [1.0, 1.0, 1.0], negative: false, materials: 1 },
  { event: 'mesh', name: 'stem', parent: 'base', triangles: 60, min: [-0.012000000104308128, -0.012000000104308128, 0.019999995827674866], max: [0.012000000104308128, 0.012000000104308128, 0.3799999952316284], scale: [1.0, 1.0, 1.0], negative: false, materials: 1 },
  { event: 'mesh', name: 'shade', parent: 'stem', triangles: 60, min: [-0.10999999940395355, -0.10999999940395355, 0.3799999952316284], max: [0.10999999940395355, 0.10999999940395355, 0.5199999809265137], scale: [1.0, 1.0, 1.0], negative: false, materials: 1 },
  { event: 'scene', objects: 3, meshes: 3, triangles: 180, materials: 2, images: 0, actions: 0, min: [-0.10999999940395355, -0.10999999940395355, 0.0], max: [0.10999999940395355, 0.10999999940395355, 0.5199999809265137], truncated: false },
  { event: 'saved', blend: null, glb: null, glbBytes: 12484 },
  { event: 'reimport', objects: 3, meshes: 3, triangles: 180, materials: 2, images: 0, actions: 0, min: [-0.10999999940395355, -0.10999999940395355, 0.0], max: [0.10999999940395355, 0.10999999940395355, 0.5199999809265137] },
  { event: 'done', sec: 0.279 },
];

export const FAKE_GLB = Buffer.from('glTF\u0002\u0000\u0000\u0000example-binary-model');

export const createFakeModelBlender = () => {
  const control = {
    executionMode: 'trusted-local',
    ready: true,
    // Every build job.json the worker was handed, in order, and every review one.
    jobs: [],
    reviews: [],
    // A promise a review waits on before its last view.
    reviewHold: null,
    // Rewrites the recorded events for one test.
    edit: null,
    // A promise the build waits on after `described` (to cancel mid-build).
    hold: null,
    // `{ message }`: the model raises after `described`, as a real crash reports it.
    crash: null,
  };

  const review = async (job, { onStdoutLine, signal }) => {
    control.reviews.push(job);
    onStdoutLine(line({ event: 'start', blender: '5.2.3', quality: null }));
    for (const look of job.looks) {
      for (const view of job.views) {
        writeFileSync(join(job.out, `${view.id}-${look}.png`), `${look} ${view.id}`);
        onStdoutLine(line({ event: 'view', id: view.id, look }));
      }
    }
    if (control.reviewHold && !signal?.aborted) await Promise.race([control.reviewHold, new Promise((resolve) => signal?.addEventListener('abort', resolve, { once: true }))]);
    if (signal?.aborted) return { status: 'terminated', reason: 'canceled', exitCode: null, signal: null };
    onStdoutLine(line({ event: 'done', sec: 1 }));
    return { status: 'completed', reason: null, exitCode: 0, signal: null };
  };

  const worker = async ({ files, onStdoutLine = () => {}, signal }) => {
    const job = JSON.parse(String(files.find((file) => file.path === 'job.json').content));
    if (job.mode === 'review') return review(job, { onStdoutLine, signal });
    control.jobs.push({ ...job, staged: files.map((file) => file.path).sort() });
    const events = (control.edit ? control.edit(recordedStarterEvents()) : recordedStarterEvents());
    for (const event of events) {
      if (event.event === 'mesh' && control.hold) {
        await Promise.race([control.hold, new Promise((resolve) => signal?.addEventListener('abort', resolve, { once: true }))]);
      }
      if (signal?.aborted) return { status: 'terminated', reason: 'canceled', exitCode: null, signal: null };
      if (event.event === 'mesh' && control.crash) {
        onStdoutLine(line({ event: 'error', message: control.crash.message, traceback: 'Traceback (most recent call last):\n  File "model.py", line 1\nRuntimeError: example' }));
        return { status: 'failed', reason: 'exit', exitCode: 1, signal: null };
      }
      if (event.event === 'saved') {
        mkdirSync(job.out, { recursive: true });
        writeFileSync(join(job.out, 'model.blend'), 'BLENDER-example');
        writeFileSync(join(job.out, 'model.glb'), FAKE_GLB);
        onStdoutLine(line({ ...event, blend: join(job.out, 'model.blend'), glb: join(job.out, 'model.glb'), glbBytes: FAKE_GLB.length }));
        continue;
      }
      onStdoutLine(line(event));
      if (event.event === 'described') onStdoutLine('Built the lamp with 16 sides');
    }
    return { status: 'completed', reason: null, exitCode: 0, signal: null };
  };

  const getCodeAnimationExecution = async () => ({
    executionMode: control.executionMode,
    lanes: { blender: { ready: control.ready, reason: control.ready ? null : 'Run the execution check first.' } },
    tools: { blender: { engine: 'BLENDER_EEVEE_NEXT', executable: '/opt/example/Blender' } },
    probe: control.ready ? { tools: { blender: { version: '5.3.0' } } } : null,
  });

  const resolveBlenderTool = async () => {
    if (!control.ready) throw new ServerError('Run the execution check first', { status: 409, code: 'CODE_ANIMATION_BLENDER_NOT_READY' });
    return { executable: '/opt/example/Blender', executionMode: control.executionMode, version: '5.3.0', worker };
  };

  return { control, worker, getCodeAnimationExecution, resolveBlenderTool };
};
