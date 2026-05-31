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
export function stripDebugMallocEnv(env) {
  return Object.fromEntries(
    Object.entries(env).filter(([k]) => !k.startsWith('Malloc'))
  );
}

export function safeChildProcessEnv(extra = {}) {
  return stripDebugMallocEnv({ ...process.env, ...extra });
}
