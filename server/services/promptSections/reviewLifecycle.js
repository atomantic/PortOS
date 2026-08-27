/**
 * Review-loop, CI-gate, and merge prompt sections.
 */

import { DEFAULT_REVIEWER, DEFAULT_REVIEW_STOP_MODE, LOCAL_LLM_REVIEWERS, MODEL_CAPABLE_CLI_REVIEWERS, describeReviewerCli, isCliReviewer, reviewerCliBinary, normalizeReviewUsernames, normalizeOptionalReviewers, normalizeReviewerMaxRounds, reviewerEffortArgs, reviewerModelArg, resolveKeyedReviewers, buildReviewWithArgs } from '../../lib/validation.js';
import { oversizedBodyPointer } from '../../lib/slashdoInvocation.js';
import { detectForgeCli } from '../../lib/gitForge.js';
import { shellQuote } from '../../lib/shellQuote.js';
import { INLINE_REVIEW_LOOP_STEP } from './constants.js';
import { normalizeForgeCli } from './forge.js';

/**
 * True when a follow-up task is a **merge-only** run: it has a PR to land but no
 * reviewer to run (Review Loop off, or every configured reviewer was stripped —
 * e.g. copilot on a GitLab MR). Tolerates the string `'true'` because task
 * metadata round-trips through JSON/forms like every other CoS flag.
 *
 * Used both to pick the prompt section and to skip preloading the reviewer-only
 * slashdo bodies (`/do:rpr`, the local-agent review loop) that section ignores.
 */
export function isMergeOnlyFollowUp(metadata = {}) {
  return metadata?.reviewLoopMergeOnly === true || metadata?.reviewLoopMergeOnly === 'true';
}

/**
 * Adapt slashdo's local-agent recipe for the pre-PR half of a manual workflow.
 * The normal recipe pushes after each reviewer pass so a later PR-side reviewer
 * sees the fixes. A local-only section must keep every fix on the branch until
 * all local reviewers finish; the outer completion workflow performs the one
 * push after that gate.
 */
export function prepareLocalReviewLoopBody(body) {
  if (typeof body !== 'string' || !body) return body;
  const withoutPushStep = body.replace(
    /\r?\n[ \t]*5\. \*\*Push verified changes\*\*:[\s\S]*?(?=\r?\n[ \t]*6\. \*\*Re-loop or stop\*\*:)/,
    '\n5. **Keep verified changes local**:\n   Skip the push step here. The outer Completion Workflow pushes the branch only after every local reviewer is clean.\n',
  );
  // Keep a future recipe revision fail-safe if it moves the push command out of
  // the numbered step that the replacement above recognizes.
  return withoutPushStep.replace(
    /^[ \t]*(?:git pull --rebase --autostash && )?git push\b[^\r\n]*\r?$/gm,
    '   # Push is deferred until every local reviewer is clean.',
  );
}

function remoteReviewBaseRef(baseBranch) {
  if (typeof baseBranch !== 'string' || !baseBranch || baseBranch === '<base-branch>') return 'origin/HEAD';
  if (baseBranch.startsWith('origin/') || baseBranch.startsWith('refs/remotes/origin/')) return baseBranch;
  return `origin/${baseBranch}`;
}

/**
 * Build the **review-loop follow-up** section — the instructions for the
 * agent spawned by `spawnReviewLoopFollowUp` to drive Copilot's review-and-fix
 * loop until the PR merges. Same 7-step procedure, same merge command, same
 * MERGED-state verification, same 10-iteration cap in BOTH the light and full
 * paths — extracted so the two can't drift independently.
 *
 * I/O (the slashdo `/do:rpr` body) is intentionally pulled outside this helper
 * and threaded in via `rprBody` so the function stays pure and synchronous.
 *
 * @param {Object} metadata - task.metadata (reviewLoopPR* fields, sourceTaskId)
 * @param {Object} [opts]
 * @param {boolean} [opts.verbose=false] - When true, emit the verbose prose
 *   variant the full (api) path uses, with PR Details list and an inlined
 *   `/do:rpr` reference. When false, emit the compact list the light path uses.
 * @param {string|null} [opts.rprBody=null] - The loaded `/do:rpr` slashdo body.
 *   Only appended in verbose mode; ignored in compact mode.
 * @param {string|null} [opts.localAgentLoopBody=null] - The loaded slashdo
 *   `lib/local-agent-review-loop.md` body (conditionals resolved to the
 *   subprocess/`else` branch). Inlined when a spawnable CLI reviewer
 *   (codex/antigravity/claude/grok) is in the list so the agent gets the exact
 *   headless invocation and review-only contract instead of improvising it.
 * @param {string|null} [opts.localAgentLoopBodyPath=null] - Path to a staged copy
 *   of that body. When set and the body is over `SLASHDO_INLINE_BUDGET_CHARS`,
 *   the section points at the file instead of pasting it. Only the inline caller
 *   passes this; a follow-up agent, whose whole job is the loop, still inlines.
 * @param {boolean} [opts.localOnly=false] - Render the pre-PR local-review half
 *   of a manual workflow, deferring pushes and PR/MR creation to the caller.
 * @param {string} [opts.baseBranch='origin/HEAD'] - Base ref used by local
 *   review diff commands when `localOnly` is set. `origin/HEAD` resolves the
 *   repository's actual default branch for adopted worktrees whose worktree
 *   metadata deliberately has no base branch.
 * @param {Array<{reviewer: string, position: number}>} [opts.reviewerPositions=[]]
 *   Complete configured reviewer order, used to carry stop-mode state across
 *   the pre-PR and post-PR phases.
 * @param {number} [opts.inlineWorkflowStep=INLINE_REVIEW_LOOP_STEP] - Completion
 *   workflow step referenced by an inline review or merge-gate section.
 * @param {boolean} [opts.inline=false] - Emit the SAME loop for an agent that
 *   opened the PR itself moments ago, rather than for a follow-up agent handed
 *   someone else's PR (`buildInlineReviewLoopSection`). Only the framing differs:
 *   the heading and opening sentence, and the fact that nothing pre-requested a
 *   Copilot review. The loop body, notes, merge command, and MERGED verification
 *   stay byte-identical so the two callers can't drift.
 * @param {string[]} [opts.localPhaseReviewers=[]] - Reviewers completed in the
 *   pre-PR local phase before this inline PR-side phase.
 * @param {boolean} [opts.localPhaseCanShortCircuit=false] - Whether the local
 *   phase is allowed to satisfy the configured stop mode for this phase too.
 * @returns {string}
 */
export function buildReviewLoopFollowUpSection(metadata = {}, { verbose = false, rprBody = null, localAgentLoopBody = null, localAgentLoopBodyPath = null, inlineExitStep = null, forgeCli = null, localOnly = false, baseBranch = '<base-branch>', reviewerPositions = [], inlineWorkflowStep = INLINE_REVIEW_LOOP_STEP, localPhaseReviewers = [], localPhaseCanShortCircuit = false } = {}) {
  // One parameter, not two: an `inline` boolean alongside it could disagree with
  // it, and the disagreement renders silently — `inline` with a blank exit step
  // emits a bare "6." and a truncated merge-gate hand-back.
  const inline = inlineExitStep !== null;
  const prUrl = metadata.reviewLoopPRUrl || '';
  const prBranch = metadata.reviewLoopPRBranch || '';
  const prNumber = metadata.reviewLoopPRNumber ?? '';
  const prOwner = metadata.reviewLoopPROwner ?? '';
  const prRepo = metadata.reviewLoopPRRepo ?? '';
  const sourceTaskId = metadata.sourceTaskId || 'unknown';
  const localPhaseReviewerList = Array.isArray(localPhaseReviewers) ? localPhaseReviewers : [];
  const localBaseRef = localOnly ? remoteReviewBaseRef(baseBranch) : baseBranch;
  const renderedBaseBranch = localOnly ? shellQuote(localBaseRef) : baseBranch;
  const configuredReviewerPositions = (Array.isArray(reviewerPositions) ? reviewerPositions : [])
    .filter(entry => entry && typeof entry.reviewer === 'string' && Number.isInteger(entry.position));
  const reviewerPositionLabel = configuredReviewerPositions.length
    ? configuredReviewerPositions.map(({ reviewer, position }) => `\`${reviewer}\`=${position}`).join(', ')
    : '';
  const preparedLocalAgentLoopBody = localOnly
    ? prepareLocalReviewLoopBody(localAgentLoopBody)
    : localAgentLoopBody;
  const reviewForgeCli = normalizeForgeCli(forgeCli)
    || (detectForgeCli(metadata.reviewLoopPRHost) === 'glab' ? 'glab' : 'gh');
  // Merge-only follow-up (Review Loop off): no reviewer to wait on or invoke —
  // the whole job is CI-gate → fix → merge. Branch before any reviewer defaulting
  // below, which would otherwise resolve the empty list back to `[copilot]`.
  if (isMergeOnlyFollowUp(metadata)) {
    return buildMergeFollowUpSection({
      prUrl, prBranch, prNumber, prOwner, prRepo, sourceTaskId, verbose, inlineExitStep,
      prHost: metadata.reviewLoopPRHost ?? '',
      forgeCli: reviewForgeCli, inlineWorkflowStep, localReviewers: localPhaseReviewerList,
    });
  }
  // Arbitrary GitHub reviewer usernames (gate-only PR reviewers), appended to
  // the review flow after the keyed reviewers.
  const usernames = normalizeReviewUsernames(metadata.reviewLoopReviewerUsernames);
  // Ordered keyed reviewer list (back-compat: legacy single `reviewLoopReviewer`).
  // `reviewLoopReviewers` from spawnReviewLoopFollowUp is authoritative (copilot
  // already stripped on non-GitHub forges); resolveKeyedReviewers keeps an
  // explicit empty list empty when usernames carry the review (username-only).
  const reviewerSource = Array.isArray(metadata.reviewLoopReviewers)
    ? metadata.reviewLoopReviewers
    : (metadata.reviewLoopReviewer ? [metadata.reviewLoopReviewer] : undefined);
  const reviewers = resolveKeyedReviewers(reviewerSource, usernames.length > 0);
  // Reviewer identities marked non-blocking — emitted with slashdo's `~opt`.
  const optionalReviewers = normalizeOptionalReviewers(metadata.reviewLoopOptionalReviewers) || [];
  // Per-reviewer `~max=<n>` iteration caps, keyed by emitted token. An absent key
  // leaves slashdo's built-in per-loop default; `0` means "loop until clean".
  const reviewerMaxRounds = normalizeReviewerMaxRounds(metadata.reviewLoopReviewerMaxRounds) || {};
  const stopMode = metadata.reviewLoopStopMode || DEFAULT_REVIEW_STOP_MODE;
  const reviewerApplies = metadata.reviewLoopReviewerApplies === true;
  const hasCopilot = reviewers.includes(DEFAULT_REVIEWER);
  const hasLocalLlm = reviewers.some(r => LOCAL_LLM_REVIEWERS.includes(r));
  // Spawnable-CLI reviewers, in configured order.
  const cliReviewers = reviewers.filter(isCliReviewer);
  const hasCli = cliReviewers.length > 0;
  const hasGithubUser = usernames.length > 0;
  // Optional per-reviewer model pins (Code Review Defaults panel, or the task's own
  // ReviewerPicker row), threaded as a reviewer-keyed map. A model-capable CLI
  // reviewer in this loop's list gets a `<reviewer> --model <id>` note; a local-LLM
  // reviewer's pin goes into its `/api/code-review/local` request body instead
  // (below). Absent = let that reviewer use its own default. For an Ollama-backed
  // `claude` reviewer the id is the local Ollama model. Falls back to the legacy
  // codex-scalar metadata key so a follow-up task persisted by an older install
  // still threads its codex model.
  const reviewerModelMap = (metadata.reviewLoopReviewerModels && typeof metadata.reviewLoopReviewerModels === 'object')
    ? metadata.reviewLoopReviewerModels
    : (typeof metadata.reviewLoopCodexModel === 'string' && metadata.reviewLoopCodexModel
        ? { codex: metadata.reviewLoopCodexModel }
        : {});
  // Optional per-reviewer reasoning-effort pins, same two sources as the models.
  // A CLI reviewer's effort becomes a flag on the command line the agent runs
  // (`--effort high` for claude/agy, `-c model_reasoning_effort=high` for codex —
  // `reviewerEffortArgs` owns that shape, and returns nothing for cursor, whose
  // level is folded into `--model` by `reviewerModelArg`); a local-LLM reviewer's becomes the
  // `reasoning_effort` field of its `/api/code-review/local` body (below). There is
  // no slashdo `--review-with` suffix for effort, which is why it rides the
  // invocation rather than `equivArgs`.
  const reviewerEffortMap = (metadata.reviewLoopReviewerEfforts && typeof metadata.reviewLoopReviewerEfforts === 'object')
    ? metadata.reviewLoopReviewerEfforts
    : {};
  // One entry per CLI reviewer carrying a pinned model and/or effort, rendered as
  // the literal command line the agent must run. Reviewers are listed rather than
  // filtered to MODEL_CAPABLE_CLI_REVIEWERS up front because a CLI reviewer may
  // carry only one of the two pins (and `grok` carries neither). The per-flag
  // gates below decide what each entry renders; an entry with no flags drops out.
  const reviewerPinEntries = cliReviewers
    .map((r) => {
      const flags = [];
      // Thread each configured model id VERBATIM. We deliberately don't env-map it
      // here (e.g. bare Claude tier → Bedrock form): this is a text-template layer
      // with only a providerId, not the merged spawn env (process.env + settings.json
      // + provider.envVars) the CLI argv builder normalizes against — and the nested
      // reviewer CLI is spawned by the agent, not PortOS, so the argv chokepoint never
      // runs. The Code Review Defaults model field is free-text for exactly this
      // reason: the user configures the id their environment needs (a Bedrock-form id
      // on a Bedrock box, an installed Ollama model for an Ollama-backed `claude`).
      if (MODEL_CAPABLE_CLI_REVIEWERS.includes(r) && typeof reviewerModelMap[r] === 'string' && reviewerModelMap[r]) {
        // `reviewerModelArg` (not the raw id) because cursor carries its
        // reasoning effort INSIDE the model id — `gpt-5[effort=max]` — so the
        // pinned pair must render as ONE `--model`, never a `--effort` cursor
        // rejects. Every other reviewer gets the id back verbatim.
        flags.push(`--model ${reviewerModelArg(r, reviewerModelMap[r], reviewerEffortMap[r])}`);
      }
      const effortArgs = reviewerEffortArgs(r, reviewerEffortMap[r]);
      if (effortArgs.length) flags.push(effortArgs.join(' '));
      // Binary, not slug: this renders a literal command line, and the
      // `antigravity` slug names no executable.
      return flags.length ? `\`${reviewerCliBinary(r) || r} ${flags.join(' ')} …\`` : null;
    })
    .filter(Boolean);
  const reviewerPinNote = reviewerPinEntries.length
    ? ` When invoking a reviewer with a pinned model or reasoning effort, pass it: ${reviewerPinEntries.join(', ')}.`
    : '';
  // When the slashdo local-agent review loop is inlined below (a spawnable CLI
  // reviewer is in the list), point the invocation step at it so the agent runs
  // the exact headless recipe instead of probing the CLI's flags / hand-rolling
  // an invocation — the failure mode that had a codex CoS agent burn a dozen
  // exploratory `claude --help` / `claude -p 'hello'` / `--tools ''` probes
  // before it stumbled into a working review call.
  const cliProcedurePointer = (hasCli && preparedLocalAgentLoopBody)
    ? ' Follow the **CLI Reviewer Procedure** section below for the exact headless invocation and review-only contract — do NOT probe the CLI or guess flags.'
    : '';
  // Each configured CLI reviewer paired with the command the agent must actually
  // run. Resolved ONCE — the slug-vs-binary distinction is the whole point of
  // this block, so every string below reads it from here rather than restating
  // the `|| slug` fallback. Unmapped slug ⇒ falls back to itself.
  const cliBinaries = cliReviewers.map(slug => ({ slug, binary: reviewerCliBinary(slug) || slug }));
  // `**codex / agy / claude**` — the CLI reviewers THIS loop configured, named by
  // the binary. Previously a fixed "codex / antigravity / claude / grok" string,
  // which both listed reviewers that weren't configured and named `antigravity`,
  // a command that exists on no PATH.
  const cliReviewerHeading = cliBinaries.map(c => c.binary).join(' / ');
  // Spell out slug → binary for any reviewer whose command differs from its
  // slug, so the agent can reconcile the configured list / `--review-with` token
  // with the executable named in the invocation table.
  const cliBinaryAliases = cliBinaries
    .filter(c => c.binary !== c.slug)
    .map(c => `the \`${c.slug}\` reviewer runs the \`${c.binary}\` binary (there is no \`${c.slug}\` command)`);
  const cliBinaryNote = cliBinaryAliases.length
    ? ` Reviewer slug → command: ${cliBinaryAliases.join('; ')}.`
    : '';
  const isOptionalReviewer = reviewer => optionalReviewers.some(optional => optional.toLowerCase() === reviewer.toLowerCase());
  const requiredCliBinaries = cliBinaries.filter(reviewer => !isOptionalReviewer(reviewer.slug));
  const optionalCliBinaries = cliBinaries.filter(reviewer => isOptionalReviewer(reviewer.slug));
  // A required reviewer that cannot run is NOT a clean review. Optional
  // reviewers have an explicit non-blocking contract for an inconclusive
  // precondition such as a missing binary, but that does not authorize a
  // self-review substitution.
  const missingCliNote = hasCli
    ? [
      `**Missing reviewer CLI:** verify each configured binary is on PATH (${cliBinaries.map(c => `\`command -v ${c.binary}\``).join(' / ')}) before concluding it is unavailable.`,
      requiredCliBinaries.length
        ? `If a required reviewer binary is genuinely missing (${requiredCliBinaries.map(c => `\`${c.binary}\``).join(' / ')}), that reviewer is UNSATISFIED — do NOT substitute your own self-review and do NOT ${localOnly ? 'push or open a PR/MR' : 'merge'}. ${localOnly ? 'Exit without opening the PR/MR.' : 'Post a PR comment naming the missing command and exit.'}`
        : '',
      optionalCliBinaries.length
        ? `A missing optional reviewer binary (${optionalCliBinaries.map(c => `\`${c.binary}\``).join(' / ')}) is an inconclusive optional result and does not block ${localOnly ? 'the push or PR/MR creation' : 'the merge'}; record it and continue without substituting a self-review.`
        : '',
    ].filter(Boolean).join(' ')
    : '';
  // "multi" reflects the TOTAL number of review sources (keyed reviewers +
  // username reviewers) so the ordered per-reviewer loop wording kicks in as
  // soon as there's more than one thing to satisfy.
  const multi = (reviewers.length + usernames.length) > 1;
  // The system pre-requests the initial Copilot review only when copilot LEADS the
  // order; otherwise the agent must request it at copilot's turn (so Copilot reviews
  // the post-CLI-fix state, not a stale diff). An INLINE loop opened its own PR
  // moments ago and nothing pre-requested anything, so it always requests.
  const copilotIsFirst = !inline && reviewers[0] === DEFAULT_REVIEWER;
  const reviewerLabel = [
    ...reviewers.map(r => `\`${r}\``),
    ...usernames.map(u => `\`@${u}\``),
  ].join(' → ');
  const optionalConfiguredReviewers = [
    ...reviewers.filter(isOptionalReviewer).map(reviewer => `\`${reviewer}\``),
    ...usernames.filter(username => isOptionalReviewer(`@${username}`)).map(username => `\`@${username}\``),
  ];
  const optionalReviewNote = optionalConfiguredReviewers.length
    ? `**Optional reviewers (~opt):** ${optionalConfiguredReviewers.join(', ')} still run and their findings must still be fixed, but a timeout, skipped/incomplete pass, or missing/malformed/no-verdict result from one of them is non-blocking. A hard reviewer error, failed build/test, rejection, or push failure still blocks.`
    : '';
  const equivArgs = buildReviewWithArgs(reviewers, { stopMode, reviewerApplies, usernames, optionalReviewers, reviewerMaxRounds, reviewerModels: reviewerModelMap });
  const equiv = equivArgs ? ` (equivalent to \`/do:pr ${equivArgs}\`)` : '';

  // First step: how to obtain a review. For a single copilot/CLI reviewer keep the
  // focused wording; for a list, dispatch each reviewer in order. Only emit the
  // per-reviewer-kind bullet that actually applies to the configured list.
  // `lmstudio`/`ollama` don't have CLIs the agent can spawn — PortOS exposes
  // `POST /api/code-review/local` which runs the configured local model against
  // the diff and returns findings text. The agent always reaches it via
  // `http://localhost:5555` (the canonical loopback API port).
  // A pinned local-LLM model can't ride the endpoint's server-side default: that
  // reads the GLOBAL settings scalar and has never seen this task. So when the
  // user pinned one on the reviewer's row, name it in the request body — `model`
  // in the POST body overrides the configured default (see routes/codeReview.js).
  // Absent pin ⇒ omit the key entirely rather than sending `""`, which would be a
  // model id the backend can't resolve.
  // The pinned reasoning effort rides the same body as `effort` — the endpoint
  // forwards it as the backend's OpenAI-compatible `reasoning_effort`. Same
  // absent-vs-empty contract as the model: no pin ⇒ the key is omitted, not blank.
  // Which body keys this run actually pins, accumulated across the local-LLM
  // reviewers in the list. The jq example below is built from THIS set rather than
  // naming both keys unconditionally: an effort-only run that was shown a
  // `model: "…"` placeholder would have the agent send the literal ellipsis, and
  // the route's `body.model || configured` prefers that truthy junk over the
  // install default — turning a pinned-effort review into a model-not-found error.
  const pinnedString = (map, r) => (typeof map[r] === 'string' && map[r] ? map[r] : null);
  const localLlmPins = LOCAL_LLM_REVIEWERS
    .filter(r => reviewers.includes(r))
    .map(r => ({ reviewer: r, model: pinnedString(reviewerModelMap, r), effort: pinnedString(reviewerEffortMap, r) }))
    .filter(p => p.model || p.effort);
  const localLlmPinNote = localLlmPins.map(({ reviewer, model, effort }) => {
    const keys = [
      ...(model ? [`"model": "${model}"`] : []),
      ...(effort ? [`"effort": "${effort}"`] : [])
    ];
    return `\`${reviewer}\` → \`${keys.join(', ')}\``;
  });
  // Both strings derive from the same `localLlmPins` array rather than the jq line
  // reading a Set the note's `.map` filled as a side effect — that coupling meant
  // hoisting one line above the other silently emptied the key list.
  const localLlmPinJq = [
    'backend: "…"',
    ...(localLlmPins.some(p => p.model) ? ['model: "…"'] : []),
    ...(localLlmPins.some(p => p.effort) ? ['effort: "…"'] : []),
    'diff: .'
  ].join(', ');
  const diffCommand = localOnly
    ? `git diff ${renderedBaseBranch}...HEAD`
    : reviewForgeCli === 'glab'
    ? `glab mr diff ${prNumber || '<MR_NUMBER>'}`
    : `gh pr diff ${prNumber || '<PR_NUMBER>'}`;
  const localLlmInvocation = `POST the diff to PortOS's local reviewer endpoint and extract its review text before evaluating it. Substitute the active reviewer name for \`<lmstudio|ollama>\`:
\`\`\`bash
REVIEW_RESPONSE=$(mktemp)
HTTP_STATUS=$(${diffCommand} | jq -Rs '{ backend: "<lmstudio|ollama>", diff: . }' | curl -sS -X POST http://localhost:5555/api/code-review/local -H 'Content-Type: application/json' -d @- -o "$REVIEW_RESPONSE" -w '%{http_code}') || {
  echo "Local reviewer failed: request transport error" >&2
  STATUS=cli-error
  exit 1
}
if [ "$HTTP_STATUS" -ge 400 ] 2>/dev/null; then
  echo "Local reviewer failed: HTTP $HTTP_STATUS $(jq -r '.error // "request failed"' "$REVIEW_RESPONSE" 2>/dev/null)" >&2
  STATUS=cli-error
  exit 1
fi
if jq -e '.error | select(type == "string" and length > 0)' "$REVIEW_RESPONSE" >/dev/null 2>&1; then
  echo "Local reviewer failed: $(jq -r '.error' "$REVIEW_RESPONSE")" >&2
  STATUS=cli-error
  exit 1
fi
if ! jq -er '.findings | select(type == "string" and length > 0)' "$REVIEW_RESPONSE" > "\${REVIEW_RESPONSE}.findings"; then
  echo "Local reviewer failed: $(jq -r '.error // "missing .findings in reviewer response"' "$REVIEW_RESPONSE")" >&2
  STATUS=no-verdict # Never treat an absent or malformed response as clean.
  exit 1
else
  cat "\${REVIEW_RESPONSE}.findings"
fi
\`\`\`
Only a successfully extracted \`.findings\` value is the review text; treat it like any other reviewer's findings.${localLlmPinNote.length
  ? ` This run pins settings for ${localLlmPinNote.join(', ')} — add those keys to the JSON body (\`jq -Rs '{ ${localLlmPinJq} }'\`) so the review runs with them instead of the install defaults. Send ONLY the keys named above; a key with no pinned value overrides the install default with junk.`
  : ''}`;
  // Instruct the agent to request each username reviewer as a PR reviewer and
  // gate the merge on their approval. `gh pr edit --add-reviewer` takes the bare
  // login, so strip the `@`.
  const githubUsersInvocation = reviewForgeCli === 'glab'
    ? `request ${usernames.map(u => `\`@${u}\``).join(', ')} as MR reviewer${usernames.length > 1 ? 's' : ''} using the GitLab project UI or API, then inspect \`glab mr view ${prNumber || '<MR_NUMBER>'}\` for their review and address any findings; their approval gates the merge.`
    : `request ${usernames.map(u => `\`@${u}\``).join(', ')} as PR reviewer${usernames.length > 1 ? 's' : ''} (\`gh pr edit ${prNumber || '<PR_NUMBER>'} --add-reviewer <user>\`, drop the \`@\`), then wait for their review (poll every 5–15s) and address any findings; their approval gates the merge.`;
  const multiBullets = [
    hasCopilot ? `**copilot**: ${copilotIsFirst
      ? 'wait for the initial Copilot review the system already pre-requested (Copilot leads the list)'
      : 'request a Copilot review when you reach its turn'} (poll every 5–15s, max 5 min/round), then re-request on later rounds.` : null,
    hasCli ? `**${cliReviewerHeading}**: invoke that CLI to review this branch's diff against its base (use the CLI's own base-diff mode or \`git diff ${renderedBaseBranch}...HEAD\`${localOnly ? '' : `; on GitHub \`gh pr diff ${prNumber || ''}\` also works`}).${cliBinaryNote}${reviewerPinNote}${cliProcedurePointer}` : null,
    hasLocalLlm ? `**lmstudio / ollama**: ${localLlmInvocation}` : null,
    hasGithubUser ? `**@github reviewers**: ${githubUsersInvocation}` : null,
  ].filter(Boolean).join(' ');
  // Name the BINARY, not the slug: `Invoke the \`antigravity\` CLI` sent a
  // follow-up agent hunting for a command that does not exist.
  const singleCliInvocation = `Invoke ${describeReviewerCli(cliReviewers[0])} to review this branch's diff against its base (use the CLI's own base-diff mode or \`git diff ${renderedBaseBranch}...HEAD\`${localOnly ? '' : `; on GitHub \`gh pr diff ${prNumber || ''}\` also works`}). Capture its findings as concrete issues to address.${reviewerPinNote}${cliProcedurePointer}`;
  // Resolved sequentially so a future reviewer kind only adds one branch
  // instead of deepening the nested ternary.
  let waitOrInvokeStep;
  if (multi) waitOrInvokeStep = `For EACH reviewer in order — ${reviewerLabel} — run a full review-and-fix sub-loop before advancing to the next. ${multiBullets}`;
  else if (hasCopilot && copilotIsFirst) waitOrInvokeStep = 'Wait for the latest Copilot review to complete (poll every 5–15s, max 5 minutes per round); the system already requested the initial review.';
  else if (hasCopilot) waitOrInvokeStep = 'Request a Copilot review when you reach its turn, then wait for it to complete (poll every 5–15s, max 5 minutes per round).';
  else if (hasLocalLlm) waitOrInvokeStep = localLlmInvocation;
  else if (hasCli) waitOrInvokeStep = singleCliInvocation;
  else waitOrInvokeStep = `To obtain a review, ${githubUsersInvocation}`;

  const stopModeNote = stopMode === 'on-findings'
    ? '**Stop mode (on-findings):** stop after the FIRST reviewer whose findings you actually fixed and committed; skip the remaining reviewers.'
    : stopMode === 'on-clean'
      ? '**Stop mode (on-clean):** stop after the FIRST reviewer that reports zero findings; skip the remaining reviewers.'
      : (multi ? '**Stop mode (all):** run every reviewer in the list, in order, before merging.' : '');
  const localPhaseReviewerNames = [...new Set(localPhaseReviewerList)];
  const prSideReviewerNames = [...reviewers, ...usernames.map(username => `@${username}`)];
  const reviewerPositionMap = new Map(configuredReviewerPositions.map(({ reviewer, position }) => [reviewer, position]));
  const localPhasePositions = localPhaseReviewerNames.map(reviewer => reviewerPositionMap.get(reviewer));
  const prSidePositions = prSideReviewerNames.map(reviewer => reviewerPositionMap.get(reviewer));
  // Cross-phase short-circuiting is safe only when the user's original ordered
  // reviewer list already placed every local reviewer before every PR-side one.
  // If the list was interleaved, a PR-side reviewer can add fixes after the local
  // trigger; skipping a later PR-side reviewer would then leave those fixes
  // unreviewed. This mirrors lib/slashdo/commands/do/pr.md's fail-closed gate.
  const crossPhaseOrderingAllowsSkip = localPhaseReviewerNames.length > 0
    && prSideReviewerNames.length > 0
    && localPhasePositions.every(Number.isInteger)
    && prSidePositions.every(Number.isInteger)
    && Math.max(...localPhasePositions) < Math.min(...prSidePositions);
  const crossPhaseStopModeNote = (!localOnly && inline && localPhaseCanShortCircuit && localPhaseReviewerList.length)
    ? [
      '**Cross-phase stop-mode gate:** the local reviewers ran before this PR-side phase, so decide the configured stop mode across both phases before requesting any reviewer listed here.',
      'The local phase persisted `LOCAL_PHASE_START_SHA`, `LOCAL_OVERALL_STATUS`, `LOCAL_STOP_TRIGGERED`, `LOCAL_STOP_INDEX`, `LOCAL_STOP_REVIEW_COMMITS`, `LOCAL_PHASE_COMMITS=$(git rev-list "$LOCAL_PHASE_START_SHA..HEAD" --count)`, and `LOCAL_REVIEWED_HEAD_SHA` in the worktree-private Git state file. Shell variables do not survive between agent commands, so at the start of this phase, in the same shell call that makes the skip decision, run `LOCAL_REVIEW_STATE_FILE="$(git rev-parse --git-path portos-local-review-state)"`, fail closed if `[ ! -s "$LOCAL_REVIEW_STATE_FILE" ]`, then load it with `. "$LOCAL_REVIEW_STATE_FILE"`. If `LOCAL_REVIEWED_HEAD_SHA` does not equal `$(git rev-parse HEAD)`, do not skip any PR-side reviewer. Use the loaded values rather than treating the PR-side list as a fresh stop-mode scope.',
      crossPhaseOrderingAllowsSkip
        ? (reviewerPositionLabel
          ? `Configured reviewer positions are zero-based: ${reviewerPositionLabel}. The original order places every local reviewer before every PR-side reviewer.`
          : 'The original order places every local reviewer before every PR-side reviewer.')
        : '**Cross-phase stop-mode skip disabled:** the configured reviewer order is interleaved, or its positions are unavailable. Always run every PR-side reviewer so fixes made after a local trigger receive review.',
      '`all` always runs the PR-side reviewers.',
      crossPhaseOrderingAllowsSkip
        ? '`on-clean` skips the PR-side reviewers only when the local phase actually satisfied that stop condition: `LOCAL_OVERALL_STATUS=partial` from a stop-mode short-circuit, or `LOCAL_OVERALL_STATUS=clean` with `LOCAL_STOP_REVIEW_COMMITS=0` and `LOCAL_STOP_TRIGGERED=true`.'
        : '`on-clean` always runs every PR-side reviewer here because cross-phase skipping is disabled for this order.',
      crossPhaseOrderingAllowsSkip
        ? '`on-findings` skips the PR-side reviewers only when the local phase actually satisfied that stop condition: `LOCAL_OVERALL_STATUS=partial` from a stop-mode short-circuit, or `LOCAL_OVERALL_STATUS=clean` with `LOCAL_STOP_REVIEW_COMMITS>0` and `LOCAL_STOP_TRIGGERED=true`.'
        : '`on-findings` always runs every PR-side reviewer here because cross-phase skipping is disabled for this order.',
      'An inconclusive or dirty local result does not satisfy a stop condition; a required local result still blocks the PR workflow, while an optional inconclusive result may continue but must never trigger this skip.',
      crossPhaseOrderingAllowsSkip
        ? 'When the local phase satisfies the stop condition, skip the PR-side phase and record the configured stop-mode short-circuit as `partial`; otherwise run this PR-side list normally. If the stop index or triggering reviewer commit count is missing or invalid, run every PR-side reviewer.'
        : 'Even when the local phase satisfies the stop condition, run every PR-side reviewer in this phase, then record the configured stop-mode result; do not skip reviewers across an interleaved phase boundary.',
    ].join('\n')
    : '';

  const applyNote = hasCli
    ? (reviewerApplies
        ? (localOnly
          ? '**Reviewer applies:** let each CLI reviewer apply its own fixes to the working tree, then verify and run tests; keep fixes committed locally. Do NOT push or open the PR/MR from this loop.'
          : '**Reviewer applies:** let each CLI reviewer apply its own fixes to the working tree, then verify, run tests, and push.')
        : (localOnly
          ? "**Reviewer applies (off):** read each CLI reviewer's findings and apply the fixes yourself (default); keep fixes committed locally. Do NOT push or open the PR/MR from this loop."
          : "**Reviewer applies (off):** read each CLI reviewer's findings and apply the fixes yourself (default)."))
    : '';

  // Inline runs opened the PR seconds ago inside their own completion workflow,
  // so nothing pre-requested anything — claiming otherwise would have the agent
  // poll forever for a Copilot review no one asked for.
  const hasExplicitLocalBase = typeof baseBranch === 'string' && baseBranch && baseBranch !== '<base-branch>';
  const localBasePreparation = hasExplicitLocalBase
    ? '`git fetch origin`'
    : '`git fetch origin`, then run `git remote set-head origin --auto` to resolve the repository default branch';
  const renderedLocalBranch = localOnly ? shellQuote(prBranch || '<branch>') : '';
  const initialReviewState = localOnly
    ? [
      `Before the first local reviewer, run ${localBasePreparation}. Set \`BRANCH=${renderedLocalBranch}\`; resolve \`LOCAL_PRE_REBASE_REMOTE\` from \`branch.$BRANCH.pushRemote\`, then \`remote.pushDefault\`, then \`branch.$BRANCH.remote\`, using \`origin\` if empty or \`.\`. Capture \`LOCAL_PRE_REBASE_HEAD_SHA=$(git rev-parse HEAD)\` and \`LOCAL_PRE_REBASE_REMOTE_SHA=$(git ls-remote --exit-code --heads "$LOCAL_PRE_REBASE_REMOTE" "$BRANCH" 2>/dev/null | awk 'NR == 1 {print $1}')\`. Immediately write all three to \`LOCAL_REVIEW_BASELINE_FILE="$(git rev-parse --git-path portos-local-review-baseline)"\` with \`printf 'LOCAL_PRE_REBASE_REMOTE=%s\\nLOCAL_PRE_REBASE_HEAD_SHA=%s\\nLOCAL_PRE_REBASE_REMOTE_SHA=%s\\n' "$LOCAL_PRE_REBASE_REMOTE" "$LOCAL_PRE_REBASE_HEAD_SHA" "$LOCAL_PRE_REBASE_REMOTE_SHA" > "$LOCAL_REVIEW_BASELINE_FILE"\`; abort if the write fails.`,
      `Rebase onto the current remote base with \`git rebase ${renderedBaseBranch}\`. Fetch/base-resolution failure or conflicts block publication; on conflict run \`git rebase --abort 2>/dev/null || true\` before stopping.`,
      `After synchronization, set \`LOCAL_PHASE_START_SHA=$(git rev-parse HEAD)\`; reset and initialize worktree-private \`LOCAL_REVIEW_STATE_FILE="$(git rev-parse --git-path portos-local-review-state)"\` with \`printf 'LOCAL_PHASE_START_SHA=%s\\nLOCAL_OVERALL_STATUS=incomplete\\nLOCAL_STOP_TRIGGERED=false\\nLOCAL_STOP_INDEX=-1\\nLOCAL_STOP_REVIEW_COMMITS=-1\\nLOCAL_PHASE_COMMITS=0\\nLOCAL_REVIEWED_HEAD_SHA=\\n' "$LOCAL_PHASE_START_SHA" > "$LOCAL_REVIEW_STATE_FILE"\`. Abort if reset/initialization fails.`,
      `Before each local reviewer, record \`LOCAL_REVIEWER_START_SHA=$(git rev-parse HEAD)\`; after its loop compute \`LOCAL_REVIEWER_COMMITS=$(git rev-list "$LOCAL_REVIEWER_START_SHA..HEAD" --count)\`. On a qualifying stop, set \`LOCAL_STOP_REVIEW_COMMITS=$LOCAL_REVIEWER_COMMITS\`. Run every local reviewer before publication, then persist the aggregate and stop result.`
    ].join(' ')
    : inline
    ? 'Nothing has reviewed this PR yet — you must request/invoke each configured reviewer yourself against its diff.'
    : (hasCopilot && copilotIsFirst)
    ? 'The system has already requested the initial Copilot code review (Copilot leads the order).'
    : hasCopilot
      ? 'Copilot is configured after another reviewer, so the system did NOT pre-request it — request the Copilot review yourself when you reach its turn (after the earlier reviewers’ fixes are pushed), and invoke the other reviewers yourself.'
      : 'The system did NOT pre-request a reviewer because no Copilot review leads the order — you must request/invoke each configured reviewer yourself against the PR diff.';
  const repeatedCommentsNote = '**Repeated comments:** If a fresh review round only re-raises feedback you intentionally rejected (with a reply explaining why), treat that round as clean and move on.';
  // Challenge protocol (#2471): auto-invoke the bounded worker↔reviewer dispute
  // from the review loop. When a reviewer's BLOCKING finding is a false positive,
  // the agent disputes it once via POST /challenge instead of silently complying
  // or accepting a false block, then RE-CHECKS (re-run reviewer) to overturn or
  // escalate. One challenge per task, also bounded by the task's retry budget —
  // a second dispute or an out-of-retries task returns 409.
  const challengeProtocolNote = [
    '**Challenge protocol (dispute a wrong rejection — use sparingly):** If a reviewer raises a BLOCKING finding you have strong, specific evidence is a false positive (it misread the diff, flagged intended behavior, or contradicts a documented repo convention), do NOT silently "fix" it or accept a false block — dispute it **exactly once** for this task:',
    '```bash',
    `curl -sS -X POST http://localhost:5555/api/cos/tasks/${sourceTaskId}/challenge -H 'Content-Type: application/json' -d '{"reason":"<why the finding is wrong>","evidence":"<file:line or diff quote>","reviewer":"<disputed reviewer>"}'`,
    '```',
    `A \`409\` (\`CHALLENGE_EXHAUSTED\` = the one challenge is spent, or \`CHALLENGE_BUDGET_EXHAUSTED\` = the task is out of retry budget) means you can't dispute — then fix the finding or, if genuinely blocked, ${localOnly ? 'stop without pushing or opening a PR/MR' : 'post a PR comment and stop'}. After filing, RE-CHECK: re-run the disputed reviewer (or another configured reviewer) against the current diff, then resolve — overturned → \`POST .../challenge/resolve\` with \`{"outcome":"upheld"}\` and continue to ${localOnly ? 'the PR/MR creation step' : 'merge'}; confirmed → fix it, or send \`{"outcome":"escalated"}\` to hand the dispute to the user.` + (hasLocalLlm ? ' For a local reviewer you may instead POST `{"recheck":{"backend":"<lmstudio|ollama>","diff":"<unified diff>"}}` and let the server re-run it and auto-derive the outcome.' : ''),
  ].join('\n');
  // Per-reviewer round caps. This prompt drives the loop in PROSE (it isn't
  // slashdo parsing a `~max=<n>` suffix), so a configured cap only binds if it's
  // spelled out here — the `equiv` flag string alone documents intent without
  // constraining the agent. `0` is slashdo's "loop until clean", so it's rendered
  // as such rather than as a zero-round budget.
  const maxRoundsEntries = Object.entries(reviewerMaxRounds)
    .filter(([token]) => reviewers.includes(token) || usernames.some(u => `@${u}`.toLowerCase() === token.toLowerCase()))
    .map(([token, max]) => `\`${token}\` → ${max === 0 ? 'loop until clean (no cap)' : `${max} round${max === 1 ? '' : 's'}`}`);
  const maxRoundsNote = maxRoundsEntries.length
    ? `**Round caps (~max):** stop these reviewers after their budget even if findings remain, then advance: ${maxRoundsEntries.join(', ')}. Spending a configured budget is a SUCCESS, not a failure — do not block the merge on it. Reviewers not listed keep the default cap below.`
    : '';

  const localRebaseConflictNote = localOnly
    ? '**Rebase conflict gate:** on conflicts, run `git rebase --abort 2>/dev/null || true`; do NOT publish a conflicted or half-rebased worktree.'
    : '';
  const localStatePersistenceNote = localOnly
    ? '**State persistence:** shell calls do not share variables. Reload state before each reviewer, preserve it while persisting `LOCAL_REVIEWER_START_SHA`; reload before commit/stop calculations and the final aggregate. Any read/write failure blocks publication.'
    : '';
  const extraNotes = [crossPhaseStopModeNote, stopModeNote, applyNote, maxRoundsNote, missingCliNote, optionalReviewNote, localRebaseConflictNote, localStatePersistenceNote].filter(Boolean);

  // Inline slashdo's local-agent review loop when a spawnable CLI reviewer is
  // configured. This is the maintained, precise recipe — exact per-CLI headless
  // invocation (`claude -p "$LOCAL_PROMPT" --dangerously-skip-permissions`,
  // `codex --sandbox read-only review --base …`, etc.), the review-only /
  // no-sub-agent-fan-out `$LOCAL_PROMPT` contract, and the parse-and-apply
  // handling. Without it the agent only sees "invoke that CLI" and reverse-
  // engineers the invocation, wasting calls. For the pre-PR local section,
  // `preparedLocalAgentLoopBody` removes the recipe's push step so the agent
  // keeps fixes local until every local reviewer is clean. The normal PR-side
  // follow-up still receives the maintained body verbatim. Both variants agree
  // with `cliBinaryNote`: slashdo's per-CLI invocation table names `agy` and
  // normalizes the `gemini`/`antigravity` slugs onto it, so the note is a pointer
  // into that table, not a correction layered over it. Conditionals were
  // resolved to the subprocess (`else`) branch by loadSlashdoLib, so no
  // in-process-Agent-tool branch leaks in to confuse a non-Claude-Code host.
  //
  // Over budget WITH a staged copy on disk (`localAgentLoopBodyPath`, only ever
  // passed for an inline loop — see buildAgentPrompt) the agent is pointed at the
  // file instead. Same trade `buildSlashdoSection` makes: an initial run is
  // already carrying the real task, and pasting 40KB of reviewer recipe up front
  // to be read at step 4 is the wrong place to spend that context.
  const localOnlyProcedureNote = localOnly
    ? '**Pre-PR rule:** keep reviewer fixes committed locally. Do NOT push or open a PR/MR here; the outer workflow publishes after local review.\n\n'
    : '';
  const cliProcedureHeader = `\n### CLI Reviewer Procedure (${cliReviewerHeading})\n\n${localOnlyProcedureNote}Drive each spawnable CLI reviewer EXACTLY as the slashdo local-agent review loop specifies — use its per-CLI invocation and review-only prompt contract verbatim; do NOT probe the CLI's \`--help\`, test it with throwaway prompts, or hand-roll flags. Run the reviewer once per round, capture its findings, and (unless reviewer-applies is set) apply the fixes yourself.\n\n`;
  //
  // The path IS the decision — it is non-null only when the caller already
  // measured the body over budget and staged it. Re-testing the length here
  // would give the two sites a way to disagree, and the disagreement is silent:
  // the file gets written AND the 40KB still gets pasted.
  const cliReviewerProcedure = (hasCli && preparedLocalAgentLoopBody)
    ? (localAgentLoopBodyPath
      ? `${cliProcedureHeader}${oversizedBodyPointer(localAgentLoopBodyPath, preparedLocalAgentLoopBody)}\n`
      : `${cliProcedureHeader}${preparedLocalAgentLoopBody}\n`)
    : '';

  // A JIRA-tracked PR is a human's to land (its ticket is already "In Review" and
  // nothing here can transition it), so this follow-up reviews and stops. Emitted
  // as the same steps 4-6 so the loop body above stays identical either way.
  const leaveOpen = metadata.reviewLoopLeaveOpen === true || metadata.reviewLoopLeaveOpen === 'true';
  const objective = leaveOpen
    ? '**Your job is to drive the review-and-fix loop to completion. Do NOT merge — this PR is tracked in JIRA and a human lands it.**'
    : '**Your job is to drive the review-and-fix loop to completion and merge the PR.**';
  // Where the loop hands control back. A follow-up agent's whole task WAS the
  // loop, so it exits; an inline loop is one step of a larger completion
  // workflow that still owes the run its `.agent-done` sentinel — telling it to
  // "exit" here leaves a finished merge without the sentinel that records it.
  const exitStep = inline
    ? `6. ${inlineExitStep}`
    : `6. Exit. Do **not** run \`/do:push\` or open a new PR${leaveOpen ? '' : ' — the merge handles everything'}. The system will clean up your worktree on exit.`;
  const localStopIndexNote = reviewerPositionLabel
    ? ` The configured reviewer positions are zero-based: ${reviewerPositionLabel}. When a qualifying verdict triggers the configured stop condition, set \`LOCAL_STOP_TRIGGERED=true\` and \`LOCAL_STOP_INDEX\` to that triggering local reviewer's position; when the list exhausts without a qualifying stop or a result is inconclusive, set \`LOCAL_STOP_TRIGGERED=false\` and \`LOCAL_STOP_INDEX=-1\`.`
    : ' Set `LOCAL_STOP_INDEX=-1` whenever no qualifying stop condition fired.';
  const closingSteps = localOnly
    ? [
      `4. When the local reviewer list is exhausted (or the stop mode triggers), record \`LOCAL_OVERALL_STATUS\`. Set \`LOCAL_STOP_TRIGGERED=true\` when the configured stop condition actually fired on a qualifying verdict, including when that verdict came from the final local reviewer; set it false only for list exhaustion without a qualifying stop or for an inconclusive result.${localStopIndexNote} Compute \`LOCAL_PHASE_COMMITS=$(git rev-list "$LOCAL_PHASE_START_SHA..HEAD" --count)\`; if a qualifying stop fired, retain the triggering reviewer's \`LOCAL_REVIEWER_COMMITS\` as \`LOCAL_STOP_REVIEW_COMMITS\`, otherwise set \`LOCAL_STOP_REVIEW_COMMITS=-1\`. Record \`LOCAL_REVIEWED_HEAD_SHA=$(git rev-parse HEAD)\`. Persist all phase state for later shell calls in the worktree-private Git state file: \`LOCAL_REVIEW_STATE_FILE="$(git rev-parse --git-path portos-local-review-state)"\`; then run \`printf 'LOCAL_PHASE_START_SHA=%s\\nLOCAL_OVERALL_STATUS=%s\\nLOCAL_STOP_TRIGGERED=%s\\nLOCAL_STOP_INDEX=%s\\nLOCAL_STOP_REVIEW_COMMITS=%s\\nLOCAL_PHASE_COMMITS=%s\\nLOCAL_REVIEWED_HEAD_SHA=%s\\n' "$LOCAL_PHASE_START_SHA" "$LOCAL_OVERALL_STATUS" "$LOCAL_STOP_TRIGGERED" "$LOCAL_STOP_INDEX" "$LOCAL_STOP_REVIEW_COMMITS" "$LOCAL_PHASE_COMMITS" "$LOCAL_REVIEWED_HEAD_SHA" > "$LOCAL_REVIEW_STATE_FILE"\`. If that write fails, do NOT push or open the PR/MR. For a final-reviewer stop, follow the same phase-level gate below: \`on-clean\` requires \`LOCAL_OVERALL_STATUS=clean\` with \`LOCAL_STOP_REVIEW_COMMITS=0\`, while \`on-findings\` requires \`LOCAL_OVERALL_STATUS=clean\` with \`LOCAL_STOP_REVIEW_COMMITS>0\`; a \`partial\` status is already a qualifying stop. Return to the Completion Workflow and continue with the push and PR/MR creation step when all executed required reviewers are clean and optional reviewers are clean or inconclusive, or when \`LOCAL_OVERALL_STATUS=partial\` records a qualifying configured stop-mode short-circuit that intentionally skipped later reviewers. Do NOT push or open the PR/MR before this local phase is complete.`,
    ]
    : leaveOpen
    ? [
      '4. When the reviewer list is exhausted (or the stop mode triggers), **leave the PR open** — do NOT merge it, and do NOT delete the branch. Its JIRA ticket is sitting in review and a human lands both together; merging here would leave the work merged and the ticket stuck in review.',
      // Forge-aware: `gh pr comment` fails outright on a GitLab MR URL.
      `5. Post a short comment on the ${detectForgeCli(metadata.reviewLoopPRHost) === 'glab' ? 'MR' : 'PR'} summarising what the reviewers raised and what you fixed, so the human landing it knows the state: ${detectForgeCli(metadata.reviewLoopPRHost) === 'glab' ? `\`glab mr note ${prNumber !== '' ? prNumber : '<MR_NUMBER>'} --message "<summary>"\`` : `\`gh pr comment "${prUrl}" --body "<summary>"\``}.`,
      exitStep,
    ]
    : [
      `4. When the reviewer list is exhausted (or the stop mode triggers), merge the PR **immediately** with this exact command (flags: \`--merge --delete-branch\`, nothing else — a true merge commit keeps the branch tip in main's history so automated worktree cleanup can prove the branch is merged):`,
      '   ```bash',
      reviewForgeCli === 'glab'
        ? `   glab mr merge "${prNumber || '<MR_NUMBER>'}" --yes --remove-source-branch`
        : `   gh pr merge "${prUrl}" --merge --delete-branch`,
      '   ```',
      reviewForgeCli === 'glab'
        ? null
        : (prOwner && prRepo && prNumber ? `   (Equivalent: \`gh pr merge ${prNumber} --repo ${prOwner}/${prRepo} --merge --delete-branch\`.)` : null),
      '   You have already verified the review is clean, so force the immediate merge. Adding any merge-deferral flag would leave the PR open after you exit.',
      reviewForgeCli === 'glab'
        ? `5. Confirm the MR is actually merged before exiting: \`glab mr view "${prNumber || '<MR_NUMBER>'}"\` must show it merged. If it is still open or was closed unmerged, investigate (a check is failing, a thread is still unresolved, or branch protection is blocking) — fix and retry the merge. Do NOT exit until it is merged.`
        : `5. Confirm the PR is actually merged before exiting: \`gh pr view "${prUrl}" --json state -q .state\` must return \`MERGED\`. If it returns \`OPEN\` or \`CLOSED\`, investigate (a check is failing, a thread is still unresolved, or branch protection is blocking) — fix and retry the merge. Do NOT exit until state is \`MERGED\`.`,
      exitStep,
    ].filter(Boolean);

  // Framing only — everything below it is identical for both callers.
  const heading = localOnly ? '### Local Review Before Opening the PR/MR' : (inline ? '## Review Loop' : '## Review-Loop Follow-up (PRIMARY OBJECTIVE)');
  const opening = localOnly
    ? `This runs as **step 3 of the Completion Workflow above**, against the committed branch \`${prBranch}\` and its base \`${baseBranch}\`. ${initialReviewState}`
    : inline
    ? `This runs as **step ${inlineWorkflowStep} of the Completion Workflow above**, against the PR you just opened on \`${prBranch}\` (\`${prUrl}\` / \`${prNumber}\` are the shell variables you captured there). ${initialReviewState} ${objective}`
    : `A previous agent finished implementing the work for source task **${sourceTaskId}** and opened **PR ${prUrl}** on branch \`${prBranch}\`. ${initialReviewState} ${objective}`;

  if (verbose && !localOnly) {
    return `
${heading}
${opening}

**Reviewers (in order)**: ${reviewerLabel}${equiv}.
${extraNotes.length ? '\n' + extraNotes.join('\n') + '\n' : ''}
**Run this loop UNTIL all configured reviewers are satisfied (or the stop mode triggers), capped at 10 iterations per reviewer:**

1. ${waitOrInvokeStep}
2. If there are unresolved review findings, fix them in this worktree, run the project's tests, commit (\`feat:\`/\`fix:\` prefix, no Co-Authored-By), push, and (for Copilot) resolve the addressed threads.
3. Re-review with the same reviewer until it reports clean, then advance to the next reviewer in the list.
${closingSteps.join('\n')}

**Hard stop:** if a reviewer's loop hasn't converged after 10 iterations, post a PR comment summarising the unresolved blockers and exit. Do not loop indefinitely.

${repeatedCommentsNote}

${challengeProtocolNote}

PR Details:
- **URL**: ${prUrl}
- **Branch**: \`${prBranch}\`
${prNumber !== '' ? `- **Number**: ${prNumber}` : ''}
${prOwner && prRepo ? `- **Repo**: ${prOwner}/${prRepo}` : ''}
- **Source task**: ${sourceTaskId}
- **Reviewers**: ${reviewerLabel}
${cliReviewerProcedure}${(rprBody && (hasCopilot || hasGithubUser)) ? `\n### /do:rpr Reference — Copilot / @github reviewers (full procedure)\n\nThis is the PR-comment review loop for the **copilot** and **@github** reviewers only (request a review on the PR, poll for comments, resolve threads).${cliReviewerProcedure ? ' It does NOT apply to the local CLI reviewers — for those, follow the **CLI Reviewer Procedure** above instead.' : ''}\n\n${rprBody}\n` : ''}`;
  }

  // Compact light-path variant.
  const compactOpening = localOnly
    ? opening
    : inline
    ? opening
    : `A previous agent finished task **${sourceTaskId}** and opened **PR ${prUrl}** on \`${prBranch}\`. ${initialReviewState} ${leaveOpen ? 'Drive the review-and-fix loop to completion — do NOT merge (JIRA-tracked; a human lands it).' : 'Drive the review-and-fix loop to completion and merge.'}`;
  const loopCompletionText = optionalConfiguredReviewers.length
    ? 'all required reviewers are satisfied and optional reviewers are satisfied or explicitly inconclusive (or the stop mode triggers)'
    : 'all configured reviewers are satisfied (or the stop mode triggers)';
  const hardStopNote = optionalConfiguredReviewers.length
    ? `**Hard stop:** if a required reviewer's loop is not converged after 10 rounds, ${localOnly ? 'do NOT push or open a PR/MR; report the unresolved blocker and exit.' : 'post a PR comment summarising blockers and exit.'} An optional reviewer may end with an inconclusive result without blocking, but a hard error, failed build/test, rejection, or push failure still blocks.`
    : `**Hard stop:** if a reviewer's loop is not converged after 10 rounds, ${localOnly ? 'do NOT push or open a PR/MR; report the unresolved blocker and exit.' : 'post a PR comment summarising blockers and exit.'}`;
  return [
    heading,
    compactOpening,
    `**Reviewers (in order)**: ${reviewerLabel}${equiv}.`,
    ...extraNotes,
    '',
    `**Loop UNTIL ${loopCompletionText}, capped at 10 iterations per reviewer:**`,
    `1. ${waitOrInvokeStep}`,
    '2. If unresolved findings: fix in this worktree, run tests, commit (`feat:`/`fix:` prefix, no Co-Authored-By)' + (localOnly ? ', then re-run the same local reviewer. Do NOT push or open a PR/MR yet.' : ', push' + (hasCopilot ? ', and (for Copilot) resolve the addressed threads.' : '.')),
    '3. Re-review with the same reviewer until clean, then advance to the next reviewer in the list.',
    ...closingSteps,
    '',
    hardStopNote,
    repeatedCommentsNote,
    '',
    challengeProtocolNote,
    cliReviewerProcedure
  ].filter(Boolean).join('\n');
}

/**
 * Build the local half of an inline review workflow. Local CLIs and local LLMs
 * can inspect the worktree directly, so they must finish before the branch is
 * pushed; forge-side reviewers remain in the post-PR section.
 */
export function buildLocalReviewLoopSection({
  taskId, branchName, baseBranch, localAgentLoopBody, localAgentLoopBodyPath = null,
  reviewers, optionalReviewers, reviewerMaxRounds, reviewerModels, reviewerEfforts, reviewStopMode, reviewerApplies, reviewerPositions = [],
}) {
  const localReviewers = (reviewers || []).filter(reviewer => isCliReviewer(reviewer) || LOCAL_LLM_REVIEWERS.includes(reviewer));
  if (!localReviewers.length) return '';
  return buildReviewLoopFollowUpSection({
    reviewLoopPRBranch: branchName || '<branch>',
    reviewLoopReviewers: localReviewers,
    reviewLoopOptionalReviewers: optionalReviewers,
    reviewLoopReviewerMaxRounds: reviewerMaxRounds,
    reviewLoopReviewerModels: reviewerModels,
    reviewLoopReviewerEfforts: reviewerEfforts,
    reviewLoopStopMode: reviewStopMode,
    reviewLoopReviewerApplies: reviewerApplies,
    sourceTaskId: taskId || 'unknown',
  }, { localAgentLoopBody, localAgentLoopBodyPath, localOnly: true, baseBranch, reviewerPositions });
}

/**
 * The step that replaces the merge steps when a PR is a human's to land — a
 * JIRA-tracked task whose ticket is already "In Review" (see
 * `lib/prDisposition.js`). Merging would land the work while the board still
 * shows it in review, and no completion path here can transition the ticket.
 */
export const LEAVE_PR_OPEN_STEP = (step, jiraTracked = false) => `${step}. **Leave the PR open — do NOT merge it.** ${jiraTracked
  ? 'This task is tracked in JIRA: its ticket is in review and a human lands the PR and the ticket together.'
  : 'This task is configured to stop after opening the PR so a human can inspect and land it.'} Report the PR URL in your summary and stop.`;

/**
 * The CI-gated merge procedure, in numbered steps starting at `startStep`.
 *
 * This is the single definition of "no reviewer is configured, so CI is the
 * merge gate" — shared by every flow that reaches it: the agent's own completion
 * workflow (slashdo TUI + Claude Code CLI via `buildPostPRMergeSteps`) and the
 * merge follow-up agent PortOS spawns when it opened the PR itself. They differ
 * only in how the PR is addressed and whether GitLab commands are offered, so
 * those are parameters rather than hand-written copies that drift.
 *
 * Ends on the same merge command + MERGED verification as the review-loop
 * contract (`buildReviewLoopFollowUpSection`): a true merge commit keeps the
 * branch tip in the base branch's history, which is what lets automated worktree
 * cleanup prove the branch landed.
 *
 * @param {number} startStep - number of the first emitted step.
 * @param {Object} opts
 * @param {string} opts.prRef - how to address the PR in `gh` commands, already
 *   quoted: the `"<PR_URL>"` placeholder before the PR exists, or the real URL.
 * @param {string} [opts.mrRef] - how to address the MR in `glab` commands.
 *   **`glab mr merge` selects by MR IID or source branch — NOT by URL**, so this
 *   is the number (or a `<MR_NUMBER>` placeholder), never `prRef`.
 * @param {'github'|'gitlab'|'unknown'} [opts.forge] - which CLI to name. PortOS
 *   opens GitLab MRs too (`git.createPR` falls back to `glab`), so a follow-up
 *   whose PR host is a GitLab instance must not be handed `gh` commands it can't
 *   run. Callers derive this with `detectForgeCli` — a GitHub Enterprise host is
 *   `github`, not "not github.com". `unknown` (the agent's own completion
 *   workflow, which runs before the PR exists) emits both, commented.
 * @returns {{lines: string[], nextStep: number}}
 */
export function buildCiMergeGateSteps(startStep, { prRef, mrRef = '<MR_NUMBER>', forge = 'github', alreadyMergedHint = ' (a saved `/do:pr` default can merge it for you)', localReviewers = [] }) {
  const gh = forge !== 'gitlab';
  const glab = forge !== 'github';
  const both = gh && glab;
  const localReviewNames = Array.isArray(localReviewers) && localReviewers.length
    ? localReviewers.map(reviewer => `\`${reviewer}\``).join(', ')
    : '';
  const localReviewAfterCodeFix = localReviewNames
    ? ` If a CI fix changes code, repeat the pre-PR local review phase for ${localReviewNames} against the new HEAD, using its same required/optional and stop-mode rules; commit and verify any reviewer fixes before pushing or merging.`
    : '';
  const localReviewRecheck = localReviewNames
    ? ` After that rebase, repeat the pre-PR local review phase for ${localReviewNames} against the new HEAD, using its same required/optional and stop-mode rules; commit and verify any fixes before pushing or merging.`
    : '';
  const checksCmd = gh
    ? `\`gh pr checks ${prRef} --watch --fail-fast --interval 30\`${glab ? ' (GitLab: `glab ci status`)' : ''}`
    : '`glab ci status`';
  const mergeableCmd = gh
    ? `\`gh pr view ${prRef} --json mergeable -q .mergeable\` reports \`CONFLICTING\`${glab ? ' (GitLab: `glab mr view ' + mrRef + '` shows a conflict)' : ''}`
    : `\`glab mr view ${mrRef}\` shows a conflict with the target branch`;
  const stateCmd = gh
    ? `\`gh pr view ${prRef} --json state -q .state\` must return \`MERGED\`${glab ? ' (GitLab: `glab mr view ' + mrRef + '` must show it merged)' : ''}`
    : `\`glab mr view ${mrRef}\` must show it merged`;
  const lines = [
    localReviewAfterCodeFix ? `**Code-changing CI fix gate:**${localReviewAfterCodeFix}` : null,
    `${startStep}. **Wait for CI to finish**: ${checksCmd}. "No checks reported" is AMBIGUOUS — a just-opened PR reports it while checks are still attaching, and merging on it races the CI this gate exists to wait for. Treat it as green ONLY when the repo genuinely has no CI (${gh ? '`gh workflow list` is empty / nothing in `.github/workflows` triggers on pull_request, and no external status check is configured' : 'no `.gitlab-ci.yml` and no pipeline is configured'}). If CI IS expected, wait 30s and re-check for up to 5 minutes — and if it still hasn't attached, **leave the PR open and say so**; never merge on checks that were expected but never appeared.`,
    `${startStep + 1}. **Clear whatever blocks the merge, then re-check.** If a check failed, read the failing job's log (${gh ? `\`gh run view --log-failed\`${glab ? ' on GitHub, `glab ci trace` on GitLab' : ''}` : '`glab ci trace`'}), fix the cause here, run the project's tests, commit (\`fix:\` prefix, no Co-Authored-By), push, and go back to the previous step — cap this at 5 rounds. If ${mergeableCmd}, \`git fetch origin\`, rebase onto the base branch, resolve the conflicts keeping BOTH sides' intent,${localReviewRecheck} re-run the tests, \`git push --force-with-lease\`, and re-check.`,
    `${startStep + 2}. **Merge** with exactly these flags, nothing else — a true merge commit keeps the branch tip in the base branch's history so automated worktree cleanup can prove the branch is merged, and any merge-deferral flag leaves the PR open after you exit. If it is already merged${alreadyMergedHint}, skip to the next step:`,
    '   ```bash',
    gh ? `   ${both ? '# GitHub:  ' : ''}gh pr merge ${prRef} --merge --delete-branch` : null,
    // `glab mr merge` takes an MR IID or source branch — a URL is not accepted.
    glab ? `   ${both ? '# GitLab:  ' : ''}glab mr merge ${mrRef} --yes --remove-source-branch` : null,
    '   ```',
    // Not every repo allows merge commits; a repo restricted to squash/rebase
    // rejects `--merge` outright, which would leave the PR open forever.
    gh ? `   If that is rejected because this repo disallows merge commits, re-check what it allows (\`gh repo view --json mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed\`) and merge with an allowed method instead — \`--squash\` first, else \`--rebase\` — keeping \`--delete-branch\`.` : null,
    `${startStep + 3}. **Confirm the merge before exiting**: ${stateCmd}. If it is still open or was closed unmerged, investigate (failing check, merge conflict, branch protection), fix, and retry. Leave it open — saying so explicitly in your completion summary — if CI stays red after a genuine fix attempt, a conflict needs a human decision, expected checks never attached, or a branch protection you cannot satisfy blocks the merge (a required approving review, a required check only a human can trigger). Hand those to a human rather than retrying until you time out.`,
  ].filter(Boolean);
  return { lines, nextStep: startStep + 4 };
}

/**
 * Build the **merge follow-up** section — the instructions for the agent
 * `spawnReviewLoopFollowUp` spawns when no reviewer survived resolution (Review
 * Loop off, or copilot-only on a non-GitHub forge). Nothing else will touch the
 * PR, so the merge gate is CI alone (`buildCiMergeGateSteps`).
 *
 * @param {Object} opts - PR coordinates + `verbose` (full/api path) vs compact.
 * @returns {string}
 */
function buildMergeFollowUpSection({ prUrl, prBranch, prNumber = '', prOwner = '', prRepo = '', prHost = '', sourceTaskId = 'unknown', verbose = false, inlineExitStep = null, forgeCli = null, inlineWorkflowStep = INLINE_REVIEW_LOOP_STEP, localReviewers = [] }) {
  const inline = inlineExitStep !== null;
  const hasLocalReview = Array.isArray(localReviewers) && localReviewers.length > 0;
  const localReviewLabel = hasLocalReview
    ? `The pre-PR local review for ${localReviewers.map(reviewer => `\`${reviewer}\``).join(', ')} has completed; no PR-side code reviewer is configured. The merge gate still re-runs that local review after any conflict rebase.`
    : 'No code review was requested for this task, so nothing else will merge this PR';
  // PortOS opens GitLab MRs via `glab` too, so a GitLab host must not be handed
  // `gh` commands (the host is persisted by spawnReviewLoopFollowUp). Classify
  // with the shared detector — a GitHub Enterprise host is still `gh`, which a
  // bare `host !== 'github.com'` test would get wrong.
  //
  // An INLINE gate has no persisted host to classify — its PR does not exist yet
  // — so the caller supplies the forge already selected for the create step.
  // Falling back to GitHub preserves the historical manual workflow when no
  // remote metadata is available.
  const gate = buildCiMergeGateSteps(1, {
    prRef: `"${prUrl}"`,
    mrRef: prNumber !== '' ? `${prNumber}` : '<MR_NUMBER>',
    forge: inline
      ? (normalizeForgeCli(forgeCli) === 'glab' ? 'gitlab' : 'github')
      : (detectForgeCli(prHost) === 'glab' ? 'gitlab' : 'github'),
    localReviewers,
    // An inline run reached this gate through plain `git`/`gh` — it never ran
    // `/do:pr`, so a saved slashdo merge default can't have landed the PR for it.
    alreadyMergedHint: inline ? '' : undefined,
  });
  const steps = [
    ...gate.lines,
    inline
      ? `${gate.nextStep}. ${inlineExitStep} ${hasLocalReview ? 'Do NOT start a second PR-side code review — the pre-PR local review is the only configured review.' : 'Do NOT start a code review — none is configured for this task.'}`
      : `${gate.nextStep}. Exit. Do NOT run \`/do:push\`, do NOT open a new PR, and ${hasLocalReview ? 'do NOT start a second PR-side code review — the pre-PR local review is the only configured review; ' : 'do NOT start a code review — '}landing this PR is the whole job.`,
  ];
  const prDetails = verbose ? [
    '',
    'PR Details:',
    `- **URL**: ${prUrl}`,
    `- **Branch**: \`${prBranch}\``,
    prNumber !== '' ? `- **Number**: ${prNumber}` : null,
    prOwner && prRepo ? `- **Repo**: ${prOwner}/${prRepo}` : null,
    `- **Source task**: ${sourceTaskId}`,
  ].filter(Boolean) : [];

  return [
    inline ? '## Merge Gate' : '## Merge Follow-up (PRIMARY OBJECTIVE)',
    inline
      ? `This runs as **step ${inlineWorkflowStep} of the Completion Workflow above**, against the PR you just opened on \`${prBranch}\` (\`${prUrl}\` / \`${prNumber}\` are the shell variables you captured there). **${localReviewLabel} Land it yourself once CI is green.**`
      : `A previous agent finished the work for source task **${sourceTaskId}** and opened **PR ${prUrl}** on \`${prBranch}\`. **${localReviewLabel} Your job is to land it once CI is green.**`,
    '',
    ...steps,
    '',
    '**Hard stop:** if CI is still red after 5 fix rounds, or a conflict needs a product decision you can\'t make, post a PR comment summarising exactly what is blocking the merge and exit with the PR left open. Do not force a merge over red CI.',
    ...prDetails,
  ].join('\n');
}
