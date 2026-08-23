/**
 * Single source of truth for the packages allowed to run install scripts.
 *
 * Every workspace pins `ignore-scripts=true` in its own .npmrc (npm reads the
 * project config from the local prefix and never walks upward, so each
 * workspace needs its own file — see client/.npmrc). That blocks the
 * preinstall/postinstall hook that supply-chain worms use as their execution
 * slot, at the cost of also skipping the handful of *legitimate* native builds.
 * Those are rebuilt explicitly here — an allowlist, so adding a dependency
 * never silently grants it an install-time code-execution slot.
 *
 * Consumed by scripts/ensure-deps.js, the root `setup` script, setup.ps1,
 * update.sh, update.ps1, and CI. Keep the list here only — a second copy is how it
 * drifts, which is exactly how setup.ps1 ended up rebuilding a package that no
 * longer exists while missing two that do.
 *
 * Usage as a CLI (what CI and `npm run setup` call):
 *   node scripts/trusted-rebuilds.js server
 */
import { execFileSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { prepareCliSpawn } from '../server/lib/bufferedSpawn.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every directory npm can install into with that directory as the local prefix:
 * the repo root plus each top-level directory carrying its own package.json.
 * Discovered rather than hand-listed — a hardcoded roster is the same drift this
 * module exists to eliminate, one level up: add a 5th workspace, forget to add it
 * to the list, and its `ignore-scripts` guard is silently absent while CI stays
 * green. Nested manifests (`server/cos-runner`) and the vendored `lib/slashdo`
 * submodule are deliberately excluded — nobody installs with those as the prefix,
 * and the submodule is not ours to configure.
 *
 * Returns labels; pair with `workspaceDir()` for the path. Root sorts first, the
 * rest alphabetically, so callers get a stable order.
 */
export function discoverWorkspaces() {
  const nested = readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(ROOT, name, 'package.json')))
    .sort();
  return ['root', ...nested];
}

/** Absolute path for a workspace label from `discoverWorkspaces()`. */
export function workspaceDir(label) {
  return label === 'root' ? ROOT : join(ROOT, label);
}

/**
 * `fatal: true` means a failed rebuild fails the install — the package is
 * required at runtime and a missing binding crashes the server. `fatal: false`
 * is best-effort: the dependency degrades rather than breaks.
 *
 * client / autofixer are intentionally absent: nothing in either needs an
 * install script (vite 8 dropped the esbuild binary dependency that used to).
 */
export const TRUSTED_REBUILDS = {
  server: [
    // node-pty builds the native PTY addon and the shell/TUI features hard-require
    // it. sharp rides along in the same call: it ships prebuilt bindings via
    // optionalDependencies today so its rebuild is currently a no-op, but it is
    // equally runtime-critical if it ever regains a lifecycle hook. Grouped
    // because they share `fatal` — a group exists to give *different* failure
    // semantics, not to hang a different comment on each package, and every extra
    // group costs another npm spawn (~180ms) for no behavioral gain.
    { pkgs: ['node-pty', 'sharp'], fatal: true },
    // Transitive, behind optional local-inference features. onnxruntime-node's
    // postinstall fetches platform binaries; absent them the feature is
    // unavailable, not fatal. protobufjs's postinstall only generates a minimal
    // build.
    { pkgs: ['onnxruntime-node', 'protobufjs'], fatal: false }
  ]
};

/**
 * Rebuild the trusted packages for one workspace.
 * Returns true when every fatal group succeeded.
 *
 * `spawn` is injectable so the fatal/non-fatal decision is testable without
 * actually invoking npm. That decision is the whole point of the module — if it
 * inverts, a failed node-pty build exits 0 and the missing binding resurfaces as
 * a confusing MODULE_NOT_FOUND at smoke-boot — so it needs real coverage rather
 * than only a shape assertion on TRUSTED_REBUILDS.
 */
export function rebuildTrusted(dir, label, { spawn = execFileSync } = {}) {
  const groups = TRUSTED_REBUILDS[label];
  if (!groups) return true;
  let ok = true;
  for (const { pkgs, fatal } of groups) {
    try {
      // Through prepareCliSpawn: on Windows `npm` is a `.cmd` shim, and Node's
      // CVE-2024-27980 patch REFUSES a `.cmd` target under `shell:false` with
      // `spawnSync npm.cmd EINVAL`. Since the node-pty group is fatal, that
      // throw exited this script 1, and `update.ps1` exits on a non-zero
      // trusted-rebuilds — so every Windows update aborted before the client
      // build and the pm2 restart, leaving the UI permanently reporting a stale
      // client build. See server/lib/bufferedSpawn.js for why the fix is a
      // `cmd.exe /c` wrap and not `shell:true` (which does not escape args).
      const { command, args } = prepareCliSpawn('npm', ['rebuild', ...pkgs]);
      spawn(command, args, { cwd: dir, stdio: 'inherit', windowsHide: true });
    } catch (err) {
      console.error(`⚠️  npm rebuild ${pkgs.join(' ')} failed for ${label}: ${err.message ?? err}`);
      if (fatal) ok = false;
    }
  }
  return ok;
}

/**
 * CLI body, returning an exit code instead of calling process.exit, so every
 * branch (usage, unknown label, rebuild-free workspace, rebuild failure) is
 * assertable. `node scripts/trusted-rebuilds.js <label> [dir]`
 */
export function runCli(argv, { spawn = execFileSync } = {}) {
  const [label, dirOverride] = argv;
  if (!label) {
    // List the real workspaces, not just the keys of TRUSTED_REBUILDS — the CLI
    // accepts any workspace (a rebuild-free one is a documented no-op), so
    // advertising only `server` misrepresents what is valid.
    console.error(`❌ usage: node scripts/trusted-rebuilds.js <${discoverWorkspaces().join('|')}>`);
    return 1;
  }
  // Validate the label against the real workspace list BEFORE the "nothing to do"
  // check below. Otherwise a typo (`sever`) falls through to a green "✅ no trusted
  // rebuilds needed" and exit 0 — reproducing the exact failure this module exists
  // to prevent (node-pty left unbuilt, surfacing much later as a confusing
  // MODULE_NOT_FOUND at smoke-boot) behind a CI step that reported success.
  const workspaces = discoverWorkspaces();
  if (!workspaces.includes(label)) {
    console.error(`❌ unknown workspace '${label}'. Known workspaces: ${workspaces.join(', ')}`);
    return 1;
  }
  if (!TRUSTED_REBUILDS[label]) {
    console.log(`✅ no trusted rebuilds needed for ${label}`);
    return 0;
  }
  console.log(`🔨 Rebuilding trusted install-script packages for ${label}`);
  return rebuildTrusted(dirOverride ?? workspaceDir(label), label, { spawn }) ? 0 : 1;
}

if (isDirectlyInvoked(import.meta.url)) process.exit(runCli(process.argv.slice(2)));
