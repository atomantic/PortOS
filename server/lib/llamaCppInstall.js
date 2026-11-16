/**
 * Where a llama.cpp install comes from on this host, and how to read what the
 * platform's package manager knows about it.
 *
 * llama.cpp publishes an official package for both managers PortOS can drive:
 * Homebrew on macOS/Linux (`brew install llama.cpp`) and winget on Windows
 * (`winget install ggml.llamacpp`, a portable zip whose shims land in WinGet's
 * Links directory). Keeping the descriptor here — rather than branching on
 * `process.platform` at each call site in `services/llamaServerManager.js` —
 * is what lets the LLMs page name the command that actually works instead of
 * telling a Windows user to run Homebrew.
 *
 * Pure, and free of ambient platform detection: the plan takes the platform as
 * an argument and the WinGet path helpers take the environment, so both
 * branches are coverable from either OS.
 */

// Two path flavours, deliberately: `isWingetManagedPath` CLASSIFIES a path
// string that came off a Windows PATH, so it must reason in win32 whatever host
// is running it (on POSIX, `path.isAbsolute('C:\\…')` is false and would quietly
// answer "no", making the rule uncoverable from a macOS/Linux checkout).
// `wingetLinkDirs` builds paths the LOCAL FILESYSTEM is then asked about, so it
// must use the native flavour — see the note on that function.
import nativePath, { win32 as winPath } from 'path';

export const LLAMA_CPP_DOWNLOAD_URL = 'https://github.com/ggml-org/llama.cpp/releases';
export const LLAMA_CPP_BREW_FORMULA = 'llama.cpp';
export const LLAMA_CPP_WINGET_ID = 'ggml.llamacpp';

// `--disable-interactivity` keeps winget from drawing a prompt no one can answer
// from a spawned child, and the two `--accept-*` flags stand in for the source
// and package agreements it otherwise blocks on the first time.
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
  // Presence and installed version.
  listArgs: Object.freeze([...WINGET_LIST_ARGS]),
  // The same listing, restricted to packages winget has a newer build for — that
  // row IS the staleness signal, since winget has no `outdated` field the way
  // `brew info --json` does, and llama.cpp's versions are build numbers
  // (`b10730`) that no semver comparison orders.
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
 * Pull one package's fields out of `winget list` table output.
 *
 * winget has no machine-readable output mode, and its table is column-aligned
 * under LOCALIZED headers, so the header row cannot be used to find the columns.
 * The package id is a whitespace-free token that appears nowhere else in the
 * table, so the fields are read positionally from the tokens that follow it:
 * `Version [Available] [Source]`. Padding for an empty column collapses under a
 * whitespace split, which is why the caller must not index past what the
 * specific invocation guarantees — `--upgrade-available` guarantees `Available`,
 * a plain `list` does not.
 *
 * @param {string} stdout raw `winget list` output
 * @param {string} packageId the exact id that was queried
 * @returns {string[]|null} the fields after the id, or `null` when the package
 *   is not listed (winget prints "No installed package found…", not an error).
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
 * The directories winget links a portable package's executables into. Both
 * scopes are returned because PortOS cannot know which one the user's install
 * chose, and neither is guaranteed to exist.
 *
 * Joined with the NATIVE separator, not win32: the caller stats these paths and
 * splices them into `process.env.PATH`, so they have to be shaped for the
 * filesystem actually running the code. On Windows — the only host that reaches
 * this in production — native IS win32, so nothing changes there; joining with
 * win32 unconditionally would instead emit backslash paths a POSIX test host can
 * neither create nor stat.
 */
export function wingetLinkDirs(env = process.env) {
  return wingetRoots(env, nativePath).map((root) => nativePath.join(root, 'Links'));
}

/**
 * The per-user and machine-wide directories winget installs packages under, in
 * the caller's chosen path flavour (see the import note at the top).
 */
function wingetRoots(env, pathFlavour) {
  return [
    env.LOCALAPPDATA ? pathFlavour.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet') : null,
    env.ProgramFiles ? pathFlavour.join(env.ProgramFiles, 'WinGet') : null,
  ].filter(Boolean);
}

/**
 * Is this binary one winget installed?
 *
 * The Windows counterpart of `services/llamaServerManager.js#isHomebrewLlamaServer`:
 * a source build or a hand-extracted release zip earlier on PATH must not be
 * offered a `winget upgrade`, which would swap a package the running process is
 * not using. Compared case-insensitively because Windows paths are.
 */
export function isWingetManagedPath(binaryPath, env = process.env) {
  if (!binaryPath || !winPath.isAbsolute(binaryPath)) return false;
  const candidate = winPath.normalize(binaryPath).toLowerCase();
  return wingetRoots(env, winPath).some((root) => (
    candidate.startsWith(winPath.normalize(root).toLowerCase() + winPath.sep)
  ));
}
