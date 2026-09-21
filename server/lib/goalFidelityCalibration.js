/**
 * Goal-fidelity CALIBRATION contract — pure.
 *
 * `goalFidelity.js` owns the verdict, `goalFidelityFollowUp.js` owns what
 * happens when the verdict found a problem. This module owns the third case,
 * which until now had nowhere to go: the follow-up investigator looked at the
 * finding, checked it against what actually shipped, and concluded **the goal
 * WAS met — the detector was wrong**.
 *
 * That outcome is not a no-op. A false `rethink` held a successful run, raised
 * a Review Hub alert, possibly filed an issue on the project's tracker, and
 * spent an agent to discover it was nothing. It will keep doing that on every
 * future run with the same shape, because the reason it misjudged is structural
 * — the reviewer sees ONLY the objective and the diff (see
 * `services/codeReview.js#GOAL_FIDELITY_SYSTEM_PROMPT`), so anything the
 * delivery depended on that isn't in those two blocks is invisible to it. The
 * overturned finding is the only evidence that ever names which piece was
 * missing, and discarding it means re-discovering the same blind spot forever.
 *
 * So an overturned finding queues a task against PortOS's OWN repo to close the
 * gap. The existing prompt already carries one such patch, added by hand after
 * exactly this failure ("Claiming/selecting that issue, creating a worktree,
 * and shipping a PR are execution steps; do not require those steps to appear
 * as code in the diff") — this module is that loop, automated.
 *
 * TWO design points carry the feature:
 *
 *  1. The fingerprint is keyed on the GAP, not on the run. Ten false positives
 *     from one missing piece of context are ONE fix, and keying on the run
 *     would mint ten agents to make it. Keying on the gap folds them into one
 *     task, which the service then unions each further run into (see
 *     `goalFidelityCalibrationFingerprint`).
 *  2. The calibration lands on PORTOS, never on the app the finding was about.
 *     The finding belonged to the app; the judge that produced it is PortOS
 *     code. Filing the fix where the finding was would put a PortOS prompt
 *     change in a managed app's backlog, where nothing can act on it.
 *
 * NEARLY CLOSURE-FREE by design, like its sibling: both imports are zero-import
 * leaves (`textUtils.js`, `agentApiToken.js`). The `curl` block takes its API
 * base as an ARGUMENT rather than importing `networkExposure.js` — resolving a
 * loopback port is I/O, it would drag seven modules (TLS cert metadata,
 * Tailscale state) behind a constant, and it belongs to the service anyway.
 *
 * The vocabulary is enforced HERE and only here: `normalizeGoalFidelityContextGap`
 * is the single gate, and the report route takes a bounded string rather than
 * this enum. Two reasons, and the second is the one that keeps it that way.
 * Behaviour: a report is expensive — an agent investigated a finished run to
 * produce it — so a near-miss gap name folds to `other` with the diagnosis
 * intact instead of 400'ing the whole report away. Cost: `cosValidation.js` is
 * statically reached by 283 of the ~1,920 server suites, so importing this
 * module there to type one field would have added 283 module instantiations to
 * a tree-wide budget (`lib/importScoping.test.js`) for a check the normalizer
 * already performs. See server/AGENTS.md "Import scoping".
 */

import { agentApiAuthNote, agentApiCurl } from './agentApiToken.js';
import { trimTo } from './textUtils.js';

/**
 * What the reviewer was missing, as a closed vocabulary.
 *
 * Closed rather than free text because the vocabulary IS the dedup key: two
 * investigators describing the same blind spot in different prose would file
 * two tasks to make one fix. Each value names a distinct place the context
 * assembly can fail, and every value maps to a different file to edit — which
 * is what makes `GOAL_FIDELITY_CONTEXT_GAP_FIXES` below a usable starting point
 * rather than a restatement of the problem.
 *
 * - `truncated-diff`          — the change was larger than `MAX_FIDELITY_DIFF_CHARS`,
 *                               so the reviewer judged a fragment. The gate already
 *                               KNOWS this (`review.diffTruncated`); the bug is that
 *                               it judged anyway instead of declining.
 * - `truncated-objective`     — the objective was over `MAX_OBJECTIVE_CHARS` and the
 *                               requirement the diff delivered fell off the end.
 * - `objective-omits-context` — the objective pointed OUT of itself (an issue body, a
 *                               linked plan, a prior run's decision) and the reviewer
 *                               never received the thing it pointed at.
 * - `work-outside-diff`       — the delivery was real but invisible in the run-window
 *                               diff: already on the base branch, in a sibling branch,
 *                               a generated or git-ignored artifact, or a pure deletion.
 * - `execution-step-misread`  — the reviewer demanded process (claim the issue, open a
 *                               PR, merge) as code in the diff.
 * - `rubric-gap`              — the prompt's own rubric misjudged a legitimate shape: a
 *                               supporting change read as `unrequested`, real verification
 *                               read as absent, a refactor read as "something else".
 * - `other`                   — a gap none of the above describes. Files the same task;
 *                               the investigator's prose carries the diagnosis.
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
 * Addressed once, here, rather than re-spelled in every gap's advice. These are
 * prose pointers into code, so nothing compiles against them; describing one
 * surface seven times means a rename can leave four copies quietly lying to an
 * unattended agent, in a task whose whole value is "here is the shortest path to
 * the code". `goalFidelityCalibration.pointers.test.js` walks this table and
 * fails when a named file or exported symbol no longer exists.
 */
export const GOAL_FIDELITY_REVIEW_SURFACES = Object.freeze({
  objective: Object.freeze({
    file: 'server/lib/goalFidelity.js',
    symbol: 'taskObjective',
    describe: 'the OBJECTIVE block — `taskObjective()` in `server/lib/goalFidelity.js`, which composes the task\'s own `description` plus `taskContextBlock(task)` (`server/lib/cosTaskPrompt.js`) and nothing else, capped at `MAX_OBJECTIVE_CHARS`',
  }),
  diff: Object.freeze({
    file: 'server/services/agentFinalization.js',
    symbol: 'evaluateGoalFidelity',
    describe: 'the DIFF block — the run-window diff assembled by `evaluateGoalFidelity` in `server/services/agentFinalization.js`, capped at `MAX_FIDELITY_DIFF_CHARS`',
  }),
  rubric: Object.freeze({
    file: 'server/services/codeReview.js',
    symbol: 'GOAL_FIDELITY_SYSTEM_PROMPT',
    describe: 'the RUBRIC it judges them with — `GOAL_FIDELITY_SYSTEM_PROMPT` in `server/services/codeReview.js`',
  }),
});

/**
 * Which surface each gap sits on, and the one thing worth knowing about that
 * gap beyond the address.
 *
 * `surface: null` means all three — the `other` case, where the report's prose
 * is the only thing that narrows it.
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
    note: 'The rubric already carves out claim-flow execution steps. Extend that carve-out to the shape that was misread — narrowly, naming it, not by weakening the rubric.',
  }),
  'rubric-gap': Object.freeze({
    surface: 'rubric',
    note: 'The rubric defines what counts as missing, unrequested, and verified. Fix the specific misreading and pin it with a regression case.',
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
 * Bound on the investigator's free text, which rides into a queued task body.
 *
 * This is the EFFECTIVE limit, and deliberately below the report schema's own
 * caps: a report is expensive to produce (an agent investigated a finished run),
 * so an over-long field is trimmed here rather than 400'd away with the
 * diagnosis still inside it.
 */
export const GOAL_FIDELITY_CALIBRATION_FREE_TEXT_CHARS = 4_000;

/**
 * The dedup key for one calibration, keyed on the GAP ALONE.
 *
 * This is the design decision that makes the loop affordable. A false positive
 * is not an incident, it is a symptom of one structural blind spot, and that
 * blind spot fires on every run with the same shape — a scheduled task drifting
 * the same way produces one overturned finding per cadence. Keyed on the run
 * (or on the overturned finding's own fingerprint, which is keyed on the task)
 * every one of those would mint its own agent to make the SAME edit to the same
 * prompt, and the second one would land on a tree the first already changed.
 *
 * Keyed on the gap they all fold into one task, and the producer unions each
 * later report's run into it (`unionAffectedRun` in the service — `addTask`'s
 * own dedup returns the survivor untouched) — so the agent that picks it up
 * sees every run the gap cost, which is the evidence that tells it how far to go.
 *
 * Nothing about the app is in the key on purpose: the judge is one piece of
 * PortOS code shared by every app, so two apps hitting the same blind spot are
 * one fix, not two. The three-segment `category:kind:scope` shape matches every
 * other investigation key so the queued task participates in the shared loop
 * policy and circuit breaker for free.
 */
export function goalFidelityCalibrationFingerprint(gap) {
  return `${CALIBRATION_CATEGORY}:${CALIBRATION_KIND}:${normalizeGoalFidelityContextGap(gap)}`;
}

/**
 * Is this value still the `<…>` placeholder the report block handed the agent?
 *
 * The block gives the investigator a ready-to-run `curl` with every field
 * spelled as `<what the reviewer could not see, …>`. An agent that runs it
 * unchanged sends those literals, and without this they land in the calibration
 * body as if they were a diagnosis — a task that reads like a real report and
 * says nothing. Shape-matched rather than compared against the exact template
 * strings, so rewording the block cannot quietly stop detecting it.
 */
const isPlaceholder = (text) => /^<[^>]*>$/.test(String(text ?? '').trim());

/** One reported free-text field, or `''` when it is absent or still the template. */
export const reportedField = (text) => {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  return !trimmed || isPlaceholder(trimmed) ? '' : trimTo(trimmed, GOAL_FIDELITY_CALIBRATION_FREE_TEXT_CHARS);
};

/**
 * Did this report carry anything real at all?
 *
 * False only for the wholly-unfilled template: no recognized gap (so it
 * normalized to `other`) AND no usable detail or evidence. A partially-filled
 * report still queues — a named gap alone points at a file, which is more than
 * nothing — so this refuses the one case that is pure noise.
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
 * Written for an agent that has never seen the overturned finding, because it
 * has not: this task is queued from a REPORT, runs later, and may fold in
 * reports from runs that finished days apart. So it restates the diagnosis, and
 * it names the reviewer's whole context surface rather than assuming the agent
 * will find it.
 *
 * The scope contract is the load-bearing paragraph. The cheapest way to make a
 * false positive stop is to make the detector never say `rethink` again, and an
 * unattended agent optimizing for "this finding must not recur" will find that
 * path. So the task states the failure mode it must not produce and asks for
 * the regression test that proves it did not.
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
      // Rendered from the surface table rather than restated, so the addresses
      // here and the one the gap above points at cannot disagree — and so the
      // pointers test, which walks that table against the real files, covers
      // this list too.
      ...Object.values(GOAL_FIDELITY_REVIEW_SURFACES).map(surface => `- ${surface.describe};`),
    ].join('\n'),
    [
      '## What to do',
      'Close the named gap so a run of this shape is judged correctly, then prove it. The fix belongs in whichever of the three surfaces above actually produced the misjudgement — do not fix a context gap by editing the rubric, or a rubric gap by widening a cap.',
      '',
      '**Do not disarm the detector.** The cheap way to stop this false positive is to make the reviewer stop returning `rethink`, and that would silently give every future run a free pass — the exact failure the gate exists to catch (`server/lib/goalFidelity.js` opens with it). A change that broadens what counts as `ship`, weakens a hold, or removes a check is only acceptable when it names the shape it exempts, and it must exempt that shape and nothing wider.',
      '',
      '**Ship a regression test** that reconstructs this case and asserts the corrected judgement — a prompt/rubric change with no test pinning it is one rebase away from being reverted by the next person who reads it as noise.',
    ].join('\n'),
  ].join('\n\n');
}

/**
 * The path the prompt tells an agent to POST to — absolute, since the agent
 * types it into a `curl`.
 *
 * The route declares its own path relative to the `/api/cos` mount, so the two
 * cannot be one literal. They are pinned from both ends instead: the block test
 * asserts this string appears in the rendered `curl`, and the route test POSTs
 * to it — a rename that moves one without the other fails the second.
 */
export const GOAL_FIDELITY_FALSE_POSITIVE_PATH = '/api/cos/goal-fidelity/false-positive';

/**
 * The block appended to a follow-up task telling the investigator how to report
 * an overturned finding.
 *
 * Lives here, beside the vocabulary it names, so the enum an agent is told to
 * pick from and the enum the server normalizes against cannot drift apart.
 *
 * `apiBase` is an ARGUMENT because resolving the loopback base is I/O
 * (`localApiBaseUrl`), which belongs to the caller; the `curl` line and the
 * auth paragraph come from `agentApiToken.js`, which owns that shape for every
 * agent-facing API call in the tree.
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

