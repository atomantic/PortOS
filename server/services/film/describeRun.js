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
import { bufferedSpawn } from '../../lib/bufferedSpawn.js';
import { stripDebugMallocEnv, whichFirst, withoutServerSecretsEnv } from '../../lib/processEnv.js';
import { DESCRIBE_LIMITS } from './limits.js';
import { parseBlenderDriverLine } from './protocol.js';
import { blenderRefusal, blenderScratchDir, blenderSrcDir } from './workspace.js';

const PY_DIR = fileURLToPath(new URL('./py/', import.meta.url));
const DESCRIBE_SCRIPT = join(PY_DIR, 'portos_film_describe.py');
const SCAN_SCRIPT = join(PY_DIR, 'portos_film_import_scan.py');
const IMPORT_SCAN_TIMEOUT_MS = 10_000;
const MANIFEST_MAX_BYTES = 4 * 1024 * 1024;

function filmPythonEnv() {
  return {
    ...stripDebugMallocEnv(withoutServerSecretsEnv()),
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
  };
}

/**
 * `blender`, `python`, or null when the scan could not be read. The scanner
 * parses the film; it does not run it. Null stays on the Blender gate.
 */
async function scanFilmImports(python, src) {
  const result = await bufferedSpawn(python, [SCAN_SCRIPT, src], {
    cwd: dirname(SCAN_SCRIPT),
    env: filmPythonEnv(),
    timeoutMs: IMPORT_SCAN_TIMEOUT_MS,
    processGroup: true,
  }).catch(() => null);
  if (!result?.success) return null;
  const answer = result.stdout.trim();
  return answer === 'blender' || answer === 'python' ? answer : null;
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
  try {
    const result = await bufferedSpawn(python, [DESCRIBE_SCRIPT, '--', jobPath], {
      cwd: dirname(DESCRIBE_SCRIPT),
      env: { ...filmPythonEnv(), PYTHONPATH: PY_DIR },
      timeoutMs: DESCRIBE_LIMITS.wallSeconds * 1000,
      processGroup: true,
      signal,
      onOutput: (chunk) => takeLines(chunk, onLog, lines),
    }).catch((error) => ({ error }));
    const canceled = signal?.aborted || result.aborted || result.signal === 'SIGTERM' || result.signal === 'SIGKILL';
    if (canceled) return { ok: false, canceled: true, error: 'Canceled', traceback: null, manifest: null, events: {} };
    if (result.timedOut) {
      return {
        ok: false, canceled: false, error: `The film exceeded the ${DESCRIBE_LIMITS.wallSeconds}s limit for listing shots`,
        traceback: null, manifest: null, events: {},
      };
    }
    for (const line of lines) {
      const event = parseBlenderDriverLine(line);
      if (event?.event === 'error') failure = event;
    }
    const info = await lstat(manifestPath).catch(() => null);
    if (result.success && info?.isFile() && info.size <= MANIFEST_MAX_BYTES) {
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
