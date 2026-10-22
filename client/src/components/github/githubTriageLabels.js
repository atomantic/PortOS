// Display labels for the GitHub inbox's triage (server/lib/githubNotificationTriage.js).
// `needs-you` has no chip: it is the inbox's default state.
export const DECISION_VIEW = {
  suspect: { tone: 'error', label: 'Suspect' },
  'surface-high': { tone: 'error', label: 'High priority' },
  surface: { tone: 'accent', label: 'Worth a look' },
  'suggest-review': { tone: 'accent', label: 'Suggest Do:Review' },
  'suggest-untrusted-review': { tone: 'warning', label: 'Suggest Untrusted:Review' },
  'suggest-mark-read': { tone: 'muted', label: 'Closed or merged' },
  'handled-by-pr-workflow': { tone: 'success', label: 'PR workflow has it' },
  duplicate: { tone: 'muted', label: 'Duplicate' },
  'suggest-done': { tone: 'muted', label: 'Suggest done' },
  'suggest-mute': { tone: 'muted', label: 'Suggest mute' },
  'handed-off': { tone: 'success', label: 'Handed off' },
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
  'own-pr-in-managed-repo': 'Activity on your own PR in a PortOS managed app, which its PR workflow handles',
  'ci-other': 'CI result outside the default branch of a repo PortOS does not manage',
  'review-trusted-author': 'Review requested by you or a collaborator with write access',
  'review-outside-author': 'Review requested on your repo by someone without write access',
  'review-elsewhere': 'Review requested on a repo you do not own',
  'mention-elsewhere': 'Mentioned in a repo you do not own',
  default: 'No rule applied, so it waits for you',
  learned: 'You handled threads like this the same way before',
  'ai-surface': 'Assist read it and thinks you should see it',
  'ai-done': 'Assist read it and found nothing for you to do',
  'ai-suggest-mute': 'Assist read it and thinks the thread is noise',
};

// Why Assist did not sort a thread, by the code the screening path returns.
export const AI_SKIP_LABELS = {
  'github-notification-provider-not-allowed': 'No AI provider this account allows is available',
  'untrusted-content-blocked': 'The abuse guard flagged its text',
  'untrusted-content-too-large': 'Its text is over the screening limit',
};

export const ACTION_LABELS = {
  done: 'Marked done',
  read: 'Marked read',
  mute: 'Muted',
  'handed-off': 'Handed off',
};

// The lanes Autopilot hands threads to, and the app tab each one reports on.
export const LANE_VIEW = {
  'pr-reviewer': { label: 'Untrusted:Review', tab: 'pull-requests' },
  'issue-watcher': { label: 'the issue watcher', tab: 'tasks' },
  'dependency-updates': { label: 'dependency updates', tab: 'tasks' },
  // A one-off CoS task in a scratch clone, for a repo no app manages.
  'security-fix': { label: 'a security fix agent', tab: null },
};

// Why Resolve with agent is unavailable for a thread.
export const AGENT_REFUSED_LABELS = {
  'private-account': 'Private accounts never hand off to an agent',
  'no-managed-app': 'Add this repo as a PortOS app to resolve it with an agent',
};

// Why Autopilot left a thread with you instead of handing it off.
export const HANDOFF_SKIP_LABELS = {
  'private-account': 'Private accounts never hand off: the lanes use their own AI providers',
  'no-managed-app': 'No PortOS app manages this repo',
  'lane-unavailable': 'The lane would not take it',
};

export const LEARNED_DECISION_LABELS = {
  surface: 'Show me',
  'suggest-done': 'Mark done',
  'suggest-mute': 'Mute',
};

export const SIGNAL_LABELS = {
  'new-account': 'Actor account is less than 30 days old',
  'first-time-actor': 'Actor has no history in this repo',
  'mass-mention': 'The latest comment mentions many people',
  'unrelated-repo': 'First notification from a repo you have no tie to',
};
