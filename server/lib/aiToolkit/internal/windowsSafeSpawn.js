/**
 * Windows command resolution and batch argument escaping shared by host CLI
 * launches, the toolkit runner, and provider catalog probes.
 *
 * This toolkit leaf stays self-contained so host callers can depend inward
 * without requiring toolkit code to import PortOS modules.
 */
import { existsSync, readFileSync } from 'fs';
import { join, dirname, isAbsolute, delimiter } from 'path';

// Prefer native executables to batch shims; ignore npm's POSIX extensionless stubs.
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
// cmd.exe cannot carry these as data: Node escapes an embedded `"` as `\"`,
// which cmd.exe does not honor, so the quote ends the quoted span and the rest
// is parsed as commands; `%VAR%` expands even inside quotes; CR/LF end the
// command line. Prompts routinely contain all of them (#12346).
const CMD_UNCARRYABLE_RE = /["%\r\n]/;
// The script/binary an npm cmd-shim forwards `%*` to, in both the current
// (`"%dp0%\…" %*`) and legacy (`"%~dp0\…" %*`) cmd-shim layouts.
const CMD_SHIM_TARGET_RE = /"%~?dp0%?\\([^"]+)"\s+%\*/g;
const CMD_SHIM_NODE_RE = /%~?dp0%?\\node\.exe"/i;
const WINDOWS_BATCH_ARG_UNSAFE = 'WINDOWS_BATCH_ARG_UNSAFE';

function escapeCmdMetachars(value, carets) {
  const str = String(value);
  if (NEEDS_NODE_QUOTING_RE.test(str)) return str;
  return str.replace(CMD_METACHAR_RE, `${carets}$&`);
}

/**
 * The direct launch an npm-style cmd-shim performs — `[node.exe, script]` for
 * a node shim, `[target.exe]` for a native one — or `null` when the file is
 * unreadable or not a shim this recognizes. Mirrors the shim's own interpreter
 * choice: a `node.exe` beside it, else `node` on the child's PATH, else this
 * process's node.
 */
function resolveCmdShimLaunch(shimPath, searchEnv) {
  let source;
  try { source = readFileSync(shimPath, 'utf8'); } catch { return null; }
  const targets = [...source.matchAll(CMD_SHIM_TARGET_RE)].map((m) => m[1]);
  const target = targets.at(-1);
  if (!target) return null;
  const shimDir = dirname(shimPath);
  const targetPath = join(shimDir, ...target.split('\\'));
  if (!existsSync(targetPath)) return null;
  if (CMD_SHIM_NODE_RE.test(source)) {
    const localNode = join(shimDir, 'node.exe');
    const pathNode = resolveWindowsExecutable('node', true, searchEnv);
    const nodeExe = existsSync(localNode) ? localNode
      : (pathNode && /\.exe$/i.test(pathNode) ? pathNode : process.execPath);
    return { command: nodeExe, args: [targetPath] };
  }
  return /\.exe$/i.test(targetPath) ? { command: targetPath, args: [] } : null;
}

/**
 * A `.cmd`/`.bat` target must run through `cmd.exe /c`, or `spawn` under
 * `shell: false` cannot execute it at all. Every other command/argv pair
 * passes through unchanged. No shell:true workaround is needed: spawning
 * cmd.exe directly lets Node quote whitespace in each argument, and
 * metacharacters inside those quotes stay literal.
 *
 * Unquoted argument metacharacters are caret-escaped TWICE: cmd.exe /c
 * consumes one level, then the batch file re-parses the expanded `%*`. The
 * command path is not re-parsed and gets one level. An argument cmd.exe
 * cannot carry at all (CMD_UNCARRYABLE_RE — agent prompts on argv) bypasses
 * cmd.exe by launching the shim's target directly; when the shim is not one
 * that can be resolved, the launch is refused (a child that prints
 * WINDOWS_BATCH_ARG_UNSAFE and exits 1) rather than handing untrusted text to
 * cmd.exe's parser. `searchEnv` is the child's env, so the bypass
 * picks the same `node` the shim would have.
 */
export function prepareWindowsSafeSpawn(command, args, isWin32 = process.platform === 'win32', searchEnv = process.env) {
  if (!isWin32 || !WIN_BATCH_EXT_RE.test(command)) return { command, args };
  if (args.some((arg) => CMD_UNCARRYABLE_RE.test(String(arg)))) {
    const direct = resolveCmdShimLaunch(command, searchEnv);
    if (direct) return { command: direct.command, args: [...direct.args, ...args] };
    // Refuse as a launch that fails, not a throw: callers prepare outside their
    // spawn-failure boundaries, and a child that exits 1 with this on stderr
    // reaches every caller's existing failure, result and cleanup path.
    return {
      command: process.execPath,
      args: ['-e', 'process.stderr.write(process.argv[1] + "\\n"); process.exit(1)', `${WINDOWS_BATCH_ARG_UNSAFE}: cannot pass an argument containing a double quote, percent sign or line break through cmd.exe to ${command}, which is not an npm shim PortOS can launch directly. Install the CLI with npm or as a native .exe.`],
    };
  }
  return {
    command: 'cmd.exe',
    args: ['/c', escapeCmdMetachars(command, '^'), ...args.map((arg) => escapeCmdMetachars(arg, '^^^'))],
  };
}
