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
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireTrustedLocalBlender, runBlenderDriverScript } from '../blenderWorkspace/worker.js';
import { parseBlenderModelDriverLine } from './protocol.js';

const DRIVER = 'portos_model_driver.py';
const PY_DIR = fileURLToPath(new URL('./py/', import.meta.url));
const STAGED_SOURCE = /\.py$/;
const GIB = 1024 ** 3;
const BUILD_LIMITS = Object.freeze({ wallSeconds: 30 * 60, memoryBytes: 16 * GIB, diskBytes: 4 * GIB, maxFiles: 10_000 });

export const BLENDER_MODEL_NEEDS_TRUSTED_LOCAL = 'A Blender model build runs the model\'s own Python on this host and writes into its workspace, so it needs Blender in Trusted local mode. Switch the execution mode under Blender execution (Code Animation > Production) and run the execution check.';

/** The checked Blender tool for a model build; 409 when it is not ready or not Trusted local. */
export const requireBlenderModelTool = () => requireTrustedLocalBlender(BLENDER_MODEL_NEEDS_TRUSTED_LOCAL);

// Every driver-side .py file, as `{ path, content }` with `/` separators; the starter is a template, not driver code.
async function stagedDriverFiles(directory = PY_DIR) {
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (absolute !== join(PY_DIR, 'starter') && entry.name !== '__pycache__') files.push(...await stagedDriverFiles(absolute));
    } else if (entry.isFile() && STAGED_SOURCE.test(entry.name)) {
      files.push({ path: relative(PY_DIR, absolute).split('\\').join('/'), content: await readFile(absolute) });
    }
  }
  return files;
}

/**
 * Run one job: `{ mode: 'build', workspace, src, out, quality }`, or
 * `{ mode: 'review', blend, out, size, views, looks }` (see review.js).
 * Resolves `{ ok, canceled, error, traceback }` (see runBlenderDriverScript).
 */
export async function runBlenderModelDriver({ tool, job, signal, onEvent, onLog }) {
  return runBlenderDriverScript({
    tool,
    entrypoint: DRIVER,
    files: [...await stagedDriverFiles(), { path: 'job.json', content: JSON.stringify(job) }],
    limits: BUILD_LIMITS,
    signal,
    parseLine: parseBlenderModelDriverLine,
    onEvent,
    onLog,
  });
}
