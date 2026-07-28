/**
 * Spawn working-directory resolution for provider runs.
 *
 * Every AI provider run gets a `workspacePath` (the selected app's repoPath) and
 * spawns its CLI/TUI with that as the child's cwd. When the value is missing the
 * spawn falls back to the PortOS repo root — which is a reasonable default, but
 * used to be *silent*: a prompt like "create HelloWorld.md" then wrote into the
 * PortOS checkout while the UI still showed the app as the selected workspace,
 * with nothing anywhere saying which directory had actually been used
 * (issue #3180).
 *
 * This module makes that decision explicit and loud in the two ways that
 * matter: it logs the effective cwd for every run, and it refuses to spawn when
 * the caller asked for a specific workspace that does not exist on disk (a
 * typo'd or moved repo path) rather than quietly running somewhere else.
 */

import { existsSync, statSync } from 'fs';

/**
 * Resolve the working directory for a provider run.
 *
 * @param {string|undefined|null} workspacePath - caller-supplied workspace (app repoPath)
 * @param {string} fallbackRoot - directory to use when no workspace was supplied
 * @param {string} [label] - short run identifier used in the log line
 * @returns {string} the directory to hand to `spawn`/`pty.spawn` as `cwd`
 * @throws {Error} when `workspacePath` was supplied but is not an existing directory
 */
export function resolveSpawnCwd(workspacePath, fallbackRoot, label = 'run') {
  const requested = typeof workspacePath === 'string' ? workspacePath.trim() : '';

  if (!requested) {
    console.log(`📂 ${label} cwd: ${fallbackRoot} (no workspace selected)`);
    return fallbackRoot;
  }

  // Fail loudly instead of silently running in the PortOS checkout. A bad
  // repoPath is a configuration error the user can fix; running the agent
  // somewhere else and reporting success is not recoverable after the fact.
  if (!existsSync(requested)) {
    throw new Error(
      `Workspace path does not exist: ${requested}. `
      + `Fix the Repository Path for this app (Apps → edit → Repository Path) and run again.`
    );
  }
  if (!statSync(requested).isDirectory()) {
    throw new Error(
      `Workspace path is not a directory: ${requested}. `
      + `Set the app's Repository Path to the repo folder, not a file.`
    );
  }

  console.log(`📂 ${label} cwd: ${requested}`);
  return requested;
}
