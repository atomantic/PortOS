// Strip macOS `Malloc*` debug env vars before spawning a child process.
//
// When PortOS is launched from Pinokio (or any tool that exports an empty or
// zero `MallocStackLogging` / `MallocScribble` / similar var), every Python
// subprocess prints
//   `MallocStackLogging: can't turn off malloc stack logging because it was not enabled`
// once per child exit. The image-gen and video-gen helpers fan out into
// download/probe subprocesses, so a single render can flood stderr with
// dozens of these lines and bury real progress.
//
// The Malloc* family is documented in libmalloc(3) and only affects macOS;
// stripping the prefix is a no-op on Linux/Windows.
import { execFile, execFileSync } from './childProcess.js';
import { promisify } from 'util';
import { accessSync, constants, statSync } from 'fs';
import { delimiter, isAbsolute, join, resolve } from 'path';

const execFileAsync = promisify(execFile);
const IS_WIN = process.platform === 'win32';

export function stripDebugMallocEnv(env) {
  return Object.fromEntries(
    Object.entries(env).filter(([k]) => !k.startsWith('Malloc'))
  );
}

export function safeChildProcessEnv(extra = {}) {
  return stripDebugMallocEnv({ ...process.env, ...extra });
}

// Canonical options for background server subprocesses. PM2 detaches PortOS
// from its launch terminal, so a Windows console executable spawned without
// windowsHide asks the default terminal host to open a transient UI window.
export function safeChildProcessOptions(options = {}) {
  const { env = process.env, ...rest } = options;
  return { ...rest, env: stripDebugMallocEnv(env), windowsHide: true };
}

// Resolve the first PATH hit for a binary via `which` (POSIX) / `where`
// (Windows) — the "is this system tool installed, and where?" probe copied
// inline across ytdlp/ffmpeg/pythonSetup/voice discovery. Returns the absolute
// path of the first match, or `null` when the binary isn't on PATH or the
// probe fails. Spawns through `safeChildProcessEnv()` (Malloc-stripped) with a
// 5s timeout; `where` can return several lines, so we take the first.
// Synchronous `whichFirst`, for the few callers that resolve a binary while
// building a spawn and cannot await (pythonSetup's detectPythonSync, behind the
// installer spawn). Same contract: absolute path of the first match, or null.
export function whichFirstSync(name) {
  const cmd = IS_WIN ? 'where' : 'which';
  try {
    const stdout = execFileSync(cmd, [name], safeChildProcessOptions({
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    }));
    return stdout.trim().split(/\r?\n/)[0] || null;
  } catch {
    return null; // not on PATH, or the probe itself failed
  }
}

export async function whichFirst(name) {
  const cmd = IS_WIN ? 'where' : 'which';
  const { stdout } = await execFileAsync(cmd, [name], safeChildProcessOptions({ timeout: 5000 }))
    .catch(() => ({ stdout: '' }));
  return stdout.trim().split(/\r?\n/)[0] || null;
}

const canExecute = (candidate) => {
  try {
    if (!statSync(candidate).isFile()) return false;
    // Windows does not use POSIX execute bits. Its command processor decides
    // launchability from the extension, which the caller checks below.
    if (!IS_WIN) accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Resolve an executable using the exact PATH a child process will receive.
 *
 * Unlike `whichFirst`, this does not launch `which`/`where`: a provider may
 * deliberately override PATH with only its own bin directory, leaving no
 * system `which` binary available to perform the probe. It returns an absolute
 * path suitable for a direct spawn, or null when the command cannot run.
 *
 * @param {string} name
 * @param {{env?: NodeJS.ProcessEnv|object, cwd?: string}} [options]
 * @returns {string|null}
 */
export function findCommandOnPath(name, { env = process.env, cwd = process.cwd() } = {}) {
  if (!name || typeof name !== 'string') return null;

  // An explicit path is resolved relative to the child cwd (matching spawn),
  // not this server's cwd. This branch also avoids splitting a Windows path on
  // the platform's PATH delimiter.
  if (isAbsolute(name) || /[\\/]/.test(name)) {
    const candidate = isAbsolute(name) ? name : resolve(cwd, name);
    return canExecute(candidate) ? candidate : null;
  }

  const pathValue = env.PATH || env.Path || '';
  const pathDirs = pathValue.split(delimiter);
  const hasExtension = /\.[^./\\]+$/.test(name);
  const extensions = IS_WIN && !hasExtension
    // Do not test an extensionless sibling first: npm installs one for POSIX
    // shells next to its Windows .cmd shim, but it is not natively launchable
    // by a Windows PTY. PATHEXT names exactly the candidates cmd.exe can run.
    ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];

  for (const rawDir of pathDirs) {
    const configuredDir = rawDir.replace(/^"(.*)"$/, '$1') || cwd;
    // A relative PATH entry is relative to the child process's cwd, not the
    // server's own cwd. Return an absolute path so the following probe and PTY
    // launch use the same executable regardless of the runner's cwd.
    const dir = isAbsolute(configuredDir) ? configuredDir : resolve(cwd, configuredDir);
    for (const extension of extensions) {
      const candidate = join(dir, `${name}${extension}`);
      if (canExecute(candidate)) return candidate;
    }
  }
  return null;
}
