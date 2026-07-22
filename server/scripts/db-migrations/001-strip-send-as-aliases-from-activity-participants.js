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
import { readFile } from 'fs/promises';
import { join } from 'path';
import { PATHS } from '../../lib/fileUtils.js';
import { isPlainObject } from '../../lib/objects.js';
import { stripParticipantsForAccount } from '../../services/humanActivity.js';

// Repo-relative label for error messages — never interpolate the absolute path,
// which embeds the OS username.
const ACCOUNTS_LABEL = 'data/messages/accounts.json';

export async function up(client) {
  // Read WITHOUT the usual `tryReadFile`/`safeJSONParse` swallowing: those collapse
  // "file absent" and "read/parse FAILED" into the same empty result, and here the
  // difference is permanent. This migration is recorded in `schema_migrations` the
  // moment `up()` returns normally, so a transient unreadable/corrupt accounts file
  // would mark the one-shot backfill done and it would never run — and the sync-time
  // delta can't cover for it either (those aliases are already stored, so the delta
  // is empty forever). Only a genuinely absent file means "no work"; any other
  // failure throws, which rolls the migration back UNAPPLIED so the next boot
  // retries it. (try/catch is sanctioned here — this runs at boot, outside the
  // Express request lifecycle.)
  let content;
  try {
    content = await readFile(join(PATHS.messages, 'accounts.json'), 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return; // no message accounts on this install — nothing to repair
    throw new Error(`migration 001: cannot read ${ACCOUNTS_LABEL} (${err?.code || 'read error'}) — refusing to mark the send-as-alias backfill applied: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`migration 001: ${ACCOUNTS_LABEL} is not valid JSON — refusing to mark the send-as-alias backfill applied: ${err.message}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`migration 001: ${ACCOUNTS_LABEL} did not contain an account map — refusing to mark the send-as-alias backfill applied.`);
  }

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
