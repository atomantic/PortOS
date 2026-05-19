/**
 * Add an "Anchor every edit in the per-episode `synopsis` entries" bullet at
 * the top of the `pipeline-arc-resolve.md` "How to resolve" list.
 *
 * Why:
 *   `buildResolveContext` already feeds episode-level `synopsis` strings into
 *   `seasonsTreeJson` (via `buildVerifyContext`), but none of the prior
 *   numbered guidance steps told the LLM to use them. The auto-resolve pass
 *   could rewrite a volume's `synopsis` in a way that contradicted the
 *   per-episode `synopsis` entries underneath. This bullet pins the LLM to
 *   treat episode synopses as ground truth when adjusting volume framing.
 *
 *   The pre-resolve verify prompt (`pipeline-arc-verify.md`) already calls
 *   out episode-level evidence explicitly ("Did a character die in episode 4
 *   but get dialogue in episode 7?"). Resolve inherited the same data path
 *   but not the same instruction shape — see PLAN.md
 *   `[resolve-issues-inherits-verify-gaps-verify-the]`.
 *
 * Implementation: hash-driven prompt-replace via `./_lib.js`. Idempotent.
 */

import { makePromptReplaceMigration } from './_lib.js';

// Hashes the file may have on disk pre-migration. Most recent shipped first,
// then older. Any match is "unmodified by user → safe to replace."
// Exported so the test suite can import them and detect drift without
// maintaining local copies.
export const ACCEPTED_OLD_MD5 = {
  'pipeline-arc-resolve.md': [
    '8e348f3d1894382889f9f0ee7d5c6792', // post-019 (worldCanonText) shipped — current pre-023
    'a8677bbe1eb38f871fb152a5b0fec7c6', // pre-019 (pre-canon), still in setup-data.js OLD list
    '87bc5c01f1a8a97b681727a38b05edc6', // pre-005 (shape-aware), still in setup-data.js OLD list
  ],
};

// New shipped hash — what data.sample carries post-migration.
export const NEW_SHIPPED_MD5 = {
  'pipeline-arc-resolve.md': '5b340885c6e8f8afc63424d6b5bc7eb7',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'resolve-prompt',
  customizedHint: (filename) =>
    `   To pick up the new "anchor in per-episode synopses" guidance manually, diff:\n` +
    `     data.sample/prompts/stages/${filename}\n` +
    `   against your current:\n` +
    `     data/prompts/stages/${filename}\n` +
    `   and add the new bullet 1 in the "How to resolve" list.`,
  skipFooter: (count) =>
    `⚠️  ${count} resolve prompt could not be auto-updated because it was customized.\n` +
    `   The auto-resolve pass will keep working but won't be explicitly told to anchor\n` +
    `   volume-synopsis edits in the per-episode \`synopsis\` entries from\n` +
    `   \`seasonsTreeJson.episodes[].synopsis\`. See data.sample/prompts/stages/.`,
});

export { applyMigration };
export default { up };
