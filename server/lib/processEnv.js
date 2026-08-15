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
