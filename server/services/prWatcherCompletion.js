// The watcher defers capped pages, so a valid dispatch has strictly fewer targets.
export const PR_WATCHER_LIST_LIMIT = 200;
const PR_STATE_BATCH_SIZE = 50;
const PR_STATE_BATCH_TIMEOUT_MS = 10_000;

export function prWatcherTargetsMetadata(prs, repoFullName, repoHost) {
  const prNumbers = [...new Set((prs || []).map(pr => pr?.number)
    .filter(number => Number.isSafeInteger(number) && number > 0))];
  return prNumbers.length && typeof repoFullName === 'string' && repoFullName
    && typeof repoHost === 'string' && repoHost
    ? { repoFullName, repoHost, prNumbers } : null;
}

/** Verify the server-stamped dispatch targets against their forge repository.
 * A completed run owes a merge for each target. A stale selection can also
 * acknowledge closed PRs.
 */
export async function verifyPrWatcherTargetsSettled(task, workspacePath, outcomeStatus) {
  if (outcomeStatus !== 'completed' && outcomeStatus !== 'no-action-needed') return null;
  const meta = task?.metadata;
  const targets = meta?.prWatcherTargets;
  if ((meta?.analysisType || meta?.taskAnalysisType) !== 'pr-watcher' || !workspacePath
    || typeof targets?.repoFullName !== 'string' || typeof targets.repoHost !== 'string' || !targets.repoHost
    || !Array.isArray(targets.prNumbers)
    || targets.prNumbers.length === 0 || targets.prNumbers.length >= PR_WATCHER_LIST_LIMIT
    || !targets.prNumbers.every(number => Number.isSafeInteger(number) && number > 0)) return null;
  const { getOriginInfo } = await import('../lib/gitRemote.js');
  const origin = await getOriginInfo(workspacePath);
  const { githubApiHost, githubRepoSpec } = await import('../lib/workTracker.js');
  const repoSpec = githubRepoSpec(origin);
  if (!repoSpec || origin.fullName !== targets.repoFullName || githubApiHost(origin.host) !== targets.repoHost) return null;
  const [host, owner, repo] = repoSpec.split('/');
  const { resolveForgeForRepo } = await import('./forgeAuth.js');
  const forge = await resolveForgeForRepo(workspacePath).catch(() => null);
  if (forge?.cli !== 'gh' || forge.host !== host) return null;
  const { execGh } = await import('./github.js');
  const allowedStates = outcomeStatus === 'completed' ? ['MERGED'] : ['MERGED', 'CLOSED'];
  const states = {};
  for (let offset = 0; offset < targets.prNumbers.length; offset += PR_STATE_BATCH_SIZE) {
    const numbers = targets.prNumbers.slice(offset, offset + PR_STATE_BATCH_SIZE);
    // Aliases bind each response to an exact number under the requested repository.
    const fields = numbers.map(number => `p${number}:pullRequest(number:${number}){number state}`).join(' ');
    const query = `query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){nameWithOwner ${fields}}}`;
    const result = await execGh(['api', 'graphql', '--hostname', host, '-f', `owner=${owner}`, '-f', `repo=${repo}`, '-f', `query=${query}`],
      PR_STATE_BATCH_TIMEOUT_MS, { cwd: workspacePath, env: forge.env, backoffKey: repoSpec })
      .then(JSON.parse).catch(() => null);
    const repository = result?.data?.repository;
    if (result?.errors || typeof repository?.nameWithOwner !== 'string'
      || repository.nameWithOwner.toLowerCase() !== targets.repoFullName.toLowerCase()) return null;
    for (const number of numbers) {
      const pr = repository[`p${number}`];
      if (pr?.number !== number || !allowedStates.includes(pr.state)) return null;
      states[number] = pr.state;
    }
  }
  return { status: 'verified', repoFullName: targets.repoFullName, repoHost: targets.repoHost, states };
}
