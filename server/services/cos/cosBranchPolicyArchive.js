/**
 * Maintain the indexed projection of branch-completion policies in CoS archives.
 *
 * Storage: `asset-file-db-indexed`. Archive membership and metadata stay on
 * disk. The local PostgreSQL index is derived, never federated. File-mode
 * tests use the same projection and update steps with in-memory lookup maps.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { atomicWrite } from '../../lib/fileUtils.js';
import { createFileWriteQueue } from '../../lib/fileWriteQueue.js';
import { isFileBackend } from '../../lib/pgFileFacade.js';
import { readBranchPolicyArchiveIndex } from '../../lib/cos/branchPolicyArchiveSource.js';
import {
  BRANCH_POLICY_REVISION_FILE, archivePolicyUnstable, insertArchivePolicyRows, readArchivePolicyBackfill, readArchivePolicyRows, readBranchPolicyArchiveStamp,
  replaceArchivePolicyRows, writeArchivePolicyStamp,
} from '../../lib/cos/branchPolicyArchiveRows.js';

const queue = createFileWriteQueue();

export function makePgBranchPolicyArchive({ query, withTransaction }) {
  return {
    async read(stamp, repoPath, branches) {
      const { rows } = await query(
        `SELECT p.agent_id AS "agentId", p.policy_json AS policy
         FROM cos_branch_policy_archive a
         LEFT JOIN cos_branch_completion_policies p ON (
           p.repo_path = '' OR (p.repo_path = $2 AND
             ($3::text[] IS NULL OR p.branch = '' OR p.branch = ANY($3::text[])))
         )
         WHERE a.id = 1 AND a.source_stamp = $1`, [stamp, repoPath, branches ?? null],
      );
      // The outer join distinguishes a complete empty scope from no usable index.
      return rows.length ? rows.filter(row => row.agentId !== null) : null;
    },
    async write(stamp, previous, records, changedIds) {
      await withTransaction(async client => {
        if (previous === null) return replaceArchivePolicyRows(client, stamp, records);
        const { rows } = await client.query('SELECT source_stamp FROM cos_branch_policy_archive WHERE id = 1 FOR UPDATE');
        if (rows[0]?.source_stamp !== previous) return;
        if (changedIds.length) {
          await client.query('DELETE FROM cos_branch_completion_policies WHERE agent_id = ANY($1::text[])', [changedIds]);
        }
        await insertArchivePolicyRows(client, records);
        await writeArchivePolicyStamp(client, stamp);
      });
    },
  };
}

export function makeFileBranchPolicyArchive() {
  let sourceStamp = null;
  const byScope = new Map();
  const scopesByAgent = new Map();
  const scope = (repo, branch) => JSON.stringify([repo, branch]);
  function add(key, row) {
    if (!byScope.has(key)) byScope.set(key, new Map());
    byScope.get(key).set(row.agentId, row);
    if (!scopesByAgent.has(row.agentId)) scopesByAgent.set(row.agentId, new Set());
    scopesByAgent.get(row.agentId).add(key);
  }
  return {
    async read(stamp, repoPath, branches) {
      if (stamp !== sourceStamp) return null;
      const keys = [scope('', ''), ...(branches ? ['', ...branches].map(branch => scope(repoPath, branch)) : [scope(repoPath)])];
      return keys.flatMap(key => [...(byScope.get(key)?.values() ?? [])]);
    },
    async write(stamp, previous, records, changedIds) {
      if (previous === null) {
        byScope.clear();
        scopesByAgent.clear();
      } else {
        if (sourceStamp !== previous) return;
        for (const id of changedIds) {
          for (const key of scopesByAgent.get(id) ?? []) {
            const rows = byScope.get(key);
            rows.delete(id);
            if (!rows.size) byScope.delete(key);
          }
          scopesByAgent.delete(id);
        }
      }
      for (const row of records) {
        add(scope(row.repoPath, row.branch), row);
        if (row.repoPath) add(scope(row.repoPath), row);
      }
      sourceStamp = stamp;
    },
  };
}

const fileStore = makeFileBranchPolicyArchive();
const backend = async () => isFileBackend() ? fileStore : makePgBranchPolicyArchive(await import('../../lib/db.js'));

export async function readIndexedArchivePolicies(dir, repoPath, branches) {
  const stamp = await readBranchPolicyArchiveStamp(dir, { recoverPending: true });
  if (!stamp) return null;
  const store = await backend();
  let rows = await store.read(stamp, repoPath, branches);
  if (rows === null) {
    // A first read, a restore or a failed publication can all land here.
    const records = await readArchivePolicyBackfill(dir, stamp);
    if (records === null) throw archivePolicyUnstable();
    await store.write(stamp, null, records);
    rows = await store.read(stamp, repoPath, branches);
  }
  // A standalone process doesn't share the local queue. Recheck the source
  // after the database roundtrip even when the transaction found the old stamp.
  if (await readBranchPolicyArchiveStamp(dir) !== stamp) throw archivePolicyUnstable();
  return rows;
}

/** Keep live-agent shadowing and archive observation in the same archive turn. */
export const withArchivePolicyRead = queue;

/**
 * For membership publication the atomic index replacement changes the stamp.
 * Metadata-only writes mark the revision pending until the source settles.
 * An interrupted write or failed projection commit leaves the archive
 * unreadable from the index until the next scoped reader rebuilds it.
 */
export function publishArchivePolicyChange(dir, publish, { index, ids, restore = false } = {}) {
  return queue(async () => {
    const before = await readBranchPolicyArchiveStamp(dir, { recoverPending: true });
    const previousIndex = before && !restore && await readBranchPolicyArchiveIndex(dir).catch(() => null);
    let result;
    if (before && !index) {
      const revision = randomUUID();
      const revisionPath = join(dir, BRANCH_POLICY_REVISION_FILE);
      await atomicWrite(revisionPath, `pending:${process.pid}:${revision}`);
      try {
        result = await publish();
      } finally {
        await atomicWrite(revisionPath, revision);
      }
    } else {
      result = await publish();
    }
    if (!previousIndex || restore) return result;

    const currentIndex = index ?? previousIndex;
    const changedIds = index
      ? [...new Set([...Object.keys(previousIndex), ...Object.keys(index)])].filter(id => previousIndex[id] !== index[id])
      : ids;
    const entries = changedIds.filter(id => Object.hasOwn(currentIndex, id)).map(id => [id, currentIndex[id]]);
    try {
      const stamp = await readBranchPolicyArchiveStamp(dir);
      if (stamp) await (await backend()).write(stamp, before, await readArchivePolicyRows(dir, entries), changedIds);
    } catch (error) {
      console.warn(`⚠️ CoS branch policy index update deferred: ${error.message}`);
    }
    return result;
  });
}
