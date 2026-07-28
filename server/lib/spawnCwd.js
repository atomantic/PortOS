/**
 * Spawn working-directory resolution for provider runs and agents.
 *
 * Every AI provider run and CoS agent gets a `workspacePath` (the selected
 * app's repoPath) and spawns its CLI/TUI with that as the child's cwd. When the
 * value is missing the spawn falls back to the PortOS repo root — which is a
 * reasonable default, but used to be *silent*: a prompt like "create
 * HelloWorld.md" then wrote into the PortOS checkout while the UI still showed
 * the app as the selected workspace, with nothing anywhere saying which
 * directory had actually been used (issue #3180).
 *
 * This module makes that decision explicit and loud in the two ways that
 * matter: it logs the effective cwd for every spawn, and it rejects a workspace
 * that was requested but does not exist on disk (a typo'd or moved repo path)
 * rather than quietly running somewhere else.
 *
 * Note this can only catch a workspace that *resolved to something wrong*. The
 * other half of #3180 — an app that resolves to no path at all — has to be
 * caught where the app is looked up, because "no path" arrives here
 * indistinguishable from "no app selected". `getAppWorkspace` returns `null`
 * for that case rather than silently substituting the PortOS root.
 */

import { statSync } from 'fs';
import { expandHome } from './fileUtils.js';

/**
 * Resolve the working directory for a spawned run or agent.
 *
 * @param {string|undefined|null} workspacePath - caller-supplied workspace (app repoPath)
 * @param {string} fallbackRoot - directory to use when no workspace was supplied
 * @param {string} [label] - short run/agent identifier used in the log line
 * @returns {string} the directory to hand to `spawn`/`pty.spawn` as `cwd`
 * @throws {Error} when `workspacePath` was supplied but is not an existing directory
 */
export function resolveSpawnCwd(workspacePath, fallbackRoot, label = 'run') {
  // expandHome so a repoPath saved as `~/Projects/App` resolves instead of
  // hard-failing as "does not exist" — `repoPath` is only validated as a
  // non-empty string, and every other user-supplied-path boundary in the repo
  // expands it too.
  const requested = expandHome(typeof workspacePath === 'string' ? workspacePath.trim() : '');

  if (!requested) {
    console.log(`📂 ${label} cwd: ${fallbackRoot} (no workspace selected)`);
    return fallbackRoot;
  }

  // Fail loudly instead of silently running in the PortOS checkout. A bad
  // repoPath is a configuration error the user can fix; running the agent
  // somewhere else and reporting success is not recoverable after the fact.
  const stats = statSync(requested, { throwIfNoEntry: false });
  if (!stats) {
    throw new Error(
      `Workspace path does not exist: ${requested}. `
      + `Fix the Repository Path for this app (Apps → edit → Repository Path) and run again.`
    );
  }
  if (!stats.isDirectory()) {
    throw new Error(
      `Workspace path is not a directory: ${requested}. `
      + `Set the app's Repository Path to the repo folder, not a file.`
    );
  }

  console.log(`📂 ${label} cwd: ${requested}`);
  return requested;
}
