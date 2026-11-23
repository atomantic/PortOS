/**
 * Runs the PortOS Blender model driver (py/portos_model_driver.py) for one
 * build or review through the shared Trusted local launcher
 * (../blenderWorkspace/worker.js). The worker's own workspace holds only the
 * staged driver and job; the driver writes model.blend and model.glb straight
 * into builds/<buildId>/, so a canceled or crashed build leaves at most a
 * partial build folder the record marks failed. The staged files are the
 * driver, portos_bake.py and the portos_model kit (py/, minus the starter), so
 * a model's `import portos_model` works wherever Blender runs.
 */
import { readFile } from 'node:fs/promises';
import { requireTrustedLocalBlender, runBlenderDriverScript } from '../blenderWorkspace/worker.js';
import { parseBlenderModelDriverLine } from './protocol.js';

const DRIVER = 'portos_model_driver.py';
const GIB = 1024 ** 3;
const BUILD_LIMITS = Object.freeze({ wallSeconds: 30 * 60, memoryBytes: 16 * GIB, diskBytes: 4 * GIB, maxFiles: 10_000 });

// Literal URLs, not a directory walk: the test memo (scripts/lib/testMemo.js) can only key a read it can see.
// bake.test.js fails when py/ holds a driver-side file this list does not stage.
const STAGED_DRIVER_FILES = Object.freeze([
  ['portos_model_driver.py', new URL('./py/portos_model_driver.py', import.meta.url)],
  ['portos_model_motion.py', new URL('./py/portos_model_motion.py', import.meta.url)],
  ['portos_model_poses.py', new URL('./py/portos_model_poses.py', import.meta.url)],
  ['portos_bake.py', new URL('./py/portos_bake.py', import.meta.url)],
  ['portos_model/bake.py', new URL('./py/portos_model/bake.py', import.meta.url)],
  ['portos_model/package.py', new URL('./py/portos_model/package.py', import.meta.url)],
  ['portos_model/parts.py', new URL('./py/portos_model/parts.py', import.meta.url)],
  ['portos_model/wear.py', new URL('./py/portos_model/wear.py', import.meta.url)],
]);
export const BLENDER_MODEL_STAGED_PATHS = STAGED_DRIVER_FILES.map(([path]) => path);

export const BLENDER_MODEL_NEEDS_TRUSTED_LOCAL = 'A Blender model build runs the model\'s own Python on this host and writes into its workspace, so it needs Blender in Trusted local mode. Switch the execution mode under Blender execution (Code Animation > Production) and run the execution check.';

/** The checked Blender tool for a model build; 409 when it is not ready or not Trusted local. */
export const requireBlenderModelTool = () => requireTrustedLocalBlender(BLENDER_MODEL_NEEDS_TRUSTED_LOCAL);

/**
 * Run one job: `{ mode: 'build', workspace, src, out, quality, sweepSeconds }`, or
 * `{ mode: 'review', blend, out, size, views, looks }` (see review.js), or
 * `{ mode: 'bake', blend, out, set, size, samples, device }` and
 * `{ mode: 'bake-export', blend, glb, out, sets }` (see bake.js).
 * Resolves `{ ok, canceled, error, traceback }` (see runBlenderDriverScript).
 */
export async function runBlenderModelDriver({ tool, job, signal, onEvent, onLog }) {
  return runBlenderDriverScript({
    tool,
    entrypoint: DRIVER,
    files: [
      ...await Promise.all(STAGED_DRIVER_FILES.map(async ([path, url]) => ({ path, content: await readFile(url) }))),
      { path: 'job.json', content: JSON.stringify(job) },
    ],
    limits: BUILD_LIMITS,
    signal,
    parseLine: parseBlenderModelDriverLine,
    onEvent,
    onLog,
  });
}
