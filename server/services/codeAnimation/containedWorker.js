/**
 * Contained Code Animation worker (#9388): stage files into a fresh, owned
 * workspace, run one operator-configured executable under the enforced OS
 * sandbox with a from-scratch environment, enforce wall-time / disk / file /
 * memory limits, own the process group through cancellation, and validate
 * what the worker left behind. No uncontained fallback exists.
 */
import { constants } from 'node:fs';
import { access, lstat, mkdir, open, readdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { ServerError } from '../../lib/errorHandler.js';
import { execFile, spawn } from '../../lib/childProcess.js';
import { withSpawnCwdEnv } from '../../lib/spawnCwd.js';
import {
  CODE_ANIMATION_SEATBELT, codeAnimationContainmentMechanism, codeAnimationSeatbeltProfile,
  codeAnimationToolRoots, codeAnimationWorkerEnv, codeAnimationWorkerLimitsSchema,
} from '../../lib/codeAnimationContainment.js';

const execFileAsync = promisify(execFile);
const WORKSPACE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SEGMENT = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9_-])?$/i;
const TAIL_BYTES = 8192;
const active = new Set();
const swept = new Set();

const canExecute = (path) => access(path, constants.X_OK).then(() => true, () => false);

/** The enforced mechanism for this host, probing only that the sandbox binary is executable. */
export async function currentContainmentMechanism(seatbeltPath = CODE_ANIMATION_SEATBELT) {
  return codeAnimationContainmentMechanism(process.platform, process.platform === 'darwin' && await canExecute(seatbeltPath));
}

// A crash leaves its workspace behind; nothing else may own a UUID entry here.
async function sweepOnce(root) {
  if (swept.has(root)) return;
  swept.add(root);
  for (const name of await readdir(root).catch(() => [])) {
    if (WORKSPACE_NAME.test(name) && !active.has(join(root, name))) await rm(join(root, name), { recursive: true, force: true });
  }
}

async function stage(input, files) {
  for (const file of files) {
    const parts = String(file.path).split('/');
    if (!parts.every((part) => SEGMENT.test(part))) throw new ServerError('Staged worker paths must be portable relative paths', { status: 400, code: 'CODE_ANIMATION_STAGE_PATH' });
    let parent = input;
    for (const part of parts.slice(0, -1)) {
      parent = join(parent, part);
      await mkdir(parent, { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
      const info = await lstat(parent);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new ServerError('Staged worker paths collide', { status: 400, code: 'CODE_ANIMATION_STAGE_PATH' });
    }
    const handle = await open(join(input, file.path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o444);
    try {
      await handle.writeFile(Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8'));
    } finally { await handle.close(); }
  }
}

// lstat walk: never follows a link the worker made. Non-regular entries and
// multiply-linked files are reported, not read.
async function measure(dirs, { maxFiles }) {
  let bytes = 0;
  let files = 0;
  const outputs = [];
  const invalid = [];
  async function walk(path, prefix, collect) {
    for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
      const full = join(path, entry.name);
      const rel = `${prefix}${entry.name}`;
      const info = await lstat(full).catch(() => null);
      if (!info) continue;
      files += 1;
      if (files > maxFiles) return;
      if (info.isDirectory()) await walk(full, `${rel}/`, collect);
      else {
        bytes += info.size;
        if (!collect) continue;
        if (!info.isFile() || info.nlink !== 1) invalid.push(rel);
        else outputs.push({ path: rel, bytes: info.size });
      }
    }
  }
  for (const [index, dir] of dirs.entries()) await walk(dir, '', index === 0);
  return { bytes, files, outputs, invalid };
}

async function residentBytes(pid) {
  const { stdout } = await execFileAsync('/bin/ps', ['-o', 'rss=', '-p', String(pid)]).catch(() => ({ stdout: '' }));
  const kib = Number.parseInt(stdout.trim(), 10);
  return Number.isFinite(kib) ? kib * 1024 : 0;
}

function groupAlive(pgid) {
  try { process.kill(-pgid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

const tail = () => {
  let text = '';
  return { push: (chunk) => { text = (text + chunk.toString('utf8')).slice(-TAIL_BYTES); }, get: () => text };
};

/**
 * Run `tool` (`{ executable, argv(entryPath, workspace) }`, chosen by server
 * code from operator configuration, never by a package) over `files` in a new
 * workspace under `workspaceRoot`. `onOutput(outputDir, outputs)` runs only for a
 * completed, valid result, before the workspace is removed. Resolves with the
 * run's evidence; refuses (503) when no enforced mechanism is available.
 */
export async function runContainedWorker({
  tool, files = [], entrypoint = null, limits: requested = {}, signal, workspaceRoot,
  onOutput, tickMs = 1000, seatbeltPath = CODE_ANIMATION_SEATBELT,
}) {
  const mechanism = await currentContainmentMechanism(seatbeltPath);
  if (!mechanism.supported) {
    throw new ServerError(`Contained execution refused: ${mechanism.reason}`, { status: 503, code: 'CODE_ANIMATION_CONTAINMENT_UNAVAILABLE' });
  }
  const limits = codeAnimationWorkerLimitsSchema.parse(requested);
  if (entrypoint !== null && !files.some((file) => file.path === entrypoint)) {
    throw new ServerError('The worker entrypoint is not a staged file', { status: 400, code: 'CODE_ANIMATION_STAGE_PATH' });
  }
  signal?.throwIfAborted();
  const executable = await realpath(tool.executable);
  await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
  const root = await realpath(workspaceRoot);
  await sweepOnce(root);
  const workspace = join(root, randomUUID());
  // Exclusive: an existing destination is never reused or followed.
  await mkdir(workspace, { mode: 0o700 });
  active.add(workspace);
  const started = Date.now();
  try {
    for (const name of ['input', 'output', 'tmp', 'home']) await mkdir(join(workspace, name), { mode: 0o700 });
    await stage(join(workspace, 'input'), files);
    const writable = ['output', 'tmp', 'home'].map((name) => join(workspace, name));
    const profile = codeAnimationSeatbeltProfile({ executable, toolRoots: codeAnimationToolRoots(executable), workspace });
    const argv = tool.argv(entrypoint === null ? null : join(workspace, 'input', entrypoint), workspace);
    // RLIMIT_FSIZE caps any single file (macOS sh counts 1 KiB blocks), no core
    // dumps, bounded descriptors. `exec` keeps one pid: sh → sandbox-exec → tool.
    const child = spawn('/bin/sh', ['-c', 'ulimit -c 0 && ulimit -n "$1" && ulimit -f "$2" && shift 2 && exec "$@"',
      'portos-contained-worker', String(limits.openFiles), String(Math.max(1, Math.floor(limits.diskBytes / 1024))),
      seatbeltPath, '-p', profile, executable, ...argv], {
      cwd: join(workspace, 'tmp'), env: withSpawnCwdEnv(codeAnimationWorkerEnv(workspace), join(workspace, 'tmp')), detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = tail();
    const stderr = tail();
    child.stdout.on('data', stdout.push);
    child.stderr.on('data', stderr.push);
    let terminated = null;
    const kill = (reason) => {
      terminated ??= reason;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    };
    const onAbort = () => kill('canceled');
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const timer = setTimeout(() => kill('time'), limits.wallSeconds * 1000);
    let checking = false;
    const watchdog = setInterval(async () => {
      if (checking || terminated) return;
      checking = true;
      try {
        const usage = await measure(writable, limits);
        if (usage.bytes > limits.diskBytes) kill('disk');
        else if (usage.files > limits.maxFiles) kill('files');
        else if (await residentBytes(child.pid) > limits.memoryBytes) kill('memory');
      } catch (error) {
        console.error(`❌ Code Animation worker watchdog failed: ${error.message}`);
        kill('watchdog');
      } finally { checking = false; }
    }, tickMs);
    const exit = await new Promise((resolve) => {
      child.once('error', (error) => resolve({ code: null, signal: null, error }));
      child.once('close', (code, sig) => resolve({ code, signal: sig, error: null }));
    });
    clearTimeout(timer);
    clearInterval(watchdog);
    signal?.removeEventListener('abort', onAbort);
    // The worker cannot fork, but the group is still verified empty, and any
    // straggler is killed before the run is reported.
    let processGroupClear = !groupAlive(child.pid);
    for (let attempt = 0; !processGroupClear && attempt < 20; attempt += 1) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
      processGroupClear = !groupAlive(child.pid);
    }
    if (exit.signal === 'SIGXFSZ') terminated ??= 'file-size';
    const usage = await measure(writable, limits);
    if (!terminated && usage.bytes > limits.diskBytes) terminated = 'disk';
    if (!terminated && usage.files > limits.maxFiles) terminated = 'files';
    let status = 'completed';
    let reason = null;
    if (terminated) { status = 'terminated'; reason = terminated; }
    else if (exit.error || exit.code !== 0) { status = 'failed'; reason = exit.error ? 'spawn' : 'exit'; }
    else if (usage.invalid.length) { status = 'failed'; reason = 'output-invalid'; }
    const result = {
      status, reason, mechanism: mechanism.id, exitCode: exit.code, signal: exit.signal,
      processGroupClear, durationMs: Date.now() - started, limits,
      usage: { bytes: usage.bytes, files: usage.files },
      outputs: status === 'completed' ? usage.outputs : [], invalidOutputs: usage.invalid,
      stdout: stdout.get(), stderr: stderr.get(),
    };
    if (status === 'completed' && onOutput) await onOutput(join(workspace, 'output'), result.outputs);
    return result;
  } finally {
    await rm(workspace, { recursive: true, force: true });
    active.delete(workspace);
  }
}
