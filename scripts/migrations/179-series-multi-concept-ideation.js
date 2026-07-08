/**
 * CWQE Phase 15 — multi-concept series ideation (#2180).
 *
 * `pipeline-series-generate.md` changed from inventing ONE series concept to
 * inventing SEVERAL genuinely distinct candidate concepts (each with craft
 * facets: hook / world / conflict engine / cost / tension / theme) under an
 * anti-generic banlist, returning a `{candidates:[...]}` JSON payload. The New
 * Series form presents the candidates for user pick; autonomous invention
 * judge-picks the winner via the new `pipeline-series-concept-judge` stage
 * (seeded by the sibling migration 180).
 *
 * `scripts/setup-data.js` only copies *missing* prompt files, so existing
 * installs keep their old single-concept `pipeline-series-generate.md` until
 * this migration rewrites it — and the service's `content.candidates` gate would
 * throw "no usable series concepts" against the old template's single-object
 * output. This hash-driven replace upgrades only installs whose copy still
 * hashes to the prior shipped version; customized prompts are left intact and
 * warned about.
 *
 * Strategy: hash-driven prompt-replace via `./_lib.js`. Idempotent.
 */

import { makePromptReplaceMigration } from './_lib.js';

// Pre-change shipped hash (the single-concept body seeded by migration 088).
export const ACCEPTED_OLD_MD5 = {
  'pipeline-series-generate.md': ['bc72731124a2bd6304362f4402c6305d'],
};

// Post-change shipped hash (multi-concept + banlist + facets).
export const NEW_SHIPPED_MD5 = {
  'pipeline-series-generate.md': '21352c21ed6d4edb7a4b7c32704eff55',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'multi-concept series ideation',
  customizedHint: (filename) =>
    `   To upgrade it manually, diff:\n` +
    `     data.reference/prompts/stages/${filename}\n` +
    `   against your current:\n` +
    `     data/prompts/stages/${filename}\n` +
    `   and switch it to emit a {"candidates":[...]} array of concepts under the\n` +
    `   anti-generic banlist ({{count}} / {{banlist}} variables).`,
  skipFooter: (count) =>
    `⚠️  ${count} series-concept prompt(s) could not be auto-updated because they\n` +
    `   were customized. "Generate with AI" on the New Series form will keep\n` +
    `   returning a single concept and the multi-candidate picker will be empty\n` +
    `   until you merge the new shape from\n` +
    `   data.reference/prompts/stages/pipeline-series-generate.md.`,
});

export { applyMigration };
export default { up };
