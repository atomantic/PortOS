// Per-app "work tracker" resolution — where a managed app's autonomous work
// items live: PLAN.md, a GitHub issue tracker, a GitLab issue tracker, or JIRA.
//
// Each managed app carries a `workTracker` field (default `'auto'`). `'auto'`
// resolves to a concrete tracker from the app's git `origin` host: a github.com
// remote → GitHub issues, a gitlab.* remote → GitLab issues, and a custom host
// known to the matching forge CLI → that forge's issues. Unknown hosts (or no
// remote) fall back to PLAN.md. JIRA is never auto-selected — it requires
// per-app JIRA config (`app.jira`) — so a user picks it deliberately.
//
// The pure mappers (hostToWorkTracker / forgeCliForTracker / trackerToClaimTaskType
// / resolveWorkTracker / hostFromOriginUrl) are side-effect-free and unit-tested.
// resolveAppWorkTracker is the async wrapper that reads the app's origin URL via
// readOriginRemoteUrl, extracts the host with hostFromOriginUrl, and checks CLI host
// maps only when the host-pattern fast path cannot identify a forge. See
// server/services/cosTaskGenerator.js for the claim-work router that consumes
// trackerToClaimTaskType.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  DISPATCH_HINT_GUIDANCE,
  JIRA_DISPATCH_HINT_GUIDANCE,
  REFERENCE_WATCH_LABEL_CONTRACT,
  REPO_STUDY_LABEL_CONTRACT,
  formatOptionalIssueLabelFlags,
} from './dispatchLabels.js';
import { getOriginInfo, readOriginRemoteUrl } from './gitRemote.js';
import { resolveSshHostAlias } from './sshHostAlias.js';
import { getAuditFilingPreset, isAuditTaskType } from './auditCatalog.js';

// Every selectable value (UI + Zod enum). `'auto'` is the default; the rest are
// concrete sources.
export const WORK_TRACKERS = ['auto', 'plan', 'github', 'gitlab', 'jira'];

// The concrete sources `'auto'` can resolve to (i.e. WORK_TRACKERS minus auto).
export const CONCRETE_WORK_TRACKERS = WORK_TRACKERS.filter(t => t !== 'auto');

export const DEFAULT_WORK_TRACKER = 'auto';

const TRACKER_LABELS = {
  auto: 'Auto (detect from git origin)',
  plan: 'PLAN.md',
  github: 'GitHub Issues',
  gitlab: 'GitLab Issues',
  jira: 'JIRA',
};

/** Human-readable label for a tracker value (falls back to the raw value). */
export function workTrackerLabel(tracker) {
  return TRACKER_LABELS[tracker] || tracker;
}

/**
 * Map a git remote host to its concrete forge work tracker, or null when the
 * host isn't a recognized forge (so the caller falls back to PLAN.md). Mirrors
 * the host classification in gitForge.detectForgeCli — covers github.com /
 * gitlab.com plus self-hosted enterprise hosts (github.*, gitlab.*).
 */
export function hostToWorkTracker(host) {
  if (!host || typeof host !== 'string') return null;
  const h = host.toLowerCase();
  if (h === 'github.com' || /(^|\.)github\./.test(h)) return 'github';
  if (h === 'gitlab.com' || /(^|\.)gitlab\./.test(h)) return 'gitlab';
  return null;
}

/**
 * True when `host` is a GitHub-family host — github.com AND self-hosted GitHub
 * Enterprise (github.*). This is the enterprise-aware replacement for the
 * github.com-only `getOriginInfo().isGithub` gate: `isGithub` drives PortOS's
 * own fork/update flow (upstream lives on github.com), so reusing it to decide
 * whether a repo's issues/PRs live on GitHub silently excluded enterprise repos.
 * Shared by prWatcher, branchReconcile, and issueReconcile so the three stay
 * consistent about what counts as "a GitHub repo".
 */
export function isGithubHost(host) {
  return hostToWorkTracker(host) === 'github';
}

/**
 * Build the host-qualified `HOST/OWNER/REPO` selector for `gh --repo` from a
 * `getOriginInfo()` result, or null when the origin isn't a usable GitHub repo
 * (no origin, unparsed owner/repo, or a non-GitHub host). The host qualifier is
 * load-bearing: a bare `OWNER/REPO` defaults `gh` to github.com, so enterprise
 * repos would be silently queried against github.com — and it stays
 * deterministic on a fork+upstream checkout where gh's cwd remote-detection
 * ambiguously resolves to the parent repo. Pairs the isGithubHost gate with the
 * selector so prWatcher, branchReconcile, and issueReconcile share one
 * definition of "a resolvable GitHub repo" instead of three hand-copied ones.
 * (No separate `hasOrigin` check: isGithubHost is true only for a real GitHub
 * host string, which getOriginInfo returns only when an origin exists.)
 *
 * Canonicalizes GitHub's SSH-over-443 alias: a `git@ssh.github.com:443/owner/repo`
 * remote parses to host `ssh.github.com`, but `gh --repo` reads the `HOST/` prefix
 * as the API host, so `ssh.github.com/owner/repo` would query the SSH endpoint and
 * silently return nothing. Only `github.com` has a documented `ssh.` alias, and an
 * enterprise host may legitimately begin with `ssh.` (`ssh.github.acme.example`),
 * so canonicalize the exact known alias rather than stripping `ssh.` from any host.
 * @param {{host?:string|null, fullName?:string|null}} origin
 * @returns {string|null}
 */
export function githubRepoSpec(origin) {
  if (!origin?.fullName || !isGithubHost(origin.host)) return null;
  return `${githubApiHost(origin.host)}/${origin.fullName}`;
}

/**
 * Canonicalize a GitHub origin host to the API host `gh --hostname` / `gh --repo`
 * expects. GitHub's SSH-over-443 alias (`git@ssh.github.com:443/owner/repo`) parses
 * to host `ssh.github.com`, but the API endpoint is `github.com` — querying
 * `ssh.github.com` as an API host silently fails. Only `github.com` has a documented
 * `ssh.` alias, so canonicalize the exact known alias and pass every other host
 * (github.com, `ssh.github.acme.example`, and other enterprise hosts) through
 * unchanged. Callers that hand a host to a `gh` `--hostname` (e.g. prWatcher's
 * `getSelfLogin`) MUST canonicalize through here, or an ssh-alias origin resolves
 * the wrong API host — the same trap `githubRepoSpec` avoids for the repo selector.
 * @param {string|null|undefined} host
 * @returns {string|null}
 */
export function githubApiHost(host) {
  if (!host) return null;
  return /^ssh\.github\.com$/i.test(host) ? 'github.com' : host;
}

/**
 * Which forge CLI a concrete tracker drives: github → `gh`, gitlab → `glab`.
 * PLAN.md and JIRA have no forge CLI, so they return null.
 */
export function forgeCliForTracker(tracker) {
  if (tracker === 'github') return 'gh';
  if (tracker === 'gitlab') return 'glab';
  return null;
}

/**
 * True when a concrete tracker records work as FILES in the repo (PLAN.md) —
 * i.e. an agent that files a proposal there necessarily dirties the worktree.
 * The forge/ticket trackers (github/gitlab/jira) take their work out-of-band via
 * `gh`/`glab`/JIRA, so a successful run can legitimately leave a clean tree.
 * Consumed by BOTH reference-watch dispatch paths — `triggerReferenceAnalysis`
 * (on-commit) and `resolveReferenceWatchBlock` (the WEEKLY scheduled task) — to
 * stamp `worktreeChangesExpected` on the spawned task off the SAME resolved
 * value that picks the prompt's {trackerInstructions} block, so the flag can't
 * drift from the instructions the agent actually got (see agentTuiSpawning.js,
 * #3102/#3140).
 * An unknown/absent tracker is treated as file-based, matching
 * formatTrackerInstructions' PLAN.md fallback.
 */
export function isFileTracker(tracker) {
  return !['github', 'gitlab', 'jira'].includes(tracker);
}

// ── {trackerInstructions} — the shared "where to file what you found" block ──
//
// A TRACKER-FILING task type reads the app read-only and delivers its findings
// as ITEMS IN THE APP'S TRACKER (PLAN.md checklist items / GitHub / GitLab
// issues / JIRA tickets) rather than as a commit. `reference-watch` was the
// first; `ux` is the second. The mechanics of "inventory existing items, record
// one per finding, finalize" are identical across them — only the PLAN.md id
// prefix, legacy forge-title marker, labels, and body requirements differ — so
// the blocks live here (next to tracker resolution) and are parameterized
// rather than copied per task type.
//
// The blocks carry {appName}/{repoPath} placeholders that each dispatch path's
// replace chain expands — every caller MUST substitute {trackerInstructions}
// FIRST so these inner placeholders are filled too (see
// referenceRepos.js#triggerReferenceAnalysis and
// cosTaskPreStepBlocks.js#buildImprovementTaskDescription).

/**
 * Per-task-type wording for `formatTrackerInstructions`. Keyed by CoS task type;
 * every key of `TRACKER_FILING_TASK_TYPES` (cosTaskGenerator.js) has an entry.
 *
 * `reference-watch` is ALSO the default option set, so a bare
 * `formatTrackerInstructions(tracker)` still returns byte-identical output to the
 * pre-generalization blocks that lived in referenceRepos.js (asserted in
 * workTracker.trackerInstructions.test.js).
 */
export const TRACKER_FILING_PRESETS = {
  'reference-watch': {
    // PLAN.md keeps its historical item ids. Forge issues use plain titles;
    // this prefix is recognized only when de-duplicating issues filed by older
    // versions of the prompt.
    slugPrefix: 'ref-watch-',
    // How the prose names this task's items ("list existing <label> issues").
    label: 'reference-watch',
    // The forge label applied to each filed issue (created if absent).
    issueLabel: 'reference-watch',
    labelDescription: 'Proposed from a reference-repo watch',
    issueLabelContract: REFERENCE_WATCH_LABEL_CONTRACT,
    // Everything after `**<Short title.>** ` in the PLAN.md checklist item.
    planItemBody: 'From `reference-watch` review of <ref name> (commit(s) `<sha>` [+ `<sha>` …], <today\'s date>). <1–2 sentences.> Fix: <files + functions in {appName}>. <Estimated scope.>',
    // What the forge issue / JIRA description body must contain.
    bodyRequirements: 'the provenance (ref + commit SHA(s) + today\'s date), the 1–2 sentence rationale, the `Fix:` line naming the {appName} files/functions to change, and the estimated scope',
    planCommitMessage: 'docs(reference-watch): propose <N> item(s) from <ref names>',
  },
  ux: {
    slugPrefix: 'ux-',
    label: 'UX-audit',
    issueLabel: 'ux',
    labelDescription: 'Proposed from a UX/design audit',
    planItemBody: 'From the `ux` audit of <route> (<today\'s date>). <What the user is trying to do and why the current design impedes it, 1–2 sentences.> Fix: <proposed change + the component file(s) in {appName}>. Scope: <small/medium/large>.',
    bodyRequirements: 'the screen/route audited and the date, what the user is trying to do there, why the current design impedes it, a concrete proposed change naming the component file(s) in {appName}, and a `Scope:` of small/medium/large',
    planCommitMessage: 'docs(ux): propose <N> UX finding(s)',
  },
  // One-shot study of a repo the user captured into the Brain (services/repoIntake.js),
  // as opposed to `reference-watch`'s recurring commit-diff review of a repo
  // configured on the app. Same clean-room contract: propose reimplementation in
  // the app's OWN code, never copy upstream source.
  'youtube-analysis': {
    slugPrefix: 'youtube-analysis-',
    label: 'youtube-analysis',
    issueLabel: 'youtube-analysis',
    labelDescription: 'Proposed from analysis of a captured YouTube transcript',
    planItemBody: 'From <video URL> (<today’s date>). <Rationale for {appName}.> Fix: <files and functions>. <Scope and validation.>',
    bodyRequirements: 'the source video URL, rationale for {appName}, inspected files/functions to change, estimated scope, and validation plan',
    planCommitMessage: 'docs: propose improvements from transcript analysis',
  },
  'repo-study': {
    slugPrefix: 'repo-study-',
    label: 'repo-study',
    issueLabel: 'repo-study',
    labelDescription: 'Proposed from a study of a captured reference repository',
    issueLabelContract: REPO_STUDY_LABEL_CONTRACT,
    planItemBody: 'From the `repo-study` of <owner/repo> (<today\'s date>). <What the upstream does and why it is worth having, 1–2 sentences.> Fix: <files + functions in {appName}>. <Estimated scope.>',
    bodyRequirements: 'the provenance (the studied repo\'s owner/repo + its license + today\'s date), the 1–2 sentence rationale for {appName}, the `Fix:` line naming the {appName} files/functions to change, and the estimated scope',
    planCommitMessage: 'docs(repo-study): propose <N> item(s) from <owner/repo>',
  },
  // The planning-only sibling of `feature-ideas`: brainstorms ONE feature and
  // files its decision-complete plan as a tracker item instead of implementing
  // anything. The claim flows (`claim-issue` / `plan-task` / `/claim`) pick the
  // filed plan up later — that is why every recorded item carries the `plan`
  // label alongside the category one.
  'plan-feature': {
    slugPrefix: 'plan-feature-',
    label: 'plan-feature',
    issueLabel: 'plan-feature',
    labelDescription: 'Feature plan filed by the plan-feature brainstorm',
    planItemBody: 'From the `plan-feature` brainstorm (<today\'s date>). <What the feature is and which user need or goal it serves, 1–2 sentences.> Approach: <the decided approach and the {appName} files/components it would touch>. Scope: <small/medium/large>.',
    bodyRequirements: 'the motivation (which PRD.md requirement or success criterion, GOALS.md priority, or repository-documented user need this serves), the decided approach naming the {appName} files/components it would touch, an estimated scope, acceptance criteria another agent can verify cold, and any explicit non-goals',
    planCommitMessage: 'docs(plan-feature): file <N> feature plan(s)',
  },
};

/**
 * The CoS task types that file their findings into the app's work tracker.
 * DERIVED from the preset table so the gate and the wording can never drift: a
 * type in the gate with no preset would silently render reference-watch's slug
 * and label into a different task's prompt.
 */
export const TRACKER_FILING_TASK_TYPES = new Set(Object.keys(TRACKER_FILING_PRESETS));

/**
 * Category labels that are not the primary `issueLabel`. Dedupes empties and
 * a metric that already equals the category (`ux` + slug `ux-`).
 */
export function extraIssueLabels(issueLabel, extraLabels = []) {
  if (!Array.isArray(extraLabels)) return [];
  return extraLabels.filter((name) => typeof name === 'string' && name.trim() && name !== issueLabel);
}

/**
 * Repeated `--label` flags for the category, any metric extras, and `plan`.
 * Shared by the gh/glab copy-pasteable `issue create` examples.
 */
export function formatForgeCategoryLabelFlags(issueLabel, extraLabels = []) {
  return [issueLabel, ...extraIssueLabels(issueLabel, extraLabels), 'plan']
    .map((name) => `--label ${name}`)
    .join(' ');
}

function metricLabelNoun(count) {
  return `metric label${count > 1 ? 's' : ''}`;
}

/**
 * Pick the {trackerInstructions} block for a resolved work tracker, falling back
 * to the PLAN.md block for an unknown/missing tracker (matching `isFileTracker`,
 * so the block a caller renders and the `worktreeChangesExpected` flag it stamps
 * always agree). Exported for tests.
 *
 * @param {string} tracker resolved tracker ('plan' | 'github' | 'gitlab' | 'jira')
 * @param {object} [options] wording overrides — see TRACKER_FILING_PRESETS
 */
export function formatTrackerInstructions(tracker, options = {}) {
  const referenceWatchPreset = TRACKER_FILING_PRESETS['reference-watch'];
  const {
    slugPrefix, label, issueLabel, labelDescription,
    extraLabels = [],
    planItemBody, bodyRequirements, planCommitMessage,
  } = { ...referenceWatchPreset, ...options };
  // The reference-watch preset is the backwards-compatible default, but its
  // preset-specific scope contract stays separate from the dispatch labels now
  // required for every forge filing preset.
  const issueLabelContract = options.issueLabelContract
    || (slugPrefix === referenceWatchPreset.slugPrefix ? REFERENCE_WATCH_LABEL_CONTRACT : null);
  const dispatchLabelCreateWording = 'Then create each required dispatch-hint label immediately before applying it.';
  const jiraDispatchLabelWording = issueLabelContract
    ? `plus the required equivalent dispatch-hint labels ${issueLabelContract.jiraFlags}:`
    : 'plus equivalent dispatch-hint labels when justified:';
  // Rendered from the shared slot list rather than a literal, so a new label axis
  // reaches this copy-pasteable example without re-patching it here — and rendered
  // twice from the one contract, because GitLab spells every prefixed label with
  // its scoped `::` separator and so cannot reuse the gh line.
  const requiredForgeFlags = issueLabelContract?.forgeFlags || '--label model:<tier> --label effort:<level>';
  const forgeLabelFlags = formatOptionalIssueLabelFlags(requiredForgeFlags);
  const forgeLabelFlagsGlab = formatOptionalIssueLabelFlags(requiredForgeFlags, { cli: 'glab' });
  const dispatchGuidance = issueLabelContract?.dispatchGuidance || DISPATCH_HINT_GUIDANCE;
  const jiraDispatchGuidance = issueLabelContract?.jiraDispatchGuidance || JIRA_DISPATCH_HINT_GUIDANCE;
  const jiraLabelContract = issueLabelContract
    ? `\n  ${issueLabelContract.instructions.split('\n').join('\n  ')}\n  For JIRA, use the equivalent labels ${issueLabelContract.jiraFlags}.`
    : '';
  const forgeLabelContract = issueLabelContract
    ? `\n  3. ${issueLabelContract.instructions.split('\n').join('\n     ')}`
    : '';
  const forgeFileStep = issueLabelContract ? '4.' : '3.';
  // Existing issues may still carry the old bracketed title tag. It is a
  // read-only compatibility hint for de-duplication, never a new issue id.
  const legacyTitleTag = `[${slugPrefix}…]`;
  const metricExtras = extraIssueLabels(issueLabel, extraLabels);
  const forgeCategoryFlags = formatForgeCategoryLabelFlags(issueLabel, extraLabels);
  const extraCreateClause = (render) => {
    if (!metricExtras.length) return '';
    return `, then the ${metricLabelNoun(metricExtras.length)} (${metricExtras.map(render).join(', then ')})`;
  };
  const extraCreateClauseGh = extraCreateClause(
    (name) => `\`gh label create ${name} --color 0366D6 --description "${labelDescription}" 2>/dev/null || true\``
  );
  const extraCreateClauseGlab = extraCreateClause(
    (name) => `\`glab label create --name ${name} --color "#0366D6" --description "${labelDescription}" 2>/dev/null || true\``
  );
  const extraJiraLabels = metricExtras.length
    ? ` and the ${metricLabelNoun(metricExtras.length)} ${metricExtras.map((name) => `\`${name}\``).join(', ')}`
    : '';

  const blocks = {
    plan: `This app records autonomous work in **PLAN.md** at the repo root ({repoPath}).

- **Inventory:** Read PLAN.md from {repoPath}. Every existing checkbox carries a \`[<slug>]\` ID — collect the \`[${slugPrefix}…]\` ones so you don't duplicate. If PLAN.md does not exist, create it with a single top-level heading (\`# {appName} — Development Plan\`) and a \`## Next Up\` section before appending.
- **Record** each proposal as a slug-tagged checklist item appended to the \`## Next Up\` section:
  \`\`\`markdown
  - [ ] [<slug>] **<Short title.>** ${planItemBody}
  \`\`\`
  Place **Maybe — needs human call** items in a \`### Trigger-gated (waiting for a precondition)\` subsection if one exists; otherwise append them under \`## Next Up\`.
- **Finalize:** Commit the PLAN.md edit with message \`${planCommitMessage}\`. Do NOT create branches or PRs — \`/claim\` (or the \`plan-task\` agent) picks the slugs up later.`,

    github: `This app tracks autonomous work in **GitHub Issues** (via the \`gh\` CLI), NOT PLAN.md — do NOT edit PLAN.md.

- **Inventory:** From {repoPath}, resolve the repo (\`gh repo view --json nameWithOwner -q .nameWithOwner\`) and read the open-issue inventory: \`gh issue list --state open --limit 500 --json number,title,body,labels --jq '.'\`. De-duplicate by matching file path/symbol or an equivalent title across the inventory, regardless of labels. Recognize a prior \`${legacyTitleTag}\` title tag as a legacy marker only. If \`gh\` is not authenticated or the remote is not GitHub, exit cleanly.
- **Record** each NEW proposal as a GitHub issue with a short, human-readable title. The issue number is its ID: do not add an id, slug, category, or severity prefix to the title. Do not relabel or edit an existing issue you skipped as a duplicate.
  1. Immediately before the first issue that uses each missing label, create it idempotently and preserve any existing label: \`gh label create ${issueLabel} --color 0366D6 --description "${labelDescription}" 2>/dev/null || true\`${extraCreateClauseGh}; create \`plan\` the same way with color \`428BCA\` and description \`Tracked by /do:replan\`. Do not use \`--force\`.
  2. ${dispatchGuidance.split('\n').join('\n     ')}
${forgeLabelContract}
  ${forgeFileStep} File with repeated \`--label\` flags so the category/scope labels stay intact. Put a multiline or shell-special body in a temporary file, capture the URL printed by \`gh issue create\`, and derive the number from that URL — do not request JSON output from issue creation:
  \`\`\`bash
  TITLE="<short human-readable title>"
  BODY_FILE="$(mktemp)"
  trap 'rm -f "$BODY_FILE"' EXIT
  cat >"$BODY_FILE" <<'EOF'
  <problem, impact, decided fix, and acceptance criteria>
  EOF
  URL="$(gh issue create --title "$TITLE" ${forgeCategoryFlags} ${forgeLabelFlags} --body-file "$BODY_FILE")"
  NUM="\${URL##*/}"
  printf '%s -> #%s\\n' "$TITLE" "$NUM"
  \`\`\`
  The body must contain ${bodyRequirements}. For **Maybe — needs human call** items, also add \`--label needs-decision\` (create it the same way if absent) and end the body with \`**Decision needed:** <one sentence>.\`.
- **Finalize:** No source-code edits, no PLAN.md, no branches, no PRs — the issues ARE the deliverable. Report created and reused issue numbers. \`/claim --issues\` (the \`claim-issue\` flow) picks them up later.`,

    gitlab: `This app tracks autonomous work in **GitLab Issues** (via the \`glab\` CLI), NOT PLAN.md — do NOT edit PLAN.md.

- **Inventory:** From {repoPath}, confirm the forge (\`glab repo view\`) and read the open-issue inventory: \`glab issue list --state opened --per-page 100 -F json\`. De-duplicate by matching file path/symbol or an equivalent title across the inventory, regardless of labels. Recognize a prior \`${legacyTitleTag}\` title tag as a legacy marker only. If \`glab\` is not authenticated or the remote is not GitLab, exit cleanly.
- **Record** each NEW proposal as a GitLab issue with a short, human-readable title. The issue number is its ID: do not add an id, slug, category, or severity prefix to the title. Do not relabel or edit an existing issue you skipped as a duplicate.
  1. Immediately before the first issue that uses each missing label, create it idempotently and preserve any existing label: \`glab label create --name ${issueLabel} --color "#0366D6" --description "${labelDescription}" 2>/dev/null || true\`${extraCreateClauseGlab}; create \`plan\` the same way with color \`#428BCA\`. ${dispatchLabelCreateWording} (glab needs \`--name\` and \`#<hex>\`).
  2. ${dispatchGuidance.split('\n').join('\n     ')}
${forgeLabelContract}
  ${forgeFileStep} File with repeated \`--label\` flags so the category/scope labels stay intact. For a multiline description, write the body to a temporary file and pass its contents as one quoted argument:
  \`\`\`bash
  TITLE="<short human-readable title>"
  BODY_FILE="$(mktemp)"
  trap 'rm -f "$BODY_FILE"' EXIT
  cat >"$BODY_FILE" <<'EOF'
  <problem, impact, decided fix, and acceptance criteria>
  EOF
  URL="$(glab issue create --title "$TITLE" ${forgeCategoryFlags} ${forgeLabelFlagsGlab} --description "$(cat "$BODY_FILE")")"
  NUM="\${URL##*/}"
  printf '%s -> #%s\\n' "$TITLE" "$NUM"
  \`\`\`
  (Run \`glab issue create --help\` if a flag is rejected — glab's flags evolve.) The body must contain ${bodyRequirements}. For **Maybe — needs human call** items, also add \`--label needs-decision\` and end the body with \`**Decision needed:** <one sentence>.\`.
- **Finalize:** No source-code edits, no PLAN.md, no branches, no MRs — the issues ARE the deliverable. Report created and reused issue numbers. \`/claim --issues\` (the \`claim-issue-gitlab\` flow) picks them up later.`,

    jira: `This app tracks autonomous work in **JIRA**. Create one JIRA issue per proposal in the app's configured project using whatever JIRA CLI/REST this environment provides. **If no JIRA credentials are available, fall back to recording proposals in PLAN.md at {repoPath} (slug-tagged \`- [ ] [<slug>] …\` checklist items under \`## Next Up\`, committed) and say so in your final summary.**

- **Inventory:** Search open JIRA issues in the configured project by file path/symbol or equivalent title, regardless of labels. Recognize a prior \`${legacyTitleTag}\` summary tag as a legacy marker only; collect the issue keys/numbers, not invented slugs.
- **Record** each NEW proposal as a JIRA issue with a short, human-readable summary. The JIRA key is its ID: do not add an id, slug, category, or severity prefix. Do not relabel a ticket you skipped as a duplicate. The description must contain ${bodyRequirements}. Apply the category label \`${issueLabel}\`${extraJiraLabels} ${jiraDispatchLabelWording}
  ${jiraDispatchGuidance.split('\n').join('\n  ')}
${jiraLabelContract}
  For **Maybe — needs human call** items, end the description with \`**Decision needed:** <one sentence>.\`.
- **Finalize:** No source-code edits, no branches, no PRs — the tickets (or the committed PLAN.md fallback) ARE the deliverable. The \`claim-issue-jira\` flow picks them up later.`,
  };

  return blocks[tracker] || blocks.plan;
}

/**
 * Resolve the {trackerInstructions} block naming where a tracker-filing task
 * records what it found, plus the two metadata signals derived from the SAME
 * resolved tracker so they can never disagree with the instructions the agent
 * actually got (#3140, #3102):
 *   - `workTracker` — traceability, and the marker that lets a ONE-OFF
 *     tracker-filing run reach `declaresNoCommitCriterion` without masquerading
 *     as a scheduled task type (see taskTypeHooks.js#isTrackerFilingDispatch)
 *   - `worktreeChangesExpected` — the PLAN.md path commits checklist items
 *     (dirty tree); the github/gitlab/jira paths file issues/tickets out of band
 *     and legitimately leave the tree CLEAN.
 *
 * A TRACKER-FILING type reads the app read-only and delivers its findings as
 * items in the app's tracker rather than as a commit. The set is derived from
 * `TRACKER_FILING_PRESETS`, so a type is gated in exactly when it has wording.
 *
 * Returns `{ trackerInstructions: '', workTracker: null }` for every other type.
 *
 * Lives here rather than in one of its callers because all three tracker-filing
 * dispatch paths need the identical four-part resolution: the SCHEDULED types
 * (cosTaskGenerator.js), the on-commit reference-watch trigger
 * (referenceRepos.js), and the one-off `repo-study` (repoIntake.js).
 */
export async function resolveTrackerFilingBlock(app, taskType, options = {}) {
  const { fileIssues = false, ...wordingOverrides } = options;
  // Always-filing types (reference-watch, repo-study) keep filing unless they
  // are ALSO an audit type that opted into do-work (`fileIssues === false`).
  // Audit types (security, ux, data-safety, …) file only when fileIssues is on.
  const alwaysPreset = TRACKER_FILING_PRESETS[taskType];
  const auditPreset = getAuditFilingPreset(taskType);
  const shouldFile = isAuditTaskType(taskType) ? fileIssues === true : Boolean(alwaysPreset);
  const preset = alwaysPreset || auditPreset;
  if (!shouldFile || !preset) return { trackerInstructions: '', workTracker: null };
  // Never throws — degrades to the PLAN.md block, which `isFileTracker` then
  // agrees with, so the flag and the instructions stay consistent.
  const workTracker = await resolveAppWorkTracker(app).catch(() => ({ resolved: 'plan' }));
  return {
    trackerInstructions: formatTrackerInstructions(workTracker.resolved, {
      ...preset,
      ...wordingOverrides,
    }),
    workTracker: workTracker.resolved,
    worktreeChangesExpected: isFileTracker(workTracker.resolved),
  };
}

/**
 * The CoS claim task type that ships work from a concrete tracker. The
 * claim-work router (cosTaskGenerator) delegates to one of these prompt bodies
 * after resolving the app's tracker:
 *   plan   → plan-task            (PLAN.md flow)
 *   github → claim-issue          (gh issue flow)
 *   gitlab → claim-issue-gitlab   (glab issue flow)
 *   jira   → claim-issue-jira     (JIRA sprint-ticket flow)
 * Returns null for an unknown tracker.
 *
 * Note: 'jira' routes to the per-ticket `claim-issue-jira` flow (claim ONE ready
 * sprint ticket, ship it, move it To Do → In Progress → In Review), NOT the
 * broader `jira-sprint-manager` triage job — that remains a separate standalone
 * scheduled task.
 */
export function trackerToClaimTaskType(tracker) {
  switch (tracker) {
    case 'plan': return 'plan-task';
    case 'github': return 'claim-issue';
    case 'gitlab': return 'claim-issue-gitlab';
    case 'jira': return 'claim-issue-jira';
    default: return null;
  }
}

/**
 * Pure resolution: given a configured `workTracker` value (possibly `'auto'`,
 * undefined, or junk) and a known origin `host`, produce the concrete tracker.
 *
 * Returns `{ configured, resolved, source }`:
 *   - configured: the normalized stored value ('auto' for absent/invalid)
 *   - resolved:   the concrete tracker ('plan' | 'github' | 'gitlab' | 'jira')
 *   - source:     'configured' (explicit choice), 'origin' (auto → host), or
 *                 'fallback' (auto with no recognizable forge host → PLAN.md)
 */
export function resolveWorkTracker({ configured, host } = {}) {
  const value = CONCRETE_WORK_TRACKERS.includes(configured) ? configured : 'auto';
  if (value !== 'auto') {
    return { configured: value, resolved: value, source: 'configured' };
  }
  const fromHost = hostToWorkTracker(host);
  if (fromHost) return { configured: 'auto', resolved: fromHost, source: 'origin' };
  return { configured: 'auto', resolved: 'plan', source: 'fallback' };
}

/**
 * Read a CLI YAML config without exposing its contents or failing resolution
 * when the file is missing, malformed, or unreadable.
 * @param {string} configPath
 * @returns {Promise<{found:boolean, config:object|null}>}
 */
async function readForgeCliConfig(configPath) {
  let contents;
  try {
    contents = await readFile(configPath, 'utf8');
  } catch (error) {
    return { found: error?.code !== 'ENOENT', config: null };
  }

  try {
    const yaml = await import('js-yaml');
    const parseYaml = yaml.load || yaml.default?.load;
    const parsed = parseYaml(contents);
    return {
      found: true,
      config: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null,
    };
  } catch {
    return { found: true, config: null };
  }
}

function configHasHost(config, host, hostMapKey = null) {
  const hosts = hostMapKey ? config?.[hostMapKey] : config?.hosts || config;
  if (!hosts || typeof hosts !== 'object' || Array.isArray(hosts)) return false;
  const normalizedHost = host.toLowerCase();
  return Object.entries(hosts).some(([configuredHost, settings]) => (
    configuredHost.toLowerCase() === normalizedHost
      && settings
      && typeof settings === 'object'
      && !Array.isArray(settings)
  ));
}

function glabConfigPaths() {
  if (process.env.GLAB_CONFIG_DIR) {
    return [path.join(process.env.GLAB_CONFIG_DIR, 'config.yml')];
  }

  const home = homedir();
  const directories = [path.join(home, '.config', 'glab-cli')];
  if (process.env.XDG_CONFIG_HOME) {
    directories.push(path.join(process.env.XDG_CONFIG_HOME, 'glab-cli'));
  } else if (process.platform === 'darwin') {
    directories.push(path.join(home, 'Library', 'Application Support', 'glab-cli'));
  } else if (process.platform === 'win32') {
    directories.push(path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'glab-cli'));
  }
  const systemConfigDirs = process.env.XDG_CONFIG_DIRS || '/etc/xdg';
  directories.push(...systemConfigDirs.split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, 'glab-cli')));
  return [...new Set(directories.map((dir) => path.join(dir, 'config.yml')))];
}

/**
 * Detect a custom forge host from the CLI host maps without launching a CLI.
 * The config values can contain credentials; only host keys are inspected.
 * @param {string|null} host
 * @returns {Promise<'github'|'gitlab'|null>}
 */
async function hostKnownToForgeCli(host) {
  if (!host) return null;
  let defaultGhConfigDir = path.join(homedir(), '.config', 'gh');
  if (process.env.XDG_CONFIG_HOME) {
    defaultGhConfigDir = path.join(process.env.XDG_CONFIG_HOME, 'gh');
  } else if (process.platform === 'win32' && process.env.APPDATA) {
    defaultGhConfigDir = path.join(process.env.APPDATA, 'GitHub CLI');
  }
  const ghConfigDir = process.env.GH_CONFIG_DIR
    || defaultGhConfigDir;
  const ghConfig = await readForgeCliConfig(path.join(ghConfigDir, 'hosts.yml'));
  if (configHasHost(ghConfig.config, host)) return 'github';

  for (const configPath of glabConfigPaths()) {
    const glabConfig = await readForgeCliConfig(configPath);
    if (!glabConfig.found) continue;
    return configHasHost(glabConfig.config, host, 'hosts') ? 'gitlab' : null;
  }
  return null;
}

/**
 * Extract just the host from a git origin URL — only the host is needed to
 * classify the forge, so this handles EVERY remote form in one pass rather than
 * chaining structure-validating owner/repo parsers (which variously reject
 * GitLab subgroup paths, `ssh://` scheme + subgroups, or ports). Returns null
 * for unparseable input. Handles:
 *   - scheme URLs: `https://`, `ssh://`, `git://` … with optional `user[:pw]@`
 *     and `:port`, and ANY path depth (so GitLab `group/subgroup/repo` works)
 *   - scp-style: `[user@]host:path`
 *
 * Embedded credentials are dropped inherently — the `user[:token]@` segment is
 * matched and discarded, never returned — so a PAT in an https remote can't
 * leak through `GET /api/apps/:id/work-tracker`. Ports are stripped too.
 *
 * A personal SSH `Host` alias is resolved to the host it connects to, so a repo
 * cloned as `git@github-acme:acme/widget.git` classifies as GitHub rather than
 * silently falling back to PLAN.md. See lib/sshHostAlias.js.
 */
export function hostFromOriginUrl(url) {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  // scheme://[userinfo@]host[:port]/...  — host is the run up to the next / : @
  // ssh config applies to SSH connections only: an `https://` remote whose host
  // collides with an ssh alias keeps its literal host, so only `ssh://` URLs
  // resolve aliases here. Otherwise downstream `gh --repo` + token overlay
  // target the wrong API host.
  const scheme = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(?:[^/@]+@)?([^/:]+)/);
  if (scheme) return (scheme[1].toLowerCase() === 'ssh' ? resolveSshHostAlias(scheme[2]) : scheme[2]) || null;
  // scp-style [user@]host:path
  const scp = trimmed.match(/^(?:[^@/]+@)?([^/:]+):/);
  if (scp) return resolveSshHostAlias(scp[1]) || null;
  return null;
}

/**
 * Resolve a managed app's effective work tracker, reading its git origin host
 * when needed. Returns `{ configured, resolved, host, forge, source }` where
 * `forge` is the CLI ('gh' | 'glab' | null) for the resolved tracker.
 * `source` is `cli-config` when an existing CLI host entry identifies a custom host.
 * Never throws — missing repo/origin data, config errors, and unknown hosts
 * degrade to PLAN.md.
 */
export async function resolveAppWorkTracker(app) {
  const configured = app?.workTracker;
  let host = null;
  if (app?.repoPath) {
    const url = await readOriginRemoteUrl(app.repoPath).catch(() => null);
    host = hostFromOriginUrl(url);
  }
  const base = resolveWorkTracker({ configured, host });
  if (base.source === 'fallback' && host) {
    const fromForgeCli = await hostKnownToForgeCli(host);
    if (fromForgeCli) {
      return {
        ...base,
        resolved: fromForgeCli,
        source: 'cli-config',
        host,
        forge: forgeCliForTracker(fromForgeCli),
      };
    }
  }
  return { ...base, host, forge: forgeCliForTracker(base.resolved) };
}

/**
 * Best-effort `group[/subgroup...]/project` display path from a GitLab origin
 * URL. Cosmetic only — `glab` targets the project from the repo cwd, not this
 * string — so callers degrade to the host classifier's fullName or the raw host
 * rather than treating a null as "not a GitLab repo". Module-private: the only
 * consumer is `resolveRepoForgeTarget` below, and this module's exports are
 * re-exported flat from the `server/lib` barrel.
 * @param {string|null|undefined} originUrl
 * @returns {string|null}
 */
function gitlabProjectPath(originUrl) {
  if (typeof originUrl !== 'string') return null;
  // scheme://[user@]host[:port]/<path>  OR  [user@]host:<path>  — capture <path>,
  // then strip a trailing `.git`.
  const m = originUrl.trim().match(/^[a-zA-Z][\w+.-]*:\/\/(?:[^/@]+@)?[^/]+\/(.+)$/)
    || originUrl.trim().match(/^(?:[^@/]+@)?[^/:]+:(.+)$/);
  return m ? m[1].replace(/\.git$/i, '').replace(/\/$/, '') : null;
}

/**
 * Resolve which forge a repo checkout's `origin` points at, together with
 * everything a `gh`/`glab` caller needs to target it — or null when the origin
 * isn't a forge PortOS can query (no remote, or a host that is neither
 * GitHub- nor GitLab-family AND no `preferredForge` override applies — see
 * below).
 *
 * The two branches deliberately differ, mirroring how the CLIs address a repo:
 * - GitHub (incl. Enterprise) resolves through `githubRepoSpec`, whose
 *   host-qualified `HOST/OWNER/REPO` selector keeps `gh --repo` deterministic on
 *   a fork+upstream checkout and correct on enterprise hosts.
 * - GitLab is classified straight off the HOST via the subgroup-safe
 *   `hostFromOriginUrl`, NOT `getOriginInfo().fullName`: the latter's strict
 *   `owner/repo` parse returns null for a nested `group/subgroup/project`
 *   remote (the common GitLab layout), which would silently read as "not a
 *   forge" even though `glab` resolves the project from its cwd regardless.
 *   `repoSpec` is therefore null for GitLab — the caller must run `glab` in
 *   `repoPath`.
 *
 * `preferredForge` ('github' | 'gitlab' | null) is the concrete tracker result
 * supplied by `resolveAppForgeTarget`: it comes from an explicit app setting or
 * from a CLI host config entry for an otherwise-unmatched host, never directly from 'auto'.
 * It's a fallback, tried only once both host-pattern checks above have failed:
 * a self-hosted GitHub Enterprise Server or GitLab instance can run on ANY
 * domain the operator picked (`git.mycompany.com`,
 * `scm.mycompany.com`, …) — there is no hostname heuristic that can tell such a
 * host apart from a non-forge remote, so the app setting or CLI host config is
 * the only signal left. A genuinely wrong preference (e.g. a bitbucket.org origin pinned to 'github')
 * still degrades gracefully: the resulting `gh`/`glab` call fails and the
 * caller reports a transient "couldn't reach" error rather than PortOS lying
 * upfront that the origin "isn't GitHub or GitLab".
 *
 * Never throws: a missing repo / unreadable origin degrades to null.
 * @param {string} repoPath
 * @param {{preferredForge?: 'github'|'gitlab'|null}} [options]
 * @returns {Promise<{forge:'github'|'gitlab', fullName:string, repoSpec:string|null, apiHost:string|null}|null>}
 */
export async function resolveRepoForgeTarget(repoPath, { preferredForge = null } = {}) {
  if (!repoPath) return null;
  const origin = await getOriginInfo(repoPath).catch(() => null);
  const githubSpec = githubRepoSpec(origin);
  if (githubSpec) {
    return {
      forge: 'github',
      fullName: origin.fullName,
      repoSpec: githubSpec,
      apiHost: githubApiHost(origin.host),
      webHost: githubApiHost(origin.host),
    };
  }
  // Reuse the URL `getOriginInfo` already read rather than spawning a second
  // `git remote get-url`. Its copy is credential-redacted (`://user:tok@` →
  // `://***@`), which both consumers below tolerate — each matches the userinfo
  // segment and discards it before reading the host / path.
  const originUrl = origin?.originUrl || null;
  const host = origin?.host || hostFromOriginUrl(originUrl);
  if (hostToWorkTracker(host) === 'gitlab' || (preferredForge === 'gitlab' && host)) {
    return {
      forge: 'gitlab',
      fullName: origin?.fullName || gitlabProjectPath(originUrl) || host,
      repoSpec: null,
      apiHost: null,
      webHost: host,
    };
  }
  if (preferredForge === 'github' && origin?.fullName && host) {
    return {
      forge: 'github',
      fullName: origin.fullName,
      repoSpec: `${host}/${origin.fullName}`,
      apiHost: githubApiHost(host),
      webHost: githubApiHost(host),
    };
  }
  return null;
}

/**
 * The browsable issue-tracker base URL for a resolved forge target — append
 * `/<number>` for one issue. GitLab nests its tracker under `/-/`; the
 * GitHub family serves it directly off the project path (and redirects a pull
 * request's number there, so one base covers both kinds of reference).
 *
 * This is where the forge-shape knowledge STOPS: a caller stamps the finished
 * base onto its record, so nothing downstream — least of all the browser — has
 * to classify a hostname or know that GitLab spells the path differently. That
 * matters because hostname classification is not authoritative: a self-hosted
 * forge on a neutral domain is resolved only by the user's own `workTracker`
 * pin, which `resolveAppForgeTarget` has already applied by the time a target
 * reaches here.
 *
 * Null when the target can't name a project: `resolveRepoForgeTarget` falls
 * `fullName` back to the bare host for an unparseable GitLab remote, which
 * would otherwise compose `https://host/host/-/issues`.
 *
 * @param {{forge:string, fullName:string|null, webHost:string|null}|null} target
 * @returns {string|null}
 */
export function repoIssueUrlBase(target) {
  if (!target?.webHost || !target.fullName || target.fullName === target.webHost) return null;
  return `https://${target.webHost}/${target.fullName}/${target.forge === 'gitlab' ? '-/issues' : 'issues'}`;
}

/**
 * Composed `resolveAppWorkTracker` + `resolveRepoForgeTarget` for callers that
 * hold the managed-app record (not just a bare `repoPath`): resolve the app's
 * work tracker, then resolve its forge target with that concrete tracker supplied
 * as the `preferredForge`. The tracker may come from a hostname match or from
 * an existing CLI config entry for a custom host.
 *
 * This composition exists so a feature can't accidentally drop the pin. Threading
 * it by hand is what left the issue-reconcile scan blind to a self-hosted forge
 * whose hostname doesn't spell out "github."/"gitlab." while the app's Issues tab
 * listed it fine (issue #3767) — the pin only matters for exactly those hosts, so
 * a missing one fails silently on every ordinary github.com/gitlab.com app.
 *
 * `preferredForge` is passed ONLY for a github/gitlab tracker: a plan/jira app has
 * no forge pin to honor, and passing its tracker through would be meaningless.
 * `target` is still resolved for those apps (the origin may well be a forge) so a
 * caller that only wants the queryable repo doesn't have to special-case them —
 * callers that must gate on the tracker read `tracker` and decide.
 *
 * Never throws — both halves degrade to null rather than rejecting.
 * @param {object} app - managed app record (needs `repoPath`, `workTracker`)
 * @param {{repoPath?: string}} [options] - `repoPath` override for a caller that
 *   scans a checkout other than `app.repoPath` (the app record supplies the pin,
 *   the override supplies the checkout).
 * @returns {Promise<{tracker:string, target:object|null}>}
 */
export async function resolveAppForgeTarget(app, { repoPath = null } = {}) {
  const { resolved: tracker } = await resolveAppWorkTracker(app).catch(() => ({ resolved: 'plan' }));
  const preferredForge = (tracker === 'github' || tracker === 'gitlab') ? tracker : null;
  const target = await resolveRepoForgeTarget(repoPath || app?.repoPath, { preferredForge });
  return { tracker, target };
}
