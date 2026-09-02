/**
 * Shared catalog of scheduled AUDIT task types — the ones that can either
 * implement a fix or just file tracker issues, matching the quota-burn
 * single-focus audit presets.
 *
 * Pure module: strings + lookups, no I/O. Quota-burn presets stay templates
 * that get COPIED into a job; this catalog is the scheduled-task counterpart
 * (toggleable at dispatch via `taskMetadata.fileIssues`).
 */

const filing = ({ slugPrefix, label, issueLabel, labelDescription, noun }) => Object.freeze({
  slugPrefix,
  label,
  issueLabel,
  labelDescription,
  planItemBody: `From the \`${label}\` audit of <slice> (<today's date>). Problem: <what is wrong, 1–2 sentences>. Impact: <runtime, data, CI/release, or recurring maintenance consequence>. Fix: <files + functions in {appName}>. Scope: <small/medium/large>.`,
  bodyRequirements: `the slice audited and the date, what is wrong with file:line references, the concrete impact (runtime, data, CI/release, or recurring maintenance), a proposed fix naming the files in {appName}, and a \`Scope:\` of small/medium/large`,
  planCommitMessage: `docs(${issueLabel}): propose <N> ${noun}`,
});

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

1. **Pick a bounded slice and say so first.** Do NOT attempt the whole repository. Choose one coherent area (a feature directory, a route group, a handful of related screens) — prefer one that recent audit issues have not already covered — and open your report by naming the slice in one line.
2. **Read the actual code.** Every finding must cite \`path/to/file.js:LINE\` and describe a concrete, reproducible impact: a reachable runtime/data failure, a CI or release failure, or recurring manual churn demonstrated by repository history. Delete subjective style preferences and any finding whose consequence you cannot prove.
3. **De-duplicate before filing.** Follow the Inventory step under "Where to record findings" above. If it is already filed, skip it; comment on the existing item only when you have genuinely new evidence.
4. **File each surviving finding as its own item.** One problem per item — never a bundle. Cap yourself at 5. Bodies must be decision-complete:
   - **Problem** — what is wrong, with file:line references.
   - **Impact** — the observable consequence (runtime, data, CI/release, or recurring maintenance), not a code-smell label.
   - **Fix** — the approach you have DECIDED on, with the files it touches. If the only obstacle was a design choice, make the call and state it. Do not file a question.
   - **Acceptance criteria** — checkboxes another agent can verify cold.
5. **Redact before you publish.** An issue is world-readable the moment it is filed. Never paste a secret, credential, token, hostname, IP address, absolute path containing a username, or any personal record into a title or body.
6. **Report at the end**: the slice you audited, each item you filed, and anything you deliberately did not file and why.

Read this repository's \`AGENTS.md\` (and any nested per-directory ones covering the slice) before you start, and honor its conventions and its explicitly declared non-issues.`;

export const DO_WORK_MODE_CONTRACT = `## Mode: implement the highest-value fix

This banner OVERRIDES any later instruction to file issues, leave source unchanged, or skip commits. Pick ONE coherent, high-value finding from the mission below and implement it this run. Do not boil the ocean.

1. **Pick a bounded slice** and say so first.
2. **Read the actual code** and the project's \`AGENTS.md\` / conventions. Honor documented non-issues.
3. **Implement the fix** — the smallest change that actually solves the concrete problem. If the only obstacle was a design choice, make the call and state it.
4. **Verify** with the project's tests (or a focused new test when the path is untested and a silent break would cost data, money, or quota).
5. **Commit** following the repo's conventions. Do not bundle unrelated cleanup.

If you find additional problems, mention them in the summary — do not expand scope. If nothing in the slice is worth changing, say so and stop without a drive-by refactor.`;

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
    defaultFileIssues: false,
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
    description: 'TypeScript-types audit — configurable: file issues or implement fixes',
    defaultFileIssues: false,
    filing: filing({
      slugPrefix: 'typing-',
      label: 'typing-audit',
      issueLabel: 'code-quality',
      labelDescription: 'Proposed from a TypeScript-types audit',
      noun: 'typing finding(s)',
    }),
  },
  'console-errors': {
    quotaBurnId: null,
    label: 'Console errors',
    description: 'Console-error audit — configurable: file issues or implement fixes',
    defaultFileIssues: false,
    filing: filing({
      slugPrefix: 'console-',
      label: 'console-error-audit',
      issueLabel: 'bug',
      labelDescription: 'Proposed from a console-error audit',
      noun: 'console-error finding(s)',
    }),
  },
  ux: {
    quotaBurnId: 'ux-audit',
    label: 'UX',
    description: 'UX/design audit — configurable: file issues (default) or implement fixes',
    defaultFileIssues: true,
    filing: filing({
      slugPrefix: 'ux-',
      label: 'UX-audit',
      issueLabel: 'ux',
      labelDescription: 'Proposed from a UX/design audit',
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
    filing: filing({
      slugPrefix: 'api-contract-',
      label: 'api-contract-audit',
      issueLabel: 'api-contract',
      labelDescription: 'Proposed from an API/route-contract audit',
      noun: 'API contract finding(s)',
    }),
  },
  'react-lifecycle': {
    quotaBurnId: 'react-lifecycle-audit',
    label: 'React lifecycle & state',
    description: 'React lifecycle audit — configurable: file issues (default) or implement fixes',
    defaultFileIssues: true,
    filing: filing({
      slugPrefix: 'react-lifecycle-',
      label: 'react-lifecycle-audit',
      issueLabel: 'react-lifecycle',
      labelDescription: 'Proposed from a React lifecycle/state audit',
      noun: 'React lifecycle finding(s)',
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
      // Reuses the existing `code-quality` label the way `simplify` does — a
      // missing log line is a maintainability defect, not its own category.
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
    filing: filing({
      slugPrefix: 'copy-',
      label: 'copy-audit',
      // User-facing wording is a UX concern, so it files under the same label
      // the UX audit uses rather than minting a near-duplicate category.
      issueLabel: 'ux',
      labelDescription: 'Proposed from a copy/text-clarity audit',
      noun: 'copy finding(s)',
    }),
  },
});

export const AUDIT_TASK_TYPES = new Set(Object.keys(AUDIT_DEFINITIONS));

/**
 * Check if a task type is an audit task registered in the catalog.
 *
 * @param {string} taskType - Task type identifier (e.g. 'security', 'code-quality')
 * @returns {boolean} True if registered in AUDIT_DEFINITIONS
 */
export function isAuditTaskType(taskType) {
  return AUDIT_TASK_TYPES.has(taskType);
}

/**
 * Get the default file-issues setting for an audit task type.
 *
 * @param {string} taskType - Task type identifier
 * @returns {boolean} True if the audit defaults to filing issues rather than fixing
 */
export function defaultFileIssuesFor(taskType) {
  return AUDIT_DEFINITIONS[taskType]?.defaultFileIssues === true;
}

/**
 * Whether do-work mode for this audit must use an isolated managed worktree.
 * The flag is catalog-owned so dispatch and schedule UI cannot drift.
 *
 * @param {string} taskType - Task type identifier
 * @returns {boolean} True when live-checkout remediation is forbidden
 */
export function auditDoWorkRequiresWorktree(taskType) {
  return AUDIT_DEFINITIONS[taskType]?.doWorkRequiresWorktree === true;
}

/**
 * Effective file-issues mode for a dispatch. An explicit `fileIssues` boolean
 * on the merged task metadata wins; otherwise the catalog default applies.
 * Accepts the `'true'`/`'false'` string forms for parity with other metadata
 * gates that round-trip through TASKS.md as text.
 *
 * @param {string} taskType - Task type identifier
 * @param {Record<string, unknown>} [metadata] - Task metadata object
 * @returns {boolean} True if this dispatch should file issues instead of making code changes
 */
export function isFileIssuesMode(taskType, metadata) {
  if (!isAuditTaskType(taskType)) return false;
  const raw = metadata?.fileIssues;
  if (raw === true || raw === 'true') return true;
  if (raw === false || raw === 'false') return false;
  return defaultFileIssuesFor(taskType);
}

/**
 * Retrieve filing preset configuration for an audit task type.
 *
 * @param {string} taskType - Task type identifier
 * @returns {object|null} Filing preset metadata (slugPrefix, label, issueLabel, planItemBody, etc.) or null
 */
export function getAuditFilingPreset(taskType) {
  return AUDIT_DEFINITIONS[taskType]?.filing || null;
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
