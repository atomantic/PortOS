/** Active audit domains and the independently configured legacy task IDs whose findings they cover. */

/** Pragmatic healthy floor of the 85-95 target band; chasing 100/100 is discouraged. */
export const QUALITY_HEALTHY_THRESHOLD = 85;

/** Scoring anchors shared by the audit prompt and Quality tab. */
export const QUALITY_SCORE_BANDS = Object.freeze([
  ['96–100', 'Exceptional quality demonstrated by inspection (optional)'],
  ['90–95', 'High quality, with no verified material defects'],
  ['85–89', 'Healthy, with minor localized polish only'],
  ['75–84', 'Mostly healthy, with localized moderate defects in secondary paths'],
  ['60–74', 'Material defects contained within a feature area'],
  ['40–59', 'Systemic or recurring defects across core workflows'],
  ['0–39', 'Severe core workflow breakage, data loss, or verified reachable exploits'],
]);

/** A run's weight halves every this many days, so remediated pre-fix runs stop pinning the score. Feature-area usage decays on the same clock. */
export const QUALITY_RECENCY_HALF_LIFE_DAYS = 7;

// A folded task is still its own executable schedule and measurement series.
// Mapping it into a domain for selection or scoring must never merge its cron,
// customized prompt, app override, pending request, or same-day snapshot row.
export const CONSOLIDATED_AUDIT_DOMAINS = Object.freeze({
  'architecture-maintainability': {
    label: 'Architecture and maintainability', members: ['code-quality', 'better-structural-drift', 'module-hygiene', 'typing'],
    mission: 'Find structural defects in module ownership, contracts, types and duplicated sources of truth that make real changes unreliable. End the completion summary with a ranked Recommended next audits list when another domain owns actionable follow-up. Leave local simplification of otherwise sound code to code-simplification.',
    issueLabel: 'code-quality',
  },
  'code-simplification': {
    label: 'Code simplification', members: ['simplify', 'over-engineering', 'better-complexity', 'better-cognitive-load'],
    mission: 'Find dead paths, excessive branching, hard-to-follow code and abstractions whose cost exceeds the problem they solve. Preserve observable behavior.',
    issueLabel: 'code-quality',
  },
  'ui-runtime-bugs': {
    label: 'Application and UI runtime bugs', members: ['app-bugs', 'ui-bugs', 'console-errors', 'ui-lifecycle'],
    mission: 'Reproduce incorrect behavior in ordinary application workflows. Include server and client behavior, browser errors and UI lifecycle faults where the repository provides those surfaces.',
    issueLabel: 'bug',
  },
  'reliability-error-handling': {
    label: 'Reliability and error handling', members: ['error-handling', 'better-runtime-safety', 'reliability', 'workflow-recovery', 'observability'],
    mission: 'Exercise failures and recovery. Trace error propagation, async failures, degraded dependencies, retries and restart behavior. Verify the operator can diagnose and recover the failed workflow.',
    issueLabel: 'resilience',
  },
  'data-integrity-safety': {
    label: 'Data integrity and safety', members: ['data-safety', 'data-integrity', 'upgrade-rehearsal'],
    mission: 'Trace persisted data through writes, migrations, backup and restore. Check for loss, incorrect joins, dropped records or destructive upgrades. Use synthetic scratch installs for upgrade rehearsals and never run destructive tests against live data.',
    issueLabel: 'data-safety',
  },
  'test-quality-coverage': {
    label: 'Test quality and coverage', members: ['test-coverage', 'better-test-quality'],
    mission: 'Identify important behavior without regression coverage and tests that pass despite a broken contract. Prefer a public-boundary test that fails on the defect.',
    issueLabel: 'tests',
  },
  'performance-efficiency': {
    label: 'Performance and resource efficiency', members: ['performance', 'cost-efficiency'],
    mission: 'Measure real latency, redundant work, resource use and provider costs. Verify a candidate improvement with the same workload.',
    issueLabel: 'performance',
  },
  'infrastructure-environment': {
    label: 'Infrastructure and development environment', members: ['infrastructure', 'better-dev-environment'],
    mission: 'Inspect deployment, CI and developer setup for reproducible build, configuration and host-resource problems. Check deployment-only surfaces only when present.',
    issueLabel: 'infrastructure',
  },
  'design-usability': {
    label: 'Design and usability', members: ['design', 'ux', 'mobile-responsive'],
    mission: 'Inspect real rendered workflows at supported viewport sizes for navigation, layout, interaction and visual hierarchy problems. Verify composition with a bounded sample of up to six screenshots across representative views. Preserve authored theme identity and keep subjective aesthetic suggestions unscored. Accessibility compliance has its own audit.',
    issueLabel: 'ux',
  },
  'documentation-content': {
    label: 'Documentation and product copy', members: ['documentation', 'copy'],
    mission: 'Compare user-facing documentation, instructions and product copy against actual behavior. Prioritize misleading guidance and text that prevents users from completing a task.',
    issueLabel: 'documentation',
  },
});

// Single-purpose domains keep their established task identity and reporting contract.
export const ACTIVE_AUDIT_DOMAIN_IDS = Object.freeze([
  'security', 'privacy', 'accessibility', 'api-contract', 'better-dependency-freedom', 'feature-completeness',
  ...Object.keys(CONSOLIDATED_AUDIT_DOMAINS),
]);

export const AUDIT_DOMAIN_ALIASES = Object.freeze(Object.fromEntries(
  Object.entries(CONSOLIDATED_AUDIT_DOMAINS).flatMap(([domain, { members }]) => members.map(id => [id, domain]))
));

export const LEGACY_AUDIT_TASK_TYPE_ALIASES = Object.freeze({ 'react-lifecycle': 'ui-lifecycle' });
export const normalizeAuditTaskType = taskType => Object.hasOwn(LEGACY_AUDIT_TASK_TYPE_ALIASES, taskType)
  ? LEGACY_AUDIT_TASK_TYPE_ALIASES[taskType] : taskType;

export function auditDomainFor(taskType) {
  const profile = normalizeAuditTaskType(taskType);
  return Object.hasOwn(AUDIT_DOMAIN_ALIASES, profile) ? AUDIT_DOMAIN_ALIASES[profile] : profile;
}

// Audits whose findings must never be narrowed by feature priority: a dormant feature still ships its security,
// privacy and data-loss defects. Decided by domain, not task id, so the folded task ids stay exempt.
export const PRIORITY_EXEMPT_AUDIT_DOMAINS = Object.freeze(['security', 'privacy', 'data-integrity-safety']);

export const isPriorityExemptAuditType = taskType => PRIORITY_EXEMPT_AUDIT_DOMAINS.includes(auditDomainFor(taskType));
