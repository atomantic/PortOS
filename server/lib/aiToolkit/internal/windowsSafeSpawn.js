/**
 * Windows-safe spawn helpers shared by every CLI probe that resolves a bare
 * command name into an executable path before handing it to `spawn`/`execFile`.
 *
 * Lives here (its own leaf) rather than inline in `providerCatalogService.js`
 * because `internal/codexAppServer.js` needs the same resolution and this
 * directory stays self-contained — no imports out, so a second copy of these
 * rules is the alternative to importing this file.
 */
import { existsSync } from 'fs';
import { join, isAbsolute, delimiter } from 'path';

const WIN_EXECUTABLE_EXTS = ['.exe', '.cmd', '.bat', '.com'];

/**
 * The absolute path of a bare command's Windows shim (`.exe`/`.cmd`/`.bat`/`.com`),
 * or `null` off-Windows, for an already-absolute/pathed command, or when no
 * shim is on `PATH`. `execFile` under `shell: false` refuses a bare `.cmd`
 * name outright, so a caller that only has the vendor's bare command must
 * resolve it first or the probe silently answers nothing.
 */
export function resolveWindowsExecutable(command, isWin32 = process.platform === 'win32', searchEnv = process.env) {
  if (!isWin32 || !command || isAbsolute(command) || /[\\/]/.test(command)) return null;
  const pathDirs = (searchEnv.PATH || searchEnv.Path || '').split(delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    for (const ext of WIN_EXECUTABLE_EXTS) {
      const candidate = join(dir, `${command}${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const WIN_BATCH_EXT_RE = /\.(cmd|bat)$/i;
const CMD_METACHAR_RE = /[&|<>^()]/g;
const NEEDS_NODE_QUOTING_RE = /[\s"]/;

function escapeCmdMetacharsIfUnquoted(value) {
  const str = String(value);
  if (NEEDS_NODE_QUOTING_RE.test(str)) return str;
  return str.replace(CMD_METACHAR_RE, '^$&');
}

/**
 * A `.cmd`/`.bat` target must run through `cmd.exe /c`, or `spawn` under
 * `shell: false` cannot execute it at all. Every other command/argv pair
 * passes through unchanged.
 */
export function prepareWindowsSafeSpawn(command, args, isWin32 = process.platform === 'win32') {
  if (isWin32 && WIN_BATCH_EXT_RE.test(command)) {
    return {
      command: 'cmd.exe',
      args: ['/c', escapeCmdMetacharsIfUnquoted(command), ...args.map(escapeCmdMetacharsIfUnquoted)],
    };
  }
  return { command, args };
}
