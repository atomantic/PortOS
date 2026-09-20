/** Structured work ownership shared by scheduler, manual actions and watchdog. */
export const DEVELOPMENT_ACTIVE_STATUSES = new Set(['pending', 'queued', 'running', 'in_progress', 'finalizing', 'blocked', 'paused']);

export function developmentWorkIdentity(task) {
  const m = { ...task, ...task?.metadata };
  const app = m.app || m.appId || m.taskApp;
  const url = m.reviewLoopPRUrl || m.prUrl;
  if (typeof url === 'string') {
    const match = url.match(/^https?:\/\/([^/]+)\/(.+?)\/(?:pull|merge_requests|\-\/merge_requests)\/(\d+)(?:[/?#]|$)/);
    if (match) return { app, key: `${match[1]}/${match[2]}/pr/${match[3]}`.toLowerCase(), kind: 'pr' };
  }
  if (m.claimFlow === true || m.claimFlow === 'true' || ['claim-work', 'claim-issue', 'claim-issue-gitlab'].includes(m.taskAnalysisType)) {
    return { app, kind: 'issue', key: m.claimTarget ? `issue/${m.claimTarget}` : '*' };
  }
  if ((m.analysisType || m.taskAnalysisType) === 'pr-watcher') return { app, kind: 'pr', key: '*' };
  return null;
}

export function sameDevelopmentWork(left, right) {
  const a = developmentWorkIdentity(left);
  const b = developmentWorkIdentity(right);
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'pr' && a.key !== '*' && b.key !== '*') return a.key === b.key;
  return !!a.app && a.app === b.app && (a.key === '*' || b.key === '*' || a.key === b.key);
}
