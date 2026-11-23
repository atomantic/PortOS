/**
 * Zod schemas and constants for the GitHub routes: managed repos and secrets, notification accounts, agent rules, the inbox, deployment review and audit.
 *
 * Its own module so GitHub schema edits do not conflict with other domains. Callers import
 * this module directly.
 */

import { z } from 'zod';
import { EFFORT_LEVELS } from './provider/providerModels.js';

export const githubRepoUpdateSchema = z.object({
  flags: z.record(z.boolean()).optional(),
  managedSecrets: z.array(z.string().min(1)).optional()
});

export const githubSecretSchema = z.object({
  value: z.string().min(1)
});

// GitHub notifications manager accounts (#12869). A bare hostname (optional
// :port) whose first character also rules out a value `gh` would parse as a flag.
export const GITHUB_ACCOUNT_HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/;
// github.com logins are [A-Za-z0-9-]; Enterprise Managed Users add `_shortcode`.
export const GITHUB_ACCOUNT_LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
export const GITHUB_ACCOUNT_TRUST_LEVELS = Object.freeze(['public', 'private']);
export const GITHUB_ACCOUNT_MODES = Object.freeze(['disabled', 'observe', 'assist', 'autopilot']);

// Per-repo automation rules for the GitHub inbox (#13192): what Assist and
// Autopilot do with a kind of notification, in one repo (`owner/repo`), an
// account/org (`owner/*`) or every repo (`*`), and on which provider/model/effort
// when it starts an agent. Repo > owner > all. Mirrors AGENT_RULE_KINDS and
// AGENT_RULE_ACTIONS in lib/githubNotificationTriage.js.
export const GITHUB_AGENT_RULE_KINDS = Object.freeze(['review-request', 'security-alert', 'issue-activity', 'ci-activity', 'own-pr', 'dependabot-pr', 'pull-request', 'mention', 'release', 'other',
  // By GitHub's notification reason; done / mute / leave only (REASON_RULE_KINDS).
  'reason-comment', 'reason-subscribed', 'reason-state-change', 'reason-assign', 'reason-author']);
export const GITHUB_AGENT_RULE_ACTIONS = Object.freeze(['agent', 'done', 'mute', 'leave', 'do-review', 'untrusted-review', 'merge']);
export const GITHUB_AGENT_RULE_REPO_RE = /^(?:\*|[A-Za-z0-9_.-]{1,100}\/(?:\*|[A-Za-z0-9_.-]{1,100}))$/;
const emptyToNullString = (value) => (value === '' ? null : value);
// A legacy `agent: true/false` (rules saved before #13192) is accepted and
// stored as `action: 'agent' / 'leave'`; `action` wins when both are sent.
export const githubAgentRuleSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
  kind: z.enum(GITHUB_AGENT_RULE_KINDS),
  repo: z.string().trim().regex(GITHUB_AGENT_RULE_REPO_RE, 'Use owner/repo, owner/* for an account or organization, or * for every repo'),
  agent: z.boolean().optional(),
  action: z.enum(GITHUB_AGENT_RULE_ACTIONS).optional(),
  mergeMethod: z.enum(['merge', 'squash', 'rebase']).optional(),
  deleteBranch: z.boolean().optional(),
  provider: z.preprocess(emptyToNullString, z.string().trim().min(1).max(128).nullable()).optional(),
  model: z.preprocess(emptyToNullString, z.string().trim().min(1).max(200).nullable()).optional(),
  effort: z.preprocess(emptyToNullString, z.enum(EFFORT_LEVELS).nullable()).optional(),
}).strict().superRefine((rule, ctx) => {
  const action = rule.action ?? (typeof rule.agent === 'boolean' ? (rule.agent ? 'agent' : 'leave') : null);
  if (!action) ctx.addIssue({ code: 'custom', path: ['action'], message: 'Choose what to do with these notifications' });
  else if (rule.kind === 'security-alert' && action !== 'agent' && action !== 'leave') {
    ctx.addIssue({ code: 'custom', path: ['action'], message: 'Security alerts are never marked done or muted by a rule' });
  } else if (rule.kind.startsWith('reason-') && !['done', 'mute', 'leave'].includes(action)) {
    ctx.addIssue({ code: 'custom', path: ['action'], message: 'A rule by notification reason can mark done, mute or leave' });
  }
  if (['do-review', 'untrusted-review', 'merge'].includes(action) && !['dependabot-pr', 'pull-request', 'own-pr', 'review-request'].includes(rule.kind)) {
    ctx.addIssue({ code: 'custom', path: ['action'], message: 'PR actions require a pull-request notification rule' });
  }
  if (action === 'merge' && rule.kind !== 'dependabot-pr') {
    ctx.addIssue({ code: 'custom', path: ['action'], message: 'Automatic merge is available for verified Dependabot pull requests' });
  }
}).transform(({ agent, ...rule }) => ({ ...rule, action: rule.action ?? (agent ? 'agent' : 'leave') }));
export const githubAgentRulesSchema = z.array(githubAgentRuleSchema).max(200).superRefine((rules, ctx) => {
  const seen = new Set();
  rules.forEach((rule, index) => {
    const key = `${rule.kind}#${rule.repo.toLowerCase()}`;
    if (seen.has(key)) ctx.addIssue({ code: 'custom', path: [index, 'repo'], message: `There is already a ${rule.kind} rule for ${rule.repo}` });
    seen.add(key);
  });
});

// The provider/model/effort an agent run starts from (#13191): the account's
// defaults, or the operator's choice for one Resolve with agent run. null or
// '' = Auto (CoS chooses).
const githubAgentPinFields = {
  provider: z.preprocess(emptyToNullString, z.string().trim().min(1).max(128).nullable()).optional(),
  model: z.preprocess(emptyToNullString, z.string().trim().min(1).max(200).nullable()).optional(),
  effort: z.preprocess(emptyToNullString, z.enum(EFFORT_LEVELS).nullable()).optional(),
};
export const githubAgentDefaultsSchema = z.object(githubAgentPinFields).strict();
export const githubNotificationAgentRunSchema = z.object(githubAgentPinFields).strict();
export const githubNotificationPullRequestActionSchema = z.object({
  action: z.enum(['merge', 'do-review', 'untrusted-review']),
  method: z.enum(['merge', 'squash', 'rebase']).optional(),
  deleteBranch: z.boolean().optional(),
  ...githubAgentPinFields,
}).strict();

export const githubAccountCreateSchema = z.object({
  label: z.string().trim().max(80).optional(),
  host: z.string().trim().toLowerCase()
    .transform((value) => value.replace(/^https?:\/\//, '').replace(/\/+$/, ''))
    .pipe(z.string().min(1).max(253).regex(GITHUB_ACCOUNT_HOST_RE, 'Use a bare hostname such as github.example.com')),
  login: z.string().trim().regex(GITHUB_ACCOUNT_LOGIN_RE, 'Not a valid GitHub login').nullable().optional(),
  trust: z.enum(GITHUB_ACCOUNT_TRUST_LEVELS).optional(),
  // null = the trust level's default (Private: local providers only).
  allowedProviders: z.array(z.string().trim().min(1).max(128)).max(50).nullable().optional(),
  mode: z.enum(GITHUB_ACCOUNT_MODES).optional(),
  // Monthly subscription audit delivered as a PortOS notification (#12874).
  auditReport: z.boolean().optional(),
  // Private (Enterprise) accounts refuse every agent hand-off unless the operator
  // opts in: the lanes run on PortOS's own providers, which the allow-list cannot bind.
  allowAgents: z.boolean().optional(),
  // Enterprise hosts only: every human on the instance counts as trusted (#13203).
  trustInstanceUsers: z.boolean().optional(),
  agentRules: githubAgentRulesSchema.optional(),
  agentDefaults: githubAgentDefaultsSchema.nullable().optional(),
  enabled: z.boolean().optional(),
}).strict();

export const githubAccountUpdateSchema = githubAccountCreateSchema.partial().strict();

// GitHub notifications inbox (#12870).
export const githubNotificationsQuerySchema = z.object({
  accountId: z.string().trim().min(1).max(100).optional(),
  view: z.enum(['needs-you', 'suspect', 'handled', 'all']).optional(),
}).strict();

export const githubNotificationMuteSchema = z.object({
  accountId: z.string().trim().min(1).max(100),
  repoFullName: z.string().trim().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/),
  reason: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).refine((reason) => reason !== 'security_alert', 'Security alerts cannot be muted'),
  muted: z.boolean(),
}).strict();

export const githubNotificationsSyncSchema = z.object({
  accountId: z.string().trim().min(1).max(100).optional(),
}).strict();

export const githubNotificationsClearSchema = z.object({
  accountId: z.string().trim().min(1).max(100).optional(),
}).strict();

// Deployment approval from the inbox (#13198): operator only.
export const githubDeploymentReviewSchema = z.object({
  state: z.enum(['approved', 'rejected']),
  environmentIds: z.array(z.number().int().positive()).min(1).max(20),
  comment: z.string().trim().max(1000).optional(),
}).strict();

export const githubNotificationActionSchema = z.object({
  action: z.enum(['read', 'done', 'reopen', 'mute', 'unsubscribe', 'resubscribe']),
}).strict();

export const GITHUB_NOTIFICATION_THREAD_ID_RE = /^\d{1,20}$/;

// Automations tab (#12871): the one cadence it offers, or back to Run now only.
export const GITHUB_NOTIFICATION_CADENCES = Object.freeze({ 'weekdays-15m': '*/15 * * * 1-5', off: null });
export const githubAuditApplySchema = z.object({
  suggestionId: z.string().trim().min(1).max(300),
}).strict();

export const githubNotificationCadenceSchema = z.object({
  cadence: z.enum(Object.keys(GITHUB_NOTIFICATION_CADENCES)),
}).strict();
