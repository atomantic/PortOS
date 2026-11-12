/**
 * Decide whether listing a film's shots needs Blender, and list a code-only
 * film with system Python. A film whose source imports bpy, bmesh or mathutils
 * stays on the Blender driver (and its trusted-local check). Anything else is
 * described here, with no Blender configured. The film is still the operator's
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
const HOST_MODULES = new Set(['bpy', 'bmesh', 'mathutils']);
const MANIFEST_MAX_BYTES = 4 * 1024 * 1024;

const stripComment = (line) => {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === quote && line[index - 1] !== '\\') quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '#') return line.slice(0, index);
  }
  return line;
};

/** Logical lines, so an import split across parentheses is still one import. */
function logicalLines(text) {
  const lines = [];
  let buffer = '';
  let depth = 0;
  for (const raw of String(text).split('\n')) {
    const line = stripComment(raw).replace(/\\\s*$/, ' ');
    buffer = buffer ? `${buffer} ${line}` : line;
    depth += (line.match(/\(/g) || []).length - (line.match(/\)/g) || []).length;
    if (depth <= 0) {
      if (buffer.trim()) lines.push(buffer.trim());
      buffer = '';
      depth = 0;
    }
  }
  if (buffer.trim()) lines.push(buffer.trim());
  return lines;
}

function importTargets(line) {
  const from = line.match(/^from\s+(\.+)?([\w.]*)\s+import\s+(.+)$/);
  if (from) {
    const names = from[3].replace(/[()]/g, ' ').split(',')
      .map((part) => part.trim().split(/\s+as\s+/i)[0].trim())
      .filter((name) => name && name !== '*');
    return { dots: (from[1] || '').length, base: from[2] || '', names };
  }
  const imported = line.match(/^import\s+(.+)$/);
  if (!imported) return null;
  const names = imported[1].split(',').map((part) => part.trim().split(/\s+as\s+/i)[0].trim()).filter(Boolean);
  return { dots: 0, base: '', names };
}

function moduleRoots(currentRel, parsed) {
  if (parsed.dots || parsed.base) {
    const dir = currentRel.split('/').slice(0, -1);
    for (let step = 1; step < parsed.dots; step += 1) dir.pop();
    const root = [...(parsed.dots ? dir : []), ...(parsed.base ? parsed.base.split('.') : [])];
    const roots = [root];
    for (const name of parsed.names) if (/^[A-Za-z_]\w*$/.test(name)) roots.push([...root, name]);
    return roots;
  }
  return parsed.names.map((name) => name.split('.').filter(Boolean));
}

async function pythonFileExists(src, parts) {
  if (!parts.length) return null;
  const rel = parts.join('/');
  for (const candidate of [`${rel}.py`, `${rel}/__init__.py`]) {
    const absolute = join(src, ...candidate.split('/'));
    if ((await lstat(absolute).catch(() => null))?.isFile()) return candidate;
  }
  return null;
}

/**
 * True when `srcDir`'s film.py (and the local modules it imports) touches
 * Blender. A missing film does not. `portos_film` is the shipped helper kit
 * and is not followed into src/.
 */
async function pythonFilmNeedsBlender(srcDir) {
  const pending = ['film.py'];
  const seen = new Set();
  while (pending.length) {
    const rel = pending.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const text = await readFile(join(srcDir, ...rel.split('/')), 'utf8').catch(() => null);
    if (text == null) continue;
    for (const line of logicalLines(text)) {
      const parsed = importTargets(line);
      if (!parsed) continue;
      for (const parts of moduleRoots(rel, parsed)) {
        const root = parts[0];
        if (!root || root === 'portos_film') continue;
        if (HOST_MODULES.has(root)) return true;
        // Follow the package prefix too: `from kit import look` runs kit/__init__.py.
        for (let length = 1; length <= parts.length; length += 1) {
          const file = await pythonFileExists(srcDir, parts.slice(0, length));
          if (file && !seen.has(file)) pending.push(file);
        }
      }
    }
  }
  return false;
}

/**
 * Whether listing shots needs the Blender tool. A missing film stays on that
 * gate: contained mode still refuses before the "no film" answer, and a code
 * film (no bpy, bmesh or mathutils) does not.
 */
export async function describeNeedsBlender(owner) {
  const src = blenderSrcDir(owner);
  if (!(await lstat(join(src, 'film.py')).catch(() => null))?.isFile()) return true;
  return pythonFilmNeedsBlender(src);
}

/** Python 3, or a 503 naming what is missing. Checked before the sync job starts. */
export async function requirePythonDescribe() {
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
