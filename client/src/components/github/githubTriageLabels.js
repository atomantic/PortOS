// Display labels for the GitHub inbox's triage (server/lib/githubNotificationTriage.js).
// `needs-you` has no chip: it is the inbox's default state.
export const DECISION_VIEW = {
  suspect: { tone: 'error', label: 'Suspect' },
  'surface-high': { tone: 'error', label: 'High priority' },
  surface: { tone: 'accent', label: 'Worth a look' },
  'suggest-review': { tone: 'accent', label: 'Suggest Do:Review' },
  'suggest-untrusted-review': { tone: 'warning', label: 'Suggest Untrusted:Review' },
  'suggest-mark-read': { tone: 'muted', label: 'Suggest mark read' },
  'handled-by-pr-workflow': { tone: 'success', label: 'PR workflow has it' },
  duplicate: { tone: 'muted', label: 'Duplicate' },
};

export const TRUST_VIEW = {
  yours: { tone: 'success', label: 'You' },
  trusted: { tone: 'success', label: 'Trusted' },
  outside: { tone: 'warning', label: 'Outside' },
};

// Why a thread got its decision, one line per rule.
export const RULE_LABELS = {
  'spam-signal': 'A spam check matched, so nothing will act on it automatically',
  'security-alert': 'Security alerts always surface first',
  'invitation-never-accepted': 'Invitations surface and are never accepted automatically',
  'finished-thread': 'The issue or pull request is already closed or merged',
  'ci-default-branch': 'CI failed on the default branch',
  'ci-watched-by-pr-workflow': 'CI on a branch of a PortOS managed app, which its PR workflow handles',
  'ci-other': 'CI result outside the default branch of a repo PortOS does not manage',
  'review-trusted-author': 'Review requested by you or a collaborator with write access',
  'review-outside-author': 'Review requested on your repo by someone without write access',
  'review-elsewhere': 'Review requested on a repo you do not own',
  'mention-elsewhere': 'Mentioned in a repo you do not own',
  default: 'No rule applied, so it waits for you',
};

export const SIGNAL_LABELS = {
  'new-account': 'Actor account is less than 30 days old',
  'first-time-actor': 'Actor has no history in this repo',
  'mass-mention': 'The latest comment mentions many people',
  'unrelated-repo': 'First notification from a repo you have no tie to',
};
