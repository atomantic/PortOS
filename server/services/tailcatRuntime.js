/**
 * Shared Tailcat CLI discovery, installation, and DERP cache support.
 * No forward/serve lifecycle state or peer registration belongs here.
 */
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join, posix, win32 } from 'node:path';
import { commandOutput } from '../lib/commandExists.js';
import { MIN_TAILCAT_VERSION, parseTailcatVersion, isTailcatVersionAtLeast, tailcatVersionTooOldMessage } from '../lib/tailcatVersion.js';
import { bufferedSpawn, spawnFailureDetail } from '../lib/bufferedSpawn.js';
import { atomicWrite } from '../lib/fileUtils.js';
import { isTestRunner } from '../lib/runtimeEnv.js';
import { findCommandOnPath, safeChildProcessEnv } from '../lib/processEnv.js';
import { ServerError } from '../lib/errorHandler.js';

const GO_INSTALL_PKG = 'github.com/tailscale/tailcat/cmd/tailcat@latest';
const BREW_FORMULA = 'tailcat';
const RELEASES_URL = 'https://github.com/tailscale/tailcat/releases';
const DEFAULT_DERP_MAP_URL = 'https://tailcat.dev/derpmap.json';
const INSTALL_TIMEOUT_MS = 180_000;
const DERP_MAP_FRESH_MS = 6 * 60 * 60 * 1000;
const DERP_MAP_FETCH_TIMEOUT_MS = 15_000;

/**
 * Where a freshly installed `tailcat` can land. PATH is checked first, then the
 * install directories a package manager uses but a long-running server process
 * may never have inherited: GOBIN / GOPATH/bin for `go install`, and the
 * Homebrew prefix for `brew install`.
 */
export function listCandidateTailcatBins({ env = process.env, home = homedir() } = {}) {
  // GOPATH may be a delimiter-separated list; `go install` writes into the first entry's bin.
  const goPath = String(env.GOPATH || '').split(delimiter).find(Boolean) || join(home, 'go');
  const goBinDir = env.GOBIN || join(goPath, 'bin');
  const brewPrefixes = [env.HOMEBREW_PREFIX, '/opt/homebrew', '/usr/local'].filter(Boolean);
  const candidates = [
    findCommandOnPath('tailcat', { env }),
    join(goBinDir, 'tailcat'),
    join(goBinDir, 'tailcat.exe'),
    ...brewPrefixes.map((prefix) => join(prefix, 'bin', 'tailcat')),
  ].filter(Boolean);
  return [...new Set(candidates)];
}

/**
 * Read `tailcat version` and return a bare semver, or null when the binary
 * cannot run / the banner cannot be parsed.
 */
export async function readTailcatBinaryVersion(
  bin,
  { readOutput = (b) => commandOutput(b, ['version'], { timeoutMs: 5_000 }) } = {},
) {
  if (!bin) return null;
  const raw = await readOutput(bin);
  return parseTailcatVersion(raw);
}

/**
 * Resolve an installed `tailcat` binary that meets {@link MIN_TAILCAT_VERSION},
 * or null when none is both runnable and new enough. Older binaries are
 * skipped (not returned) so install/upgrade can still try to replace them —
 * use {@link findTooOldTailcat} when the operator needs a version-gate error.
 * Injected deps keep unit tests off the real PATH / child_process.
 */
export async function detectTailcat({
  candidates = listCandidateTailcatBins(),
  readOutput = (bin) => commandOutput(bin, ['version'], { timeoutMs: 5_000 }),
  minimum = MIN_TAILCAT_VERSION,
} = {}) {
  for (const bin of candidates) {
    const raw = await readOutput(bin);
    if (raw === null) continue;
    const version = parseTailcatVersion(raw);
    if (isTailcatVersionAtLeast(version, minimum)) return bin;
  }
  return null;
}

/**
 * First runnable candidate that is below the version floor (or unparseable).
 * Used to turn a silent "no usable binary" into a clear upgrade error.
 */
export async function findTooOldTailcat({
  candidates = listCandidateTailcatBins(),
  readOutput = (bin) => commandOutput(bin, ['version'], { timeoutMs: 5_000 }),
  minimum = MIN_TAILCAT_VERSION,
} = {}) {
  for (const bin of candidates) {
    const raw = await readOutput(bin);
    if (raw === null) continue;
    const version = parseTailcatVersion(raw);
    if (!isTailcatVersionAtLeast(version, minimum)) {
      return { bin, version };
    }
  }
  return null;
}

/**
 * Manual-install guidance for this host. Tailcat publishes release binaries for
 * Linux and Windows ONLY — pointing a macOS operator at the releases page is a
 * dead end, so darwin gets the Homebrew formula instead.
 */
export function manualInstallHint(platform = process.platform) {
  if (platform === 'darwin') {
    return (
      `Install or upgrade to tailcat ${MIN_TAILCAT_VERSION}+ with `
      + `\`brew upgrade ${BREW_FORMULA}\` / \`brew install ${BREW_FORMULA}\` `
      + `(Tailcat ships no macOS release binary), then retry.`
    );
  }
  return (
    `Install tailcat ${MIN_TAILCAT_VERSION}+ from ${RELEASES_URL} `
    + `or \`go install ${GO_INSTALL_PKG}\`, then retry.`
  );
}

/**
 * Ordered install strategies available on this host.
 *
 * Homebrew comes first: it is the only prebuilt route on macOS, and it fetches
 * over plain HTTPS, so it still works where `go install` cannot reach the Go
 * module proxy (a local network filter breaking Go's dialer shows up as an
 * opaque `connect: bad file descriptor`). `go install` stays as the fallback
 * for hosts with a toolchain but no brew.
 */
export function listTailcatInstallers({
  brewBin = findCommandOnPath('brew'),
  goBin = findCommandOnPath('go'),
  runInstall = runInstallCommand,
} = {}) {
  const installers = [];
  if (brewBin) {
    const brewEnv = {
      // Auto-update pulls the whole formula index before installing a ~10MB
      // bottle; the operator asked to add a peer, not to refresh Homebrew.
      HOMEBREW_NO_AUTO_UPDATE: '1',
      HOMEBREW_NO_INSTALL_CLEANUP: '1',
    };
    installers.push({
      label: `brew install/upgrade ${BREW_FORMULA}`,
      // `install` is a no-op when an older bottle is already present; follow
      // with `upgrade` so a 0.5.x Homebrew install can still reach the floor.
      // An "already up-to-date" upgrade failure is fine — the post-install
      // version gate decides whether we are done (and go install may still run).
      run: async () => {
        await runInstall(brewBin, ['install', BREW_FORMULA], brewEnv);
        await runInstall(brewBin, ['upgrade', BREW_FORMULA], brewEnv).catch(() => undefined);
      },
    });
  }
  if (goBin) {
    installers.push({
      label: 'go install',
      run: () => runInstall(goBin, ['install', GO_INSTALL_PKG]),
    });
  }
  return installers;
}

/**
 * Resolve a runnable `tailcat`, installing it through the first strategy that
 * works. Every strategy is a named package manager the operator already has —
 * PortOS never downloads an arbitrary URL on their behalf — and a total failure
 * reports what each one actually said so the operator can act on it.
 */
export async function ensureTailcatInstalled({
  detect = detectTailcat,
  findTooOld = findTooOldTailcat,
  installers = listTailcatInstallers(),
  platform = process.platform,
} = {}) {
  const existing = await detect();
  if (existing) return { bin: existing, installed: false };

  const rejectTooOldOrMissing = async (failures = []) => {
    const tooOld = await findTooOld();
    if (tooOld) {
      const detail = failures.length ? ` Install attempts: ${failures.join('; ')}.` : '';
      throw new ServerError(
        `${tailcatVersionTooOldMessage({ version: tooOld.version, platform })}${detail}`,
        { status: 503, code: 'TAILCAT_VERSION_TOO_OLD' },
      );
    }
    if (failures.length) {
      throw new ServerError(
        `Could not install tailcat — ${failures.join('; ')}. ${manualInstallHint(platform)}`,
        { status: 503, code: 'TAILCAT_INSTALL_FAILED' },
      );
    }
    throw new ServerError(
      `tailcat is not installed, and neither Homebrew nor Go was found on PATH. ${manualInstallHint(platform)}`,
      { status: 503, code: 'TAILCAT_MISSING' },
    );
  };

  if (installers.length === 0) {
    await rejectTooOldOrMissing();
  }

  const failures = [];
  for (const installer of installers) {
    // Promise.resolve().then defers the call, so an installer that throws
    // SYNCHRONOUSLY still falls through to the next one instead of escaping
    // past the ServerError wrapper as an unhandled 500.
    const error = await Promise.resolve().then(() => installer.run()).then(() => null, (err) => err);
    if (error) {
      failures.push(`${installer.label} failed: ${summarizeInstallError(error)}`);
      continue;
    }
    const bin = await detect();
    if (bin) return { bin, installed: true };
    // Installer exited 0 but left only an old / unparseable binary — keep
    // trying other strategies, then fail with the version gate (not "success").
    const leftover = await findTooOld();
    if (leftover) {
      failures.push(
        `${installer.label} finished but tailcat is still below ${MIN_TAILCAT_VERSION}`
        + (leftover.version ? ` (found ${leftover.version})` : ' (version unknown)'),
      );
    } else {
      failures.push(`${installer.label} finished but no tailcat binary was found`);
    }
  }

  await rejectTooOldOrMissing(failures);
}

/** One line of an installer's diagnostics, bounded so a toast stays readable. */
function summarizeInstallError(error) {
  const first = String(error?.message || 'unknown error').split('\n').map((line) => line.trim()).find(Boolean);
  const text = first || 'unknown error';
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

async function runInstallCommand(bin, args, extraEnv = {}) {
  const result = await bufferedSpawn(bin, args, {
    env: safeChildProcessEnv(extraEnv),
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  if (result.success) return;
  throw new Error(result.timedOut
    ? `timed out after ${INSTALL_TIMEOUT_MS / 1000}s`
    // Homebrew opens with tap/deprecation warnings, so its FIRST stderr line is
    // rarely the failure — spawnFailureDetail takes the last one it printed.
    : spawnFailureDetail(result, `exit ${result.code}`));
}

/** Go's `url.QueryEscape`, which is what names tailcat's DERP map cache files. */
function goQueryEscape(value) {
  return String(value).replace(/[^A-Za-z0-9\-_.~]/g, (char) => (char === ' '
    ? '+'
    : [...Buffer.from(char, 'utf8')].map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join('')));
}

/** The DERP map URL tailcat will use, honoring the env override it reads itself. */
function derpMapUrl(env = process.env) {
  return env.TAILCAT_DERPMAP_URL || DEFAULT_DERP_MAP_URL;
}

/**
 * tailcat's own on-disk DERP map cache: `<user cache dir>/tailcat/derpmap-<escaped URL>.json`,
 * whose mtime is the stored-at time. Mirrors Go's `os.UserCacheDir()` per platform.
 */
export function derpMapCachePath({
  url = derpMapUrl(),
  env = process.env,
  home = homedir(),
  platform = process.platform,
} = {}) {
  // Join for the REQUESTED platform, not the host: the caller names the platform,
  // so a `darwin` path asked for from a Windows runner must still be POSIX.
  const { join: joinFor } = platform === 'win32' ? win32 : posix;
  const base = platform === 'darwin' ? joinFor(home, 'Library', 'Caches')
    : platform === 'win32' ? (env.LOCALAPPDATA || joinFor(home, 'AppData', 'Local'))
      : (env.XDG_CACHE_HOME || joinFor(home, '.cache'));
  return joinFor(base, 'tailcat', `derpmap-${goQueryEscape(url)}.json`);
}

/**
 * Pre-warm tailcat's DERP map cache using PortOS's own HTTP stack.
 *
 * tailcat resolves a tc address's relay region by fetching that map with Go's
 * HTTP client. On a host where a local network filter permits Node and curl but
 * blocks Go's dialer, the fetch fails (`context deadline exceeded`, or the same
 * `connect: bad file descriptor` that breaks `go install`) and **every** tailcat
 * command dies before it can serve or dial — while PortOS reaches the identical
 * URL fine. Writing the map into the cache tailcat already reads makes the CLI
 * work without needing the network itself.
 *
 * Strictly best-effort and never fatal: any failure just leaves tailcat to fetch
 * the map the way it normally would. `fetchFn` defaults to null under the test
 * runner so a suite can never reach the network by forgetting to inject it.
 */
export async function primeDerpMapCache({
  url = derpMapUrl(),
  cachePath = derpMapCachePath(),
  fetchFn = isTestRunner() ? null : fetch,
  statFn = stat,
  writeFn = atomicWrite,
  freshMs = DERP_MAP_FRESH_MS,
  now = Date.now(),
} = {}) {
  if (!fetchFn) return { primed: false, reason: 'no-fetch' };
  const cachedAt = await statFn(cachePath).then((info) => info.mtimeMs, () => null);
  if (cachedAt !== null && now - cachedAt < freshMs) return { primed: false, reason: 'fresh' };

  const body = await fetchFn(url, { signal: AbortSignal.timeout(DERP_MAP_FETCH_TIMEOUT_MS) })
    .then((res) => (res.ok ? res.text() : null))
    .catch(() => null);
  // Only a parseable map goes in — never poison the cache with an error page.
  if (!safeParseJson(body)) return { primed: false, reason: 'unavailable' };

  const written = await writeFn(cachePath, body).then(() => true, () => false);
  if (written) console.log(`🐈 Primed tailcat DERP map cache (${body.length} bytes) for ${url}`);
  return { primed: written, reason: written ? 'written' : 'write-failed' };
}

function safeParseJson(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null; // an error page or truncated body is not a DERP map
  }
}

