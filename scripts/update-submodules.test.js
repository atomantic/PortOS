/**
 * Cross-platform self-update contract. Executing either updater for real would
 * pull, install, rebuild, migrate, and restart the live instance, so source
 * inspection is the highest safe boundary for pinning their command parity.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SCRIPT_COMMANDS = [
  {
    path: 'update.sh',
    pull: 'run git pull --rebase',
    sync: 'run git submodule sync --recursive',
    update: 'run git submodule update --init --recursive',
    preflight: 'if ! repair_stale_submodules; then',
    dirtyGuard: 'if has_local_changes; then',
  },
  {
    path: 'update.ps1',
    pull: 'Invoke-Logged git pull --rebase',
    sync: 'Invoke-Logged git submodule sync --recursive',
    update: 'Invoke-Logged git submodule update --init --recursive',
    preflight: 'if (-not (Repair-StaleSubmodules)) {',
    dirtyGuard: 'if ($hasChanges) {',
  },
];

describe.each(SCRIPT_COMMANDS)('$path submodule update contract', ({ path, pull, sync, update, preflight, dirtyGuard }) => {
  const source = readFileSync(join(REPO_ROOT, path), 'utf8');

  it('syncs recursive metadata and then checks out pinned commits after pulling', () => {
    const pullIndex = source.indexOf(pull);
    const syncIndex = source.lastIndexOf(sync);
    const updateIndex = source.lastIndexOf(update);

    expect(pullIndex).toBeGreaterThanOrEqual(0);
    expect(syncIndex).toBeGreaterThan(pullIndex);
    expect(updateIndex).toBeGreaterThan(syncIndex);
  });

  it('repairs an interrupted submodule checkout before the dirty-tree guard', () => {
    const preflightIndex = source.indexOf(preflight);
    const dirtyIndex = source.indexOf(dirtyGuard);
    const pullIndex = source.indexOf(pull);

    expect(preflightIndex).toBeGreaterThanOrEqual(0);
    expect(dirtyIndex).toBeGreaterThan(preflightIndex);
    expect(preflightIndex).toBeLessThan(pullIndex);
    expect(source.indexOf(preflight, preflightIndex + preflight.length)).toBeGreaterThan(dirtyIndex);
  });

  it('does not advance submodules past the commits reviewed by PortOS', () => {
    expect(source).not.toMatch(/git submodule update[^\n]*--remote/);
  });

  it('never uses stash as an implicit update transport', () => {
    expect(source).not.toMatch(/git\s+stash|--autostash/);
    expect(source).toContain('Checkout is dirty; no stash was created');
  });

  // This script is the most likely producer of an abandoned lock (PM2 tree-kills
  // it mid-run), and without the sweep every later self-update fails identically
  // on a file under `.git/` only a human would find. Both platforms call the one
  // Node helper rather than each reimplementing "is this lock abandoned?".
  it('clears locks a previously killed update left behind, before it takes any', () => {
    const sweepIndex = source.indexOf('clearStaleGitLocksIn');
    expect(sweepIndex).toBeGreaterThanOrEqual(0);
    expect(sweepIndex).toBeLessThan(source.indexOf(pull));
  });
});
