/** Build and persist the PostgreSQL lookup rows for archived branch-completion policy. */
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { branchPolicyScope, normalizedPolicyWorkspace, projectPolicyAgent, reviewTargetBranches } from './branchCompletionProjection.js';
import { readBranchPolicyArchiveIndex, readBranchPolicyArchiveRecord, validateBranchPolicyArchiveRow } from './branchPolicyArchiveSource.js';
import { toPgJson } from '../pgJson.js';
import { atomicWrite } from '../fileUtils.js';
import { processLiveness } from '../processIdentity.js';

export const BRANCH_POLICY_REVISION_FILE = '.branch-policy-revision';
export const BRANCH_POLICY_ARCHIVE_UNSTABLE = 'COS_BRANCH_POLICY_ARCHIVE_UNSTABLE';

export function archivePolicyUnstable() {
  return Object.assign(new Error('archive metadata publication is in progress or changed during the read'), { code: BRANCH_POLICY_ARCHIVE_UNSTABLE });
}
const BATCH = 50;

/** The revision changes before metadata replacement. The index stat also binds
 * the projection to the exact membership file, including after a file restore. */
export async function readBranchPolicyArchiveStamp(dir, { recoverPending = false } = {}) {
  const revisionPath = join(dir, BRANCH_POLICY_REVISION_FILE);
  const [index, revision] = await Promise.all([
    stat(join(dir, 'index.json'), { bigint: true }).catch(error => { if (error.code === 'ENOENT') return null; throw error; }),
    readFile(revisionPath, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; }),
  ]);
  if (!index?.isFile()) return null;
  const pending = /^pending:(\d+):[0-9a-f-]+$/.exec(revision);
  if (pending) {
    const pid = Number(pending[1]);
    // Recovery runs under the local archive queue. A separate live process
    // may still be publishing; its pending revision is never indexable.
    if (!recoverPending) return null;
    if (pid !== process.pid && processLiveness(pid) !== 'dead') throw archivePolicyUnstable();
    await atomicWrite(revisionPath, randomUUID());
    return readBranchPolicyArchiveStamp(dir);
  }
  return ['v1', index.dev, index.ino, index.size, index.mtimeNs, index.ctimeNs, revision].join(':');
}

async function archivePolicyRows(dir, agentId, date) {
  try {
    validateBranchPolicyArchiveRow(agentId, date);
    const agent = await readBranchPolicyArchiveRecord(dir, agentId, date);
    if (!agent) return [{ agentId, repoPath: '', branch: '', policy: { dangling: true } }];
    const policy = projectPolicyAgent(agent);
    const repoPath = normalizedPolicyWorkspace(policy.metadata.sourceWorkspace);
    if (!repoPath) return [];
    // An unreadable binding holds the entire known repository. A missing or
    // malformed record cannot identify its repository and holds every lookup.
    const { branchCompletionPolicy: receipt, reviewLoopMergeTarget: target } = policy.metadata;
    const reviewBranches = reviewTargetBranches(target);
    const branches = branchPolicyScope(policy.metadata) ?? [''];
    return [...branches].map(branch => ({
      agentId, repoPath, branch, policy, completedAt: policy.completedAt,
      prUrl: branch === receipt?.branch ? receipt.prUrl : reviewBranches.includes(branch) ? target.url : null,
    }));
  } catch (error) {
    return [{ agentId, repoPath: '', branch: '', policy: { error: error.message, code: error.code } }];
  }
}

export async function readArchivePolicyRows(dir, entries) {
  const rows = [];
  for (let start = 0; start < entries.length; start += BATCH) {
    const batch = await Promise.all(entries.slice(start, start + BATCH).map(([id, date]) => archivePolicyRows(dir, id, date)));
    for (const records of batch) rows.push(...records);
  }
  return rows;
}

export async function insertArchivePolicyRows(client, rows) {
  for (let start = 0; start < rows.length; start += BATCH) {
    const batch = rows.slice(start, start + BATCH);
    await client.query(
      `INSERT INTO cos_branch_completion_policies (agent_id, repo_path, branch, pr_url, policy_json, completed_at)
       SELECT u.agent_id, u.repo_path, u.branch, u.pr_url, u.policy_json::json, u.completed_at
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::timestamptz[])
         AS u(agent_id, repo_path, branch, pr_url, policy_json, completed_at)`,
      [batch.map(row => row.agentId), batch.map(row => row.repoPath), batch.map(row => row.branch),
        batch.map(row => typeof row.prUrl === 'string' ? row.prUrl : null), batch.map(row => toPgJson(row.policy)), batch.map(row => {
          const timestamp = Date.parse(row.completedAt);
          return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
        })],
    );
  }
}

export async function writeArchivePolicyStamp(client, stamp) {
  await client.query(
    `INSERT INTO cos_branch_policy_archive (id, source_stamp) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET source_stamp = EXCLUDED.source_stamp`, [stamp],
  );
}

/** Read a complete, stable source image for initial migration or restore repair. */
export async function readArchivePolicyBackfill(dir, stamp) {
  const index = await readBranchPolicyArchiveIndex(dir);
  const rows = await readArchivePolicyRows(dir, Object.entries(index));
  return await readBranchPolicyArchiveStamp(dir) === stamp ? rows : null;
}

export async function replaceArchivePolicyRows(client, stamp, rows) {
  await client.query('DELETE FROM cos_branch_completion_policies');
  await insertArchivePolicyRows(client, rows);
  await writeArchivePolicyStamp(client, stamp);
}
