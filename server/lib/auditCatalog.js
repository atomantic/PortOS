/**
 * `getAuditScheduleMetadata` derives upgrade-safe display names and cluster labels.
 */

import { ACTIVE_AUDIT_DOMAIN_IDS, CONSOLIDATED_AUDIT_DOMAINS, auditDomainFor } from './auditDomains.js';
import { LIGHT_FINDINGS_BATCH_EXCEPTION } from './dispatchLabels.js';
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
5. **File every accepted finding in the reviewed slice as a separate item after the review**, except that ${LIGHT_FINDINGS_BATCH_EXCEPTION}. One root cause per item or checklist entry — never split one problem to inflate the count. Bound the investigation, not the severity of findings you retain. Zero or one issue is valid when the reviewed evidence supports it. Bodies must be decision-complete:
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
export { LEGACY_AUDIT_TASK_TYPE_ALIASES, normalizeAuditTaskType } from './auditDomains.js';

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

const standaloneDomains = {
  security: {
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
  privacy: {
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
  accessibility: {
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
  'api-contract': {
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
  'better-dependency-freedom': {
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
  'feature-completeness': {
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
};

const consolidated = Object.fromEntries(Object.entries(CONSOLIDATED_AUDIT_DOMAINS).map(([id, domain]) => [id, {
  label: domain.label,
  description: domain.mission,
  defaultFileIssues: true,
  doWorkRequiresWorktree: domain.doWorkRequiresWorktree,
  requiresCapability: domain.requiresCapability,
  filing: filing({ slugPrefix: id + '-', label: id + '-audit', issueLabel: domain.issueLabel,
    labelDescription: domain.label + ' audit', noun: domain.label + ' finding(s)' }),
}]));

export const AUDIT_DEFINITIONS = Object.freeze({ ...standaloneDomains, ...consolidated });
export const AUDIT_TASK_TYPE_LIST = ACTIVE_AUDIT_DOMAIN_IDS;
export const AUDIT_TASK_TYPES = new Set(AUDIT_TASK_TYPE_LIST);

/**
 * Check if a task type is an audit task registered in the catalog.
 *
 * @param {string} taskType - Task type identifier (e.g. 'security', 'code-quality')
 * @returns {boolean} True if registered in AUDIT_DEFINITIONS
 */
export function isAuditTaskType(taskType) {
  return Object.hasOwn(AUDIT_DEFINITIONS, auditDomainFor(taskType));
}

/**
 * Get the default file-issues setting for an audit task type.
 *
 * @param {string} taskType - Task type identifier
 * @returns {boolean} True if the audit defaults to filing issues rather than fixing
 */
export function defaultFileIssuesFor(taskType) {
  return AUDIT_DEFINITIONS[auditDomainFor(taskType)]?.defaultFileIssues === true;
}

/**
 * Whether do-work mode for this audit must use an isolated managed worktree.
 * The flag is catalog-owned so dispatch and schedule UI cannot drift.
 *
 * @param {string} taskType - Task type identifier
 * @returns {boolean} True when live-checkout remediation is forbidden
 */
export function auditDoWorkRequiresWorktree(taskType) {
  return AUDIT_DEFINITIONS[auditDomainFor(taskType)]?.doWorkRequiresWorktree === true;
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
  return AUDIT_DEFINITIONS[auditDomainFor(taskType)]?.requiresCapability || null;
}

/**
 * Retrieve filing preset configuration for an audit task type.
 *
 * @param {string} taskType - Task type identifier
 * @returns {object|null} Filing preset metadata (slugPrefix, label, issueLabel, planItemBody, etc.) or null
 */
export function getAuditFilingPreset(taskType) {
  return AUDIT_DEFINITIONS[auditDomainFor(taskType)]?.filing || null;
}

// Owner labels as `task-type=labels`: the lane metric label is what lane
// health attributes on, so an out-of-lane item carries the owner's full set.
const OWNER_LABELS = Object.entries(AUDIT_DEFINITIONS)
  .map(([type, { filing }]) => `${type}=${[filing.issueLabel, ...filing.extraLabels].join('+')}`)
  .join(', ');

/**
 * Both banners carry it: a verified finding outside the audit's category or
 * reviewed slice is still tracked, under its owning lane, never left as a note.
 */
export const OUT_OF_SCOPE_FINDINGS_RULE = `## Findings outside this audit's category or slice

Track every verified defect you encounter outside this audit's category or reviewed slice as its own item, using the tracker instructions above — never only in the summary, a recommendations list or a closing note. Mission advice that a problem belongs to a sibling audit means do not score, fix or deep-investigate it here; it does not mean leave it untracked. Cite path:line and a concrete impact, de-duplicate as usual, name the owning audit task type, and label it with the owner's labels (task-type=labels: ${OWNER_LABELS}) instead of this category's. Report an unverified suspicion as unconfirmed with its next verification step. List every such item filed or matched in the final report.`;

/**
 * Return the appropriate mode banner contract string for the given execution mode.
 *
 * @param {boolean} fileIssues - Whether the dispatch is in file-issues mode
 * @returns {string} The contract text defining the operating constraints for the agent
 */
export function modeContractFor(fileIssues) {
  return `${fileIssues ? FILE_ISSUES_MODE_CONTRACT : DO_WORK_MODE_CONTRACT}\n\n${OUT_OF_SCOPE_FINDINGS_RULE}`;
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
// (lib/cos/cosValidation.js), the generator, and the prompt-expansion guard all
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
  'code-quality': ['architecture-maintainability', 'reliability-error-handling'],
  dry: ['code-simplification'],
  architecture: ['architecture-maintainability', 'api-contract'],
  'bugs-perf': ['ui-runtime-bugs', 'reliability-error-handling', 'performance-efficiency'],
  'stack-specific': ['ui-runtime-bugs', 'accessibility', 'data-integrity-safety', 'security', 'infrastructure-environment'],
  deps: ['better-dependency-freedom', 'security'],
  tests: ['test-quality-coverage', 'infrastructure-environment'],
  ux: ['design-usability', 'documentation-content', 'feature-completeness'],
  structural: ['architecture-maintainability', 'code-simplification'],
  'cognitive-load': ['code-simplification'],
});

/** @deprecated Use DO_BETTER_SCOPE_COVERAGE. */
export const DO_BETTER_LENS_COVERAGE = DO_BETTER_SCOPE_COVERAGE;

/** Schedule display metadata follows the active audit domain. */
export function getAuditScheduleMetadata(taskType) {
  const canonicalType = auditDomainFor(taskType);
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
 * Each entry lists only its immediate predecessors. Urgent defects outrank
 * the advisory sequence.
 */
export const AUDIT_SUGGESTED_AFTER = Object.freeze({
  // Broad triage first, then coverage, so the tests written next are aimed at
  // the findings the triage surfaced.
  'test-quality-coverage': Object.freeze(['architecture-maintainability']),
  'code-simplification': Object.freeze(['architecture-maintainability', 'feature-completeness']),
  'infrastructure-environment': Object.freeze(['security', 'test-quality-coverage']),
  'performance-efficiency': Object.freeze(['code-simplification']),
  'documentation-content': Object.freeze(['performance-efficiency', 'design-usability']),
  'better-dependency-freedom': Object.freeze(['architecture-maintainability']),
});

// WHY each audit sits where it does in the order above — rationale only. The
// sequence itself is AUDIT_SUGGESTED_AFTER, which names real task types; this
// text must never be the only place an ordering relationship is recorded.
// Urgent bugs outrank the sequence; re-measure after each merged change.
export const AUDIT_RUN_GUIDANCE = Object.freeze({
  'test-quality-coverage': 'Target coverage and weak assertions at the behavioral risks identified during architectural review.',
  'code-simplification': 'Simplify code once ownership is understood and unfinished features have been identified.',
  'infrastructure-environment': 'Review deployment and developer workflows after code security and test behavior are understood.',
  'performance-efficiency': 'Measure the cost of the code that remains after simplification.',
  'documentation-content': 'Document the verified performance characteristics and final user workflows.',
  security: 'Head of the order — an exploitable defect is fixed before any cleanup, whatever else is queued.',
  'better-dependency-freedom': 'Unnecessary dependencies go once ownership is clear, so no effort is spent polishing code a removal deletes.',
  privacy: 'Head of the order — exposed personal data is a harm already happening, whatever cleanup is queued.',
  'feature-completeness': 'Runs before simplify sweeps unreferenced code, so an unfinished feature is decided (finish, hide, or remove) rather than silently deleted.',
});
