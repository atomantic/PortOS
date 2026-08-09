/**
 * Series Autopilot — pipeline self-improvement (opt-in meta-diagnosis).
 *
 * Every other gate in this conductor judges the STORY. This one judges the
 * AUTOMATION: when a run ends badly — or finishes carrying unhealthy telemetry —
 * it asks whether the failure is a content problem (the manuscript needs human
 * editorial work) or a PIPELINE problem (PortOS is missing an editorial step
 * earlier in the process, a stage prompt keeps producing unusable output, a
 * runner swallows a failure, a gate is misconfigured). On a pipeline verdict it
 * files a CoS task against PortOS itself so the automation gets fixed instead of
 * the same defect being re-diagnosed by hand on every series.
 *
 * Three properties keep this from becoming a spend/spam hazard:
 *
 *  1. **Opt-in, and signal-gated.** Off by default (`options.selfImprove`), and
 *     even when on, a run with clean telemetry never makes an LLM call —
 *     `shouldDiagnose` requires an actual bad signal (a pause, an error, a check
 *     that threw, a retried child, a filed craft gap, a skipped step).
 *  2. **One call per run, budget-gated.** The diagnosis is a single staged LLM
 *     call at the run's terminal, billed as one cos action and skipped when the
 *     daily budget is spent.
 *  3. **Deduped, approval-gated and worktree-isolated.** The filed task's first
 *     line is stable per (area, defect), so cosTaskStore's dedup collapses the
 *     same diagnosis across runs and series onto one open task. The task always
 *     awaits human approval, runs in a worktree, and opens a PR — an LLM's
 *     unverified read of one run's telemetry never dispatches a coding agent at
 *     PortOS's own source unattended. That matches every other autonomously
 *     generated code-editing task in PortOS (layeredIntelligence's
 *     `buildHandoffTask`, `autoFixer`, `agentErrorAnalysis` all hard-code
 *     `approvalRequired: true`); the autonomy dial for this class of work is the
 *     CoS approval queue, not a per-series checkbox.
 *
 * The signal log is captured passively: `noteSignal` taps the same SSE frames
 * the run already broadcasts (`session.js#broadcast`), so a new telemetry frame
 * becomes diagnosable evidence with no extra instrumentation.
 *
 * PRIVACY: the diagnosis prompt asks for a defect report about PortOS's code and
 * prompts, explicitly NOT about the story — and `shapeDiagnosis` bounds every
 * field — because the filed task is read by a coding agent that opens a public
 * PR. Manuscript text must not travel into that task.
 */

import { PORTOS_APP_ID } from '../../../lib/appIdentity.js';
import * as cosTaskStore from '../../cosTaskStore.js';
import { getDomainBudgetStatus, recordDomainUsage } from '../../domainUsage.js';
import { PR_COMPLETIONS } from '../../../lib/prDisposition.js';
import { runStagedLLM } from '../../../lib/stageRunner.js';
import { trimToClause } from '../../../lib/storyBible.js';
import { slugify } from '../../../lib/planIds.js';
import { getSettings } from '../../settings.js';
import { buildEditorialCheckPlan } from '../editorial/checkRunner.js';
import { getSeries } from '../series.js';
import { summarizeSignals } from './state.js';
import { broadcast, providerOverrideOpts } from './session.js';

const SELF_IMPROVE_STAGE = 'pipeline-self-improve';

/**
 * Does this run carry evidence worth spending a diagnosis call on? Pure.
 *
 * `outcome` is the run's terminal disposition: 'done' | 'paused' | 'error'. A
 * cancel is never diagnosed — the user stopped it, so there is no failure to
 * explain. A pause or an error always is. A `done` run only qualifies when its
 * telemetry says the automation limped: a check threw, a child had to be
 * retried/escalated, a step was skipped, or the advisory craft gate filed gaps.
 */
export function shouldDiagnose(record, outcome) {
  if (!record || record.options?.selfImprove !== true || record.mode !== 'execute') return false;
  if (outcome === 'paused' || outcome === 'error') return true;
  if (outcome !== 'done') return false;
  const rs = record.runState || {};
  if (rs.editorialCheckErroredIds?.size > 0) return true;
  if (rs.scriptCraftGapIssues?.size > 0) return true;
  return (record.signals || []).some((s) => (
    s.type === 'child:retry' || s.type === 'child:escalate' || s.type === 'step:skip'
    || (s.type === 'check:complete' && s.error)
  ));
}

// The verdict vocabulary. `pipeline` is the only one that files anything (and the
// only one this pass reports at all — see runSelfImproveDiagnosis); `content`
// means the manuscript, not the code, needs work, and `none` means the run's
// trouble was expected/benign.
const SELF_IMPROVE_VERDICTS = Object.freeze(['pipeline', 'content', 'none']);

// Where in PortOS the proposed fix belongs. Prefixes the filed task's dedup key
// (see buildSelfImproveTask) and tells a reader which part of the system the
// brief is about before they open it.
const SELF_IMPROVE_AREAS = Object.freeze([
  'editorial-check', 'pipeline-step', 'prompt', 'runner', 'config',
]);

// A diagnosis below this confidence is dropped rather than filed — a speculative
// "maybe the pipeline?" is not worth a coding agent's time.
export const SELF_IMPROVE_MIN_CONFIDENCE = 0.6;

/**
 * Sanitize the LLM's diagnosis into the fixed shape the rest of this module
 * relies on. Returns null when the payload can't be read as a verdict at all.
 * Pure.
 */
export function shapeDiagnosis(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const verdict = SELF_IMPROVE_VERDICTS.includes(raw.verdict) ? raw.verdict : null;
  if (!verdict) return null;
  const confidence = Number.isFinite(raw.confidence)
    ? Math.min(1, Math.max(0, raw.confidence))
    : 0;
  return {
    verdict,
    confidence,
    area: SELF_IMPROVE_AREAS.includes(raw.area) ? raw.area : 'pipeline-step',
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
 * Should this shaped diagnosis produce a CoS task? Pure — a pipeline verdict
 * that clears the confidence bar and actually says what to change.
 */
export function isFilable(diagnosis) {
  return !!diagnosis
    && diagnosis.verdict === 'pipeline'
    && diagnosis.confidence >= SELF_IMPROVE_MIN_CONFIDENCE
    && !!diagnosis.title
    && !!diagnosis.proposedChange;
}

/**
 * Shape the CoS task for a filable diagnosis. Pure, so the dedup key and the
 * agent-facing brief are testable without a task store.
 *
 * The FIRST LINE is the dedup key (cosTaskStore matches on it, lowercased,
 * scoped to the app), so it carries the area AND a slug of the diagnosis itself.
 * Area alone would be wrong in both directions: it is deliberately NOT
 * per-series (the defect lives in shared PortOS code, so one open task should
 * cover it however many series hit it), but keying on the bucket would cap
 * PortOS at one open task per area forever and silently discard the next,
 * different `editorial-check` defect — and a task that ends up `blocked` counts
 * as a duplicate too, which would mute that area permanently.
 */
export function buildSelfImproveTask({ diagnosis, seriesId, seriesName, outcome, outcomeReason, counts }) {
  const slug = slugify(diagnosis.title);
  const lines = [
    `Pipeline self-improvement (${diagnosis.area}/${slug}) — Series Autopilot diagnosed a PortOS automation defect`,
    '',
    `**${diagnosis.title}**`,
    '',
    diagnosis.problem,
    '',
    `Proposed change: ${diagnosis.proposedChange}`,
  ];
  if (diagnosis.risks) lines.push('', `Risks / things to be careful of: ${diagnosis.risks}`);
  lines.push(
    '',
    `Diagnosed from an autopilot run that ended \`${outcome}\`${outcomeReason ? ` — ${outcomeReason}` : ''}.`,
    'Confirm the defect in the code before changing anything: this brief is one LLM\'s read of a single run\'s telemetry, not a reproduction.',
  );
  const context = JSON.stringify({
    source: 'series-autopilot-self-improve',
    seriesId,
    seriesName,
    outcome,
    outcomeReason: trimToClause(outcomeReason, 500),
    area: diagnosis.area,
    confidence: diagnosis.confidence,
    evidence: diagnosis.evidence,
    signalCounts: counts,
  }).slice(0, 4000);
  return {
    description: lines.join('\n'),
    context,
    app: PORTOS_APP_ID,
    priority: 'MEDIUM',
    // Always isolated, always via a PR, always approval-gated — see the module
    // header. `approvalRequired` is honored only for internal tasks, which is
    // why this files as one.
    useWorktree: true,
    openPR: true,
    prCompletion: PR_COMPLETIONS.REVIEW_THEN_MERGE,
    simplify: true,
    approvalRequired: true,
  };
}

// The conductor's step order, as prose the diagnosis prompt can reason over when
// asked "is a step missing, and where would it go?". Mirrors resolveNextStep's
// STEP comments — a step added there should gain a line here so the model isn't
// told to add something that already exists.
const STEP_SEQUENCE = [
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

// The run's effective gate configuration, as the diagnosis context. Only the
// knobs that shape WHICH steps ran and how hard they tried — enough for the
// model to tell "this gate is off" from "this gate ran and failed".
const gateConfigOf = (options) => ({
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
 * Run the meta-diagnosis at a run's terminal and file a PortOS task when the
 * verdict says the automation is at fault.
 *
 * Runs BEFORE the terminal frame is broadcast, and its summary rides that frame
 * (and the persisted marker) rather than arriving after it: a client tears its
 * stream down on the terminal frame and SSE replays only the LAST payload, so a
 * post-terminal frame would be both unseen live and destructive to the replayed
 * terminal. The `selfimprove:start` frame is the live signal that the run is
 * spending one more beat on its post-mortem.
 *
 * Best-effort by contract: callers `.catch()` it, and a skip is silent — the
 * point is that a successful run must never be turned into a failure by its own
 * post-mortem. Returns null when nothing was diagnosed, else a compact summary.
 */
export async function runSelfImproveDiagnosis(sId, record, { outcome, reason = null } = {}) {
  if (!shouldDiagnose(record, outcome)) return null;

  const budget = await getDomainBudgetStatus('cos');
  if (!budget.withinBudget) return null;

  const [series, settings] = await Promise.all([
    getSeries(sId).catch(() => null),
    getSettings().catch(() => null),
  ]);
  const checkPlan = await buildEditorialCheckPlan(sId, { settings }).catch(() => null);
  const { signals, counts, dropped } = summarizeSignals(record);

  broadcast(sId, { type: 'selfimprove:start', runId: record.runId, outcome, signals: signals.length });

  const { content } = await runStagedLLM(SELF_IMPROVE_STAGE, {
    seriesName: series?.name || 'unknown',
    targetFormat: series?.targetFormat || 'unknown',
    outcome,
    outcomeReason: trimToClause(reason, 1000) || 'none',
    stepSequence: STEP_SEQUENCE,
    gateConfigJson: JSON.stringify(gateConfigOf(record.options || {}), null, 2),
    enabledChecks: (checkPlan?.checks || []).map((c) => `${c.id} (${c.kind})`).join(', ') || 'none',
    // One COMPACT frame per line, not a pretty-printed array: the frames are flat
    // and scalar-only, so indenting them puts every key on its own line and
    // roughly doubles the token count of the single expensive call this feature
    // makes. One object per line reads the same to the model at half the cost.
    signalsJson: signals.map((s) => JSON.stringify(s)).join('\n').slice(0, 40_000),
    signalCountsJson: JSON.stringify(counts, null, 2),
    droppedSignals: dropped,
    erroredChecks: [...(record.runState?.editorialCheckErroredIds || [])].join(', ') || 'none',
    craftGapIssues: record.runState?.scriptCraftGapIssues?.size || 0,
  }, { ...providerOverrideOpts(record), returnsJson: true, source: SELF_IMPROVE_STAGE });
  await recordDomainUsage('cos', { actions: 1 });

  const diagnosis = shapeDiagnosis(content);
  // Nothing filable → nothing to report. A `content` / `none` verdict means the
  // pipeline behaved, and a low-confidence guess is not worth a line of UI, so
  // the terminal frame and the marker stay clean rather than carrying a
  // "diagnosed nothing" payload no reader consumes. The log line is where an
  // operator can still see the pass ran.
  if (!isFilable(diagnosis)) {
    console.log(`🔧 autopilot self-improve — series=${sId.slice(0, 12)} nothing filed (verdict=${diagnosis?.verdict || 'unreadable'} confidence=${diagnosis?.confidence ?? '—'})`);
    return null;
  }

  const task = buildSelfImproveTask({
    diagnosis,
    seriesId: sId,
    seriesName: series?.name || null,
    outcome,
    outcomeReason: reason,
    counts,
  });
  const result = await cosTaskStore.addTask(task, 'internal')
    .catch((err) => { console.log(`⚠️ autopilot: self-improve filing failed: ${err.message}`); return null; });
  const filed = !!result && !result.duplicate;
  console.log(`🔧 autopilot self-improve — series=${sId.slice(0, 12)} area=${diagnosis.area} ${result ? (filed ? `filed ${result.id}` : 'duplicate of an open task') : 'filing failed'}`);
  return {
    verdict: diagnosis.verdict,
    area: diagnosis.area,
    title: diagnosis.title,
    // The durable pointer from "this run" to "that task" — the console line above
    // is not something a user can go read later.
    taskId: result?.id || null,
    filed,
    duplicate: !!result?.duplicate,
  };
}
