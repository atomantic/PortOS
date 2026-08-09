/**
 * Series Autopilot — shared diagnosis core for the two pipeline-improvement
 * passes: the self-improve post-mortem (`selfImprove.js`, human-approved) and
 * the observing orchestrator (`observer.js`, auto-dispatched).
 *
 * DELIBERATELY A LEAF: this module imports only `lib/` helpers — never
 * `./session.js`, `../series.js`, or anything else inside this package's known
 * import cycle (session → autoRunner → … → the barrel; see the barrel's TDZ
 * note). That is what lets both siblings dereference these exports at
 * module-evaluation time (`OBSERVER_AREAS` derives from `SELF_IMPROVE_AREAS`
 * with a spread) instead of each keeping a hand-mirrored copy. Keep it pure:
 * an import added here from inside the cycle re-introduces the TDZ crash this
 * module exists to avoid.
 *
 * What lives here is the shared CONTRACT — the verdict/area vocabulary, the
 * diagnosis shape, the evidence predicates, the prompt context both stage
 * templates consume, and the filed-task frame (dedup key + brief layout). The
 * POLICY deltas (confidence bars, approval, pass gating/windowing) stay in the
 * feature modules where they read as explicit decisions.
 */

import { PORTOS_APP_ID } from '../../../lib/appIdentity.js';
import { PR_COMPLETIONS } from '../../../lib/prDisposition.js';
import { trimToClause } from '../../../lib/storyBible.js';
import { slugify } from '../../../lib/planIds.js';

// The verdict vocabulary. `pipeline` is the only one that files anything;
// `content` means the manuscript, not the code, needs work, and `none` means
// the run's trouble was expected/benign.
const DIAGNOSIS_VERDICTS = Object.freeze(['pipeline', 'content', 'none']);

// Where in PortOS the proposed fix belongs. Prefixes the filed task's dedup key
// (see buildDiagnosisTask) and tells a reader which part of the system the
// brief is about before they open it. The observer extends this with `ui`.
export const SELF_IMPROVE_AREAS = Object.freeze([
  'editorial-check', 'pipeline-step', 'prompt', 'runner', 'config',
]);

/**
 * Sanitize the LLM's diagnosis into the fixed shape both passes rely on.
 * Returns null when the payload can't be read as a verdict at all. Pure.
 * `areas` is the accepted area vocabulary — the observer passes its extended
 * set; the default keeps the post-mortem's behavior unchanged.
 */
export function shapeDiagnosis(raw, areas = SELF_IMPROVE_AREAS) {
  if (!raw || typeof raw !== 'object') return null;
  const verdict = DIAGNOSIS_VERDICTS.includes(raw.verdict) ? raw.verdict : null;
  if (!verdict) return null;
  const confidence = Number.isFinite(raw.confidence)
    ? Math.min(1, Math.max(0, raw.confidence))
    : 0;
  return {
    verdict,
    confidence,
    area: areas.includes(raw.area) ? raw.area : 'pipeline-step',
    title: trimToClause(raw.title, 160),
    problem: trimToClause(raw.problem, 2000),
    evidence: Array.isArray(raw.evidence)
      ? raw.evidence.map((e) => trimToClause(e, 400)).filter(Boolean).slice(0, 8)
      : [],
    proposedChange: trimToClause(raw.proposedChange, 2000),
    risks: trimToClause(raw.risks, 800),
  };
}

/**
 * Should this shaped diagnosis produce work? Pure — a pipeline verdict that
 * clears the caller's confidence bar and actually says what to change. The bar
 * is a parameter because it is POLICY: the human-approved post-mortem accepts
 * more speculation than the auto-merging observer.
 */
export function isActionableDiagnosis(diagnosis, minConfidence) {
  return !!diagnosis
    && diagnosis.verdict === 'pipeline'
    && diagnosis.confidence >= minConfidence
    && !!diagnosis.title
    && !!diagnosis.proposedChange;
}

/**
 * Did the run's telemetry say the AUTOMATION limped — a check that threw, a
 * filed craft gap, a retried/escalated child, a skipped step? Pure.
 */
export function hasAutomationSignals(record) {
  const rs = record?.runState || {};
  if (rs.editorialCheckErroredIds?.size > 0) return true;
  if (rs.scriptCraftGapIssues?.size > 0) return true;
  return (record?.signals || []).some((s) => (
    s.type === 'child:retry' || s.type === 'child:escalate' || s.type === 'step:skip'
    || (s.type === 'check:complete' && s.error)
  ));
}

/**
 * Does a run terminal carry evidence worth spending a diagnosis call on? Pure.
 * A pause or an error always does; a cancel never (the user stopped it — there
 * is no failure to explain); a `done` run only when its telemetry says the
 * automation limped. Each pass composes this with its own enable predicate.
 */
export function terminalWarrantsDiagnosis(record, outcome) {
  if (outcome === 'paused' || outcome === 'error') return true;
  if (outcome !== 'done') return false;
  return hasAutomationSignals(record);
}

// The conductor's step order, as prose the diagnosis prompts can reason over
// when asked "is a step missing, and where would it go?". Mirrors
// resolveNextStep's STEP comments — a step added there should gain a line here
// so the model isn't told to add something that already exists.
export const STEP_SEQUENCE = [
  'generateArc — draft the whole-series arc + volumes',
  'generateEpisodes — break each volume into issues',
  'verifyArc — cross-volume synopsis continuity verify → resolve loop',
  'foundationGate — weighted judge of world/characters/arc before drafting',
  'beatSheet — per-volume beat sheets',
  'beatContinuity — whole-manuscript beat-level continuity loop',
  'textStages — per-issue prose + scripts',
  'scriptVerify — structural page/panel parse gate + advisory craft gate',
  'editorialReview — series-level manuscript completeness review → fix loop',
  'reverseOutline — refresh scene segmentation for the checks that consume it',
  'editorialChecks — registry-driven editorial checks (deterministic + LLM)',
  'editorialHealthGate — readiness gate over open blocking findings',
  'revisionCycle — opt-in iterate-to-quality adversarial cut + judge loop',
  'canonVerify — every drawn canon noun has a description',
  'visualDraft — queue draft renders for covers + interior pages',
  'produceTeaser — opt-in Creative Director teaser video',
].join('\n');

// The run's effective gate configuration, as diagnosis context. Only the knobs
// that shape WHICH steps ran and how hard they tried — enough for the model to
// tell "this gate is off" from "this gate ran and failed".
export const gateConfigOf = (options) => ({
  maxArcVerifyRounds: options.maxArcVerifyRounds,
  maxBeatContinuityRounds: options.maxBeatContinuityRounds,
  maxEditorialRounds: options.maxEditorialRounds,
  maxFoundationRounds: options.maxFoundationRounds,
  foundationGate: options.foundationGate,
  foundationThreshold: options.foundationThreshold,
  readinessGate: options.readinessGate,
  checkFindingsPauseThreshold: options.checkFindingsPauseThreshold,
  revisionEnabled: options.revisionEnabled,
  includeVisual: options.includeVisual,
  target: options.target,
});

/**
 * The prompt variables both diagnosis stage templates share. Pure over the run
 * record + pre-fetched context; each caller spreads its phase-specific vars
 * (`outcome`/`outcomeReason`, and the observer's `phase`/`priorFilings`) on
 * top. One builder so the encoding below can't drift between the two prompts.
 */
export function buildDiagnosisStageVars(record, { series, checkPlan, signals, counts, dropped }) {
  const rs = record.runState || {};
  return {
    seriesName: series?.name || 'unknown',
    targetFormat: series?.targetFormat || 'unknown',
    stepSequence: STEP_SEQUENCE,
    gateConfigJson: JSON.stringify(gateConfigOf(record.options || {}), null, 2),
    enabledChecks: (checkPlan?.checks || []).map((c) => `${c.id} (${c.kind})`).join(', ') || 'none',
    // One COMPACT frame per line, not a pretty-printed array: the frames are
    // flat and scalar-only, so indenting them puts every key on its own line
    // and roughly doubles the token count of the call. One object per line
    // reads the same to the model at half the cost.
    signalsJson: signals.map((s) => JSON.stringify(s)).join('\n').slice(0, 40_000),
    signalCountsJson: JSON.stringify(counts, null, 2),
    droppedSignals: dropped,
    erroredChecks: [...(rs.editorialCheckErroredIds || [])].join(', ') || 'none',
    craftGapIssues: rs.scriptCraftGapIssues?.size || 0,
  };
}

// Ceiling on the observer's per-run filing log — shared with the marker
// sanitizer in ../series.js so the wire cap and the producer cap can't drift.
export const DIAGNOSIS_MAX_FILED = 5;

/**
 * Shape the CoS task for an actionable diagnosis. Pure, so the dedup key and
 * the agent-facing brief are testable without a task store. The callers supply
 * the wording deltas (`descriptionPrefix`, `leadLine`, `tailLines`) and the ONE
 * policy bit that separates the passes (`approvalRequired`).
 *
 * `description` is ONE LINE, and that is a hard requirement, not a style
 * choice: `generateTasksMarkdown` writes the description verbatim into a single
 * `- [ ] #id | PRIORITY | <description>` row (only *metadata* values go through
 * `escapeNewlines`). A multi-line description therefore spills its tail into
 * TASKS.md as stray un-parsed lines AND is truncated to its first line on the
 * next read — silently dropping the entire brief, so the agent would receive a
 * defect report with no defect in it. The brief lives in `context`, which is
 * newline-escaped and round-trips intact.
 *
 * That one line is also the dedup key (cosTaskStore matches on it, lowercased,
 * scoped to the app), so it carries the area AND a slug of the diagnosis
 * itself. Area alone would be wrong in both directions: it is deliberately NOT
 * per-series (the defect lives in shared PortOS code, so one open task should
 * cover it however many series hit it), but keying on the bucket would cap
 * PortOS at one open task per area forever and silently discard the next,
 * different defect in it — and a task that ends up `blocked` counts as a
 * duplicate too, which would mute that area permanently. The slug is the
 * kebab-cased title, so the row stays readable in TASKS.md.
 */
export function buildDiagnosisTask({ diagnosis, descriptionPrefix, leadLine, tailLines, approvalRequired }) {
  const slug = slugify(diagnosis.title);
  const brief = [
    leadLine,
    '',
    diagnosis.problem,
    '',
    `Proposed change: ${diagnosis.proposedChange}`,
  ];
  if (diagnosis.risks) brief.push('', `Risks / things to be careful of: ${diagnosis.risks}`);
  if (diagnosis.evidence.length) {
    brief.push('', 'Evidence from the run telemetry:', ...diagnosis.evidence.map((e) => `- ${e}`));
  }
  brief.push('', ...tailLines);
  return {
    description: `${descriptionPrefix} (${diagnosis.area}/${slug})`,
    context: brief.join('\n').slice(0, 4000),
    app: PORTOS_APP_ID,
    priority: 'MEDIUM',
    useWorktree: true,
    openPR: true,
    prCompletion: PR_COMPLETIONS.REVIEW_THEN_MERGE,
    simplify: true,
    approvalRequired,
  };
}
