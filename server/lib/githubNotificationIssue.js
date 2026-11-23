/** Bind a GitHub inbox issue action to its verified issue, repository, and account. */
import { repoApiPath } from './githubNotificationParse.js';

const sameRepoPart = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

export const matchesNotificationIssueRepository = (target, expected) => target?.forge === 'github'
  && sameRepoPart(target.apiHost, expected?.host)
  && sameRepoPart(target.fullName, expected?.repo);

const LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

/** An inbox claim can only target the open Issue represented by the stored thread. */
export function notificationIssueClaimTarget(account, row) {
  if (!account?.enabled || account.mode === 'disabled' || (account.trust === 'private' && !account.allowAgents)
    || row?.subject_type !== 'Issue' || row.reason === 'security_alert' || row.state !== 'open' || row.suspect || row.decision === 'handed-off'
    || row.evidence?.subjectState !== 'open' || !row.evidence?.repoManaged
    || !['yours', 'trusted'].includes(row.trust) || row.evidence.actorType !== 'User'
    || !LOGIN_RE.test(row.evidence.actor || '')) return null;
  const path = repoApiPath(row.subject_api_url, account.host);
  const match = /^repos\/([^/]+\/[^/]+)\/issues\/([1-9]\d{0,8})$/.exec(path || '');
  if (!match || match[1].toLowerCase() !== row.repo_full_name?.toLowerCase()) return null;
  return { host: account.host, repo: match[1], number: Number(match[2]), author: row.evidence.actor };
}
