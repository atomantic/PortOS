/**
 * Runs the PortOS Blender film driver (py/portos_blender_driver.py) for one
 * job, through the operator-owned Blender tool and its supervised worker.
 *
 * A film is the operator's own Python with host access, rendering on the GPU
 * and writing frames straight into the project workspace, so this lane accepts
 * only Trusted local execution; a contained Blender is refused, and nothing
 * here changes that setting. The worker's own workspace holds just the staged
 * driver, helper kit, job and song (read-only); the frames land in renders/,
 * so a cancelled or crashed job keeps what it finished.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathWithin } from '../../../lib/pathWithin.js';
import { requireTrustedLocalBlender, runBlenderDriverScript } from '../blenderWorkspace/worker.js';
import { blenderRendersDir, blenderSongFile, blenderSrcDir, blenderWorkspaceDir } from './workspace.js';
import { BLENDER_NEEDS_TRUSTED_LOCAL } from './state.js';
import { parseBlenderDriverLine } from './protocol.js';
import { DESCRIBE_LIMITS, RENDER_LIMITS } from './limits.js';

const PY_DIR = fileURLToPath(new URL('./py/', import.meta.url));
const DRIVER = 'portos_blender_driver.py';
const KIT = 'portos_film';
const MANIFEST_MAX_BYTES = 4 * 1024 * 1024;

/** The checked Blender tool for a film job; 409 when it is not ready or not Trusted local. */
export const requireBlenderFilmTool = () => requireTrustedLocalBlender(BLENDER_NEEDS_TRUSTED_LOCAL);

/** A shipped driver or kit file by its `/`-separated path; a path that climbs out of py/ throws (`pathWithin`). */
export const driverSourcePath = (path) => pathWithin(PY_DIR, ...path.split('/'));

// Read from disk for each job: the driver and kit are plain source files.
async function stagedDriverFiles() {
  const kit = (await readdir(join(PY_DIR, KIT))).filter((name) => name.endsWith('.py')).sort();
  return Promise.all([DRIVER, ...kit.map((name) => `${KIT}/${name}`)].map(async (path) => ({
    path, content: await readFile(driverSourcePath(path)),
  })));
}

/** The job fields every mode shares. `options` is what the film reads as `ctx.options`. */
export const blenderJobBase = (owner, { settings, options }) => ({
  workspace: blenderWorkspaceDir(owner),
  src: blenderSrcDir(owner),
  out: blenderRendersDir(owner),
  songPath: blenderSongFile(owner),
  engine: settings.engine,
  width: settings.width,
  height: settings.height,
  fps: settings.fps,
  options,
});

/**
 * Run one driver job. `onEvent(event)` receives each protocol event as it is
 * printed and `onLog(line)` every output line. Resolves
 * `{ ok, canceled, error, traceback, manifest, events }`; a failure is a value,
 * not a throw, so the caller decides how its job ends.
 */
export async function runBlenderDriver({ tool, job, song, signal, onEvent = () => {}, onLog = () => {} }) {
  const describe = job.mode === 'describe';
  let manifest = null;
  const seen = { start: null, done: null };
  const result = await runBlenderDriverScript({
    tool,
    entrypoint: DRIVER,
    files: [...await stagedDriverFiles(),
      { path: 'job.json', content: JSON.stringify(job) }, { path: 'song.json', content: JSON.stringify(song) }],
    limits: describe ? DESCRIBE_LIMITS : RENDER_LIMITS,
    signal,
    parseLine: parseBlenderDriverLine,
    onEvent: (event) => {
      if (event.event === 'start' || event.event === 'done') seen[event.event] = event;
      onEvent(event);
    },
    onLog,
    onOutput: describe ? async (directory, outputs) => {
      const written = outputs.find((file) => file.path === 'manifest.json');
      if (!written || written.bytes > MANIFEST_MAX_BYTES) return;
      // Unparseable output is reported as "no shot list", like a missing one.
      manifest = await readFile(join(directory, 'manifest.json'), 'utf8').then((text) => JSON.parse(text)).catch(() => null);
    } : undefined,
  });
  return { ...result, manifest: result.ok ? manifest : null, events: seen };
}
