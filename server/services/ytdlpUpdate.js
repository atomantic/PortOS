/**
 * yt-dlp version reporting and in-place update (#7255 follow-up).
 *
 * YouTube gates its media URLs behind a player handshake that yt-dlp tracks
 * release-to-release, so a binary only weeks old starts returning a flat
 * `HTTP Error 403: Forbidden` for videos the browser plays fine. That is the
 * single most common cause of a failed download here, and the remedy is always
 * the same one command — so the Video Downloader page offers the button rather
 * than sending the user to a terminal, mirroring the llama.cpp / Ollama update
 * affordances on the Local LLMs page.
 *
 * Deliberately NOT modelled on `llamaServerManager`'s package plan: yt-dlp has
 * no daemon to stop and restart, and its own `-U` self-update covers every
 * install shape Homebrew doesn't (standalone binary, pip, pipx) — refusing with
 * its own accurate message when it can't. So there are exactly two paths here,
 * and the non-Homebrew one delegates the decision to yt-dlp itself.
 */

import { realpath } from 'fs/promises';
import { bufferedSpawn } from '../lib/bufferedSpawn.js';
import { runStreamingCommand } from '../lib/streamingSpawn.js';
import { findYtDlp, resetYtDlpCache } from '../lib/ytdlp.js';

const BREW_FORMULA = 'yt-dlp';
const VERSION_PROBE_TIMEOUT_MS = 10_000;
const BREW_INFO_TIMEOUT_MS = 20_000;
const UPGRADE_TIMEOUT_MS = 10 * 60 * 1000;
const GITHUB_TIMEOUT_MS = 8_000;

export const YTDLP_DOWNLOAD_URL = 'https://github.com/yt-dlp/yt-dlp#installation';

/**
 * Run a small local command and retain its output without throwing. Version and
 * Homebrew metadata are optional decorations on a status response, so a
 * missing or broken command must not take the endpoint down with it.
 */
async function readCommandOutput(command, args, timeoutMs) {
  const result = await bufferedSpawn(command, args, { timeoutMs, shell: false });
  return { ok: result.success === true, stdout: result.stdout || '', stderr: result.stderr || '' };
}

/** `yt-dlp --version` prints the bare version token (`2026.08.19`) and nothing else. */
async function readYtDlpVersion(binaryPath) {
  const result = await readCommandOutput(binaryPath, ['--version'], VERSION_PROBE_TIMEOUT_MS);
  if (!result.ok) return null;
  return result.stdout.trim().split(/\r?\n/)[0]?.trim() || null;
}

/**
 * Homebrew's view of the formula, or null when Homebrew doesn't have it (which
 * includes "Homebrew isn't installed" — the same answer for this caller).
 */
async function readBrewInfo() {
  const result = await readCommandOutput(
    'brew',
    ['info', '--json=v2', '--formula', BREW_FORMULA],
    BREW_INFO_TIMEOUT_MS,
  );
  if (!result.ok) return null;
  return Promise.resolve()
    .then(() => JSON.parse(result.stdout))
    .then((payload) => {
      const formula = payload?.formulae?.find((entry) => entry?.name === BREW_FORMULA);
      if (!formula?.installed?.[0]) return null;
      return {
        installedVersion: String(formula.installed[0].version || '') || null,
        latestVersion: formula.versions?.stable ? String(formula.versions.stable) : null,
        outdated: formula.outdated === true,
        pinned: formula.pinned === true,
        linked: Boolean(formula.linked_keg),
      };
    })
    .catch(() => null);
}

/**
 * Confirm the yt-dlp on PATH really is Homebrew's linked keg.
 *
 * `brew info` reports that the formula is linked, not which executable PATH
 * resolves — a pip or standalone install earlier on PATH coexists happily with
 * a linked formula, and `brew upgrade` would then leave the *running* binary
 * untouched. Canonicalize both sides so Homebrew's `bin` → `opt` → `Cellar`
 * symlink chain compares equal.
 */
async function isHomebrewYtDlp(binaryPath) {
  const prefix = await readCommandOutput('brew', ['--prefix', BREW_FORMULA], BREW_INFO_TIMEOUT_MS);
  const prefixPath = prefix.ok ? prefix.stdout.trim().split(/\r?\n/)[0] : '';
  if (!binaryPath || !prefixPath) return false;
  const [active, brewed] = await Promise.all([
    realpath(binaryPath).catch(() => null),
    realpath(`${prefixPath}/bin/yt-dlp`).catch(() => null),
  ]);
  return Boolean(active && brewed && active === brewed);
}

// Latest published yt-dlp release, cached. GitHub's release API is
// unauthenticated-rate-limited and this endpoint is hit on every Video
// Downloader page load, so a steady-state UI must not ask it each time.
// `version: null` is the not-fetched sentinel (distinct from a cached value); a
// success holds for the long TTL, a failure backs off for the short one rather
// than poisoning the cache forever or hammering.
let latestReleaseCache = { version: null, fetchedAt: 0 };
const LATEST_TTL_MS = 6 * 60 * 60 * 1000;
const LATEST_ERROR_TTL_MS = 10 * 60 * 1000;

/** Exported for tests — a module-level cache would otherwise leak across cases. */
export function resetYtDlpLatestCache() {
  latestReleaseCache = { version: null, fetchedAt: 0 };
}

async function getLatestYtDlpVersion() {
  const age = Date.now() - latestReleaseCache.fetchedAt;
  if (latestReleaseCache.version && age < LATEST_TTL_MS) return latestReleaseCache.version;
  if (!latestReleaseCache.version && latestReleaseCache.fetchedAt && age < LATEST_ERROR_TTL_MS) return null;

  const release = await fetch('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest', {
    headers: { 'User-Agent': 'PortOS', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const version = release?.tag_name ? String(release.tag_name).trim() : null;
  latestReleaseCache = { version, fetchedAt: Date.now() };
  return version;
}

/**
 * yt-dlp versions are zero-padded dates (`2026.08.19`, nightlies
 * `2026.08.19.232702`), so a plain string comparison orders them correctly —
 * and a nightly ahead of the latest stable tag is correctly reported as current
 * rather than as an available "update" that would move the user backwards.
 */
const isNewer = (latest, installed) => Boolean(latest && installed && latest > installed);

/**
 * What the Video Downloader page needs to render the update row: which yt-dlp
 * is on PATH, how old it is, and whether PortOS may update it for the user.
 *
 * Kept off the download path — it spends a `brew info` and (for non-Homebrew
 * installs) a GitHub round-trip, neither of which a download should wait on.
 */
export async function getYtDlpUpdateStatus() {
  const binaryPath = await findYtDlp();
  if (!binaryPath) {
    return {
      installed: false,
      path: null,
      version: null,
      latestVersion: null,
      updateAvailable: false,
      canUpdate: false,
      method: null,
      methodLabel: null,
      updateCommand: null,
      blockedReason: 'yt-dlp is not on PATH. Install it first — PortOS does not vendor it.',
      downloadUrl: YTDLP_DOWNLOAD_URL,
    };
  }

  const [version, brew] = await Promise.all([readYtDlpVersion(binaryPath), readBrewInfo()]);
  const brewOwnsIt = Boolean(brew) && await isHomebrewYtDlp(binaryPath);

  if (brewOwnsIt) {
    // Homebrew's own `outdated` flag is authoritative — it compares against the
    // formula the upgrade would actually install, which is what the button runs.
    const blockedReason = brew.pinned
      ? 'yt-dlp is pinned in Homebrew. Unpin it before asking PortOS to update it.'
      : !brew.linked
        ? 'Homebrew has yt-dlp installed but its keg is not linked. Link the formula before asking PortOS to update it.'
        : null;
    return {
      installed: true,
      path: binaryPath,
      version: version || brew.installedVersion,
      latestVersion: brew.latestVersion,
      updateAvailable: brew.outdated,
      canUpdate: blockedReason === null,
      method: 'brew',
      methodLabel: 'Homebrew',
      updateCommand: 'brew upgrade yt-dlp',
      blockedReason,
      downloadUrl: YTDLP_DOWNLOAD_URL,
    };
  }

  // Everything else — a standalone binary, pip, pipx — goes through yt-dlp's own
  // `-U`, which updates a standalone binary in place and refuses a managed
  // install with an accurate message naming the manager that owns it. PortOS
  // can't tell those two apart reliably, and yt-dlp can, so it decides.
  const latestVersion = await getLatestYtDlpVersion();
  return {
    installed: true,
    path: binaryPath,
    version,
    latestVersion,
    updateAvailable: isNewer(latestVersion, version),
    canUpdate: true,
    method: 'self',
    methodLabel: 'yt-dlp self-update',
    updateCommand: 'yt-dlp -U',
    blockedReason: null,
    downloadUrl: YTDLP_DOWNLOAD_URL,
  };
}

/**
 * Update yt-dlp in place, streaming the package manager's own output so the
 * page can show progress on a `brew upgrade` that takes a minute.
 *
 * Never throws for an update failure — the caller turns the returned shape into
 * a response. `version` is re-read afterwards so the UI reports what is on disk
 * now rather than what the command claimed.
 */
export async function updateYtDlp({ onProgress = () => {} } = {}) {
  const status = await getYtDlpUpdateStatus();
  if (!status.installed) return { success: false, error: status.blockedReason };
  if (!status.canUpdate) return { success: false, error: status.blockedReason };

  const [command, args] = status.method === 'brew'
    ? ['brew', ['upgrade', BREW_FORMULA]]
    : [status.path, ['-U']];

  onProgress({ event: 'progress', message: `Updating yt-dlp via ${status.methodLabel}…` });
  const run = await runStreamingCommand(
    command,
    args,
    (message) => onProgress({ event: 'progress', message }),
    { timeoutMs: UPGRADE_TIMEOUT_MS },
  );

  if (!run.success) {
    return {
      success: false,
      error: `yt-dlp update failed: ${run.error || `${status.methodLabel} reported an unknown error`}`,
    };
  }

  // A Homebrew upgrade relinks the keg, which can move the binary PATH resolves
  // — drop the discovery cache so the next download spawns the new one.
  resetYtDlpCache();
  resetYtDlpLatestCache();
  const after = await getYtDlpUpdateStatus();
  return {
    success: true,
    version: after.version,
    previousVersion: status.version,
    // A `brew upgrade` on an already-current formula and a `yt-dlp -U` with
    // nothing to do both exit 0, so say so rather than implying a new build.
    note: after.version && status.version && after.version === status.version
      ? `already on ${after.version}`
      : null,
  };
}
