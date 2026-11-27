/**
 * Installs and upgrades llama.cpp through the platform package manager and reports available updates.
 */

import { realpath } from 'fs/promises';
import { bufferedSpawn } from '../lib/bufferedSpawn.js';
import { commandExists } from '../lib/commandExists.js';
import { ServerError } from '../lib/errorHandler.js';
import {
  LLAMA_CPP_BREW_FORMULA,
  LLAMA_CPP_DOWNLOAD_URL,
  isWingetManagedPath,
  llamaCppInstallPlan,
  parseWingetPackageFields,
  wingetLinkDirs,
} from '../lib/llamaCppInstall.js';
import { adoptPathDirs, findCommandOnPath, safeChildProcessEnv } from '../lib/processEnv.js';
import { runStreamingCommand } from '../lib/streamingSpawn.js';

const VERSION_PROBE_TIMEOUT_MS = 5000;
const BREW_INFO_TIMEOUT_MS = 15_000;
// winget rebuilds its source index on the first query of a session, which takes
// longer than any single `brew info`.
const WINGET_LIST_TIMEOUT_MS = 60_000;
const BREW_LINK_TIMEOUT_MS = 60_000;
const UPGRADE_TIMEOUT_MS = 30 * 60 * 1000;

// Which package manager PortOS drives for llama.cpp. Only the test seam writes
// it, so both the Homebrew and the winget path stay coverable from either OS.
let platformOverride = null;
let installInProgress = false;
export const getLlamaServerInstallPlan = () => llamaCppInstallPlan(platformOverride || process.platform);

export function _setLlamaInstallPlatformForTests(platform) {
  platformOverride = platform;
}

/**
 * Run a small local command and retain its output without throwing. Version and
 * Homebrew metadata are optional decorations on status, so a missing/broken
 * command must not take the runtime status endpoint down with it.
 */
async function readCommandOutput(command, args, timeoutMs) {
  const result = await bufferedSpawn(command, args, { timeoutMs, shell: false });
  return {
    error: result.success
      ? null
      : result.error || new Error(result.timedOut ? `timed out after ${timeoutMs}ms` : `exited with code ${result.code}`),
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

/**
 * Read the version printed by the installed llama-server binary. Different
 * llama.cpp builds have used both `version: X` and `version X`, so accept both
 * spellings while keeping the status field to the useful short version token.
 */
function parseLlamaServerVersion(output) {
  const match = String(output || '').match(/\bversion\s*:?\s+([^\s(]+)/i);
  return match?.[1]?.replace(/^v/, '') || null;
}

async function readLlamaServerVersion(binaryPath) {
  const result = await readCommandOutput(binaryPath, ['--version'], VERSION_PROBE_TIMEOUT_MS);
  return result.error ? null : parseLlamaServerVersion(`${result.stdout}\n${result.stderr}`);
}

/**
 * Read Homebrew's formula metadata for the installed llama.cpp package.
 * `outdated` is authoritative here: llama.cpp's installed Homebrew version is
 * often a build number while the current formula uses a release version, so a
 * generic semver comparison would report false positives.
 */
async function readBrewLlamaCppInfo() {
  const result = await readCommandOutput(
    'brew',
    ['info', '--json=v2', '--formula', LLAMA_CPP_BREW_FORMULA],
    BREW_INFO_TIMEOUT_MS,
  );
  if (result.error) return null;

  return Promise.resolve()
    .then(() => JSON.parse(result.stdout))
    .then(async (payload) => {
      const formula = payload?.formulae?.find((entry) => entry?.name === LLAMA_CPP_BREW_FORMULA);
      const installed = formula?.installed?.[0];
      if (!installed) return null;
      const prefixResult = await readCommandOutput(
        'brew',
        ['--prefix', LLAMA_CPP_BREW_FORMULA],
        BREW_INFO_TIMEOUT_MS,
      );
      return {
        installedVersion: String(installed.version || ''),
        latestVersion: formula?.versions?.stable ? String(formula.versions.stable) : null,
        outdated: formula.outdated === true,
        pinned: formula.pinned === true,
        linked: Boolean(formula.linked_keg),
        prefix: prefixResult.error ? null : prefixResult.stdout.trim().split(/\r?\n/)[0] || null,
      };
    })
    .catch(() => null);
}

/**
 * Confirm that the binary found on PATH resolves to Homebrew's linked keg.
 *
 * `brew info` reports whether the formula is linked, not which executable the
 * current PATH resolves. A source build earlier on PATH can therefore coexist
 * with a linked Homebrew formula; upgrading the formula in that state would
 * leave the serving process on the old source build. Canonicalize both paths so
 * the normal `/opt/homebrew/bin` and `/opt/homebrew/opt` symlinks compare as the
 * same Cellar executable.
 */
async function isHomebrewLlamaServer(binaryPath, brewInfo) {
  if (!binaryPath || !brewInfo?.prefix) return false;
  const expectedPath = `${brewInfo.prefix}/bin/llama-server`;
  const [activePath, homebrewPath] = await Promise.all([
    realpath(binaryPath).catch(() => null),
    realpath(expectedPath).catch(() => null),
  ]);
  return Boolean(activePath && homebrewPath && activePath === homebrewPath);
}

/**
 * Homebrew's answer to "what is installed, is it stale, and may PortOS update
 * it?", in the shape every caller below consumes.
 *
 * `blockedReason` is what makes this the single manager-specific step: a pinned
 * or unlinked formula, or a source build sitting earlier on PATH, all stay the
 * user's to update by hand, and each refusal has to say which. `null` means
 * PortOS may run the upgrade, so `canUpgrade` is simply its absence.
 */
async function readBrewPackageStatus(binaryPath) {
  const brewInfo = await readBrewLlamaCppInfo();
  if (!brewInfo) return null;
  const blockedReason = brewInfo.pinned
    ? 'llama.cpp is pinned in Homebrew. Unpin it before asking PortOS to update it.'
    : !brewInfo.linked
      ? 'Homebrew has llama.cpp installed, but its keg is not linked to the llama-server on PATH. Link the formula manually before asking PortOS to update it.'
      : !(await isHomebrewLlamaServer(binaryPath, brewInfo))
        ? `The active llama-server is not the linked Homebrew llama.cpp binary, so PortOS left it untouched. Update that installation manually: ${LLAMA_CPP_DOWNLOAD_URL}`
        : null;
  return {
    installedVersion: brewInfo.installedVersion || null,
    latestVersion: brewInfo.latestVersion || null,
    outdated: brewInfo.outdated === true,
    canUpgrade: blockedReason === null,
    blockedReason,
  };
}

/**
 * The same shape, read from winget.
 *
 * winget has no `brew info --json` equivalent, so this asks two questions in
 * parallel instead of parsing one payload: `winget list` says whether the
 * package is installed at all (and at what version), and the same query with
 * `--upgrade-available` lists it only when a newer build exists. Neither answer
 * is a version comparison PortOS performs — llama.cpp versions are build
 * numbers (`b10730`), which no semver comparison orders correctly.
 */
async function readWingetPackageStatus(binaryPath, plan) {
  const [listed, upgradable] = await Promise.all([
    readCommandOutput('winget', plan.listArgs, WINGET_LIST_TIMEOUT_MS),
    readCommandOutput('winget', plan.upgradeCheckArgs, WINGET_LIST_TIMEOUT_MS),
  ]);
  if (listed.error) return null;
  const installedFields = parseWingetPackageFields(listed.stdout, plan.packageId);
  if (!installedFields) return null;
  // Only the `--upgrade-available` table is guaranteed to carry the `Available`
  // column, so the newer version is read from that run and nowhere else.
  const upgradeFields = upgradable.error ? null : parseWingetPackageFields(upgradable.stdout, plan.packageId);
  const ours = isWingetManagedPath(binaryPath);
  return {
    installedVersion: installedFields[0] || null,
    latestVersion: upgradeFields?.[1] || null,
    outdated: Boolean(upgradeFields),
    canUpgrade: ours,
    blockedReason: ours
      ? null
      : `The active llama-server is not the winget-installed llama.cpp, so PortOS left it untouched. Update that installation manually: ${LLAMA_CPP_DOWNLOAD_URL}`,
  };
}

/** Package metadata for whichever manager this platform uses, or `null`. */
const readPackageStatus = (plan, binaryPath) => (
  plan.manager === 'winget'
    ? readWingetPackageStatus(binaryPath, plan)
    : readBrewPackageStatus(binaryPath)
);

/**
 * Resolves the `llama-server` executable on the child-process PATH.
 *
 * Deliberately a filesystem probe only — `findCommandOnPath` already requires a
 * regular file carrying the execute bit, which is all "is it installed?" means.
 * Do NOT re-add a `commandExists`-style `llama-server --version` probe on top.
 *
 * @returns {string|null} absolute path, or null when it is not on PATH
 */
export function resolveLlamaServerBinary() {
  return findCommandOnPath('llama-server');
}

/**
 * Check whether this platform's package manager has a newer llama.cpp build.
 * This is kept separate from the lifecycle status probe because the latter is
 * also used by performance/ownership paths that must remain disk-and-process
 * local; the LLMs page calls this explicit update-information path.
 */
export async function getLlamaServerUpdateStatus() {
  const binaryPath = resolveLlamaServerBinary();
  if (!binaryPath) {
    return {
      version: null,
      latestVersion: null,
      updateAvailable: false,
      canUpgrade: false,
      downloadUrl: LLAMA_CPP_DOWNLOAD_URL,
    };
  }

  const [version, packageStatus] = await Promise.all([
    readLlamaServerVersion(binaryPath),
    readPackageStatus(getLlamaServerInstallPlan(), binaryPath),
  ]);
  return {
    version: version || packageStatus?.installedVersion || null,
    latestVersion: packageStatus?.latestVersion || null,
    updateAvailable: Boolean(packageStatus?.outdated),
    canUpgrade: Boolean(packageStatus?.canUpgrade),
    downloadUrl: LLAMA_CPP_DOWNLOAD_URL,
  };
}

/**
 * Refuse an upgrade PortOS has no business running, with the reason.
 *
 * A package PortOS did not install — a source build, a hand-extracted release
 * zip, a pinned or unlinked keg — must be left alone: swapping the package would
 * not touch the binary actually on PATH, so the user would be told their runtime
 * was updated while the serving process stayed exactly as stale as before.
 *
 * Manager-agnostic on purpose: `readPackageStatus` is the ONE place that knows
 * how each package manager answers "may PortOS update this?", so a new manager
 * is registered there and in its plan rather than adding a branch here.
 *
 * @returns {Promise<object|null>} a failure result, or `null` to proceed
 */
export async function upgradePreflight(plan, binaryPath) {
  const status = await readPackageStatus(plan, binaryPath);
  if (!status) return { success: false, error: plan.notInstalledError };
  if (status.canUpgrade) return null;
  return { success: false, manualUpdateRequired: true, error: status.blockedReason };
}

/**
 * Update the package and restore PATH visibility if the package manager left
 * the executable unlinked. The process manager coordinates daemon restarts.
 */
export async function updateLlamaServerPackage(plan, onProgress) {
  onProgress({ event: 'progress', message: `Updating llama.cpp via ${plan.managerLabel}…` });
  const upgraded = await runStreamingCommand(
    plan.manager,
    plan.upgradeArgs,
    (message) => onProgress({ event: 'progress', message }),
    { timeoutMs: UPGRADE_TIMEOUT_MS },
  );

  if (!upgraded.success) {
    return {
      success: false,
      error: `llama.cpp upgrade failed: ${upgraded.error || `${plan.managerLabel} reported an unknown error`}.`,
    };
  }

  if (!resolveLlamaServerBinary()) {
    const { repaired, detail } = await repairBinaryOnPath(plan, safeChildProcessEnv(), onProgress);
    if (!repaired) {
      return {
        success: false,
        updated: true,
        error: `llama.cpp was upgraded, but its llama-server binary is not on PATH${detail ? `: ${detail}` : '.'}`,
      };
    }
  }

  return { success: true };
}

/**
 * Runs `brew link --overwrite llama.cpp`, resolving `{ linked, output }` on exit
 * rather than rejecting — a failed link attempt should fall through to the
 * caller's own error message, not replace it with a `brew link` failure. The
 * captured output is what makes a failure diagnosable ("Could not symlink…",
 * a permissions error on the prefix); discarding it left the caller guessing.
 */
async function linkLlamaCpp(env) {
  const result = await bufferedSpawn('brew', ['link', '--overwrite', LLAMA_CPP_BREW_FORMULA], {
    env,
    shell: false,
    processGroup: true,
    timeoutMs: BREW_LINK_TIMEOUT_MS,
  });
  const diagnostics = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
  return {
    linked: result.success,
    output: result.timedOut
      ? `brew link timed out after ${BREW_LINK_TIMEOUT_MS / 1000}s`
      : result.error?.message || diagnostics,
  };
}

/**
 * Adopt winget's portable-shim directory onto this process's PATH.
 *
 * winget links a portable package's executables into a Links directory and adds
 * that directory to the USER environment — a change an already-running PortOS
 * does not inherit, so a perfectly successful install would otherwise report
 * "llama-server was not found on PATH" until the server was restarted. See
 * `adoptPathDirs` for why extending `process.env.PATH` is the fix.
 *
 * @returns {string|null} the newly-visible binary path, or null if it is not there
 */
function adoptWingetLinkDirs() {
  adoptPathDirs(wingetLinkDirs());
  return resolveLlamaServerBinary();
}

/**
 * Put llama.cpp's binary on PATH when the package manager left it off.
 *
 * The two managers land in this state for different reasons and get out of it
 * in different ways, but from here they look identical — the manager reports a
 * package it installed, and PATH still finds nothing. `brew install`/`brew
 * upgrade` can leave a keg unlinked ("Warning: llama.cpp X is already
 * installed, it's just not linked."); winget puts its portable shims in a Links
 * directory it adds to the USER environment, which an already-running PortOS has
 * not inherited. Shared by the install and upgrade paths so a change to either
 * story is made once.
 *
 * Resolves rather than rejecting: a failed repair falls through to the caller's
 * own error message, and `detail` is what makes that message diagnosable.
 *
 * @returns {Promise<{repaired: boolean, detail: string|null}>}
 */
async function repairBinaryOnPath(plan, env, onProgress) {
  if (plan.manager === 'winget') {
    return { repaired: Boolean(adoptWingetLinkDirs()), detail: null };
  }
  onProgress({ event: 'progress', message: 'llama.cpp is installed but not linked — linking…' });
  const { linked, output } = await linkLlamaCpp(env);
  return {
    repaired: Boolean(linked && resolveLlamaServerBinary()),
    // A `brew link` conflict can list every clashing file, so cap what rides
    // along into the caller's error message.
    detail: output ? output.slice(0, 500) : null,
  };
}

/**
 * Installs llama.cpp through this platform's package manager — Homebrew on
 * macOS/Linux, winget on Windows.
 */
export async function installLlamaServer({ onProgress = () => {} } = {}) {
  if (installInProgress) {
    throw new ServerError('A llama.cpp install is already in progress.', {
      status: 409,
      code: 'LLAMA_INSTALL_IN_PROGRESS',
    });
  }
  installInProgress = true;
  try {
    const plan = getLlamaServerInstallPlan();
    if (!(await commandExists(plan.manager, ['--version']))) {
      throw new ServerError(plan.missingManagerError, { status: 400 });
    }

    onProgress({ event: 'start', message: `Installing llama.cpp via ${plan.managerLabel}…` });
    const env = safeChildProcessEnv();
    const installed = await runStreamingCommand(
      plan.manager,
      plan.installArgs,
      (message) => onProgress({ event: 'progress', message }),
      { env, timeoutMs: UPGRADE_TIMEOUT_MS, processGroup: process.platform !== 'win32' },
    );
    if (!installed.success) {
      throw new ServerError(`${plan.installCommand} failed: ${installed.error}`, { status: 502, code: 'INTERNAL_ERROR' });
    }

    let binaryPath = resolveLlamaServerBinary();
    let hint = plan.pathRepairHint;
    if (!binaryPath) {
      const repair = await repairBinaryOnPath(plan, env, onProgress).catch((err) => {
        throw new ServerError(`Failed to verify the llama.cpp install: ${err.message}`, { status: 502, code: 'INTERNAL_ERROR' });
      });
      if (repair.detail) hint = `${plan.manager} said: ${repair.detail}`;
      if (repair.repaired) binaryPath = resolveLlamaServerBinary();
    }
    if (!binaryPath) {
      throw new ServerError(`${plan.manager} completed but llama-server was not found on PATH — ${hint}`, {
        status: 502,
        code: 'INTERNAL_ERROR',
      });
    }
    onProgress({ event: 'complete', message: `llama.cpp installed successfully (${binaryPath})` });
    return { success: true, message: 'llama.cpp installed successfully' };
  } finally {
    installInProgress = false;
  }
}
