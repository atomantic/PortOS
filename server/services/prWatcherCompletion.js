/** A pr-watcher run whose every dispatched PR is already merged or closed had
 * nothing to act on: the selection went stale between the poll and the spawn.
 * Only the server-stamped target list (`metadata.prWatcherTargets`, written by
 * resolvePrWatcherBlock) is trusted, and every PR must be readable on the forge
 * as non-OPEN. This is not a general pr-watcher no-commit exemption: an open
 * target, an unreadable PR, or another repository keeps the commit criterion.
 */
const MAX_VERIFIED_TARGETS = 50;

export function prWatcherTargetsMetadata(prs, repoFullName) {
  const prNumbers = [...new Set((prs || []).map(pr => pr?.number)
    .filter(number => Number.isSafeInteger(number) && number > 0))];
  return prNumbers.length && typeof repoFullName === 'string' && repoFullName
    ? { repoFullName, prNumbers } : null;
}

export async function verifyPrWatcherTargetsSettled(task, workspacePath) {
  const meta = task?.metadata;
  const targets = meta?.prWatcherTargets;
  if ((meta?.analysisType || meta?.taskAnalysisType) !== 'pr-watcher' || !workspacePath
    || typeof targets?.repoFullName !== 'string' || !Array.isArray(targets.prNumbers)
    || targets.prNumbers.length === 0 || targets.prNumbers.length > MAX_VERIFIED_TARGETS
    || !targets.prNumbers.every(number => Number.isSafeInteger(number) && number > 0)) return null;
  const { getOriginInfo } = await import('../lib/gitRemote.js');
  const origin = await getOriginInfo(workspacePath);
  if (origin?.fullName !== targets.repoFullName) return null;
  const { probeChangeRequestState } = await import('./prProbe.js');
  const states = {};
  for (const number of targets.prNumbers) {
    const probe = await probeChangeRequestState(workspacePath, { number });
    if (probe.readable !== true || !['MERGED', 'CLOSED'].includes(probe.prState)) return null;
    states[number] = probe.prState;
  }
  return { status: 'verified', repoFullName: targets.repoFullName, states };
}
