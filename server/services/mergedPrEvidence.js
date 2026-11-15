/** Fresh GitHub facts about a merged pull request. Read-only: no fetch, policy
 * write or retirement authority follows from either answer.
 */
import { execGit } from '../lib/execGit.js';
import { getOriginInfo } from '../lib/gitRemote.js';
import { parsePullRequestUrl } from '../lib/gitForge.js';

const oid = value => typeof value === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value);
const validBranchName = value => typeof value === 'string' && value.length > 0 && !value.startsWith('-')
  && !/[\x00-\x20~^:?*\[\\]/.test(value) && !value.includes('..') && !value.includes('@{');

/** Whether the forge reports `head` as a strict descendant of `tip`. A tip the
 * forge does not know (never pushed, or collected) is not contained. */
async function forgeContainsTip(origin, options, execGh, tip, head) {
  const raw = await execGh(['api', '--hostname', origin.host, `repos/${origin.fullName}/compare/${tip}...${head}?per_page=1`], undefined, options)
    .catch(error => {
      if (/\(HTTP (404|422)\)/.test(error.ghStderr || '')) return null;
      throw new Error('merged-pr-forge-unavailable');
    });
  if (raw === null) return false;
  let compare;
  try { compare = JSON.parse(raw); } catch { throw new Error('merged-pr-forge-unavailable'); }
  return compare?.status === 'ahead' && compare.behind_by === 0
    && compare.base_commit?.sha === tip && compare.merge_base_commit?.sha === tip;
}

/** Selects the merged PR for an exact local tip. Selection is not proof: callers
 * re-read the PR with `readMergedPrDelivery` before relying on it.
 * `mergedAt` is the forge's merge time, or null for a historical-branch match.
 */
export async function findMergedPullRequest(repoPath, branch, tip, { forgeAccount = null } = {}) {
  const [{ execGh }, { resolveForgeExecOptions }, { githubRepoSpec }] = await Promise.all([
    import('./github.js'), import('./forgeExecOptions.js'), import('../lib/workTracker.js'),
  ]);
  const origin = await getOriginInfo(repoPath);
  const spec = githubRepoSpec(origin);
  if (!spec) throw new Error('merged-pr-forge-unsupported');
  const options = await resolveForgeExecOptions(repoPath, { forgeAccount });
  if (!oid(tip)) throw new Error('merged-pr-ambiguous');
  // Query the exact commit, not an unbounded reused-branch history. A capped
  // association result cannot establish uniqueness.
  const association = await execGh(['api', '--hostname', origin.host,
    `repos/${origin.fullName}/commits/${tip}/pulls?per_page=100`], undefined, options)
    .catch(error => {
      // An unpublished/rebased local tip may not exist on the forge. That
      // endpoint's missing-commit response does not establish empty history:
      // permit only the bounded historical lookup below, which must succeed.
      const detail = error.ghStderr || '';
      if (/\(HTTP 404\)/.test(detail)
        || (detail.includes(`No commit found for SHA: ${tip}`) && /\(HTTP 422\)/.test(detail))) return null;
      throw new Error('merged-pr-forge-unavailable');
    });
  const rows = association === null ? [] : JSON.parse(association);
  if (!Array.isArray(rows) || rows.length >= 100
    || new Set(rows.map(row => row?.html_url)).size !== rows.length
    || rows.some(row => {
      const parsed = parsePullRequestUrl(row?.html_url);
      return !parsed || parsed.host !== origin.host || `${parsed.owner}/${parsed.repo}` !== origin.fullName
        || typeof row.head?.ref !== 'string' || !oid(row.head?.sha);
    })) throw new Error('merged-pr-ambiguous');
  const matches = rows.filter(row => row.head.sha === tip && row.head.ref === branch
    && row.head.repo?.full_name === origin.fullName && row.base?.repo?.full_name === origin.fullName
    && row.state === 'closed' && typeof row.merged_at === 'string' && Number.isFinite(Date.parse(row.merged_at)));
  if (matches.length > 1) throw new Error('merged-pr-ambiguous');
  if (matches.length === 1) return { url: matches[0].html_url, mergedAt: matches[0].merged_at };
  // An older local tip may still name its branch's one merged PR. Never choose
  // among several candidates.
  const historical = await execGh(['pr', 'list', '--repo', spec, '--head', branch, '--state', 'merged',
    '--limit', '2', '--json', 'url'], undefined, options).then(JSON.parse)
    .catch(() => { throw new Error('merged-pr-forge-unavailable'); });
  const selected = Array.isArray(historical) && historical.length === 1 && parsePullRequestUrl(historical[0]?.url);
  if (!selected || selected.host !== origin.host || `${selected.owner}/${selected.repo}` !== origin.fullName) throw new Error('merged-pr-ambiguous');
  return { url: historical[0].url, mergedAt: null };
}

/**
 * Proves that `prUrl` is this repository's merged, same-repository PR for
 * `branch`, and returns its merged head and actual target. With
 * `exactDeliveredHead`, `scopeProof` says whether that commit is the merged head
 * itself (`exact-delivered-head`) or a forge-confirmed ancestor of it
 * (`ancestor-of-delivered-head`). A live remote branch that moved past the
 * merged head means work was pushed after the merge, so the read refuses.
 */
export async function readMergedPrDelivery(repoPath, branch, prUrl, { forgeAccount = null, exactDeliveredHead = null } = {}) {
  const origin = await getOriginInfo(repoPath);
  const parsed = parsePullRequestUrl(prUrl);
  if (!origin || !parsed || parsed.host !== origin.host || `${parsed.owner}/${parsed.repo}` !== origin.fullName) {
    throw new Error('merged-pr-repository-mismatch');
  }
  const [{ execGh }, { resolveForgeExecOptions }] = await Promise.all([import('./github.js'), import('./forgeExecOptions.js')]);
  const options = await resolveForgeExecOptions(repoPath, { forgeAccount });
  const read = args => execGh(args, undefined, options).then(JSON.parse).catch(() => { throw new Error('merged-pr-forge-unavailable'); });
  const api = path => read(['api', '--hostname', origin.host, path]);
  const remote = await read(['pr', 'view', prUrl, '--json', 'url,state,headRefName,headRefOid,isCrossRepository,mergeCommit,baseRefName']);
  // The merged PR records its delivery target; the default branch is repository
  // metadata, not a requirement that release work also landed on main.
  const targetBranch = remote.baseRefName;
  if (remote.url !== prUrl || remote.state !== 'MERGED' || remote.headRefName !== branch || remote.isCrossRepository !== false
    || !validBranchName(targetBranch) || !oid(remote.headRefOid) || !oid(remote.mergeCommit?.oid)) {
    throw new Error('merged-pr-not-matching');
  }
  const detail = await api(`repos/${origin.fullName}/pulls/${parsed.number}`);
  if (detail.head?.sha !== remote.headRefOid || detail.base?.ref !== targetBranch || detail.merged !== true
    || detail.merge_commit_sha !== remote.mergeCommit.oid) throw new Error('merged-pr-not-matching');
  const exact = oid(exactDeliveredHead) && exactDeliveredHead === remote.headRefOid;
  // A PR head rewritten after this checkout last pushed can still contain every
  // local commit. Those exact commits stay in the merged PR's own history.
  const ancestor = !exact && oid(exactDeliveredHead)
    && await forgeContainsTip(origin, options, execGh, exactDeliveredHead, remote.headRefOid);
  const repository = await api(`repos/${origin.fullName}`);
  const defaultBranch = repository.default_branch;
  const target = await api(`repos/${origin.fullName}/git/ref/heads/${encodeURIComponent(defaultBranch)}`);
  if (!oid(target.object?.sha)) throw new Error('merged-pr-default-unreadable');
  const delivery = targetBranch === defaultBranch ? target
    : await api(`repos/${origin.fullName}/git/ref/heads/${encodeURIComponent(targetBranch)}`);
  if (!oid(delivery.object?.sha)) throw new Error('merged-pr-target-unreadable');
  // ls-remote returns an empty successful result only for actual ref absence.
  const remoteHead = (await execGit(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], repoPath,
    { env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0' } })
    .catch(() => { throw new Error('merged-pr-remote-ref-unreadable'); })).stdout.trim();
  if (remoteHead && remoteHead !== `${remote.headRefOid}\trefs/heads/${branch}`) throw new Error('merged-pr-remote-head-changed');
  return { repository: `${origin.host}/${origin.fullName}`, prUrl, prHead: remote.headRefOid,
    mergeCommit: remote.mergeCommit.oid, defaultBranch, defaultHead: target.object.sha,
    ...(targetBranch !== defaultBranch && { targetBranch, targetHead: delivery.object.sha }), remoteHead: remoteHead || null,
    ...(exact && { scopeProof: 'exact-delivered-head' }),
    ...(ancestor && { scopeProof: 'ancestor-of-delivered-head', deliveredAncestorHead: exactDeliveredHead }) };
}
