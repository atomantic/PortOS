/**
 * The managed-app placeholders every CoS prompt template shares.
 */

import { appWorktreeSlug } from './worktreeOwnership.js';

/**
 * Expand `{appName}` / `{repoPath}` / `{appId}` / `{appSlug}` in `text`. Replacers are
 * function-form because a name/path/id is free text a `$` can appear in. Callers expand
 * their injected blocks (`{trackerInstructions}`) FIRST, as those carry placeholders too. Pure.
 * @param {string} text - the prompt template
 * @param {{id?: string, name?: string, repoPath?: string}} app - managed-app record
 */
export function applyAppPlaceholders(text, app) {
  const slug = appWorktreeSlug(app);
  return String(text)
    .replace(/\{appName\}/g, () => app?.name ?? '')
    .replace(/\{repoPath\}/g, () => app?.repoPath ?? '')
    .replace(/\{appId\}/g, () => app?.id ?? '')
    .replace(/\{appSlug\}/g, () => slug);
}
