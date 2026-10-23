import { repoApiPath } from './githubNotificationParse.js';

/** A notification can name only a PR in its own repository and account host. */
export function notificationPullRequestTarget(account, row) {
  if (!account || row?.subject_type !== 'PullRequest') return null;
  const path = repoApiPath(row.subject_api_url, account.host);
  const match = /^repos\/([^/]+\/[^/]+)\/pulls\/(\d{1,9})$/.exec(path || '');
  if (!match || match[1].toLowerCase() !== row.repo_full_name?.toLowerCase()) return null;
  const number = Number(match[2]);
  return number > 0 ? { number, repo: match[1], repoSpec: `${account.host}/${match[1]}` } : null;
}

/** Cheap list projection; every mutation re-reads the forge and checks again. */
export function notificationPullRequestView(account, row) {
  const target = notificationPullRequestTarget(account, row);
  if (!target || row.state !== 'open' || row.suspect || ['closed', 'merged'].includes(row.evidence?.subjectState)) return null;
  const trusted = ['yours', 'trusted'].includes(row.trust);
  const agentsAllowed = account.trust !== 'private' || account.allowAgents === true;
  return {
    number: target.number,
    mergeEligible: trusted,
    doReviewEligible: agentsAllowed && trusted,
    // Native bots are trusted inbox actors, but the app's PR reviewer still
    // screens their dependency patches through its external-contributor lane.
    reviewEligible: agentsAllowed && row.evidence?.repoManaged === true && (!trusted || row.evidence?.actorType === 'Bot'),
  };
}
