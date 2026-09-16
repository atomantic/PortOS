/**
 * The managed-app placeholders every CoS prompt template shares.
 *
 * Four renderers build an agent prompt from a template plus an app record
 * (`services/cosTaskGenerator.js`'s claim-work router and JIRA per-ticket
 * builder, `services/cosTaskPreStepBlocks.js`'s scheduled builder, and
 * `services/referenceRepos.js`), and each used to spell this head of the
 * `.replace()` chain itself. They drifted: `{appSlug}` reached three of them, so
 * the fourth would ship a literal `{appSlug}` into a shell path the moment a
 * worktree-creating body was routed through it. One function makes adding a
 * placeholder one edit rather than a four-site audit.
 */

import { appWorktreeSlug } from './worktreeOwnership.js';

/**
 * Expand `{appName}` / `{repoPath}` / `{appId}` / `{appSlug}` in `text`.
 *
 * Every replacement is FUNCTION-form. A replacement STRING makes `String.replace`
 * read `$&`, `$1` and the before/after-match tokens out of the substituted VALUE —
 * and an app name, a repo path and an id are all free text a `$` can appear in.
 *
 * Callers substitute their own injected Markdown blocks (`{trackerInstructions}`,
 * `{modeInstructions}`) BEFORE calling this: those blocks carry `{appName}` /
 * `{repoPath}` of their own, which are expanded only if the block lands first.
 *
 * Pure.
 *
 * @param {string} text - the prompt template
 * @param {{id?: string, name?: string, repoPath?: string}} app - managed-app record
 * @returns {string}
 */
export function applyAppPlaceholders(text, app) {
  const slug = appWorktreeSlug(app);
  return String(text)
    .replace(/\{appName\}/g, () => app?.name ?? '')
    .replace(/\{repoPath\}/g, () => app?.repoPath ?? '')
    .replace(/\{appId\}/g, () => app?.id ?? '')
    // The per-app segment of a worktree directory name under the ONE shared
    // `data/cos/worktrees/` root — see appWorktreeSlug for why it has to be there.
    .replace(/\{appSlug\}/g, () => slug);
}
