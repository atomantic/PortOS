#!/usr/bin/env node
/**
 * Installs or updates the slash-do command set by running the git-pinned
 * submodule CLI at lib/slashdo/bin/cli.js with the current Node binary.
 *
 * slash-do lays the commands down under ~/.claude/commands (or each detected AI
 * environment's equivalent). The submodule commit is the single version pin, so
 * nothing is fetched from the npm registry (no network, no bypass of
 * .npmrc ignore-scripts).
 *
 * Always exits 0: PortOS works without the global commands, so a failed install
 * must never fail a setup or an update. Called by scripts/setup.js and
 * scripts/update.mjs (update.sh / update.ps1 delegate there).
 *
 * Node builtins only, so it runs on a clone with no node_modules.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectlyInvoked } from './lib/directInvocation.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SLASHDO_CLI = join(ROOT, 'lib/slashdo/bin/cli.js');

// slash-do's "multiple environments detected" prompt blocks on readline when
// stdin is not a TTY; answering "a" selects every detected environment.
function runCli(cli) {
  const result = spawnSync(process.execPath, [cli], { input: 'a\n', stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true });
  return result.status === 0;
}

/** Returns 'installed', 'failed' or 'skipped'; never throws. */
export function installSlashdo({ cli = SLASHDO_CLI, run = runCli, log = console.log } = {}) {
  if (!existsSync(cli)) {
    log('⚠️  lib/slashdo submodule not initialized — skipping slash-do install (run: git submodule update --init --recursive)');
    return 'skipped';
  }
  log('📦 Installing/updating slash-do commands (lib/slashdo)...');
  let ok = false;
  try {
    ok = run(cli);
  } catch { /* reported below */ }
  if (!ok) {
    log('⚠️  slash-do install failed — skipping (you can re-run later: node scripts/install-slashdo.js)');
    return 'failed';
  }
  return 'installed';
}

if (isDirectlyInvoked(import.meta.url)) {
  installSlashdo();
  process.exitCode = 0;
}
