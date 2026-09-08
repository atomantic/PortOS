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
  // The six types below give every `do:better` audit lens a scheduled
  // counterpart (DO_BETTER_LENS_COVERAGE, at the bottom of this file). They
  // are refactor- or defect-hunting lanes carved out of the broader
  // code-quality / module-hygiene / test-coverage bodies so each can be
  // scheduled, pinned to a provider, and toggled between filing and fixing on
  // its own. Every one files under an existing label rather than minting a
  // near-duplicate category, and the refactor lanes require a managed
  // worktree in do-work mode: a mechanical restructuring of a hot function or
  // a dependency swap is exactly the edit that must never land in the user's
  // live checkout.
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
    description: 'Reader-cost audit — configurable: file issues (default) or implement one refactor',
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
    filing: filing({
      slugPrefix: 'test-quality-',
      label: 'test-quality-audit',
      issueLabel: 'tests',
      labelDescription: 'Proposed from a test-quality audit',
      noun: 'test-quality finding(s)',
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
  if (raw === true || raw === 'true') return true;
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

/**
 * Which scheduled audit types cover each `do:better` audit lens
 * (lib/slashdo/lib/better-audit.md, the `For \`<lens>\`:` list). The slashdo
 * command fans the same lenses out to sub-agents in one run; PortOS exposes
 * each as its own schedulable, provider-pinnable task so a managed app can run
 * every category of self-improvement on its own cadence. Keys are the lens
 * slugs slashdo uses; values are the AUDIT_DEFINITIONS types that own that
 * lens's findings, in no significant order — the relation is many-to-many both
 * ways (`security` answers three lenses; `bugs-perf` has four owners), which
 * is why this is a lens-keyed map rather than a field on each definition. A
 * per-definition field could not answer the question the map exists for: did
 * upstream add a lens that NOTHING here owns?
 *
 * It drives schedule discovery labels, never dispatch or execution ordering.
 * auditCatalog.test.js checks it two ways: every
 * listed type is a real audit type, and (when the submodule is checked out)
 * every lens slashdo declares has an entry here, so a lens added upstream
 * cannot silently go unschedulable.
 */
export const DO_BETTER_LENS_COVERAGE = Object.freeze({
  security: ['security'],
  'code-quality': ['code-quality', 'observability'],
  dry: ['simplify'],
  architecture: ['module-hygiene', 'api-contract'],
  'bugs-perf': ['better-runtime-safety', 'performance', 'error-handling', 'observability'],
  'stack-specific': ['react-lifecycle', 'accessibility', 'data-safety', 'security'],
  deps: ['better-dependency-freedom', 'security'],
  tests: ['test-coverage', 'better-test-quality'],
  ux: ['ux', 'mobile-responsive', 'copy'],
  structural: ['module-hygiene', 'better-structural-drift', 'simplify'],
  'cognitive-load': ['better-cognitive-load', 'better-complexity'],
});

/** Display metadata is derived, so upgrades never rewrite durable task IDs. */
export function getAuditScheduleMetadata(taskType) {
  if (!isAuditTaskType(taskType)) return { displayName: taskType, defaultLabels: [] };
  const lenses = Object.entries(DO_BETTER_LENS_COVERAGE)
    .filter(([, types]) => types.includes(taskType)).map(([lens]) => lens);
  return {
    displayName: taskType.startsWith('better-') ? taskType : `better-${taskType}`,
    defaultLabels: ['codebase-improvement', 'slashdo', ...lenses],
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
  // The restructuring ladder: consolidate sources of truth, delete what is
  // dead, then draw module boundaries, then reduce what survives.
  simplify: Object.freeze(['better-structural-drift']),
  'module-hygiene': Object.freeze(['simplify']),
  'better-dependency-freedom': Object.freeze(['module-hygiene']),
  'better-complexity': Object.freeze(['module-hygiene']),
  'better-cognitive-load': Object.freeze(['better-complexity']),
  // Measure and describe the shape that survived the ladder.
  performance: Object.freeze(['better-complexity']),
  documentation: Object.freeze(['performance', 'better-cognitive-load']),
});

// WHY each audit sits where it does in the order above — rationale only. The
// sequence itself is AUDIT_SUGGESTED_AFTER, which names real task types; this
// text must never be the only place an ordering relationship is recorded.
// Urgent bugs outrank the sequence; re-measure after each merged change.
export const AUDIT_RUN_GUIDANCE = Object.freeze({
  'better-test-quality': 'Assesses whether the tests you have detect the regressions the other audits found — so refactors that follow have a safety net.',
  'test-coverage': 'Adds the missing boundary coverage a refactor needs before it starts; avoid duplicating assertions a stronger test already makes.',
  security: 'Head of the order — an exploitable defect is fixed before any cleanup, whatever else is queued.',
  'data-safety': 'Head of the order — data-loss and upgrade hazards are fixed before code moves around them.',
  'better-runtime-safety': 'Head of the order — reachable runtime defects are fixed first; rerun once structure settles.',
  'error-handling': 'Head of the order — safe failure behavior is established before the same code is restructured.',
  'better-structural-drift': 'Start of the restructuring ladder: consolidating sources of truth first means every later refactor targets the surviving implementation.',
  simplify: 'Dead and duplicate code is removed before modules are reorganized, so the reorganization only moves live code.',
  'module-hygiene': 'Ownership and module boundaries are settled before function-level work, so complexity is measured on the final layout.',
  'better-dependency-freedom': 'Unnecessary dependencies go once ownership is clear, so no effort is spent polishing code a removal deletes.',
  'better-complexity': 'Remeasures the functions that survived the ladder and reduces the costliest branching.',
  'better-cognitive-load': 'Reviews names, abstraction levels, and readability of the shape everything else left behind.',
  'code-quality': 'Broad triage that points at the focused audit worth running; avoid overlapping fixes in the same slice.',
  documentation: 'Describes the final result, so it runs once behavior and structure have settled.',
  performance: 'Measure a real bottleneck before optimizing, and remeasure after structural and complexity changes.',
});
