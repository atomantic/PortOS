/**
 * Decide whether listing a film's shots needs Blender, and list a code-only
 * film with system Python. A film whose source imports bpy, bmesh or mathutils
 * stays on the Blender driver. Anything else is described here, with no Blender
 * configured, under the same trusted-local execution setting. The film is still the operator's
 * own Python: it can read the workspace, and it cannot choose where the
 * manifest is written.
 */
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from '../../lib/childProcess.js';
import { safeChildProcessOptions, whichFirst, withoutServerSecretsEnv } from '../../lib/processEnv.js';
import { withSpawnCwdEnv } from '../../lib/spawnCwd.js';
import { parseBlenderDriverLine } from './protocol.js';
import { blenderRefusal, blenderScratchDir, blenderSrcDir } from './workspace.js';

const PY_DIR = fileURLToPath(new URL('./py/', import.meta.url));
const DESCRIBE_SCRIPT = join(PY_DIR, 'portos_film_describe.py');
const SCAN_SCRIPT = join(PY_DIR, 'portos_film_import_scan.py');
const MANIFEST_MAX_BYTES = 4 * 1024 * 1024;

/**
 * `blender`, `python`, or null when the scan could not be read. The scanner
 * parses the film; it does not run it. Null stays on the Blender gate.
 */
function scanFilmImports(python, src) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (answer) => { if (!settled) { settled = true; resolve(answer); } };
    const chunks = [];
    let child;
    try {
      const cwd = dirname(SCAN_SCRIPT);
      const env = withSpawnCwdEnv(withoutServerSecretsEnv(process.env), cwd);
      env.PYTHONNOUSERSITE = '1';
      env.PYTHONDONTWRITEBYTECODE = '1';
      child = spawn(python, [SCAN_SCRIPT, src], safeChildProcessOptions({
        cwd, env, stdio: ['ignore', 'pipe', 'pipe'],
      }));
    } catch {
      finish(null);
      return;
    }
    child.stdout.on('data', (chunk) => { if (chunks.length < 8) chunks.push(chunk); });
    child.stderr.on('data', () => {});
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      const answer = Buffer.concat(chunks).toString('utf8').trim();
      finish(code === 0 && (answer === 'blender' || answer === 'python') ? answer : null);
    });
  });
}

/**
 * Whether listing shots needs the Blender tool. A missing film stays on that
 * gate: contained mode still refuses before the "no film" answer, and a code
 * film (no bpy, bmesh or mathutils) does not.
 */
export async function describeNeedsBlender(owner) {
  const src = blenderSrcDir(owner);
  if (!(await lstat(join(src, 'film.py')).catch(() => null))?.isFile()) return true;
  const python = (await whichFirst('python3')) || (await whichFirst('python'));
  // No interpreter, or a scan that cannot show the film is code-only, stays on the Blender gate.
  if (!python) return true;
  return await scanFilmImports(python, src) !== 'python';
}

/** Python 3, or a 503 naming what is missing. Checked before the sync job starts. */
export async function requirePythonDescribe() {
  const { getCodeAnimationExecution } = await import('../codeAnimation/execution.js');
  if ((await getCodeAnimationExecution()).executionMode !== 'trusted-local') {
    throw blenderRefusal("Listing a code film runs its Python on this host, so it needs Trusted local mode. Switch the execution mode under Blender execution (Code Animation > Production, or this panel's Settings).", 'MUSIC_VIDEO_BLENDER_NEEDS_TRUSTED_LOCAL', 409);
  }
  const python = (await whichFirst('python3')) || (await whichFirst('python'));
  if (!python) {
    throw blenderRefusal("Python 3 is required to list a code film's shots, and it was not found on PATH", 'MUSIC_VIDEO_BLENDER_PYTHON_MISSING', 503);
  }
  return python;
}

function takeLines(chunk, onLog, sink) {
  for (const line of String(chunk).split(/\r?\n/)) {
    if (!line) continue;
    onLog(line);
    if (sink.length < 400) sink.push(line);
  }
}

/**
 * Run describe(ctx) for a code film. Resolves the same shape as
 * `runBlenderDriver`: `{ ok, canceled, error, traceback, manifest, events }`.
 */
export async function runPythonDescribe({ owner, song, signal, onLog = () => {}, job }) {
  const python = await requirePythonDescribe();
  const scratch = blenderScratchDir(owner, `describe-${job.jobId || 'film'}`);
  await rm(scratch, { recursive: true, force: true });
  await mkdir(scratch, { recursive: true });
  const manifestPath = join(scratch, 'manifest.json');
  const jobPath = join(scratch, 'job.json');
  await writeFile(join(scratch, 'song.json'), JSON.stringify(song));
  await writeFile(jobPath, JSON.stringify({ ...job, manifestOut: manifestPath }));
  const lines = [];
  let failure = null;
  // Pin PWD to the spawn cwd. A child that reads PWD instead of its real
  // working directory would otherwise describe the film from the server's
  // checkout (#3193).
  const cwd = dirname(DESCRIBE_SCRIPT);
  const env = withSpawnCwdEnv(withoutServerSecretsEnv(process.env), cwd);
  env.PYTHONPATH = PY_DIR;
  env.PYTHONNOUSERSITE = '1';
  env.PYTHONDONTWRITEBYTECODE = '1';
  const run = () => new Promise((resolve) => {
    let settled = false;
    const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
    let child;
    try {
      child = spawn(python, [DESCRIBE_SCRIPT, '--', jobPath], safeChildProcessOptions({
        cwd, env, signal, stdio: ['ignore', 'pipe', 'pipe'],
      }));
    } catch (error) {
      finish({ code: 1, error });
      return;
    }
    child.stdout.on('data', (chunk) => takeLines(chunk, onLog, lines));
    child.stderr.on('data', (chunk) => takeLines(chunk, onLog, lines));
    child.on('error', (error) => finish({ code: 1, error }));
    child.on('close', (code, killSignal) => finish({ code: code ?? 1, killSignal }));
  });
  try {
    if (signal?.aborted) return { ok: false, canceled: true, error: 'Canceled', traceback: null, manifest: null, events: {} };
    const result = await run();
    for (const line of lines) {
      const event = parseBlenderDriverLine(line);
      if (event?.event === 'error') failure = event;
    }
    const canceled = signal?.aborted || result.killSignal === 'SIGTERM' || result.killSignal === 'SIGKILL';
    if (canceled) return { ok: false, canceled: true, error: 'Canceled', traceback: null, manifest: null, events: {} };
    const info = await lstat(manifestPath).catch(() => null);
    if (result.code === 0 && info?.isFile() && info.size <= MANIFEST_MAX_BYTES) {
      const manifest = await readFile(manifestPath, 'utf8').then((text) => JSON.parse(text)).catch(() => null);
      if (manifest) return { ok: true, canceled: false, error: null, traceback: null, manifest, events: {} };
    }
    return {
      ok: false, canceled: false, manifest: null, events: {},
      error: failure?.message || result.error?.message || 'The film could not list its shots',
      traceback: failure?.traceback || null,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
