/**
 * Where a llama.cpp install comes from on this host (Homebrew or winget), and how to read what the package manager
 * knows about it.
 *
 * Pure: platform and env are arguments so both branches are coverable from either OS.
 */

// `isWingetManagedPath` classifies a string off a Windows PATH, so it uses win32 on any host; `wingetLinkDirs` builds paths the local filesystem is asked about, so it uses the native flavour.
import nativePath, { win32 as winPath } from 'path';

export const LLAMA_CPP_DOWNLOAD_URL = 'https://github.com/ggml-org/llama.cpp/releases';
export const LLAMA_CPP_BREW_FORMULA = 'llama.cpp';
export const LLAMA_CPP_WINGET_ID = 'ggml.llamacpp';

// Without these winget blocks on prompts and agreements nobody can answer from a spawned child.
const WINGET_FLAGS = ['--exact', '--disable-interactivity'];
const WINGET_AGREEMENTS = ['--accept-source-agreements', '--accept-package-agreements'];

const WINGET_LIST_ARGS = ['list', '--id', LLAMA_CPP_WINGET_ID, ...WINGET_FLAGS];

const BREW_PLAN = Object.freeze({
  manager: 'brew',
  managerLabel: 'Homebrew',
  packageId: LLAMA_CPP_BREW_FORMULA,
  installCommand: `brew install ${LLAMA_CPP_BREW_FORMULA}`,
  installArgs: Object.freeze(['install', LLAMA_CPP_BREW_FORMULA]),
  upgradeArgs: Object.freeze(['upgrade', LLAMA_CPP_BREW_FORMULA]),
  missingManagerError:
    'Homebrew was not found. Please install Homebrew from https://brew.sh or build llama.cpp from source.',
  notInstalledError:
    `llama.cpp is not installed through Homebrew, so PortOS cannot update it here. Install it with Homebrew or update your source build manually: ${LLAMA_CPP_DOWNLOAD_URL}`,
  pathRepairHint: `try running \`brew link --overwrite ${LLAMA_CPP_BREW_FORMULA}\` manually`,
});

const WINGET_PLAN = Object.freeze({
  manager: 'winget',
  managerLabel: 'winget',
  packageId: LLAMA_CPP_WINGET_ID,
  installCommand: `winget install ${LLAMA_CPP_WINGET_ID}`,
  installArgs: Object.freeze(['install', '--id', LLAMA_CPP_WINGET_ID, ...WINGET_FLAGS, ...WINGET_AGREEMENTS]),
  upgradeArgs: Object.freeze(['upgrade', '--id', LLAMA_CPP_WINGET_ID, ...WINGET_FLAGS, ...WINGET_AGREEMENTS]),
  listArgs: Object.freeze([...WINGET_LIST_ARGS]),
// Restricted to packages with a newer build: winget has no `outdated` field and llama.cpp build numbers (`b10730`) are not semver-orderable.
  upgradeCheckArgs: Object.freeze([...WINGET_LIST_ARGS, '--upgrade-available']),
  missingManagerError:
    `winget was not found. Install "App Installer" from the Microsoft Store, or download a Windows llama.cpp build from ${LLAMA_CPP_DOWNLOAD_URL} and put its bin directory on PATH.`,
  notInstalledError:
    `llama.cpp is not installed through winget, so PortOS cannot update it here. Install it with \`winget install ${LLAMA_CPP_WINGET_ID}\` or update your own build manually: ${LLAMA_CPP_DOWNLOAD_URL}`,
  pathRepairHint:
    'restart PortOS so it picks up the PATH entry winget added, or add WinGet\'s Links directory to PATH manually',
});

/**
 * The install descriptor for a platform.
 * @param {string} platform a `process.platform` value
 */
export function llamaCppInstallPlan(platform) {
  return platform === 'win32' ? WINGET_PLAN : BREW_PLAN;
}

/**
 * Pull one package's fields out of `winget list` output. winget has no machine-readable mode and localizes its
 * headers, so fields are read positionally from the tokens after the package id: `Version [Available] [Source]`.
 * Empty columns collapse, so index only what the invocation guarantees (`--upgrade-available` guarantees `Available`).
 * Returns null when the package is not listed (winget prints "No installed package found…", not an error).
 *
 * @param {string} stdout raw `winget list` output
 * @param {string} packageId the exact id that was queried
 * @returns {string[]|null} the fields after the id, or `null` when the package is not listed
 */
export function parseWingetPackageFields(stdout, packageId) {
  const wanted = String(packageId || '').toLowerCase();
  if (!wanted) return null;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/).filter(Boolean);
    const index = fields.findIndex((field) => field.toLowerCase() === wanted);
    if (index !== -1) return fields.slice(index + 1);
  }
  return null;
}

/**
 * The directories winget links a portable package's executables into (both scopes; neither is guaranteed to exist).
 * Joined with the NATIVE separator because callers stat these and splice them into `process.env.PATH`.
 */
export function wingetLinkDirs(env = process.env) {
  return wingetRoots(env, nativePath).map((root) => nativePath.join(root, 'Links'));
}

function wingetRoots(env, pathFlavour) {
  return [
    env.LOCALAPPDATA ? pathFlavour.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet') : null,
    env.ProgramFiles ? pathFlavour.join(env.ProgramFiles, 'WinGet') : null,
  ].filter(Boolean);
}

// Windows counterpart of `isHomebrewLlamaServer`: a source build earlier on PATH must not be offered a `winget upgrade`. Case-insensitive like Windows paths.
export function isWingetManagedPath(binaryPath, env = process.env) {
  if (!binaryPath || !winPath.isAbsolute(binaryPath)) return false;
  const candidate = winPath.normalize(binaryPath).toLowerCase();
  return wingetRoots(env, winPath).some((root) => (
    candidate.startsWith(winPath.normalize(root).toLowerCase() + winPath.sep)
  ));
}
