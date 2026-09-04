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
import { accessSync, constants, existsSync, statSync } from 'fs';
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

// AI CLIs need the host's runtime essentials and forge-delivery fallbacks, but
// they do not need the rest of the server's ambient environment. Provider
// authentication is selected below per child provider; explicit provider.envVars
// / before overlays remain available for configured credentials and per-run
// settings.
const SAFE_CLI_BASE_ENV_KEYS = new Set([
  'PATH', 'Path', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LANGUAGE', 'TERM', 'COLORTERM', 'TZ', 'HOSTNAME', 'NODE', 'NODE_ENV', 'NODE_PATH',
  'NVM_DIR', 'NVM_BIN', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'CODEX_HOME',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'EDITOR', 'VISUAL', 'PORTOS_REAL_PM2',
  'SystemRoot', 'SystemDrive', 'ComSpec', 'PATHEXT', 'USERPROFILE', 'APPDATA',
  'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'HOMEDRIVE', 'HOMEPATH',
  'AWS_REGION', 'AWS_DEFAULT_REGION', 'SSH_AUTH_SOCK', 'GH_TOKEN', 'GITHUB_TOKEN',
]);

const SAFE_CLI_BASE_ENV_PREFIXES = ['LC_'];

const CLI_PROVIDER_AUTH_RULES = Object.freeze({
  claude: {
    keys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'],
    prefixes: ['CLAUDE_CODE_', 'CLAUDE_'],
  },
  codex: { keys: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_BASE'], prefixes: [] },
  agy: { keys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_API_KEY'], prefixes: ['GEMINI_CLI_'] },
  grok: { keys: ['XAI_API_KEY', 'GROK_API_KEY'], prefixes: [] },
  kimi: { keys: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'], prefixes: [] },
  cursor: { keys: ['CURSOR_API_KEY'], prefixes: [] },
});

const LOCAL_PROVIDER_MARKERS = ['ollamaBacked', 'mtplxBacked', 'llamaBacked', 'vllmBacked', 'sglangBacked'];

/**
 * Build the non-secret provider metadata needed to classify ambient CLI auth
 * in another process. Provider envVars are deliberately excluded: those may
 * contain credentials and are already carried separately when explicitly
 * configured.
 *
 * The result is stamped `authOnly` because it is a PARTIAL view — an identity,
 * not a provider record. Its consumer (the CoS runner) hands it to
 * `buildCliChildEnv`, which feeds `provider` to two different contracts:
 * `buildSafeCliBaseEnv`, which wants exactly this identity, and
 * `composeProviderEnv`, which otherwise treats it as authoritative and
 * regenerates every per-provider env layer from it. Regenerating from a partial
 * view over an already-composed delta produces a WORSE value that still wins by
 * layer order — see the `authOnly` short-circuit in `cliChildEnv.js`.
 */
export function cliProviderAuthDescriptor(provider) {
  if (!provider || typeof provider !== 'object') return null;
  const descriptor = {};
  if (typeof provider.id === 'string' && provider.id) descriptor.id = provider.id;
  if (typeof provider.command === 'string' && provider.command) descriptor.command = provider.command;
  for (const marker of LOCAL_PROVIDER_MARKERS) {
    if (provider[marker] === true) descriptor[marker] = true;
  }
  return Object.keys(descriptor).length ? { ...descriptor, authOnly: true } : null;
}

function cliProviderAuthRule(provider) {
  const command = typeof provider?.command === 'string'
    ? provider.command.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '')
    : '';
  const id = String(provider?.id || '').toLowerCase();
  const local = LOCAL_PROVIDER_MARKERS.some((marker) => provider?.[marker] === true);
  if (local) return null;
  if (command === 'claude' || id.startsWith('claude-code')) return CLI_PROVIDER_AUTH_RULES.claude;
  if (command === 'codex' || id === 'codex' || id === 'codex-tui') return CLI_PROVIDER_AUTH_RULES.codex;
  if (command === 'agy' || command === 'antigravity' || id.startsWith('antigravity')) return CLI_PROVIDER_AUTH_RULES.agy;
  if (command === 'grok' || id.startsWith('grok-')) return CLI_PROVIDER_AUTH_RULES.grok;
  if (command === 'kimi' || id.startsWith('kimi-')) return CLI_PROVIDER_AUTH_RULES.kimi;
  if (command === 'cursor-agent' || id.startsWith('cursor-')) return CLI_PROVIDER_AUTH_RULES.cursor;
  return null;
}

/**
 * Keep only the environment an AI CLI needs to start, deliver work, and use
 * the selected provider's ambient auth. Unrelated provider credentials are
 * dropped; provider-specific values should otherwise be supplied through the
 * explicit overlays, not inherited from the PortOS server process.
 *
 * @param {NodeJS.ProcessEnv|object} [env=process.env]
 * @param {{id?:string, command?:string, ollamaBacked?:boolean, mtplxBacked?:boolean, llamaBacked?:boolean, vllmBacked?:boolean, sglangBacked?:boolean}|null} [provider]
 * @returns {Record<string,string>}
 */
export function buildSafeCliBaseEnv(env = process.env, provider = null) {
  const authRule = cliProviderAuthRule(provider);
  return Object.fromEntries(
    Object.entries(env || {}).filter(([key, value]) => value != null && (
      SAFE_CLI_BASE_ENV_KEYS.has(key)
      || SAFE_CLI_BASE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
      || authRule?.keys.includes(key)
      || authRule?.prefixes.some((prefix) => key.startsWith(prefix))
    )),
  );
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

// Windows paths are case-insensitive and PATH mixes casings freely
// (`C:\ProgramData\npm` vs `c:\programdata\npm`), so a case-sensitive compare
// would append a duplicate of an entry that is already there.
const samePathEntry = (a, b) => (IS_WIN ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * Adopt directories onto THIS process's PATH.
 *
 * A package manager that installs into a directory the running process's PATH
 * does not name is the recurring case, and it always looks the same from here:
 * the install succeeds and the binary reports as "not found". winget adds its
 * portable-shim Links directory to the USER environment, which an
 * already-running server never inherited; npm's global prefix need not be the
 * directory the platform's Node installer put on PATH at all, so no restart
 * fixes that one.
 *
 * Extending `process.env.PATH` fixes both this process's own lookups AND every
 * child it spawns, since `safeChildProcessEnv` / `buildSafeCliBaseEnv` derive
 * from it — which is what a CLI launched by BARE NAME through node-pty needs,
 * because resolving its path is not something that launch can use.
 *
 * Only directories that exist are adopted: `findCommandOnPath` stats every PATH
 * entry against every PATHEXT extension, so a dead entry taxes every later
 * lookup for the life of the process.
 *
 * @param {string[]} dirs
 * @returns {string[]} the directories newly added
 */
export function adoptPathDirs(dirs) {
  // `process.env` is case-insensitive on Windows, so `.PATH` reads a `Path`
  // entry too — no second spelling to check. The empty segments a trailing or
  // doubled delimiter leaves behind are dropped rather than carried along.
  const entries = String(process.env.PATH || '').split(delimiter).filter(Boolean);
  const added = [];
  for (const dir of dirs) {
    if (!dir || entries.some((entry) => samePathEntry(entry, dir)) || !existsSync(dir)) continue;
    entries.push(dir);
    added.push(dir);
  }
  if (added.length > 0) process.env.PATH = entries.join(delimiter);
  return added;
}
