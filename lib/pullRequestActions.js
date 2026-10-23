// Shared by the app PR list, GitHub inbox and notification automation rules.
export const PULL_REQUEST_ACTION_LABELS = Object.freeze({
  'do-review': 'Do:Review',
  'untrusted-review': 'Untrusted:Review',
  merge: 'Merge',
});

export const PULL_REQUEST_RULE_KINDS = Object.freeze(['dependabot-pr', 'pull-request', 'own-pr', 'review-request']);
export const PULL_REQUEST_ACTIONS = Object.freeze(Object.keys(PULL_REQUEST_ACTION_LABELS));
export const isPullRequestAgentAction = action => action === 'do-review' || action === 'untrusted-review';
