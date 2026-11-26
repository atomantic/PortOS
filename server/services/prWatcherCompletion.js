/** Verify the server-stamped dispatch targets against their forge repository.
 * A completed run owes a merge for each target. A no-op can also acknowledge
 * a stale selection whose PRs were closed before the watcher could act.
 */
const MAX_VERIFIED_TARGETS = 50;

export function prWatcherTargetsMetadata(prs, repoFullName, repoHost) {
  const prNumbers = [...new Set((prs || []).map(pr => pr?.number)
    .filter(number => Number.isSafeInteger(number) && number > 0))];
  return prNumbers.length && typeof repoFullName === 'string' && repoFullName
    && typeof repoHost === 'string' && repoHost
    ? { repoFullName, repoHost, prNumbers } : null;
}

export async function verifyPrWatcherTargetsSettled(task, workspacePath, outcomeStatus) {
  if (outcomeStatus !== 'completed' && outcomeStatus !== 'no-action-needed') return null;
  const meta = task?.metadata;
  const targets = meta?.prWatcherTargets;
  if ((meta?.analysisType || meta?.taskAnalysisType) !== 'pr-watcher' || !workspacePath
    || typeof targets?.repoFullName !== 'string' || typeof targets.repoHost !== 'string' || !targets.repoHost
    || !Array.isArray(targets.prNumbers)
    || targets.prNumbers.length === 0 || targets.prNumbers.length > MAX_VERIFIED_TARGETS
    || !targets.prNumbers.every(number => Number.isSafeInteger(number) && number > 0)) return null;
  const { getOriginInfo } = await import('../lib/gitRemote.js');
  const origin = await getOriginInfo(workspacePath);
  const { githubApiHost } = await import('../lib/workTracker.js');
  if (origin?.fullName !== targets.repoFullName || githubApiHost(origin?.host) !== targets.repoHost) return null;
  // Number-only gh lookups can default to another remote in a fork checkout.
  const repoSpec = `${targets.repoHost}/${targets.repoFullName}`;
  const { probeChangeRequestState } = await import('./prProbe.js');
  const allowedStates = outcomeStatus === 'completed' ? ['MERGED'] : ['MERGED', 'CLOSED'];
  const states = {};
  for (const number of targets.prNumbers) {
    const probe = await probeChangeRequestState(workspacePath, { number, repoSpec });
    if (probe.readable !== true || !allowedStates.includes(probe.prState)) return null;
    states[number] = probe.prState;
  }
  return { status: 'verified', repoFullName: targets.repoFullName, repoHost: targets.repoHost, states };
}
