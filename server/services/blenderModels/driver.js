/**
 * Runs the PortOS Blender model driver (py/portos_model_driver.py) for one
 * build or review through the shared Trusted local launcher
 * (../blenderWorkspace/worker.js). The worker's own workspace holds only the
 * staged driver and job; the driver writes model.blend and model.glb straight
 * into builds/<buildId>/, so a canceled or crashed build leaves at most a
 * partial build folder the record marks failed.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { requireTrustedLocalBlender, runBlenderDriverScript } from '../blenderWorkspace/worker.js';
import { parseBlenderModelDriverLine } from './protocol.js';

const DRIVER = 'portos_model_driver.py';
const DRIVER_PATH = fileURLToPath(new URL('./py/portos_model_driver.py', import.meta.url));
const GIB = 1024 ** 3;
const BUILD_LIMITS = Object.freeze({ wallSeconds: 30 * 60, memoryBytes: 16 * GIB, diskBytes: 4 * GIB, maxFiles: 10_000 });

export const BLENDER_MODEL_NEEDS_TRUSTED_LOCAL = 'A Blender model build runs the model\'s own Python on this host and writes into its workspace, so it needs Blender in Trusted local mode. Switch the execution mode under Blender execution (Code Animation > Production) and run the execution check.';

/** The checked Blender tool for a model build; 409 when it is not ready or not Trusted local. */
export const requireBlenderModelTool = () => requireTrustedLocalBlender(BLENDER_MODEL_NEEDS_TRUSTED_LOCAL);

/**
 * Run one job: `{ mode: 'build', workspace, src, out, quality }`, or
 * `{ mode: 'review', blend, out, size, views, looks }` (see review.js).
 * Resolves `{ ok, canceled, error, traceback }` (see runBlenderDriverScript).
 */
export async function runBlenderModelDriver({ tool, job, signal, onEvent, onLog }) {
  return runBlenderDriverScript({
    tool,
    entrypoint: DRIVER,
    files: [{ path: DRIVER, content: await readFile(DRIVER_PATH) }, { path: 'job.json', content: JSON.stringify(job) }],
    limits: BUILD_LIMITS,
    signal,
    parseLine: parseBlenderModelDriverLine,
    onEvent,
    onLog,
  });
}
