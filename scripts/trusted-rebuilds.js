/**
 * Single source of truth for the packages allowed to run install scripts.
 *
 * Every workspace pins `ignore-scripts=true` in its own .npmrc (npm reads project
 * config from the local prefix and never walks upward; see client/.npmrc). That
 * blocks the preinstall/postinstall hook supply-chain worms use, at the cost of
 * skipping the few *legitimate* native builds, which are rebuilt explicitly here.
 * An allowlist, so adding a dependency never silently grants it an install-time
 * code-execution slot.
 *
 * Consumed by scripts/ensure-deps.js (whose installWorkspace scripts/setup.js reuses), update.sh/ps1 and CI
 * (`node scripts/trusted-rebuilds.js server`); a second copy of the list drifts.
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
 * Discovered, not hand-listed: a hardcoded roster is the same drift this module
 * exists to eliminate (a forgotten 5th workspace silently lacks its
 * `ignore-scripts` guard while CI stays green). Nested manifests
 * (`server/cos-runner`) and the vendored `lib/slashdo` submodule are excluded:
 * nobody installs with those as the prefix, and the submodule isn't ours.
 *
 * Returns labels (pair with `workspaceDir()`), root first, the rest sorted.
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
 * `fatal: true` means a failed rebuild fails the install: the package is required
 * at runtime and a missing binding crashes the server. `fatal: false` is
 * best-effort: the dependency degrades rather than breaks.
 *
 * client is absent: it does not need an install script.
 */
export const TRUSTED_REBUILDS = {
  server: [
    // node-pty builds the native PTY addon the shell/TUI features hard-require.
    // sharp ships prebuilt bindings today (its rebuild is a no-op) but is equally
    // runtime-critical. Grouped because they share `fatal`; every extra group
    // costs another npm spawn (~180ms).
    { pkgs: ['node-pty', 'sharp'], fatal: true },
    // Transitive, behind optional local-inference features: onnxruntime-node's
    // postinstall fetches platform binaries (absent = feature unavailable, not
    // fatal); protobufjs's only generates a minimal build.
    { pkgs: ['onnxruntime-node', 'protobufjs'], fatal: false }
  ]
};

/**
 * Rebuild the trusted packages for one workspace; true when every fatal group
 * succeeded. `spawn` is injectable so the fatal/non-fatal decision is testable
 * without invoking npm: if it inverts, a failed node-pty build exits 0 and the
 * missing binding resurfaces as a confusing MODULE_NOT_FOUND at smoke-boot.
 */
export function rebuildTrusted(dir, label, { spawn = execFileSync } = {}) {
  const groups = TRUSTED_REBUILDS[label];
  if (!groups) return true;
  let ok = true;
  for (const { pkgs, fatal } of groups) {
    try {
      // Through prepareCliSpawn: on Windows `npm` is a `.cmd` shim, which Node's
      // CVE-2024-27980 patch REFUSES under `shell:false` (`spawnSync npm.cmd
      // EINVAL`); that throw aborted every Windows update before the client build
      // and pm2 restart. See server/lib/bufferedSpawn.js for why the fix is a
      // `cmd.exe /c` wrap and not `shell:true` (which does not escape args).
      // `npm rebuild` still honors ignore-scripts=true from the workspace .npmrc;
      // override it for these named packages only.
      const { command, args } = prepareCliSpawn('npm', ['rebuild', '--ignore-scripts=false', ...pkgs]);
      spawn(command, args, { cwd: dir, stdio: 'inherit', windowsHide: true });
    } catch (err) {
      console.error(`⚠️  npm rebuild ${pkgs.join(' ')} failed for ${label}: ${err.message ?? err}`);
      if (fatal) ok = false;
    }
  }
  return ok;
}

/**
 * CLI body, returning an exit code instead of calling process.exit so every
 * branch is assertable. `node scripts/trusted-rebuilds.js <label> [dir]`
 */
export function runCli(argv, { spawn = execFileSync } = {}) {
  const [label, dirOverride] = argv;
  if (!label) {
    console.error(`❌ usage: node scripts/trusted-rebuilds.js <${discoverWorkspaces().join('|')}>`);
    return 1;
  }
  // Validate against the real workspace list BEFORE the "nothing to do" check, or a
  // typo (`sever`) falls through to a green exit 0 and leaves node-pty unbuilt.
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
