/**
 * Read-only managed-app resolution for CoS dispatch and workspace preparation.
 * Preserve legacy registry shapes without bootstrapping or rewriting the registry.
 */

import { join } from 'path';
import { PATHS, readJSONFile, expandHome } from '../../lib/fileUtils.js';

const ROOT_DIR = PATHS.root;

/**
 * Get the workspace path for an app, or `null` when it can't be resolved (registry missing, app
 * not found, no `repoPath`). The explicit `null` sentinel (never the PortOS root, which made an
 * unresolvable app look working, #3180) lets each caller decide whether "no workspace" is legal.
 * The reason is logged here, where it's known.
 *
 * @returns {Promise<string|null>} the app's repoPath, or null if unresolvable
 */
export async function getAppWorkspace(appName) {
  const appsFile = join(ROOT_DIR, 'data/apps.json');
  const unresolved = (why) => { console.warn(`⚠️ ${why} — no agent workspace resolved`); return null; };

  const data = await readJSONFile(appsFile, null);
  if (!data) return unresolved(`No apps registry at ${appsFile}`);

  // Handle both object format { apps: { id: {...} } } and array format [...]
  const apps = data.apps || data;

  const app = Array.isArray(apps)
    ? apps.find(a => a.name === appName || a.id === appName)
    // Object format - keys are app IDs
    : (apps[appName] || Object.values(apps).find(a => a.name === appName));

  if (!app) return unresolved(`App '${appName}' not found in apps registry`);
  if (!app.repoPath) return unresolved(`App '${appName}' has no repoPath`);
  // Expand here, not just at spawn: agentLifecycle persists this as `sourceWorkspace` and worktree
  // cleanup/merge later uses it as a child's cwd, and Node never shell-expands `~`.
  return expandHome(app.repoPath);
}

/**
 * Get full app data for a task (including jira config).
 * Returns the app object or null if not found.
 */
export async function getAppDataForTask(task) {
  const appName = task?.metadata?.app;
  if (!appName) return null;

  const appsFile = join(ROOT_DIR, 'data/apps.json');
  const data = await readJSONFile(appsFile, null);
  if (!data) return null;

  const apps = data.apps || data;

  if (Array.isArray(apps)) {
    return apps.find(a => a.name === appName || a.id === appName) || null;
  }

  return apps[appName] || Object.values(apps).find(a => a.name === appName) || null;
}

/**
 * Every managed app that pins an explicit `forgeAccount`, as `[{ repoPath, forgeAccount }]`.
 * Forge auth has only a cwd (an agent worktree included), so it needs this path-keyed inverse of
 * `getAppWorkspace`; returning only PINNED apps lets forge auth skip the `git rev-parse` worktree
 * mapping when the list is empty.
 *
 * @returns {Promise<Array<{repoPath: string, forgeAccount: string}>>}
 */
export async function listForgePinnedApps() {
  const data = await readJSONFile(join(ROOT_DIR, 'data/apps.json'), null);
  if (!data) return [];
  const apps = data.apps || data;
  // `Object.values` covers both registry shapes (array values are its elements).
  return Object.values(apps)
    .filter(app => app?.repoPath && typeof app.forgeAccount === 'string' && app.forgeAccount.trim())
    .map(app => ({ repoPath: expandHome(app.repoPath), forgeAccount: app.forgeAccount.trim() }));
}
