/**
 * Goal-fidelity CALIBRATION contract — pure.
 *
 * `goalFidelity.js` owns the verdict, `goalFidelityFollowUp.js` owns what happens when the verdict
 * found a problem. This module owns the case where the follow-up investigator concluded **the goal
 * WAS met — the detector was wrong**.
 *
 * The misjudgement is structural (the reviewer sees ONLY the objective and the diff, see
 * `services/goalFidelityReview.js#GOAL_FIDELITY_SYSTEM_PROMPT`), so it recurs on every run of the same
 * shape, and the overturned finding is the only evidence naming the missing piece. It therefore
 * queues a task against PortOS's OWN repo to close the gap.
 *
 * Design points:
 *
 *  1. The fingerprint is keyed on the GAP, not the run: ten false positives from one missing piece
 *     of context are ONE fix, and each further run is unioned into that task
 *     (see `goalFidelityCalibrationFingerprint`).
 *  2. The calibration lands on PORTOS, never on the app the finding was about; the judge is PortOS
 *     code, and a prompt change in a managed app's backlog could not be acted on.
 *
 * NEARLY CLOSURE-FREE by design: both imports are zero-import leaves (`textUtils.js`,
 * `agentApiToken.js`). The `curl` block takes its API base as an ARGUMENT rather than importing
 * `networkExposure.js`, which would drag seven modules (TLS cert metadata, Tailscale state) behind
 * a constant.
 *
 * The vocabulary is enforced HERE only: `normalizeGoalFidelityContextGap` is the single gate, and
 * the report route takes a bounded string rather than this enum. A near-miss gap name folds to
 * `other` with the diagnosis intact instead of 400'ing an expensive report away, and importing this
 * module from `cosValidation.js` (statically reached by most server suites) would blow the
 * tree-wide import budget (`lib/importScoping.test.js`; server/AGENTS.md "Import scoping").
 */

import { agentApiAuthNote, agentApiCurl } from './agent/agentApiToken.js';
import { trimTo } from './textUtils.js';

/**
 * What the reviewer was missing, as a closed vocabulary.
 *
 * Closed rather than free text because the vocabulary IS the dedup key: the same blind spot in
 * different prose would file two tasks for one fix. Each value names a distinct place the context
 * assembly can fail.
 *
 * - `truncated-diff`          — change larger than `MAX_FIDELITY_DIFF_CHARS`; the reviewer judged a fragment.
 * - `truncated-objective`     — objective over `MAX_OBJECTIVE_CHARS`; a delivered requirement fell off the end.
 * - `objective-omits-context` — objective pointed OUT of itself (issue body, linked plan, prior decision)
 *                               and the reviewer never received it.
 * - `work-outside-diff`       — delivery real but invisible in the run-window diff (already on base,
 *                               sibling branch, generated or git-ignored artifact, pure deletion).
 * - `execution-step-misread`  — reviewer demanded process (claim, PR, merge) as code in the diff.
 * - `rubric-gap`              — the rubric misjudged a legitimate shape (supporting change read as
 *                               `unrequested`, real verification read as absent).
 * - `other`                   — none of the above; the investigator's prose carries the diagnosis.
 */
export const GOAL_FIDELITY_CONTEXT_GAPS = Object.freeze([
  'truncated-diff',
  'truncated-objective',
  'objective-omits-context',
  'work-outside-diff',
  'execution-step-misread',
  'rubric-gap',
  'other',
]);

/** The gap a report gets when it named none, or named one we do not know. */
export const DEFAULT_GOAL_FIDELITY_CONTEXT_GAP = 'other';

/**
 * The reviewer's ENTIRE context, as three surfaces — and where each one lives.
 *
 * Addressed once here rather than re-spelled per gap: these are prose pointers nothing compiles
 * against, so `goalFidelityCalibration.pointers.test.js` walks this table and fails when a named
 * file or exported symbol no longer exists.
 */
export const GOAL_FIDELITY_REVIEW_SURFACES = Object.freeze({
  objective: Object.freeze({
    file: 'server/lib/goalFidelity.js',
    symbol: 'taskObjective',
    describe: 'the OBJECTIVE block — `taskObjective()` in `server/lib/goalFidelity.js`, which composes the task\'s own `description` and `taskContextBlock(task)` (`server/lib/cos/cosTaskPrompt.js`) within `MAX_OBJECTIVE_CHARS`, plus a marker for task screenshots whose separately bounded image content is passed to the local reviewer',
  }),
  diff: Object.freeze({
    file: 'server/services/agent/agentGoalFidelity.js',
    symbol: 'evaluateGoalFidelity',
    describe: 'the DIFF block — the run-window diff assembled by `evaluateGoalFidelity` in `server/services/agent/agentGoalFidelity.js`, capped at `MAX_FIDELITY_DIFF_CHARS`, which on a retry shares that cap with the change and commit messages an earlier attempt provably merged (`services/goalFidelityPriorDelivery.js`)',
  }),
  rubric: Object.freeze({
    file: 'server/services/goalFidelityReview.js',
    symbol: 'GOAL_FIDELITY_SYSTEM_PROMPT',
    describe: 'the RUBRIC it judges them with — `GOAL_FIDELITY_SYSTEM_PROMPT` in `server/services/goalFidelityReview.js`',
  }),
});

/**
 * Which surface each gap sits on, plus one note about it. `surface: null` means all three (`other`).
 */
export const GOAL_FIDELITY_CONTEXT_GAP_FIXES = Object.freeze({
  'truncated-diff': Object.freeze({
    surface: 'diff',
    note: 'The gate already KNOWS the diff was truncated (`runLocalGoalFidelityReview` refuses over the cap, and `review.diffTruncated` marks a partial one) — so the question is whether a truncated diff may produce a run-HOLDING verdict at all, or only an advisory one.',
  }),
  'truncated-objective': Object.freeze({
    surface: 'objective',
    note: 'Either the cap is wrong for this install\'s objectives, or the truncation drops the requirement-bearing part — prefer preserving the requirements over trailing prose to raising a fixed cap.',
  }),
  'objective-omits-context': Object.freeze({
    surface: 'objective',
    note: 'The objective referenced something the task carries elsewhere (an issue body, metadata, a linked plan). That is what has to be folded into the objective block — trusted, and still bounded.',
  }),
  'work-outside-diff': Object.freeze({
    surface: 'diff',
    note: 'Either the window missed real work (wrong base, wrong branch, excluded path) or the delivery genuinely is not a diff — in which case the gate needs to be able to say "not judgeable from a diff" instead of `rethink`.',
  }),
  'execution-step-misread': Object.freeze({
    surface: 'rubric',
    note: 'The rubric already carves out claim-flow execution steps. Extend that carve-out in general terms to the kind of execution step that was misread, not by weakening the rubric.',
  }),
  'rubric-gap': Object.freeze({
    surface: 'rubric',
    note: 'The rubric defines what counts as missing, unrequested, and verified. Correct the general rule that produced the misreading and pin it with a regression case.',
  }),
  other: Object.freeze({
    surface: null,
    note: 'None of the known gaps fit, so start from the whole context surface and let the diagnosis below narrow it.',
  }),
});

/** One gap's advice: where to look, then what to know. */
export const describeGoalFidelityContextGap = (gap) => {
  const { surface, note } = GOAL_FIDELITY_CONTEXT_GAP_FIXES[normalizeGoalFidelityContextGap(gap)];
  const where = surface
    ? `Look at ${GOAL_FIDELITY_REVIEW_SURFACES[surface].describe}.`
    : `Look at all three: ${Object.values(GOAL_FIDELITY_REVIEW_SURFACES).map(s => s.describe).join('; ')}.`;
  return `${where} ${note}`;
};

/** One reported gap, validated. Anything unknown becomes `other` rather than being dropped. */
export function normalizeGoalFidelityContextGap(value) {
  return GOAL_FIDELITY_CONTEXT_GAPS.includes(value) ? value : DEFAULT_GOAL_FIDELITY_CONTEXT_GAP;
}

/** `category` / `kind` segments of the shared `category:kind:scope` fingerprint. */
const CALIBRATION_CATEGORY = 'goal-fidelity-calibration';
const CALIBRATION_KIND = 'context-gap';

/**
 * Bound on the investigator's free text, which rides into a queued task body. This is the EFFECTIVE
 * limit, deliberately below the report schema's caps so an over-long field is trimmed, not 400'd.
 */
export const GOAL_FIDELITY_CALIBRATION_FREE_TEXT_CHARS = 4_000;

/**
 * The dedup key for one calibration, keyed on the GAP ALONE.
 *
 * A blind spot fires on every run of the same shape; keyed on the run or the task, each would mint
 * an agent making the SAME prompt edit. Keyed on the gap they fold into one task, and the producer
 * unions each later report's run into it (`unionAffectedRun` in the service, since `addTask`'s own
 * dedup returns the survivor untouched) so the agent sees every run the gap cost.
 *
 * No app in the key on purpose: the judge is shared PortOS code. The three-segment
 * `category:kind:scope` shape matches other investigation keys so the task joins the shared loop
 * policy and circuit breaker.
 */
export function goalFidelityCalibrationFingerprint(gap) {
  return `${CALIBRATION_CATEGORY}:${CALIBRATION_KIND}:${normalizeGoalFidelityContextGap(gap)}`;
}

/**
 * Is this value still the `<…>` placeholder the report block handed the agent?
 *
 * An agent that runs the block's `curl` unchanged sends the template literals, which would read as
 * a real diagnosis. Shape-matched rather than compared to the template strings so rewording the
 * block cannot silently stop detecting it.
 */
const isPlaceholder = (text) => /^<[^>]*>$/.test(String(text ?? '').trim());

/** One reported free-text field, or `''` when it is absent or still the template. */
export const reportedField = (text) => {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  return !trimmed || isPlaceholder(trimmed) ? '' : trimTo(trimmed, GOAL_FIDELITY_CALIBRATION_FREE_TEXT_CHARS);
};

/**
 * False only for the wholly-unfilled template (no recognized gap AND no usable detail or evidence);
 * a named gap alone still points at a file, so partial reports queue.
 */
export function goalFidelityReportIsSubstantive({ gap, detail, evidence } = {}) {
  return GOAL_FIDELITY_CONTEXT_GAPS.includes(gap)
    || Boolean(reportedField(detail))
    || Boolean(reportedField(evidence));
}

/** Bounded free text, or a stated absence — never a silent empty section. */
const reported = (text, empty) => reportedField(text) || empty;

/**
 * The CoS task body for one calibration.
 *
 * Written for an agent that has never seen the overturned finding (queued from a REPORT, run
 * later), so it restates the diagnosis and names the reviewer's whole context surface.
 *
 * The scope contract is load-bearing: an unattended agent optimizing for "this finding must not
 * recur" will disarm the detector or add a single-diff matcher (#16103), so the task confines the
 * fix to the general prompt or its evidence and demands a regression test.
 */
export function buildGoalFidelityCalibrationTask({ gap, detail, evidence, findingFingerprint, taskId, verdict } = {}) {
  const resolved = normalizeGoalFidelityContextGap(gap);
  const header = `[Auto] Goal-fidelity calibration (${resolved}): the reviewer judged a delivered objective as not delivered`;
  return [
    header,
    [
      '## What happened',
      `A goal-fidelity review returned **${verdict || 'a finding'}** on a finished agent run${taskId ? ` (task \`${taskId}\`)` : ''}, and the follow-up investigation overturned it: the objective WAS delivered. The run was held, and an agent was spent, for a judgement the evidence does not support.`,
      findingFingerprint ? `The overturned finding's own key was \`${findingFingerprint}\`.` : null,
    ].filter(Boolean).join('\n'),
    `## What the reviewer was missing\n**${resolved}** — ${describeGoalFidelityContextGap(resolved)}`,
    `## The investigator's diagnosis\n${reported(detail, '_The report named no detail beyond the gap._')}`,
    `## Evidence the objective was delivered\n${reported(evidence, '_The report cited no specific evidence._')}`,
    [
      '## The reviewer\'s entire context',
      'The goal-fidelity reviewer is a tool-free local model handed exactly two blocks and nothing else — no repository, no file list, no PR, no history. Anything a delivery depended on that is not in those two blocks is invisible to it:',
      '',
      // Rendered from the surface table so the pointers test covers this list too.
      ...Object.values(GOAL_FIDELITY_REVIEW_SURFACES).map(surface => `- ${surface.describe};`),
    ].join('\n'),
    [
      '## What to do',
      'Close the named gap so a run of this shape is judged correctly, then prove it. The fix belongs in whichever of the three surfaces above actually produced the misjudgement — do not fix a context gap by editing the rubric, or a rubric gap by widening a cap.',
      '',
      '**Edit only the general prompt or the evidence supplied to it.** Never add a matcher, classifier, extra prompt or extra review pass keyed to this case: no code that recognizes a specific diff, file path, function name or objective wording. A reviewer that special-cases past diffs does not generalize, and nobody can reason about such a matcher without the incident (#16103). State the correction as a rule any objective of this kind can use.',
      '',
      '**Do not disarm the detector.** The cheap way to stop this false positive is to make the reviewer stop returning `rethink`, and that would silently give every future run a free pass — the exact failure the gate exists to catch (`server/lib/goalFidelity.js` opens with it). A change that broadens what counts as `ship`, weakens a hold, or removes a check is only acceptable when it states the kind of shape it exempts in general terms, and it must exempt that kind and nothing wider.',
      '',
      '**Ship a regression test** that reconstructs this case and asserts the corrected judgement — a prompt/rubric change with no test pinning it is one rebase away from being reverted by the next person who reads it as noise.',
    ].join('\n'),
  ].join('\n\n');
}

/**
 * The path the prompt tells an agent to POST to — absolute, since the agent
 * types it into a `curl`.
 *
 * The route declares its path relative to the `/api/cos` mount, so they cannot be one literal;
 * the block test and the route test both pin this string.
 */
export const GOAL_FIDELITY_FALSE_POSITIVE_PATH = '/api/cos/goal-fidelity/false-positive';

/**
 * The block appended to a follow-up task telling the investigator how to report
 * an overturned finding.
 *
 * Lives beside the vocabulary it names so the enum agents pick from and the one the server
 * normalizes against cannot drift. `apiBase` is an ARGUMENT because resolving it is I/O
 * (`localApiBaseUrl`) owned by the caller.
 */
export function buildGoalFidelityFalsePositiveReportBlock({ apiBase, findingFingerprint, taskId } = {}) {
  const payload = JSON.stringify({
    gap: `<one of: ${GOAL_FIDELITY_CONTEXT_GAPS.join(' | ')}>`,
    detail: '<what the reviewer could not see, in one or two sentences>',
    evidence: '<file:line, commit, or PR that shows the objective WAS delivered>',
    ...(findingFingerprint ? { fingerprint: findingFingerprint } : {}),
    ...(taskId ? { taskId } : {}),
  });
  return [
    '## First: is the finding actually right?',
    'Check the objective against what shipped BEFORE changing anything. A goal-fidelity verdict is one local model\'s reading of a diff it saw without the repository, and it is wrong often enough that "reconcile it" is the wrong first move. If the objective was in fact delivered, do NOT ship a reconciliation — there is nothing to reconcile, and a change made to satisfy a false finding is a regression.',
    '',
    'Report the overturned finding instead, so the blind spot that produced it gets fixed rather than re-encountered:',
    '',
    '```bash',
    agentApiCurl({ apiBase, path: GOAL_FIDELITY_FALSE_POSITIVE_PATH, payload }),
    '```',
    '',
    agentApiAuthNote(),
    '',
    '`gap` is what the REVIEWER could not see, not what you did about it — it is what the queued calibration is keyed on, so pick the one that names the missing context. Reports sharing a gap fold into one calibration task. After reporting, complete any tracked issue resolution required by the investigation before finishing. Say in your summary that the finding was overturned and that you reported it, and ship nothing else.',
  ].join('\n');
}

/** One-line human summary of a calibration report, for a log line. */
export function formatGoalFidelityCalibrationSummary(result) {
  if (!result?.queued) {
    return `Goal-fidelity calibration not queued${result?.reason ? ` (${result.reason})` : ''}`;
  }
  const state = result.duplicate ? 'folded into' : result.approvalRequired ? 'queued for approval as' : 'queued as';
  return `Goal-fidelity calibration (${result.gap}) ${state} ${result.taskId}`;
}
