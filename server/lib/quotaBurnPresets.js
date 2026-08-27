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
 * A contract change that must reach EXISTING jobs therefore needs a migration.
 * Two exist, and the second supersedes the first's matching rule:
 *
 * - Migration 294 (#4852, the CLAUDE.md → AGENTS.md rename) matched a stored
 *   prompt byte-for-byte against a reconstructed prior render. That rule turned
 *   out to be too strict to be useful: a job seeded two contract revisions ago
 *   matches no single reconstructed render, so 294 skipped every real job on
 *   this install as "user-edited" and they kept running a prompt that predated
 *   the dispatch-label guidance entirely — which is why a whole quota-burn
 *   backlog arrived with no `model:`/`effort:` routing on it.
 * - Migration 305 matches on the MISSION half instead (everything above
 *   `## How to run this audit`, the part that says WHAT to audit) and replaces
 *   the contract half, which is the part this file owns and revises. Copy that
 *   migration for the next contract edit rather than 294's.
 *
 * Pure module: strings only, no I/O. `routes/quotaBurn.js` serves the list in
 * the config catalog; the client's preset picker applies one to a job row.
 */

import { MANDATORY_DISPATCH_HINT_GUIDANCE } from './dispatchLabels.js';
import { QUOTA_BURN_JOB_TYPE } from './quotaBurnConfig.js';

/** Params every audit preset sets, and why they differ from the job defaults. */
const AUDIT_PARAMS = Object.freeze({
  // These jobs READ code and file issues — they never write a file, so there is
  // nothing to isolate. Running in the app's own checkout, on whatever branch it
  // is already on, is the honest shape: no branch is created, nothing is
  // merged, and no worktree is left to clean up.
  //
  // This is deliberately NOT the worktree posture. `useWorktree` + `openPR:
  // false` is the AUTO-MERGE posture — on success the agent's branch is merged
  // onto the source workspace's default branch with no PR and no review — so
  // isolating an audit "for safety" actually buys it a way to land code.
  // Isolation would only earn its keep for an audit that had to build or run
  // tests; those can still opt in via the job's `discardWorktree` checkbox.
  useWorktree: false,
  // The deliverable is what the agent DOES during the run (`gh issue create`),
  // not a commit and not the completion sentinel. This is what strips every
  // commit/push/PR instruction out of the prompt — including the one that would
  // otherwise tell a no-worktree task to `/do:push` to the branch it is
  // standing on, which here is the app's default branch.
  noCodeOutput: true,
  // Both presuppose a diff to ship. Leaving them on sends the agent hunting for
  // one at the end of a window where there is none. (The job runner forces them
  // off for a no-code job anyway — belt and braces, since a hand-edited plan
  // reaches the runner without passing through this file.)
  openPR: false,
  simplify: false,
});

/**
 * The line that splits a rendered audit prompt in two: above it the MISSION
 * (what to audit — one per preset, essentially stable), below it the CONTRACT
 * (how to audit — shared, and the half this file keeps revising).
 *
 * Exported because that split is what lets a migration tell a stale shipped
 * render apart from a prompt the user wrote over. See `upgradeStoredAuditPrompt`.
 */
export const AUDIT_CONTRACT_HEADING = '## How to run this audit';

/**
 * The half of every audit prompt that is about HOW to audit rather than WHAT to
 * audit. Written once so a lesson learned from one bad run (a preset that filed
 * forty nits, or one that quietly stopped at the first `gh` failure) fixes every
 * preset at once.
 */
const auditContract = ({ labels, dedupeSearch }) => `
${AUDIT_CONTRACT_HEADING}

Most of this window belongs to RESEARCH, not to filing. Two issues another agent
can execute cold — trigger named, fix decided, files listed — are worth more than
five it has to re-investigate from scratch. Spend roughly the first two thirds of
the window reading and tracing, and only then start filing.

1. **Pick a bounded slice and say so first.** Do NOT attempt the whole
   repository. Choose one coherent area (a feature directory, a route group, a
   handful of related screens) — prefer one that recent audit issues have not
   already covered — and open your report by naming the slice in one line.
2. **Research each candidate before you judge it.** Read the whole file, not the
   lines your search matched. Trace the value end to end: where it is set, who
   else reads it, and what each caller does when it fails. Read the tests that
   already cover it, and check \`git log -n 5 -- <file>\` for why the code is
   shaped the way it is — code that looks wrong is often load-bearing. Drop any
   candidate you cannot walk through this way; a hunch is not a finding.
3. **Prove the trigger.** Every finding must cite \`path/to/file.js:LINE\` and
   name the path that actually reaches it — which user action, route, event, or
   scheduled job, in what state — plus what goes wrong and who notices. If you
   cannot name a reachable trigger, the finding is a guess: delete it. That
   filter is the whole point of this job.
4. **Decide the fix before you file it.** Name the approach, every file it
   touches, and the tests to add or change. Where you had a real choice, say
   which option you rejected and why in one line. If the only obstacle was a
   design decision, make the call — do not file a question.
5. **De-duplicate before filing.** Run
   \`gh issue list --state open --limit 200 --search "${dedupeSearch}"\` (and a
   plain keyword search per finding). If it is already filed, skip it; comment on
   the existing issue only when you have genuinely new evidence.
6. **File each surviving finding as its own issue.** Write the body to a scratch
   file OUTSIDE the repository — \`BODY=$(mktemp)\` — then create with repeated
   \`--label\` flags:
   \`gh issue create --title "..." --body-file "$BODY" --label ...\`. Keep scratch
   files out of the working tree: you are running in the repository's OWN
   checkout, on the branch it is currently on — not a throwaway copy — so
   anything you leave behind is left in the user's working tree. Category
   labels (create each missing one immediately before applying it —
   \`gh label create <name> --color 0366D6 2>/dev/null || true\`):
   ${labels}. Then the required dispatch labels.
   ${MANDATORY_DISPATCH_HINT_GUIDANCE.split('\n').join(' ')} One problem per
   issue — never a bundle. Do not relabel an existing issue you skipped as a
   duplicate.
7. **Bodies must be decision-complete**, in this shape:
   - **Problem** — what is wrong, with file:line references.
   - **Trigger** — the path that reaches it: the action, the state, the caller.
   - **Impact** — the user-visible consequence, not the code smell.
   - **Fix** — the approach you have DECIDED on, the files it touches, the tests
     to add or change, and the alternative you rejected with a one-line
     rationale. Do not file a question.
   - **Acceptance criteria** — checkboxes another agent can verify cold.
8. **Cap yourself at 5 issues, and aim for two or three.** Depth is the
   deliverable: a handful of researched, ready-to-work issues is worth more than
   a wall of nits, and a long tail of low-value issues costs a human real triage
   time. Fewer than 5 real problems? File fewer, and spend the time you save
   going deeper on the ones you keep or widening the slice you researched.
9. **Redact before you publish.** An issue is world-readable the moment it is
   filed. Never paste a secret, credential, token, hostname, IP address, absolute
   path containing a username, or any personal record into a title or body — cite
   the location and redact the value (\`<token>\`, \`<hostname>\`, \`<user-email>\`).
   For a LIVE credential, do not file an ordinary issue at all: a public tracker
   entry naming the file and line is a world-readable map to a working secret.
   Report it in your final summary to the user, say it needs rotating, and file
   at most a location-free issue ("a committed credential needs rotating and
   purging from history — details in the run summary").
10. **Change no code.** No edits, no commits, no branches, no pull requests, and
   no \`git checkout\`/\`switch\` — you are standing in the user's live checkout of
   this repository, so an edit or a branch change is felt immediately by whoever
   is working in it. The deliverable is the filed issues, and the run must end
   with the same \`git status\` and the same branch it started on.
11. **Report at the end**: the slice you audited, what you traced and ruled out,
   each issue number and title, and anything you deliberately did not file and
   why.

If \`gh\` cannot reach the network (errors like "bad file descriptor" or a
connect timeout), do not give up silently — fall back to the REST API with the
token from the local keyring:
\`TOK=$(command gh auth token)\`, then with the JSON payload in \`BODY=$(mktemp)\`:
\`curl -sS -H "Authorization: Bearer $TOK" -H "Accept: application/vnd.github+json" -d @"$BODY" https://api.github.com/repos/<owner>/<repo>/issues\`.
A window spent finding real problems and filing none is a wasted window.

Read this repository's \`AGENTS.md\` (or \`CLAUDE.md\`, and any nested
per-directory ones covering the slice) before you start, and honor its
conventions and its explicitly declared non-issues — a finding that contradicts
a documented project decision is noise, not a bug.`.trim();

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

  auditPreset({
    id: 'api-contract-audit',
    label: 'API & route contracts',
    summary: 'Endpoint validation, status codes, query/param types, and error payloads.',
    labels: '`bug`, `area:api`, `plan`',
    dedupeSearch: 'api route contract validation status code',
    mission: `
# API contract audit — file issues, change nothing

Audit this application's API endpoints and route handlers for contract drift,
validation gaps, and error traps, and file them as GitHub issues. No code changes.

Trace client callers to server routes and schemas:

- **Unvalidated inputs** — endpoints reading \`req.body\`/\`query\`/\`params\` directly
  without a validation schema, allowing malformed types into domain logic.
- **Client/server drift** — client services sending unused fields, routes
  expecting omitted properties, or callers expecting unreturned responses.
- **Status and envelope errors** — 200 responses returning \`{ error }\`, raw 500s
  for bad client input, or bare strings instead of \`{ error: message }\`.
- **Async traps** — route handlers missing \`asyncHandler\`, where a rejected
  promise hangs the request socket.
- **Loose schemas** — validation schemas allowing unbounded strings (missing
  \`.max()\`), arbitrary keys (missing \`.strict()\`), or unvalidated enums.
- **HTTP method mismatch** — mutations on \`GET\` or non-idempotent updates.

For each finding, cite the caller and route (\`path/to/file.js:LINE\`), the
invalid shape, and the concrete failure that occurs.`,
  }),

  auditPreset({
    id: 'react-lifecycle-audit',
    label: 'React lifecycle & state',
    summary: 'Stale closures, effect cleanups, state sync, and unmount safety in UI code.',
    labels: '`bug`, `area:ui`, `plan`',
    dedupeSearch: 'react lifecycle effect cleanup state closure',
    mission: `
# React lifecycle audit — file issues, change nothing

Audit React components, custom hooks, and state lifecycles for memory leaks,
stale closures, and race conditions, and file them as GitHub issues. No code changes.

Inspect UI components and hooks:

- **Missing effect teardowns** — \`useEffect\` listeners (\`window\`/\`document\`),
  timers, sockets, or observers without cleanup functions on unmount.
- **Stale closures** — callbacks and timers capturing state/props without
  up-to-date refs or dependencies, operating on stale data.
- **Unmounted state updates** — async operations setting state after unmount
  or when superseded by a newer request.
- **Derived state anti-patterns** — mirroring props in local state synced via
  \`useEffect\`, causing visual flashes and desync instead of \`useMemo\`.
- **Render-time side-effects** — mutating refs or triggering side-effects during
  render rather than in effects/handlers.
- **Broken dependencies** — missing dependencies causing stale reads, or inline
  object literals triggering runaway render loops.

Trace the sequence of user interactions and state transitions that triggers
each defect.`,
  }),

  auditPreset({
    id: 'observability-audit',
    label: 'Logging & observability',
    summary: 'Silent failure swallowing, missing error logs, log noise, and diagnostic gaps.',
    labels: '`code-quality`, `plan`',
    dedupeSearch: 'logging observability telemetry diagnostics',
    mission: `
# Observability audit — file issues, change nothing

Audit how this application logs events, reports runtime failures, and surfaces
diagnostics, and file the gaps as GitHub issues. No code changes this run.

Trace error handling and log statements:

- **Silent failure swallowing** — \`catch\` blocks discarding errors with no
  logging or telemetry, hiding failures in production.
- **Log noise & console spam** — polling loops, socket frames, or hot render
  paths emitting lines on every tick, burying actionable errors.
- **Missing error context** — errors logged with only \`err.message\` while
  omitting task IDs, universe IDs, route paths, or stack traces.
- **Inconsistent log levels** — fatal runtime errors logged as \`console.log\`
  instead of \`console.error\` / structured error loggers.
- **Uninstrumented workflows** — multi-step background pipelines or agent
  transitions with no progress logging, leaving stuck jobs invisible.

For each finding, cite the catch block or uninstrumented workflow and explain
what operational blindspot it creates.`,
  }),

  auditPreset({
    id: 'copy-audit',
    label: 'Copy & text clarity',
    summary: 'Jargon, misleading labels, confusing error text, and missing pluralization.',
    labels: '`ux`, `plan`',
    dedupeSearch: 'copy text clarity phrasing wording',
    mission: `
# Copy clarity audit — file issues, change nothing

Audit user-facing copy, labels, tooltips, dialogs, and error messages for
clarity, accuracy, and consistency, and file them as GitHub issues. No code changes.

Review user-facing UI text:

- **Internal jargon** — technical variable names, database keys, or protocol
  details leaking into UI labels where domain terms belong.
- **Ambiguous action labels** — generic "OK"/"Submit" on destructive actions
  instead of explicit verbs ("Delete", "Discard"), or misleading "Cancel" buttons.
- **Dead-end error messages** — "Failed" or "Invalid request" without explaining
  what was wrong or how the user can resolve it.
- **Broken pluralization** — "1 items", "0 files deleted", or "found 1 results"
  missing singular/plural branching.
- **Inconsistent terminology** — the same entity or action named differently
  across tabs, dialogs, and navigation.
- **Clipped labels** — text containers with fixed widths cutting off words.

Provide the exact current string, where it appears (\`file.jsx:LINE\`), and the
proposed replacement text with rationale.`,
  }),
]);

/** Look up a preset by id. Returns `null` for an unknown id — never throws. */
export function findQuotaBurnPreset(id) {
  return QUOTA_BURN_PROMPT_PRESETS.find((preset) => preset.id === id) || null;
}

/**
 * Sentences every shipped render of the contract has carried. A stored prompt
 * missing one is not a shipped contract — it is a user's own How-to-run section,
 * and refreshing it would silently delete their instructions.
 *
 * Deliberately drawn from the OLDEST wording still in the field, not the newest:
 * a phrase this revision introduced would match nothing and make the upgrade a
 * no-op on exactly the stale jobs it exists to rescue.
 */
const SHIPPED_CONTRACT_ANCHORS = Object.freeze([
  'Pick a bounded slice and say so first',
  'gh issue create',
  'Change no code.',
  'Report at the end',
]);

/**
 * The current render for a stored audit prompt that is still a shipped preset,
 * or `null` to leave the stored text exactly as it is.
 *
 * Matching is on the MISSION half — everything above `AUDIT_CONTRACT_HEADING` —
 * rather than on the whole string. A job seeded N contract revisions ago matches
 * no reconstructed prior render byte-for-byte (that is why migration 294 skipped
 * every real job as "user-edited"), but its mission half is unchanged, because
 * revisions land in the contract. Requiring the stored contract to still carry
 * `SHIPPED_CONTRACT_ANCHORS` keeps the looser rule from overwriting a user who
 * kept a preset's mission and wrote their own procedure under it.
 *
 * Returns `null` when the prompt is already current, so a caller can count real
 * upgrades without diffing.
 */
export function upgradeStoredAuditPrompt(stored) {
  if (typeof stored !== 'string' || !stored.includes(AUDIT_CONTRACT_HEADING)) return null;
  const index = stored.indexOf(AUDIT_CONTRACT_HEADING);
  const storedMission = stored.slice(0, index);
  const storedContract = stored.slice(index);
  if (!SHIPPED_CONTRACT_ANCHORS.every((anchor) => storedContract.includes(anchor))) return null;

  for (const preset of QUOTA_BURN_PROMPT_PRESETS) {
    const current = preset.params.prompt;
    if (current.slice(0, current.indexOf(AUDIT_CONTRACT_HEADING)) !== storedMission) continue;
    return current === stored ? null : current;
  }
  return null;
}
