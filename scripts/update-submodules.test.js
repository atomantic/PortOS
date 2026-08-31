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
    pull: 'run git pull --rebase --autostash',
    sync: 'run git submodule sync --recursive',
    update: 'run git submodule update --init --recursive',
  },
  {
    path: 'update.ps1',
    pull: 'Invoke-Logged git pull --rebase --autostash',
    sync: 'Invoke-Logged git submodule sync --recursive',
    update: 'Invoke-Logged git submodule update --init --recursive',
  },
];

describe.each(SCRIPT_COMMANDS)('$path submodule update contract', ({ path, pull, sync, update }) => {
  const source = readFileSync(join(REPO_ROOT, path), 'utf8');

  it('syncs recursive metadata and then checks out pinned commits after pulling', () => {
    const pullIndex = source.indexOf(pull);
    const syncIndex = source.indexOf(sync);
    const updateIndex = source.indexOf(update);

    expect(pullIndex).toBeGreaterThanOrEqual(0);
    expect(syncIndex).toBeGreaterThan(pullIndex);
    expect(updateIndex).toBeGreaterThan(syncIndex);
  });

  it('does not advance submodules past the commits reviewed by PortOS', () => {
    expect(source).not.toMatch(/git submodule update[^\n]*--remote/);
  });
});
