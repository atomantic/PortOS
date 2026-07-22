/**
 * 001 — strip already-known Gmail send-as aliases from stored activity participants (#2855).
 *
 * `messageActivityCandidates` excludes every owner address (primary + send-as
 * aliases) from a received message's participants, but rows recorded BEFORE an
 * account's alias set was learned kept the alias as a second participant. Because
 * activity inserts are `ON CONFLICT (source, dedupe_key) DO NOTHING` (a deliberate
 * "re-syncs are no-ops" contract), a re-sync never rewrites them — so a 1:1 email
 * delivered to an alias keeps looking like a group thread to the Tribe-outreach
 * detector.
 *
 * The sync path (`messageSync.repairActivityAliasParticipants`) repairs rows when
 * an account learns a NEW alias, but that delta trigger can't help an install whose
 * alias set was ALREADY learned by an earlier build — the set never changes again,
 * so the trigger never fires. This migration closes that gap once, at upgrade, by
 * stripping every currently-stored alias from that account's existing rows.
 *
 * Idempotent by construction (the `EXISTS` gate means a second run matches nothing),
 * and recorded in `schema_migrations` so it only runs once anyway.
 */
import { join } from 'path';
import { PATHS, safeJSONParse, tryReadFile } from '../../lib/fileUtils.js';
import { isPlainObject } from '../../lib/objects.js';
import { stripParticipantsForAccount } from '../../services/humanActivity.js';

export async function up(client) {
  const content = await tryReadFile(join(PATHS.messages, 'accounts.json'));
  if (!content) return; // no message accounts on this install — nothing to repair
  const parsed = safeJSONParse(content, {}, { context: 'migration-001-send-as-aliases' });
  if (!isPlainObject(parsed)) return;

  let repaired = 0;
  for (const account of Object.values(parsed)) {
    if (!account?.id) continue;
    // Reuses the service's scoped rewrite, but on the migration's transaction
    // client so the repair shares this migration's all-or-nothing semantics.
    repaired += await stripParticipantsForAccount(
      account.id,
      account.type || 'message',
      account.sendAsAliases,
      { client },
    );
  }
  if (repaired > 0) {
    console.log(`🗓️  Migration 001: stripped owner send-as aliases from ${repaired} activity event(s)`);
  }
}
