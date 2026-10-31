import { isTruthyMeta } from './metadataFlags.js';
import { renderOrPrependSection } from './promptSectionRenderer.js';
/**
 * Shared catalog of scheduled AUDIT task types — the ones that can either
 * implement a fix or just file tracker issues, matching the quota-burn
 * single-focus audit presets.
 *
 * Pure module: strings + lookups, no I/O. Quota-burn presets stay templates
 * that get COPIED into a job; this catalog is the scheduled-task counterpart
 * (toggleable at dispatch via `taskMetadata.fileIssues`).
 */

/**
 * Inventory stem of a slug prefix (`cognitive-load-` → `cognitive-load`).
 * The same token is the extra forge label so a backlog can be filtered by
 * metric without parsing titles.
 */
export function metricLabelFromSlugPrefix(slugPrefix) {
  return String(slugPrefix || '').replace(/-+$/, '');
}

const filing = ({ slugPrefix, label, issueLabel, labelDescription, noun }) => {
  const metricLabel = metricLabelFromSlugPrefix(slugPrefix);
  // Apply the slug-stem as a second label whenever it is not already the
  // category (`code-quality` + `cognitive-load`, `bug` + `runtime-safety`).
  // When they coincide (`ux`, `security`) the category flag is enough.
  const extraLabels = metricLabel && metricLabel !== issueLabel
    ? Object.freeze([metricLabel])
    : Object.freeze([]);
  return Object.freeze({
    slugPrefix,
    label,
    issueLabel,
    metricLabel,
    extraLabels,
    labelDescription,
    planItemBody: `From the \`${label}\` audit of <slice> (<today's date>). Problem: <what is wrong, 1–2 sentences>. Impact: <runtime, data, CI/release, or recurring maintenance consequence>. Fix: <files + functions in {appName}>. Scope: <small/medium/large>.`,
    bodyRequirements: `the slice audited and the date, what is wrong with file:line references, the concrete impact (runtime, data, CI/release, or recurring maintenance), a proposed fix naming the files in {appName}, and a \`Scope:\` of small/medium/large`,
    planCommitMessage: `docs(${issueLabel}): propose <N> ${noun}`,
  });
};

/**
 * The one redaction rule every audit dispatch carries. Both mode banners own
 * it; a mission body must not restate it (auditCatalog.test.js, #12080) — the
 * same goes for "read AGENTS.md first", which the banners also own.
 */
export const AUDIT_REDACTION_RULE = 'Never paste a secret, credential, token, hostname, IP address, account id, absolute path containing a username, or any personal record into a title or body — describe its shape and location instead.';

/**
 * The half of every audit dispatch that is about HOW to run, not WHAT to
 * look for. Injected at generation time so a customized stored prompt still
 * honors the chosen mode — this banner overrides any later "fix and commit"
 * or "file issues, change nothing" instruction in the mission body.
 */
export const FILE_ISSUES_MODE_CONTRACT = `## Mode: file issues, change nothing

This banner OVERRIDES any later instruction to edit source, commit, open a PR, create a branch, or \`git checkout\`/\`switch\`. You are standing in the user's live checkout of this repository — an edit or a branch change is felt immediately by whoever is working in it.

Your deliverable is tracker items, not code. The run must end with the same \`git status\` and the same branch it started on.

## Where to record findings

{trackerInstructions}

## How to run this audit

1. **Scan broadly, then bound the investigation.** Follow the repository-wide discovery and ranking contract below BEFORE choosing a slice. Deep-review the strongest candidates in one coherent area; do not attempt to deeply read the whole repository.
2. **Complete a substantive review before filing.** Spend most of the available run budget investigating and validating candidates, reserving time for de-duplication, filing, and the final report. Within the bounded slice, inventory at least three distinct relevant paths or components (or all of them if fewer exist), then inspect their callers, consumers, tests, and relevant history. Finding or filing the first issue is NOT a stopping condition: continue through the remaining inventory, including when the first candidate is a duplicate or rejected. Stop when the inventory is reviewed, the configured run budget is nearly exhausted, or a concrete blocker prevents further review; do not idle to fill time or exceed the run budget.
3. **Read the actual code.** Every finding must cite \`path/to/file.js:LINE\` and describe a concrete, reproducible impact: a reachable runtime/data failure, a CI or release failure, or recurring manual churn demonstrated by repository history. Delete subjective style preferences and any finding whose consequence you cannot prove.
4. **De-duplicate before filing.** Follow the Inventory step under "Where to record findings" above. If it is already filed, skip it; comment on the existing item only when you have genuinely new evidence.
5. **File every accepted finding in the reviewed slice as a separate item after the review.** One root cause per item — never split one problem to inflate the count. Bound the investigation, not the severity of findings you retain. Zero or one issue is valid when the reviewed evidence supports it. Bodies must be decision-complete:
   - **Problem** — what is wrong, with file:line references.
   - **Impact** — the observable consequence (runtime, data, CI/release, or recurring maintenance), not a code-smell label.
   - **Fix** — the approach you have DECIDED on, with the files it touches. If the only obstacle was a design choice, make the call and state it. Do not file a question.
   - **Acceptance criteria** — checkboxes another agent can verify cold.
6. **Redact before you publish.** An issue is world-readable the moment it is filed. ${AUDIT_REDACTION_RULE}
7. **Report at the end**: the slice and paths reviewed, each item you filed, candidates you deliberately did not file and why, any unreviewed inventory, and the reason you stopped.

Read this repository's \`AGENTS.md\` (and any nested per-directory ones covering the slice) before you start, and honor its conventions and its explicitly declared non-issues.`;

export const DO_WORK_MODE_CONTRACT = `## Mode: audit and fix, track every deferred finding

This banner OVERRIDES any later instruction to stop after one fix, forbid deferred issues, leave source unchanged, or skip commits. Implement all accepted fixes in coherent, reviewable slices. Keep investigation bounded; this is not exhaustive file-by-file certification.

1. **Scan broadly, rank candidates, then pick a bounded slice** containing the highest-impact actionable finding. Follow the discovery contract below before choosing.
2. **Read the actual code** and the project's \`AGENTS.md\` / conventions. Honor documented non-issues.
3. **Implement the fix** — the smallest change that actually solves the concrete problem. If the only obstacle was a design choice, make the call and state it.
4. **Verify** with the project's tests (or a focused new test when the path is untested and a silent break would cost data, money, or quota).
5. **Commit** following the repo's conventions. Do not bundle unrelated cleanup.

Every accepted finding requires resolution regardless of severity; warnings and nits are not exemptions. Severity determines sequencing only. Theoretical multi-writer, crash-recovery, or state-preservation findings on ephemeral/regenerable state (git worktrees, caches, agent runs, in-memory locks) are NOT accepted findings and must be rejected as \`not-applicable\` rather than turned into defensive journals/locks or filed as tracker issues. Previously accepted rules are revisable. Prefer investing effort in high-quality fixes. Reassess value and feasibility before retiring a rule that is no longer useful or has no current solution worth pursuing; remove it from linting or quality scanning with concise rationale. Difficulty alone is not an exemption, and reassessment is not permission to hide a known important defect merely to pass checks. Reject irrelevant rules or false positives with evidence, rather than demoting useful checks to tolerated warnings. Never hide findings, weaken tests, or disable useful checks to get green. Genuine hardware, permission, or user-decision blockers remain unresolved with a tracked owner and next step.

Every actionable finding must end as a verified fix or a linked existing/new tracker issue. Search current code, open/closed issues, PRs and active owners before filing; never duplicate another worker's issue. Preserve existing ownership and labels. For a new issue include evidence, impact, chosen fix and acceptance criteria; use the repository's issue-label contract. Redact before you publish — a filed item is world-readable the moment it lands. ${AUDIT_REDACTION_RULE} A summary-only deferral is incomplete delivery. If filing or verification fails, retain the finding and report the blocker; never invent a link or mark it resolved. Unconfirmed candidates stay explicitly unconfirmed with confidence and the next verification step. If no verified finding remains, report that evidence without a drive-by refactor.

## Where to track deferred findings

{trackerInstructions}`;

/**
 * Repository shapes an audit can REQUIRE to be worth running at all.
 *
 * An app that ships no user interface has nothing for an accessibility audit to
 * look at, so scheduling one buys a weekly `coverage: not-applicable` report and
 * a provider call. Each definition below may name one of these in
 * `requiresCapability`; the DETECTION lives in
 * `services/appQualitySchedule.js`, which is where the shapes are read off a
 * checkout. The requirement lives here, beside the audit it describes, so a new
 * audit cannot be added without the guard test asking the question.
 *
 * `test-coverage` is deliberately ungated: a repository with no tests is the
 * one that audit has the most to say about. Its sibling `better-test-quality`
 * IS gated, because it assesses tests that exist.
 */
export const AUDIT_REPO_CAPABILITIES = Object.freeze(['ui', 'typescript', 'typed', 'tests', 'dependencies', 'api', 'infrastructure']);

/** Read aliases kept only for in-flight tasks and historical quality records. */
export const LEGACY_AUDIT_TASK_TYPE_ALIASES = Object.freeze({ 'react-lifecycle': 'ui-lifecycle' });
export const normalizeAuditTaskType = (taskType) => Object.hasOwn(LEGACY_AUDIT_TASK_TYPE_ALIASES, taskType)
  ? LEGACY_AUDIT_TASK_TYPE_ALIASES[taskType]
  : taskType;

/** Why an app lacking the capability is not worth scheduling that audit for. */
export const AUDIT_CAPABILITY_MISSING_REASON = Object.freeze({
  ui: 'no user interface found in this repository',
  typescript: 'no TypeScript sources found in this repository',
  typed: 'no supported typed-language sources found in this repository',
  tests: 'no test files found in this repository',
  dependencies: 'no dependency manifest found in this repository',
  api: 'no HTTP route or API surface found in this repository',
  infrastructure: 'no infrastructure-as-code, container, deployment, or CI configuration found in this repository',
});

/**
 * Scheduled audit types that support the file-issues vs do-work toggle.
 * `quotaBurnId` maps onto `QUOTA_BURN_PROMPT_PRESETS` so a new burn preset
 * cannot land without a scheduled counterpart (guarded in auditCatalog.test.js).
 */
export const AUDIT_DEFINITIONS = Object.freeze({
  security: {
    quotaBurnId: 'security-audit',
    label: 'Security',
    description: 'Security audit — configurable: file issues or implement fixes',
    defaultFileIssues: false,
    filing: filing({
      slugPrefix: 'security-',
      label: 'security-audit',
      issueLabel: 'security',
      labelDescription: 'Proposed from a security audit',
      noun: 'security finding(s)',
    }),
  },
  'code-quality': {
    quotaBurnId: null,
    label: 'Code quality',
    description: 'Code quality improvements — configurable: file issues or implement fixes',
    defaultFileIssues: false,
    filing: filing({
      slugPrefix: 'code-quality-',
      label: 'code-quality-audit',
      issueLabel: 'code-quality',
      labelDescription: 'Proposed from a code-quality audit',
      noun: 'code-quality finding(s)',
    }),
  },
  'test-coverage': {
    quotaBurnId: 'test-gap-audit',
    label: 'Test coverage',
    description: 'Test-coverage audit — configurable: file issues or add tests',
    // Files by default (#12087): unattended test addition is a CI-time cost with
    // no reviewer judging whether the regression named is worth the suite time.
    defaultFileIssues: true,
    filing: filing({
      slugPrefix: 'test-gap-',
      label: 'test-gap-audit',
      issueLabel: 'tests',
      labelDescription: 'Proposed from a test-coverage audit',
      noun: 'test-gap finding(s)',
    }),
  },
  performance: {
    quotaBurnId: 'perf-audit',
    label: 'Performance',
    description: 'Performance audit — configurable: file issues or implement fixes',
    defaultFileIssues: false,
    filing: filing({
      slugPrefix: 'perf-',
      label: 'performance-audit',
      issueLabel: 'performance',
      labelDescription: 'Proposed from a performance audit',
      noun: 'performance finding(s)',
    }),
  },
  accessibility: {
    quotaBurnId: 'a11y-audit',
    label: 'Accessibility',
    description: 'Accessibility audit — configurable: file issues or implement fixes',
    defaultFileIssues: false,
    requiresCapability: 'ui',
    filing: filing({
      slugPrefix: 'a11y-',
      label: 'accessibility-audit',
      issueLabel: 'accessibility',
      labelDescription: 'Proposed from an accessibility audit',
      noun: 'accessibility finding(s)',
    }),
  },
  documentation: {
    quotaBurnId: 'docs-audit',
    label: 'Documentation',
    description: 'Docs-drift audit — configurable: file issues or implement fixes',
    defaultFileIssues: false,
    filing: filing({
      slugPrefix: 'docs-',
      label: 'docs-audit',
      issueLabel: 'documentation',
      labelDescription: 'Proposed from a documentation-drift audit',
      noun: 'docs finding(s)',
    }),
  },
  'ui-bugs': {
    quotaBurnId: null,
    label: 'UI bugs',
    description: 'Find UI bugs — configurable: file issues or implement fixes',
    defaultFileIssues: false,
    requiresCapability: 'ui',
    filing: filing({
      slugPrefix: 'ui-bug-',
      label: 'ui-bug-audit',
      issueLabel: 'bug',
      labelDescription: 'Proposed from a UI-bug audit',
      noun: 'UI bug(s)',
    }),
  },
  'mobile-responsive': {
    quotaBurnId: 'mobile-audit',
    label: 'Mobile & responsive',
    description: 'Mobile/responsive audit — configurable: file issues or implement fixes',
    defaultFileIssues: false,
    requiresCapability: 'ui',
    filing: filing({
      slugPrefix: 'mobile-',
      label: 'mobile-audit',
      issueLabel: 'mobile',
      labelDescription: 'Proposed from a mobile/responsive audit',
      noun: 'mobile finding(s)',
    }),
  },
  'error-handling': {
    quotaBurnId: 'resilience-audit',
    label: 'Error handling',
    description: 'Failure-path audit — configurable: file issues or implement fixes',
    defaultFileIssues: false,
    filing: filing({
      slugPrefix: 'resilience-',
      label: 'resilience-audit',
      issueLabel: 'resilience',
      labelDescription: 'Proposed from a failure-path audit',
      noun: 'resilience finding(s)',
    }),
  },
  typing: {
    quotaBurnId: null,
    label: 'Typing',
    description: 'Typed-language audit — configurable: file issues or implement fixes',
    defaultFileIssues: false,
    requiresCapability: 'typed',
    filing: filing({
      slugPrefix: 'typing-',
      label: 'typing-audit',
      issueLabel: 'code-quality',
      labelDescription: 'Proposed from a typed-language audit',
      noun: 'typing finding(s)',
    }),
  },
  'console-errors': {
    quotaBurnId: null,
    label: 'Console errors',
    description: 'Console-error audit — configurable: file issues or implement fixes',
    defaultFileIssues: false,
    requiresCapability: 'ui',
    filing: filing({
      slugPrefix: 'console-',
      label: 'console-error-audit',
      issueLabel: 'bug',
      labelDescription: 'Proposed from a console-error audit',
      noun: 'console-error finding(s)',
    }),
  },
  design: {
    quotaBurnId: null,
    label: 'Design',
    description: 'Rendered design audit — configurable: file issues (default) or implement fixes',
    defaultFileIssues: true,
    requiresCapability: 'ui',
    filing: filing({
      slugPrefix: 'design-',
      label: 'design-audit',
      issueLabel: 'ux',
      labelDescription: 'Proposed from a rendered design audit',
      noun: 'design finding(s)',
    }),
  },
  ux: {
    quotaBurnId: 'ux-audit',
    label: 'UX',
    description: 'UX audit — configurable: file issues (default) or implement fixes',
    defaultFileIssues: true,
    requiresCapability: 'ui',
    filing: filing({
      slugPrefix: 'ux-',
      label: 'UX-audit',
      issueLabel: 'ux',
      labelDescription: 'Proposed from a UX audit',
      noun: 'UX finding(s)',
    }),
  },
  'data-safety': {
    quotaBurnId: 'data-safety-audit',
    label: 'Data & upgrade safety',
    description: 'Data/upgrade-safety audit — configurable: file issues (default) or implement fixes',
    defaultFileIssues: true,
    filing: filing({
      slugPrefix: 'data-safety-',
      label: 'data-safety-audit',
      issueLabel: 'data-safety',
      labelDescription: 'Proposed from a data/upgrade-safety audit',
      noun: 'data-safety finding(s)',
    }),
  },
  simplify: {
    quotaBurnId: 'simplify-audit',
    label: 'Dead code & duplication',
    description: 'Dead-code/duplication audit — configurable: file issues (default) or implement removals',
    defaultFileIssues: true,
    filing: filing({
      slugPrefix: 'simplify-',
      label: 'simplify-audit',
      issueLabel: 'code-quality',
      labelDescription: 'Proposed from a dead-code/duplication audit',
      noun: 'simplify finding(s)',
    }),
  },
  // Active cleanup counterpart of the shared proportionality check in
  // auditQualityInstructions: other lanes avoid ADDING heavyweight process
  // machinery, this one hunts the machinery already added.
  'over-engineering': {
    quotaBurnId: null,
    label: 'Over-engineering',
    description: 'Over-engineering audit (process and validation machinery whose cost exceeds its demonstrated harm) — configurable: file issues (default) or implement removals',
    defaultFileIssues: true,
    filing: filing({
      slugPrefix: 'over-engineering-',
      label: 'over-engineering-audit',
      issueLabel: 'code-quality',
      labelDescription: 'Proposed from an over-engineering audit',
      noun: 'over-engineering finding(s)',
    }),
  },
  'module-hygiene': {
    quotaBurnId: null,
    label: 'Module hygiene',
    description: 'Module-hygiene audit — configurable: file issues (default) or implement one isolated refactor',
    defaultFileIssues: true,
    doWorkRequiresWorktree: true,
    filing: filing({
      slugPrefix: 'module-hygiene-',
      label: 'module-hygiene-audit',
      issueLabel: 'code-quality',
      labelDescription: 'Proposed from a module-hygiene audit',
      noun: 'module-hygiene finding(s)',
    }),
  },
  'api-contract': {
    quotaBurnId: 'api-contract-audit',
    label: 'API & route contracts',
    description: 'API contract audit — configurable: file issues (default) or implement fixes',
    defaultFileIssues: true,
    requiresCapability: 'api',
    filing: filing({
      slugPrefix: 'api-contract-',
      label: 'api-contract-audit',
      issueLabel: 'api-contract',
      labelDescription: 'Proposed from an API/route-contract audit',
      noun: 'API contract finding(s)',
    }),
  },
  'ui-lifecycle': {
    quotaBurnId: 'ui-lifecycle-audit',
    label: 'UI lifecycle & state',
    description: 'UI lifecycle audit — configurable: file issues (default) or implement fixes',
    defaultFileIssues: true,
    requiresCapability: 'ui',
    filing: filing({
      slugPrefix: 'ui-lifecycle-',
      label: 'ui-lifecycle-audit',
      issueLabel: 'ui-lifecycle',
      labelDescription: 'Proposed from a UI lifecycle/state audit',
      noun: 'UI lifecycle finding(s)',
    }),
  },
  observability: {
    quotaBurnId: 'observability-audit',
    label: 'Logging & observability',
    description: 'Observability audit — configurable: file issues (default) or implement fixes',
    defaultFileIssues: true,
    filing: filing({
      slugPrefix: 'observability-',
      label: 'observability-audit',
      // Category stays `code-quality` (a missing log line is a
      // maintainability defect); the metric label `observability` is
      // derived from the slug so the backlog can still be filtered by lens.
      issueLabel: 'code-quality',
      labelDescription: 'Proposed from a logging/observability audit',
      noun: 'observability finding(s)',
    }),
  },
  copy: {
    quotaBurnId: 'copy-audit',
    label: 'Copy & text clarity',
    description: 'Copy-clarity audit — configurable: file issues (default) or implement rewrites',
    defaultFileIssues: true,
    requiresCapability: 'ui',
    filing: filing({
      slugPrefix: 'copy-',
      label: 'copy-audit',
      // User-facing wording is a UX concern, so the category stays `ux`;
      // the metric label `copy` is derived from the slug.
      issueLabel: 'ux',
      labelDescription: 'Proposed from a copy/text-clarity audit',
      noun: 'copy finding(s)',
    }),
  },
  // These six PortOS-owned focused missions map onto the current generic
  // `/do:better` scopes through DO_BETTER_SCOPE_COVERAGE below. Their
  // scheduleable mission bodies add narrow checks; they do not copy slashdo's
  // audit orchestration or tracker-filing procedure. Each keeps its existing
  // category label and an additional metric label where needed. Refactor lanes
  // require a managed worktree in do-work mode so edits never land in a live
  // checkout.
  'better-complexity': {
    quotaBurnId: null,
    label: 'Cyclomatic complexity',
    description: 'Complexity-reduction audit — configurable: file issues (default) or implement one refactor',
    defaultFileIssues: true,
    doWorkRequiresWorktree: true,
    filing: filing({
      slugPrefix: 'complexity-',
      label: 'complexity-audit',
      issueLabel: 'code-quality',
      labelDescription: 'Proposed from a cyclomatic-complexity audit',
      noun: 'complexity finding(s)',
    }),
  },
  'better-cognitive-load': {
    quotaBurnId: null,
    label: 'Cognitive load & readability',
    description: 'Reader-cost and excessive code-comment audit — configurable: file issues (default) or implement one refactor',
    defaultFileIssues: true,
    doWorkRequiresWorktree: true,
    filing: filing({
      slugPrefix: 'cognitive-load-',
      label: 'cognitive-load-audit',
      issueLabel: 'code-quality',
      labelDescription: 'Proposed from a cognitive-load/readability audit',
      noun: 'cognitive-load finding(s)',
    }),
  },
  'better-structural-drift': {
    quotaBurnId: null,
    label: 'Structural drift & sources of truth',
    description: 'Generated-artifact / hand-synced-registry drift audit — configurable: file issues (default) or implement one consolidation',
    defaultFileIssues: true,
    doWorkRequiresWorktree: true,
    filing: filing({
      slugPrefix: 'structural-drift-',
      label: 'structural-drift-audit',
      issueLabel: 'code-quality',
      labelDescription: 'Proposed from a structural-drift audit',
      noun: 'structural-drift finding(s)',
    }),
  },
  'better-runtime-safety': {
    quotaBurnId: null,
    label: 'Runtime safety & async correctness',
    description: 'Latent-defect audit — configurable: file issues (default) or implement fixes',
    defaultFileIssues: true,
    filing: filing({
      slugPrefix: 'runtime-safety-',
      label: 'runtime-safety-audit',
      issueLabel: 'bug',
      labelDescription: 'Proposed from a runtime-safety audit',
      noun: 'runtime-safety finding(s)',
    }),
  },
  'better-dependency-freedom': {
    quotaBurnId: null,
    label: 'Dependency freedom',
    description: 'Dependency-necessity audit — configurable: file issues (default) or implement one removal',
    defaultFileIssues: true,
    requiresCapability: 'dependencies',
    doWorkRequiresWorktree: true,
    filing: filing({
      slugPrefix: 'depfree-',
      label: 'dependency-freedom-audit',
      issueLabel: 'dependencies',
      labelDescription: 'Proposed from a dependency-freedom audit',
      noun: 'dependency finding(s)',
    }),
  },
  'better-test-quality': {
    quotaBurnId: null,
    label: 'Test quality',
    description: 'Vacuous/weak/redundant-test audit — configurable: file issues (default) or implement one cleanup',
    defaultFileIssues: true,
    requiresCapability: 'tests',
    filing: filing({
      slugPrefix: 'test-quality-',
      label: 'test-quality-audit',
      issueLabel: 'tests',
      labelDescription: 'Proposed from a test-quality audit',
      noun: 'test-quality finding(s)',
    }),
  },
  // The host the code is developed on. Every lens above reads source or runs
  // the product; none measures what running the test suites or dev server
  // does to the developer's machine — the gap that let test suites leak
  // tens of thousands of temp directories unnoticed (#9000). Ungated: any
  // repository has a development loop.
  'better-dev-environment': {
    quotaBurnId: null,
    label: 'Development environment',
    description: 'Dev-loop host-impact audit (leaked temp files and processes, writes outside the sandbox, watcher and idle cost, suite runtime) — configurable: file issues (default) or implement one fix',
    defaultFileIssues: true,
    filing: filing({
      slugPrefix: 'dev-environment-',
      label: 'dev-environment-audit',
      issueLabel: 'tests',
      labelDescription: 'Proposed from a development-environment audit',
      noun: 'dev-environment finding(s)',
    }),
  },
  // Service and data-platform lenses. The catalog above grew out of a web app
  // with a UI; these cover what a backend service, data platform, or
  // infrastructure repository is judged on and nothing above owns: the
  // deployment it describes, the correctness of the data flowing through it,
  // how it behaves under restarts and load, what it does with personal data,
  // and what it costs to run. Each defaults to file-issues — their findings
  // usually touch production configuration, where an unattended edit is the
  // wrong default.
  infrastructure: {
    quotaBurnId: null,
    label: 'Infrastructure & deployment',
    description: 'Infrastructure-as-code, container, deployment and CI audit — configurable: file issues (default) or implement fixes',
    defaultFileIssues: true,
    requiresCapability: 'infrastructure',
    filing: filing({
      slugPrefix: 'infrastructure-',
      label: 'infrastructure-audit',
      issueLabel: 'infrastructure',
      labelDescription: 'Proposed from an infrastructure/deployment audit',
      noun: 'infrastructure finding(s)',
    }),
  },
  'data-integrity': {
    quotaBurnId: null,
    label: 'Data integrity & pipelines',
    description: 'Data-correctness audit (ingestion, idempotency, consistency, schema evolution) — configurable: file issues (default) or implement fixes',
    defaultFileIssues: true,
    filing: filing({
      slugPrefix: 'data-integrity-',
      label: 'data-integrity-audit',
      // Same category as its upgrade-time sibling; the metric label
      // `data-integrity` separates runtime data correctness in the backlog.
      issueLabel: 'data-safety',
      labelDescription: 'Proposed from a data-integrity/pipeline audit',
      noun: 'data-integrity finding(s)',
    }),
  },
  reliability: {
    quotaBurnId: null,
    label: 'Reliability & operability',
    description: 'Service reliability audit (shutdown, health checks, backpressure, job leasing, mixed-version deploys) — configurable: file issues (default) or implement fixes',
    defaultFileIssues: true,
    filing: filing({
      slugPrefix: 'reliability-',
      label: 'reliability-audit',
      // Filed beside error-handling's call-level findings; the metric label
      // `reliability` marks the system-level ones.
      issueLabel: 'resilience',
      labelDescription: 'Proposed from a reliability/operability audit',
      noun: 'reliability finding(s)',
    }),
  },
  privacy: {
    quotaBurnId: null,
    label: 'Privacy & data governance',
    description: 'Personal/sensitive-data handling audit (exposure, minimization, retention, erasure) — configurable: file issues (default) or implement fixes',
    defaultFileIssues: true,
    filing: filing({
      slugPrefix: 'privacy-',
      label: 'privacy-audit',
      issueLabel: 'privacy',
      labelDescription: 'Proposed from a privacy/data-governance audit',
      noun: 'privacy finding(s)',
    }),
  },
  'cost-efficiency': {
    quotaBurnId: null,
    label: 'Cost & resource efficiency',
    description: 'Metered-spend audit (paid API calls, unbounded scans, storage tiers, over-provisioning) — configurable: file issues (default) or implement fixes',
    defaultFileIssues: true,
    filing: filing({
      slugPrefix: 'cost-',
      label: 'cost-efficiency-audit',
      // Spend is a performance-family concern; the metric label `cost` keeps
      // it filterable apart from latency work.
      issueLabel: 'performance',
      labelDescription: 'Proposed from a cost/resource-efficiency audit',
      noun: 'cost finding(s)',
    }),
  },
  // Work that was started and never finished: stubs reachable from the UI,
  // permanently disabled controls, settings nothing reads. Every other lens
  // reads these as intentional (simplify would delete them, ui-bugs sees
  // nothing "broken"), so they need an owner that decides finish/hide/remove.
  'feature-completeness': {
    quotaBurnId: null,
    label: 'Feature completeness',
    description: 'Incomplete-feature audit (stubs reachable from the UI, disabled or "coming soon" controls, settings nothing reads, capabilities with no entry point) — configurable: file issues (default) or finish one',
    defaultFileIssues: true,
    filing: filing({
      slugPrefix: 'incomplete-',
      label: 'feature-completeness-audit',
      issueLabel: 'bug',
      labelDescription: 'Proposed from an incomplete-feature audit',
      noun: 'incomplete-feature finding(s)',
    }),
  },
  // Multi-step workflows judged from the server's in-progress states: each
  // needs a visible resume/cancel/reattach exit after a failed follow-up step
  // or a reload. A page walk exercises one click and never sees this.
  'workflow-recovery': {
    quotaBurnId: null,
    label: 'Workflow recovery',
    description: 'Workflow completion and recovery audit (stranded in-progress states, busy refusals without a handle, client follow-up steps that fail after the server succeeded) — configurable: file issues (default) or implement fixes',
    defaultFileIssues: true,
    filing: filing({
      slugPrefix: 'workflow-',
      label: 'workflow-recovery-audit',
      issueLabel: 'bug',
      labelDescription: 'Proposed from a workflow completion and recovery audit',
      noun: 'workflow-recovery finding(s)',
    }),
  },
  // Executes the upgrade path and a backup restore against scratch roots built
  // from fixture shapes. `data-safety` reads migrations and backup code
  // statically; the failures that reached installs (#6182, #12044, #12046,
  // #12049) were visible only on the executed path.
  'upgrade-rehearsal': {
    quotaBurnId: null,
    label: 'Upgrade & restore rehearsal',
    description: 'Upgrade and restore rehearsal (runs migrations over synthetic older installs and a backup restore in scratch directories, never the live data) — configurable: file issues (default) or implement fixes',
    defaultFileIssues: true,
    filing: filing({
      slugPrefix: 'upgrade-rehearsal-',
      label: 'upgrade-rehearsal-audit',
      // Same category as the static read; the metric label separates what an
      // executed rehearsal found from what a read of the code found.
      issueLabel: 'data-safety',
      labelDescription: 'Proposed from an upgrade and restore rehearsal',
      noun: 'upgrade-rehearsal finding(s)',
    }),
  },
});

export const AUDIT_TASK_TYPES = new Set(Object.keys(AUDIT_DEFINITIONS));

/**
 * The same set as an ordered list, in catalog order. The Set answers
 * membership; anything that has to ENUMERATE the audits — a request schema's
 * enum, a schedule planner laying them out — reads this rather than re-deriving
 * `Object.keys(AUDIT_DEFINITIONS)` and acquiring a second vocabulary.
 */
export const AUDIT_TASK_TYPE_LIST = Object.freeze([...AUDIT_TASK_TYPES]);

/**
 * Check if a task type is an audit task registered in the catalog.
 *
 * @param {string} taskType - Task type identifier (e.g. 'security', 'code-quality')
 * @returns {boolean} True if registered in AUDIT_DEFINITIONS
 */
export function isAuditTaskType(taskType) {
  return AUDIT_TASK_TYPES.has(normalizeAuditTaskType(taskType));
}

/**
 * Get the default file-issues setting for an audit task type.
 *
 * @param {string} taskType - Task type identifier
 * @returns {boolean} True if the audit defaults to filing issues rather than fixing
 */
export function defaultFileIssuesFor(taskType) {
  return AUDIT_DEFINITIONS[normalizeAuditTaskType(taskType)]?.defaultFileIssues === true;
}

/**
 * Whether do-work mode for this audit must use an isolated managed worktree.
 * The flag is catalog-owned so dispatch and schedule UI cannot drift.
 *
 * @param {string} taskType - Task type identifier
 * @returns {boolean} True when live-checkout remediation is forbidden
 */
export function auditDoWorkRequiresWorktree(taskType) {
  return AUDIT_DEFINITIONS[normalizeAuditTaskType(taskType)]?.doWorkRequiresWorktree === true;
}

/**
 * The dispatch's own `fileIssues` answer, or `null` when it did not give one.
 *
 * Three-valued on purpose: absent is NOT "off". The catalog default only
 * applies to the absent case, and an explicit `false` on a type that defaults
 * to filing has to survive as a real "implement" choice. Accepts the
 * `'true'`/`'false'` string forms for parity with other metadata gates that
 * round-trip through TASKS.md as text.
 *
 * @param {Record<string, unknown>} [metadata] - Task metadata object
 * @returns {boolean|null} The explicit choice, or null when the key is absent
 */
function explicitFileIssues(metadata) {
  const raw = metadata?.fileIssues;
  if (isTruthyMeta(raw)) return true;
  if (raw === false || raw === 'false') return false;
  return null;
}

/**
 * Effective file-issues mode for a dispatch. An explicit `fileIssues` boolean
 * on the merged task metadata wins; otherwise the catalog default applies.
 *
 * @param {string} taskType - Task type identifier
 * @param {Record<string, unknown>} [metadata] - Task metadata object
 * @returns {boolean} True if this dispatch should file issues instead of making code changes
 */
export function isFileIssuesMode(taskType, metadata) {
  if (!isAuditTaskType(taskType)) return false;
  return explicitFileIssues(metadata) ?? defaultFileIssuesFor(taskType);
}

/**
 * Whether a dispatch EXPLICITLY asked for file-issues delivery — the lane for
 * work that has no catalog default to fall back on.
 *
 * A custom app job is user-authored: nothing in this catalog knows what it
 * audits, so there is no default to consult and opting in is the only way a
 * custom agent task can carry the posture. Deliberately separate from
 * `isFileIssuesMode`, which stays gated on the catalog so a non-audit built-in
 * (`claim-issue`, `user-action-review`) cannot acquire the audit posture from a
 * `fileIssues` key it uses to mean something else.
 *
 * @param {Record<string, unknown>} [metadata] - Task metadata object
 * @returns {boolean} True only when the dispatch itself asked to file issues
 */
export function isExplicitFileIssuesRequest(metadata) {
  return explicitFileIssues(metadata) === true;
}

/**
 * The task-metadata posture a file-issues dispatch runs with, in ONE place.
 *
 * These flags are what actually enforce the mode: the banner is text a
 * model may argue with, but `noCodeOutput` is what routes the prompt through
 * `buildActionOutputCompletionSection` — stripping every commit/push/PR/
 * auto-merge instruction — and what makes `declaresNoCommitCriterion` stop
 * scoring a diff-free run as a failure (`services/taskTypeHooks.js`), so an
 * issues-only run can neither be told to ship code nor be failed and retried
 * for not shipping any. `useWorktree: false` keeps `openPR: false` from
 * meaning the AUTO-MERGE posture, and `simplify: false` drops a step that
 * presupposes a diff.
 *
 * `fileIssues` rides along so the persisted task states the mode it ran in
 * rather than leaving readers to re-derive it from a catalog default that may
 * have changed since.
 *
 * Every lane stamps THIS object — the scheduled audit generator and the custom
 * agent job generator — so the two cannot drift into separate postures.
 * `worktreeChangesExpected` is deliberately NOT here: the PLAN.md tracker files
 * by committing checklist items, so its file-issues run legitimately leaves a
 * dirty tree, and that flag is derived per dispatch from the resolved tracker.
 */
export const FILE_ISSUES_DELIVERY_SETTINGS = Object.freeze({
  fileIssues: true,
  noCodeOutput: true,
  useWorktree: false,
  openPR: false,
  simplify: false,
});

/**
 * The repository shape this audit needs to be worth scheduling, or null when it
 * applies to any repository. Catalog-owned like `doWorkRequiresWorktree`, so
 * the schedule planner and the detection cannot drift from the audit itself.
 *
 * @param {string} taskType - Task type identifier
 * @returns {string|null} A member of AUDIT_REPO_CAPABILITIES, or null
 */
export function auditCapabilityRequirement(taskType) {
  return AUDIT_DEFINITIONS[normalizeAuditTaskType(taskType)]?.requiresCapability || null;
}

/**
 * Retrieve filing preset configuration for an audit task type.
 *
 * @param {string} taskType - Task type identifier
 * @returns {object|null} Filing preset metadata (slugPrefix, label, issueLabel, planItemBody, etc.) or null
 */
export function getAuditFilingPreset(taskType) {
  return AUDIT_DEFINITIONS[normalizeAuditTaskType(taskType)]?.filing || null;
}

/**
 * Return the appropriate mode banner contract string for the given execution mode.
 *
 * @param {boolean} fileIssues - Whether the dispatch is in file-issues mode
 * @returns {string} The contract text defining the operating constraints for the agent
 */
export function modeContractFor(fileIssues) {
  return fileIssues ? FILE_ISSUES_MODE_CONTRACT : DO_WORK_MODE_CONTRACT;
}

/**
 * Ensure a prompt carries the mode banner. If the template already has a
 * `{modeInstructions}` placeholder the generator will substitute it; otherwise
 * the banner is prepended so a customized stored prompt still honors the mode.
 *
 * @param {string} promptTemplate - The raw prompt template or prompt string
 * @param {string} modeInstructions - The mode contract banner to wrap or inject
 * @returns {string} Wrapped prompt string
 */
export function applyAuditModeWrapper(promptTemplate, modeInstructions) {
  const prompt = typeof promptTemplate === 'string' ? promptTemplate : '';
  if (!modeInstructions) return prompt;
  if (prompt.includes('{modeInstructions}')) return prompt;
  return `${modeInstructions}\n\n---\n\n${prompt}`;
}

// better-dependency-freedom's removal bar — the same vocabulary as slashdo's
// `/do:depfree` / `--heavy` / `--extreme`. `default` keeps large, widely
// audited libraries; `heavy` exempts only foundational frameworks, runtimes and
// core tooling; `extreme` exempts only what cannot be owned responsibly (the
// runtime, security-sensitive protocols and primitives, native bindings,
// CI-required tooling) and is written for the strongest model at max effort.
// Catalog-owned, like the mode contracts above, so the sanitizer
// (lib/cosValidation.js), the generator, and the prompt-expansion guard all
// read ONE list and a value cannot be settable yet silently absent from the
// prompt. Absent = default.
export const DEPFREE_MODES = ['default', 'heavy', 'extreme'];
export const DEFAULT_DEPFREE_MODE = 'default';

// One block per DEPFREE_MODES entry: where the "Acceptable" line sits for the
// dependency-freedom audit. Keyed by the same list the sanitizer allowlists, so
// a mode cannot be settable yet silently absent from the prompt. The wording
// tracks slashdo's `/do:depfree` default / --heavy / --extreme rules so a
// PortOS-scheduled audit and a terminal run of the command draw the same line.
const DEPFREE_MODE_BLOCKS = {
  default: `## Removal bar for this run: default

Keep large, widely audited libraries that do real work — frameworks, runtimes,
database drivers, build toolchains, rendering and math libraries — without
relitigating them. Candidates are small single-purpose packages, wrappers over
capabilities the platform now provides, micro-packages, and libraries where the
project uses one or two functions. A replacement above ~300 lines of owned code
is Infeasible at this bar; prefer a native API or a short owned helper.`,
  heavy: `## Removal bar for this run: heavy

Only foundational frameworks, core platform tooling, and language runtimes are
exempt. Popularity and download counts do not exempt a library: utility
collections, HTTP clients, logging, CLI parsers, date, glob, validation, retry,
color, and event-emitter libraries are all candidates, and devDependencies get
the same priority as production ones. Maintenance status is irrelevant — the
question is whether the project can own the code. The replacement ceiling is
~300 lines of owned code per package; when a package sits on the line, lean
toward removal.`,
  extreme: `## Removal bar for this run: extreme — the goal is zero dependencies

Exempt ONLY what cannot be owned responsibly: the language runtime and its
standard library, the package manager and compiler the build needs,
security-sensitive protocol and primitive implementations (TLS, cryptography,
authentication protocols, database wire protocols with authentication, codecs
with conformance suites you cannot run), native bindings to the OS or hardware,
and the lint/format/test tooling CI requires. Everything else is a candidate —
web frameworks, UI libraries, client SDKs, ORMs, parsers, build plugins — judged
by whether its USED surface can be rebuilt behind a parity test suite, never by
its size or popularity. There is no line ceiling.

For any replacement above ~100 lines, write a replacement design first: the
exact used surface (symbols, options, behaviors relied on), the owned module's
API, the parity test plan, the edge cases the call sites reach versus the ones
provably unreachable, and the risk the swap carries. The design is part of the
finding, and part of the PR when you implement. Work extra hard: read the
library's source for the behaviors the call sites depend on — option defaults,
error shapes, ordering guarantees, encoding edge cases — instead of guessing
from its README, and write the parity tests so they fail against a stub before
any call site switches over.

A package you leave in place needs a reason a reviewer could argue with;
"popular", "large", or "too much code" is not one. Record what a future run
would need instead (a conformance suite, a native addon, a product-level
rewrite). This bar is written for the strongest available model at maximum
reasoning effort; if this run is on a budget provider or model, say so at the
top of the report rather than quietly lowering the bar.`,
};

/**
 * Render the operator's dependency-freedom removal bar into the audit prompt.
 * `depfreeMode` was merged (global → per-app override) and value-constrained
 * by sanitizeTaskMetadata, so read it straight from the metadata; absent means
 * the default bar. A customized stored prompt that dropped `{depfreeMode}`
 * still gets the block PREPENDED, so choosing the heavy or extreme bar is never
 * a silent no-op on that install. Every other task type passes through.
 */
export function applyDepfreeMode(promptTemplate, taskType, metadata) {
  const prompt = typeof promptTemplate === 'string' ? promptTemplate : '';
  if (taskType !== 'better-dependency-freedom') return prompt;
  const mode = DEPFREE_MODES.includes(metadata?.depfreeMode) ? metadata.depfreeMode : DEFAULT_DEPFREE_MODE;
  // The block carries its own heading, so the prepend path passes null.
  return renderOrPrependSection(prompt, '{depfreeMode}', null, DEPFREE_MODE_BLOCKS[mode]);
}


/**
 * Scheduled audit types mapped onto the scope table in slashdo's
 * `lib/better-audit.md`. The exported `DO_BETTER_LENS_COVERAGE` name remains
 * as a compatibility alias for callers that used the old per-lens roster;
 * the source of truth is now slashdo's generic scope table. Values are
 * AUDIT_DEFINITIONS types that cover a scope; the relation is many-to-many.
 *
 * This map drives schedule discovery labels, never dispatch or execution
 * ordering. The test parses the bundled table and checks both directions, so
 * adding a slashdo scope without a scheduled owner or leaving stale scope
 * labels fails at the source boundary.
 */
export const DO_BETTER_SCOPE_COVERAGE = Object.freeze({
  security: ['security', 'privacy'],
  'code-quality': ['code-quality', 'observability'],
  dry: ['simplify'],
  architecture: ['module-hygiene', 'api-contract'],
  'bugs-perf': ['better-runtime-safety', 'performance', 'error-handling', 'observability', 'reliability', 'cost-efficiency', 'workflow-recovery'],
  'stack-specific': ['ui-lifecycle', 'accessibility', 'data-safety', 'upgrade-rehearsal', 'security', 'infrastructure', 'data-integrity'],
  deps: ['better-dependency-freedom', 'security'],
  tests: ['test-coverage', 'better-test-quality', 'better-dev-environment'],
  ux: ['ux', 'design', 'mobile-responsive', 'copy', 'feature-completeness'],
  structural: ['module-hygiene', 'better-structural-drift', 'simplify', 'over-engineering'],
  'cognitive-load': ['better-cognitive-load', 'better-complexity'],
});

/** @deprecated Use DO_BETTER_SCOPE_COVERAGE; kept for API compatibility. */
export const DO_BETTER_LENS_COVERAGE = DO_BETTER_SCOPE_COVERAGE;

/** Display metadata is derived, so upgrades never rewrite durable task IDs. */
export function getAuditScheduleMetadata(taskType) {
  const canonicalType = normalizeAuditTaskType(taskType);
  if (!isAuditTaskType(canonicalType)) return { displayName: taskType, defaultLabels: [] };
  const scopes = Object.entries(DO_BETTER_SCOPE_COVERAGE)
    .filter(([, types]) => types.includes(canonicalType)).map(([scope]) => scope);
  return {
    displayName: canonicalType.startsWith('better-') ? canonicalType : `better-${canonicalType}`,
    defaultLabels: ['codebase-improvement', 'slashdo', ...scopes],
  };
}

/**
 * Shipped advisory run order for the audit types, named by SCHEDULED TASK TYPE.
 *
 * This is the default for each task's editable `suggestedAfter` array, layered
 * at READ time by `getScheduleStatus` (services/taskSchedule.js) rather than
 * seeded onto the stored rows — like `runGuidance` and `displayName` beside it,
 * so an edit here reaches every existing install with no migration, while a
 * user's stored list (an explicit `[]` included) still wins. It is ADVISORY:
 * nothing in the scheduler reads it, and a task whose suggested predecessors
 * haven't run still runs. The ENFORCED field is `runAfter`, which blocks
 * dispatch until each named type has run since this task's last run.
 *
 * The prose it replaced ("After structural drift, remove dead code…") named the
 * audits by their subject matter rather than by their task type, so a reader
 * could not tell whether "structural drift" was another scheduled task or just
 * a concept — which is the whole question the guidance exists to answer.
 *
 * Each entry lists only its IMMEDIATE predecessors; transitive order follows
 * from the chain (better-cognitive-load comes after simplify because it comes
 * after better-complexity, which comes after module-hygiene, which comes after
 * simplify). Keeping the lists to one or two entries is deliberate — a list
 * that restates the whole chain is unreadable and drifts on every edit.
 *
 * The safety audits (security, data-safety, better-runtime-safety,
 * error-handling) and the broad code-quality triage seed EMPTY: they are the
 * head of the order, and an exploitable defect outranks the sequence anyway.
 */
export const AUDIT_SUGGESTED_AFTER = Object.freeze({
  // Broad triage first, then coverage, so the tests written next are aimed at
  // the findings the triage surfaced.
  'test-coverage': Object.freeze(['code-quality']),
  'better-test-quality': Object.freeze(['test-coverage']),
  'better-dev-environment': Object.freeze(['better-test-quality']),
  // The restructuring ladder: consolidate sources of truth, delete what is
  // dead, then draw module boundaries, then reduce what survives.
  simplify: Object.freeze(['better-structural-drift', 'feature-completeness']),
  'over-engineering': Object.freeze(['simplify']),
  'module-hygiene': Object.freeze(['simplify']),
  'better-dependency-freedom': Object.freeze(['module-hygiene']),
  'better-complexity': Object.freeze(['module-hygiene']),
  'better-cognitive-load': Object.freeze(['better-complexity']),
  // Measure and describe the shape that survived the ladder.
  performance: Object.freeze(['better-complexity']),
  documentation: Object.freeze(['performance', 'better-cognitive-load']),
  // Service lenses: deployment config after the code-level security pass it
  // shares findings with; system-level reliability after call-level failure
  // handling; spend after latency, since a performance fix often moves cost.
  infrastructure: Object.freeze(['security']),
  reliability: Object.freeze(['error-handling']),
  'workflow-recovery': Object.freeze(['error-handling']),
  'cost-efficiency': Object.freeze(['performance']),
  // The executed rehearsal follows the static read, so it spends its scratch
  // boots on the hazards the read could not see.
  'upgrade-rehearsal': Object.freeze(['data-safety']),
});

// WHY each audit sits where it does in the order above — rationale only. The
// sequence itself is AUDIT_SUGGESTED_AFTER, which names real task types; this
// text must never be the only place an ordering relationship is recorded.
// Urgent bugs outrank the sequence; re-measure after each merged change.
export const AUDIT_RUN_GUIDANCE = Object.freeze({
  'better-test-quality': 'Assesses whether the tests you have detect the regressions the other audits found — so refactors that follow have a safety net.',
  'better-dev-environment': 'Follows test quality, so it measures the host impact of the suite that will keep running rather than tests about to be deleted.',
  'test-coverage': 'Adds the missing boundary coverage a refactor needs before it starts; avoid duplicating assertions a stronger test already makes.',
  security: 'Head of the order — an exploitable defect is fixed before any cleanup, whatever else is queued.',
  'data-safety': 'Head of the order — data-loss and upgrade hazards are fixed before code moves around them.',
  'better-runtime-safety': 'Head of the order — reachable runtime defects are fixed first; rerun once structure settles.',
  'error-handling': 'Head of the order — safe failure behavior is established before the same code is restructured.',
  'better-structural-drift': 'Start of the restructuring ladder: consolidating sources of truth first means every later refactor targets the surviving implementation.',
  simplify: 'Dead and duplicate code is removed before modules are reorganized, so the reorganization only moves live code.',
  'over-engineering': 'Follows simplify, which removes code with no behavior; this removes process and validation machinery that works but costs more than the harm it prevents.',
  'module-hygiene': 'Ownership and module boundaries are settled before function-level work, so complexity is measured on the final layout.',
  'better-dependency-freedom': 'Unnecessary dependencies go once ownership is clear, so no effort is spent polishing code a removal deletes.',
  'better-complexity': 'Remeasures the functions that survived the ladder and reduces the costliest branching.',
  'better-cognitive-load': 'Reviews names, abstraction levels, and readability of the shape everything else left behind.',
  design: 'Inspect rendered composition after UX clarifies the task flow; preserve authored theme identity and deduplicate shared root causes with sibling UI audits.',
  'code-quality': 'Broad triage that points at the focused audit worth running; avoid overlapping fixes in the same slice.',
  documentation: 'Describes the final result, so it runs once behavior and structure have settled.',
  performance: 'Measure a real bottleneck before optimizing, and remeasure after structural and complexity changes.',
  'data-integrity': 'Head of the order — duplicated, dropped, or silently wrong data compounds with every run, so it is fixed before code moves around it.',
  privacy: 'Head of the order — exposed personal data is a harm already happening, whatever cleanup is queued.',
  infrastructure: 'Follows the code-level security pass, so deployment findings (exposure, credentials, unpinned images) do not duplicate what it already filed.',
  reliability: 'Follows call-level failure handling: once each call fails safely, look at how the service as a whole restarts, drains, and sheds load.',
  'cost-efficiency': 'Follows performance, because a latency fix often changes what the path costs; measure spend on the shape that survived.',
  'feature-completeness': 'Runs before simplify sweeps unreferenced code, so an unfinished feature is decided (finish, hide, or remove) rather than silently deleted.',
  'workflow-recovery': 'Follows call-level failure handling: once each step fails safely, check that a workflow stopped between steps still offers the user a way to finish or cancel it.',
  'upgrade-rehearsal': 'Follows the static data-safety read: once the hazards a read can see are fixed, execute migrations and a backup restore against scratch installs to catch what only running them shows.',
});
