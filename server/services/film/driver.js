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
import { PATHS } from '../../lib/paths.js';
import { codeAnimationWorkerFailure } from '../../lib/codeAnimationContainment.js';
import { blenderRefusal, blenderRendersDir, blenderSongFile, blenderSrcDir, blenderWorkspaceDir } from './workspace.js';
import { BLENDER_NEEDS_TRUSTED_LOCAL } from './state.js';
import { parseBlenderDriverLine } from './protocol.js';

const PY_DIR = fileURLToPath(new URL('./py/', import.meta.url));
const DRIVER = 'portos_blender_driver.py';
const KIT = 'portos_film';
// Shared with every other PortOS-owned Blender run; each run owns one UUID folder in it.
const WORKER_ROOT = 'code-animation-workspaces';
const GIB = 1024 ** 3;
const RENDER_LIMITS = Object.freeze({ wallSeconds: 6 * 60 * 60, memoryBytes: 32 * GIB, diskBytes: 16 * GIB, maxFiles: 200_000 });
const DESCRIBE_LIMITS = Object.freeze({ wallSeconds: 5 * 60, memoryBytes: 8 * GIB, diskBytes: GIB, maxFiles: 10_000 });
const MANIFEST_MAX_BYTES = 4 * 1024 * 1024;

/** The checked Blender tool for a film job; 409 when it is not ready or not Trusted local. */
export async function requireBlenderFilmTool() {
  const { getCodeAnimationExecution, resolveBlenderTool } = await import('../codeAnimation/execution.js');
  if ((await getCodeAnimationExecution()).executionMode !== 'trusted-local') {
    throw blenderRefusal(BLENDER_NEEDS_TRUSTED_LOCAL, 'MUSIC_VIDEO_BLENDER_NEEDS_TRUSTED_LOCAL', 409);
  }
  return resolveBlenderTool();
}

// Read from disk for each job: the driver and kit are plain source files.
async function stagedDriverFiles() {
  const kit = (await readdir(join(PY_DIR, KIT))).filter((name) => name.endsWith('.py')).sort();
  return Promise.all([DRIVER, ...kit.map((name) => `${KIT}/${name}`)].map(async (path) => ({
    path, content: await readFile(join(PY_DIR, ...path.split('/'))),
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
  let failure = null;
  let manifest = null;
  const seen = { start: null, done: null };
  const run = await tool.worker({
    tool: {
      executable: tool.executable,
      argv: (entry, workspace) => ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1',
        '--python', entry, '--', join(workspace, 'input', 'job.json')],
    },
    workspaceRoot: join(PATHS.data, WORKER_ROOT),
    entrypoint: DRIVER,
    files: [...await stagedDriverFiles(),
      { path: 'job.json', content: JSON.stringify(job) }, { path: 'song.json', content: JSON.stringify(song) }],
    limits: describe ? DESCRIBE_LIMITS : RENDER_LIMITS,
    signal,
    onStdoutLine: (line) => {
      const event = parseBlenderDriverLine(line);
      // The error event carries its traceback JSON-escaped on one line; the caller writes it out as text.
      if (event?.event !== 'error') onLog(line);
      if (!event) return;
      if (event.event === 'error') failure = event;
      if (event.event === 'start' || event.event === 'done') seen[event.event] = event;
      onEvent(event);
    },
    onStderrLine: onLog,
    onOutput: describe ? async (directory, outputs) => {
      const written = outputs.find((file) => file.path === 'manifest.json');
      if (!written || written.bytes > MANIFEST_MAX_BYTES) return;
      // Unparseable output is reported as "no shot list", like a missing one.
      manifest = await readFile(join(directory, 'manifest.json'), 'utf8').then((text) => JSON.parse(text)).catch(() => null);
    } : undefined,
  });
  if (run.status === 'completed') return { ok: true, canceled: false, error: null, traceback: null, manifest, events: seen };
  const canceled = run.status === 'terminated' && run.reason === 'canceled';
  return {
    ok: false, canceled, manifest: null, events: seen,
    error: canceled ? 'Canceled' : failure?.message || codeAnimationWorkerFailure(run),
    traceback: failure?.traceback || null,
  };
}
