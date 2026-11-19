#!/usr/bin/env node
/**
 * Installs or updates the pinned slash-do command set (`npx slash-do@<version>`).
 *
 * slash-do lays the commands down under ~/.claude/commands (or each detected AI
 * environment's equivalent). The git submodule at lib/slashdo is the in-repo
 * source CoS agents load inline; this keeps the user-global command pool current.
 * The version lives in scripts/SLASHDO_VERSION, the single pin.
 *
 * Always exits 0: PortOS works without the global commands, so a failed install
 * must never fail a setup or an update. Called by scripts/setup.js, update.sh and
 * update.ps1.
 *
 * Node builtins plus server/lib/bufferedSpawn.js (itself builtins-only), so it
 * runs on a clone with no node_modules.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectlyInvoked } from './lib/directInvocation.js';
// `npx` is a `.cmd` shim on Windows, which Node refuses to spawn under shell:false.
import { prepareCliSpawn } from '../server/lib/bufferedSpawn.js';

const VERSION_FILE = join(dirname(fileURLToPath(import.meta.url)), 'SLASHDO_VERSION');

/** The pinned version, or null when the pin file is missing or not an exact semver. */
export function readSlashdoVersion(file = VERSION_FILE) {
  try {
    const version = readFileSync(file, 'utf8').trim();
    return /^\d+\.\d+\.\d+$/.test(version) ? version : null;
  } catch {
    return null;
  }
}

// slash-do's "multiple environments detected" prompt blocks on readline when
// stdin is not a TTY; answering "a" selects every detected environment.
function runNpx(version) {
  const { command, args } = prepareCliSpawn('npx', ['--yes', `slash-do@${version}`]);
  const result = spawnSync(command, args, { input: 'a\n', stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true });
  return result.status === 0;
}

/** Returns 'installed', 'failed' or 'skipped'; never throws. */
export function installSlashdo({ version = readSlashdoVersion(), run = runNpx, log = console.log } = {}) {
  if (!version) {
    log('⚠️  scripts/SLASHDO_VERSION missing or not an exact version — skipping slash-do install');
    return 'skipped';
  }
  log(`📦 Installing/updating slash-do commands (npx slash-do@${version})...`);
  let ok = false;
  try {
    ok = run(version);
  } catch { /* reported below */ }
  if (!ok) {
    log(`⚠️  slash-do install failed — skipping (you can re-run later: npx slash-do@${version})`);
    return 'failed';
  }
  return 'installed';
}

if (isDirectlyInvoked(import.meta.url)) {
  installSlashdo();
  process.exitCode = 0;
}
