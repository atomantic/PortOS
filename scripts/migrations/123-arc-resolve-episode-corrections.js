/**
 * Update the `pipeline-arc-resolve` stage prompt to add an episode-correction
 * channel.
 *
 * The arc auto-resolve pass used to rewrite only the arc + volume/season
 * synopses and was explicitly forbidden from touching episodes. That made any
 * finding whose contradiction *originates* inside one episode's planning
 * synopsis structurally unresolvable — every verify round re-flagged it because
 * the offending episode text never changed, so the autopilot's arc-verify loop
 * could never converge and always paused for human review.
 *
 * The new prompt lets the resolver return a sparse `episodes[]` array of
 * corrected episode synopses (keyed by seasonNumber + episodeNumber), which
 * `resolveVerifyIssues` writes back to each issue's `idea.input` seed. Editing
 * is safe at the arc-verify gate because no script has been drafted yet.
 *
 * Strategy: hash-driven prompt-replace via `./_lib.js`. Idempotent.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'pipeline-arc-resolve.md': [
    '5b340885c6e8f8afc63424d6b5bc7eb7', // pre-123 (episodes forbidden)
  ],
};

export const NEW_SHIPPED_MD5 = {
  'pipeline-arc-resolve.md': 'cc27b4da1d1a13c35e35d1c2d6183815', // post-123 (episodes[] channel)
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'arc-resolve stage prompt',
  customizedHint: (filename) =>
    `   To add the episode-correction channel manually, diff:\n` +
    `     data.reference/prompts/stages/${filename}\n` +
    `   against your current:\n` +
    `     data/prompts/stages/${filename}\n` +
    `   and merge instruction 8 + the episodes[] output field.`,
  skipFooter: (count) =>
    `⚠️  ${count} prompt(s) could not be auto-updated because they were customized.\n` +
    `   Arc auto-resolve will keep working but won't be able to fix episode-level\n` +
    `   contradictions until you merge the episodes[] channel manually.`,
});

export { applyMigration };
export default { up };
