/**
 * Ready-made work prompts for `agent-prompt` burn jobs.
 *
 * A burn window is a use-it-or-lose-it budget, and the thing it is worst at is
 * open-ended "do something useful" work: an agent with a vague prompt spends a
 * whole window rediscovering the repo. These presets are the opposite — each is
 * ONE narrow audit dimension (the single-focus form of `/do:better --issues`)
 * that reads real code, files decision-complete GitHub issues, and changes
 * nothing. That shape suits an unattended window: the output is a queue another
 * agent can drain later, so a burn that lands at 3am needs no review to be safe.
 *
 * TEMPLATES, not references. Picking a preset COPIES its prompt into the job's
 * own `params.prompt`, which the user then edits freely. Nothing on disk points
 * back at a preset id, so editing the text here never rewrites a configured job
 * on any install and there is no migration to write — the cost is that an
 * improved prompt reaches existing jobs only when the user re-picks the preset.
 *
 * Pure module: strings only, no I/O. `routes/quotaBurn.js` serves the list in
 * the config catalog; the client's preset picker applies one to a job row.
 */

import { QUOTA_BURN_JOB_TYPE } from './quotaBurnConfig.js';

/** Params every audit preset sets, and why they differ from the job defaults. */
const AUDIT_PARAMS = Object.freeze({
  // Read-only work still gets an isolated checkout: an audit that wanders into
  // an edit must not dirty (or switch the branch of) the primary working copy
  // the user has open.
  useWorktree: true,
  // No code changes means no PR and nothing for /simplify to clean up. Leaving
  // these on makes the agent hunt for a diff to ship and end the window
  // confused.
  openPR: false,
  simplify: false,
});

/**
 * The half of every audit prompt that is about HOW to audit rather than WHAT to
 * audit. Written once so a lesson learned from one bad run (a preset that filed
 * forty nits, or one that quietly stopped at the first `gh` failure) fixes every
 * preset at once.
 */
const auditContract = ({ labels, dedupeSearch }) => `
## How to run this audit

1. **Pick a bounded slice and say so first.** Do NOT attempt the whole
   repository. Choose one coherent area (a feature directory, a route group, a
   handful of related screens) — prefer one that recent audit issues have not
   already covered — and open your report by naming the slice in one line.
2. **Read the actual code.** Every finding must cite \`path/to/file.js:LINE\` and
   describe a concrete, reproducible failure: what a user does, in what state,
   and what goes wrong. Delete any finding you cannot state that way — that
   filter is the whole point of this job.
3. **De-duplicate before filing.** Run
   \`gh issue list --state open --limit 200 --search "${dedupeSearch}"\` (and a
   plain keyword search per finding). If it is already filed, skip it; comment on
   the existing issue only when you have genuinely new evidence.
4. **File each surviving finding as its own issue.** Use
   \`gh issue create --title "..." --body-file <file> --label ...\`. Suggested
   labels: ${labels}. Run \`gh label list\` first and use only labels that exist.
   One problem per issue — never a bundle.
5. **Bodies must be decision-complete**, in this shape:
   - **Problem** — what is wrong, with file:line references.
   - **Impact** — the user-visible consequence, not the code smell.
   - **Fix** — the approach you have DECIDED on, with the files it touches. If
     the only obstacle was a design choice, make the call and state it with a
     one-line rationale. Do not file a question.
   - **Acceptance criteria** — checkboxes another agent can verify cold.
6. **Cap yourself at 5 issues.** A handful of well-evidenced, ready-to-work
   issues is worth more than a wall of nits, and a long tail of low-value issues
   costs a human real triage time. Fewer than 5 real problems? File fewer.
7. **Change no code.** No commits, no branches, no pull requests. The deliverable
   is the filed issues.
8. **Report at the end**: the slice you audited, each issue number and title, and
   anything you deliberately did not file and why.

If \`gh\` cannot reach the network (errors like "bad file descriptor" or a
connect timeout), do not give up silently — fall back to the REST API with the
token from the local keyring:
\`TOK=$(command gh auth token)\` then
\`curl -sS -H "Authorization: Bearer $TOK" -H "Accept: application/vnd.github+json" -d @body.json https://api.github.com/repos/<owner>/<repo>/issues\`.
A window spent finding real problems and filing none is a wasted window.

Read this repository's \`CLAUDE.md\` (and any nested per-directory ones covering
the slice) before you start, and honor its conventions and its explicitly
declared non-issues — a finding that contradicts a documented project decision
is noise, not a bug.`.trim();

const auditPreset = ({ id, label, summary, labels, dedupeSearch, mission }) => Object.freeze({
  id,
  label,
  summary,
  jobType: QUOTA_BURN_JOB_TYPE.AGENT_PROMPT,
  params: Object.freeze({ ...AUDIT_PARAMS, prompt: `${mission.trim()}\n\n${auditContract({ labels, dedupeSearch })}\n` }),
});

/**
 * The catalog the config page offers. Order is presentation order; ids are
 * stable because a job may record which preset seeded it for display.
 */
export const QUOTA_BURN_PROMPT_PRESETS = Object.freeze([
  auditPreset({
    id: 'ux-audit',
    label: 'UX issues',
    summary: 'Audit the UI for interaction friction and file the fixes as issues.',
    labels: '`ux`, `area:ui`, `plan`',
    dedupeSearch: 'ux audit',
    mission: `
# UX audit — file issues, change nothing

You are auditing this application's USER EXPERIENCE and filing what you find as
GitHub issues. You are not fixing anything this run.

Work from the UI code (components, pages, drawers, forms) and reason about it as
the person using it, not as the person who wrote it. Hunt specifically for:

- **Controls that do something surprising.** An icon-only button that spends
  money, deletes data, or dispatches work with no confirmation, no label, and no
  distinction from the harmless controls beside it.
- **Invisible state.** A surface that auto-saves with nothing on screen saying
  so; a mutation with no confirmation; a background job whose progress is
  guessable only from a spinner; "did that work?" moments generally.
- **Disabled with no reason.** A button greyed out where the only explanation is
  a \`title\` tooltip (invisible on touch) or nothing at all.
- **Lost work.** Navigation, tab switches, or drawer closes that discard an
  unsaved edit; forms that clear on error; optimistic updates that silently
  revert.
- **Dead ends.** Empty states that suggest no next action, errors that state a
  failure without a remedy, filters that can produce a blank screen with no way
  back.
- **Inconsistency with the rest of the app.** The same concept spelled two ways,
  a hand-rolled clone of a shared component, a flow that breaks the conventions
  the project's UI docs describe.
- **Reachability.** A view that cannot be linked to, bookmarked, or reached from
  the command palette / navigation because its selection lives in local state.

Prefer one high-traffic screen audited deeply over ten skimmed.`,
  }),

  auditPreset({
    id: 'a11y-audit',
    label: 'Accessibility issues',
    summary: 'Keyboard, screen-reader, focus, and contrast gaps in the UI.',
    labels: '`ux`, `area:ui`, `plan`',
    dedupeSearch: 'accessibility a11y',
    mission: `
# Accessibility audit — file issues, change nothing

Audit this application's UI for accessibility defects and file them as GitHub
issues. No code changes this run.

Look for the failures that actually lock someone out:

- **Click handlers with no keyboard path** — a \`div\`/\`span\`/icon with
  \`onClick\` and no \`role\`, \`tabIndex\`, or Enter/Space handling.
- **Unlabeled controls** — icon-only buttons with no \`aria-label\`, inputs whose
  label is styled text rather than a real \`<label htmlFor>\`/\`id\` pair, form
  fields whose only cue is a placeholder.
- **Focus management** — modals and drawers that do not take focus, do not
  restore it on close, or let Tab escape behind the overlay; a destructive
  confirm the keyboard reaches before the cancel.
- **State that only exists visually** — validation errors, async status, and
  live updates that never reach a screen reader (no \`aria-live\`,
  \`aria-invalid\`, \`aria-expanded\`, \`aria-busy\`).
- **Contrast and sizing** — low-contrast secondary text against the app's
  background, text below ~12px carrying real meaning, meaning conveyed by color
  alone.
- **Motion and autoplay** — animation or autoplaying media that ignores
  \`prefers-reduced-motion\`.

Verify each finding against the file rather than assuming a pattern is wrong —
many components already handle this correctly through a shared helper, and
re-filing those wastes the window.`,
  }),

  auditPreset({
    id: 'mobile-audit',
    label: 'Mobile & responsive issues',
    summary: 'Small-screen layout, touch targets, and hover-only affordances.',
    labels: '`ux`, `area:ui`, `plan`',
    dedupeSearch: 'mobile responsive',
    mission: `
# Mobile / responsive audit — file issues, change nothing

Audit this application's UI on small screens and file what breaks as GitHub
issues. No code changes this run.

Read the components' layout classes and reason about a ~375px-wide viewport:

- **Horizontal overflow** — fixed pixel widths, wide tables/grids/code blocks
  with no scroll container, a page body that scrolls sideways.
- **Touch targets** — interactive elements smaller than ~44px, or packed so
  tightly that the destructive one sits under the thumb.
- **Hover-only information** — anything whose meaning lives in a \`title\` or a
  hover tooltip, which touch users never see. Disabled-button explanations and
  icon-only controls are the usual offenders.
- **Modals, drawers, and menus** that assume desktop width instead of becoming a
  full-screen sheet, or whose scroll region is the page rather than the panel.
- **Above the fold** — the primary action of a screen pushed below a stack of
  configuration on a short viewport.
- **Breakpoint drift** — responsive utility classes referencing breakpoints the
  build does not define, so the style silently never applies.

Name the exact screens you checked; a claim about "the app" that cites no
component is not a finding.`,
  }),

  auditPreset({
    id: 'resilience-audit',
    label: 'Error & empty-state issues',
    summary: 'Failure paths: silent catches, double toasts, stale data, lost edits.',
    labels: '`bug`, `ux`, `plan`',
    dedupeSearch: 'error handling empty state',
    mission: `
# Failure-path audit — file issues, change nothing

Audit what this application does when things go WRONG, and file the gaps as
GitHub issues. No code changes this run.

The happy path is usually fine; look at the other branches:

- **Swallowed failures** — a \`.catch()\` that returns a fallback and shows the
  user nothing, so a failed save looks exactly like a successful one.
- **Doubled or missing feedback** — a request helper that toasts AND a caller
  that toasts (two toasts for one failure), or a mutation that toasts neither.
- **Absent vs. empty conflated** — a fetch that failed rendering as "you have
  none", a cache that cannot tell "not loaded" from "loaded, legitimately zero",
  a merge where a missing key clears a value the user set.
- **Stale UI after a mutation** — a list that keeps the deleted row, a detail
  view still showing pre-save values, a status that never clears on failure.
- **Unsaved-work loss** — a debounced save dropped on unmount, an edit discarded
  by a tab switch or a refetch that overwrites in-flight typing.
- **Retry and recovery** — a transient failure that latches a control off for
  the life of the page, with no way to re-arm short of a reload.

For each finding, state the failure trigger concretely (which call, failing how)
and what the user sees instead of the truth.`,
  }),

  auditPreset({
    id: 'perf-audit',
    label: 'Performance issues',
    summary: 'Hot-path waste: render storms, N+1 reads, unbounded lists, polling.',
    labels: '`bugs-perf`, `plan`',
    dedupeSearch: 'performance slow',
    mission: `
# Performance audit — file issues, change nothing

Audit this application for real performance defects and file them as GitHub
issues. No code changes this run.

Chase work that scales badly, not micro-optimizations:

- **Per-item I/O in a loop** — a request handler that reads or queries once per
  record where one batched read would do.
- **Repeated expensive scans** — the same directory walk, file parse, or
  aggregation performed twice in one request, or on every poll.
- **Unbounded growth** — lists, logs, caches, or in-memory maps with no cap;
  responses that serialize an entire collection to render a picker that needs
  two fields.
- **Render storms** — state updated on every keystroke or every socket frame
  with no debounce/batching, context values rebuilt each render, expensive
  derived values recomputed unmemoized in a hot component.
- **Timers and polling** — intervals that keep running after unmount, poll
  frequencies far tighter than the data changes, backoff-free retry loops.
- **Leaks** — subscriptions, listeners, PTYs, or GPU/media resources allocated
  without a matching teardown.

Quantify the cost where you can ("N universes ⇒ N file reads per page load") —
a finding with a magnitude is one someone can prioritize.`,
  }),

  auditPreset({
    id: 'test-gap-audit',
    label: 'Test coverage gaps',
    summary: 'Untested logic where a regression would cost data, money, or quota.',
    labels: '`tests`, `plan`',
    dedupeSearch: 'test coverage',
    mission: `
# Test-gap audit — file issues, change nothing

Find the places where this repository's tests would NOT catch a regression that
matters, and file them as GitHub issues. No code changes this run — you are
specifying the tests, not writing them.

Rank candidates by what a silent break would cost:

- **Irreversible or expensive paths first** — anything that deletes or
  overwrites user data, spends provider quota or money, writes to a shared
  store, or ships something outward.
- **Guards and gates** — a condition that exists specifically to prevent a past
  incident, with no test asserting it still holds.
- **Branchy pure logic** — normalizers, mergers, and validators whose tests only
  cover the happy shape, leaving the absent/empty/malformed cases unasserted.
- **Recently fixed bugs** — walk recent fix commits; a fix landed without a
  regression test is the highest-value gap on this list.
- **Shape-dense code** — where reviewers keep finding a new failing input,
  propose a property test over generated inputs rather than more example cases.
- **False green** — suites so heavily mocked that they would pass against a
  broken implementation, or that assert a call happened but never its arguments.

Each issue should name the file under test, the specific cases to assert, and
where the test file belongs.`,
  }),

  auditPreset({
    id: 'simplify-audit',
    label: 'Dead code & duplication',
    summary: 'Unused exports, copy-paste drift, and helpers that should be reused.',
    labels: '`code-quality`, `plan`',
    dedupeSearch: 'dead code duplication',
    mission: `
# Dead-code and duplication audit — file issues, change nothing

Find code this repository would be better without, and file the removals as
GitHub issues. No code changes this run.

- **Unreferenced code** — exports with no importer, components rendered from
  nowhere, feature flags with one branch permanently dead, config keys nothing
  reads. Verify with a repo-wide search before filing; a dynamic or
  string-keyed reference is easy to miss and a wrong removal is expensive.
- **Re-implemented helpers** — a local function that duplicates something the
  project's shared library catalogs already provide. Cite both, and propose the
  reuse.
- **Copy-paste drift** — near-identical blocks that have diverged, where one copy
  has a fix the other never got. That divergence is a latent bug; say which copy
  is correct.
- **Modules that outgrew their file** — one file holding several unrelated
  concerns, or a component whose body has swallowed logic that belongs in a
  hook or a pure helper. Propose the split, with the new file names.
- **Stale scaffolding** — commented-out blocks, TODOs whose work already
  shipped, migration or compatibility shims whose trigger can no longer occur.

Note carefully: cross-version and cross-install compatibility code is NOT dead
code, even when this install no longer hits it. Read the project's rules on
migrations and version gates before proposing any such removal.`,
  }),

  auditPreset({
    id: 'data-safety-audit',
    label: 'Data & upgrade-safety issues',
    summary: 'Migrations, schema parity, and cross-version compatibility gaps.',
    labels: '`bug`, `area:database`, `plan`',
    dedupeSearch: 'migration schema compatibility',
    mission: `
# Data and upgrade-safety audit — file issues, change nothing

Audit this repository for changes that could corrupt, lose, or strand user data
across upgrades and machines, and file them as GitHub issues. No code changes
this run.

- **Format changes without a migration** — a stored shape the code now expects
  that an older install's files or rows do not have, with nothing to convert
  them and no defensive read path.
- **Missing seeds and defaults** — a new stored artifact with no shipped
  reference copy, so a fresh install starts broken.
- **Schema parity drift** — a field added to a sanitizer, writer, or payload but
  never to the validation schema (or the reverse), so a valid record is rejected
  or an invalid one is stored.
- **Version gates** — cross-machine or cross-version payloads whose meaning
  changed without the version marker moving, letting a newer peer feed something
  an older one will mis-handle.
- **Destructive defaults** — an exclude/cleanup/reset path whose pattern is
  broader than intended, a delete that is not scoped, a write that clobbers a
  field it never read.
- **Read-modify-write races between two paths** that mutate the same record or
  file and can drop one another's changes.

State the upgrade scenario explicitly for each finding: which install, holding
what, upgrading to what, and what breaks.`,
  }),

  auditPreset({
    id: 'docs-audit',
    label: 'Docs drift',
    summary: 'Docs and onboarding steps the code no longer matches.',
    labels: '`documentation`, `plan`',
    dedupeSearch: 'docs documentation drift',
    mission: `
# Documentation-drift audit — file issues, change nothing

Find where this repository's documentation and its code disagree, and file the
corrections as GitHub issues. No code changes this run — including no doc edits.

Verify claims against the source rather than reading docs on their own:

- **Setup and run instructions** that name commands, scripts, ports, or
  environment variables the code no longer uses (or omits ones now required).
- **Architecture docs** describing a module layout, data location, or flow that
  has since moved.
- **Convention docs** stating a rule the codebase has broadly stopped following —
  say which is now correct, the rule or the code, and why.
- **Undocumented surfaces** — a feature, endpoint, config key, or failure mode a
  new contributor cannot discover from the docs at all.
- **Examples that would fail** if pasted into a terminal today.
- **Stale references** — links to files that moved, issues long closed, or
  external resources that no longer exist.

Prioritize the docs a newcomer hits first; a wrong README costs more than a
wrong deep-dive.`,
  }),

  auditPreset({
    id: 'security-audit',
    label: 'Security issues (in-threat-model)',
    summary: 'Real exposure for this deployment model — no boilerplate hardening.',
    labels: '`bug`, `plan`',
    dedupeSearch: 'security',
    mission: `
# Security audit — file issues, change nothing

Audit this repository for security defects that are REAL under its actual threat
model, and file them as GitHub issues. No code changes this run.

Read the project's documented security model FIRST and treat it as binding. If
it declares something a non-issue for this deployment (an omitted control, a
documented default, an accepted risk), do not file it — a window spent re-filing
an explicitly closed concern is worse than a window spent idle.

What is worth filing:

- **Secrets in the wrong place** — credentials, tokens, or keys that could reach
  a commit, a log line, a bundled client asset, a shared artifact, or an
  outbound request that had no business carrying them.
- **Command and path injection** — user-controlled input reaching a shell, a
  path join, or a dynamic import without validation; an allowlist that a crafted
  value can walk out of.
- **Destructive operations with too little scoping** — a delete, overwrite, or
  reset whose target is computed rather than constrained, especially where a
  test or dev path could aim it at real data.
- **Trust boundaries that are actually crossed** — data arriving from another
  machine, a third-party API, or a model response being used without validation
  where a malformed or hostile value would do damage.
- **Dependency exposure** — a known-vulnerable package on a path that actually
  processes untrusted input (not a transitive dev-only advisory).

Every finding needs a plausible attacker or accident story that ends in real
harm. "Best practice says otherwise" is not one.`,
  }),
]);

/** Look up a preset by id. Returns `null` for an unknown id — never throws. */
export function findQuotaBurnPreset(id) {
  return QUOTA_BURN_PROMPT_PRESETS.find((preset) => preset.id === id) || null;
}
