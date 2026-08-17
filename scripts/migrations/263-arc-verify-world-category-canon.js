/**
 * Show the arc verifier the world canon it is already judging groundedness
 * against.
 *
 * A Universe Builder world defines its factions, locations, vehicles, artifacts,
 * and interfaces as `categories` variations. The named-canon trunks the verify
 * prompt rendered (`worldCanonText` — characters/places/objects) stay EMPTY until
 * prose mints entities into them, so the verifier was told "here is the world
 * canon" and handed a list that omitted the entire built world. It then flagged
 * locked faction cards as invented, un-canonized, and "absent from the World
 * Canon" — findings no arc edit can close, because the entity was grounded all
 * along.
 *
 * That is a stall, not a nuisance: the foundation gate's structure arm reverts
 * its whole repair whenever `verifyArc` leaves ANY blocker, so one permanent
 * false positive discards every real fix alongside it. The sibling
 * `pipeline-arc-resolve.md` and `pipeline-volume-verify.md` already render this
 * block — only the arc verifier was blind, which is exactly why the verify/
 * resolve pair could never converge.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'pipeline-arc-verify.md': ['68f6956d7e09ebdb3870d8726b1b2a7a'],
};

export const NEW_SHIPPED_MD5 = {
  'pipeline-arc-verify.md': 'a397f158fd9c0dca1c8dbe62df253f70',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'arc-verify world category canon',
  customizedHint: (filename) =>
    `   To upgrade it manually, diff data.reference/prompts/stages/${filename}\n` +
    `   against data/prompts/stages/${filename} and add the world entity category +\n` +
    `   composite blocks plus the rule that category canon is grounded canon.`,
});

export { applyMigration };
export default { up };
