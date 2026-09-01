/**
 * Rename the Brain link repository fields from their GitHub-only shape to the
 * host-generic one, now that PortOS clones gitlab.com as well as github.com.
 *
 *     isGitHubRepo → isRepo          (the legacy key is KEPT, see below)
 *     gitHubOwner  → repoOwner
 *     gitHubRepo   → repoName
 *     linkType 'github' → 'repo'
 *                  + repoHost: 'github.com'
 *
 * Every link this migration touches was captured before multi-host support
 * existed, so its host can only be github.com — the legacy fields had no way to
 * express anything else.
 *
 * The legacy keys are deliberately LEFT IN PLACE rather than deleted. PortOS is
 * distributed: brain links federate verbatim, and a peer still on older code
 * reads `isGitHubRepo` to decide a link is a clonable repo. Dropping the key
 * here would demote every shared repo to a plain bookmark on that peer. New
 * writes keep both shapes for the same reason (`lib/repoLinkFields.js`), and a
 * later migration can retire the legacy half once no supported peer reads it.
 *
 * Idempotent: a record that already carries `isRepo` is skipped, so a re-run
 * after a partial pass finishes the remainder without rewriting the rest.
 *
 * The legacy → new mapping is deliberately duplicated from
 * `server/lib/repoLinkFields.js` rather than imported: a migration is a
 * point-in-time record and must not drift when that module changes.
 */

import { readdir } from 'fs/promises';
import { join } from 'path';
import { readJSONFile } from '../../server/lib/fileUtils.js';
import { writeJsonAtomic } from './_lib.js';

const LABEL = 'migration 330';

/** The upgraded record, or null when nothing needs to change. */
export function upgradeLinkRecord(record) {
  if (!record || typeof record !== 'object') return null;
  // Tombstones carry no link fields, and a record already in the new shape is
  // done — including one written by a newer peer that reached this install
  // before the migration ran.
  if (record._deleted || record.isRepo !== undefined) return null;
  if (!record.isGitHubRepo) return null;

  return {
    ...record,
    isRepo: true,
    repoHost: 'github.com',
    repoOwner: record.gitHubOwner ?? null,
    repoName: record.gitHubRepo ?? null,
    ...(record.linkType === 'github' ? { linkType: 'repo' } : {}),
  };
}

export default {
  async up({ rootDir }) {
    const linksDir = join(rootDir, 'data', 'brain', 'links');
    const entries = await readdir(linksDir, { withFileTypes: true })
      .catch(err => (err.code === 'ENOENT' ? [] : Promise.reject(err)));

    let updated = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(linksDir, entry.name, 'index.json');
      // A record that is missing or unreadable is left exactly as it is — this
      // migration is a field rename, not a repair pass.
      const record = await readJSONFile(path, null);
      const upgraded = upgradeLinkRecord(record);
      if (!upgraded) continue;
      await writeJsonAtomic(path, upgraded);
      updated += 1;
    }

    if (updated === 0) return { updated: 0, reason: 'already-applied' };
    console.log(`🔗 ${LABEL}: renamed repository fields on ${updated} brain link(s).`);
    return { updated };
  },
};
