/**
 * Writers Room — autonomous multi-pass Polish loop (#2173, CWQE Phase 9).
 *
 * Brings the pipeline's cut → revise → gate quality loop to a single Writers
 * Room work. Each cycle:
 *   1. evaluate  — score the current body (reuses the `evaluate` stage).
 *   2. cuts      — adversarial cut pass; apply only SAFE cuts (OVER-EXPLAIN +
 *                  REDUNDANT) mechanically via the pipeline's applyCuts helpers.
 *   3. revise    — brief-driven rewrite of the cut body (old draft as raw
 *                  material + a WHAT TO KEEP section so good material survives).
 *   4. re-evaluate + gate — keep the revision only if it improved the score,
 *                  else revert. Plateau/regression stops the loop early.
 *
 * The loop is USER-TRIGGERED ONLY (an explicit POST from the work page) — it is
 * never fired from server boot or any background job, per the AI-provider policy.
 * Progress streams over SSE (createSseRunner); every distinct kept body state is
 * snapshotted immutably (polishStore.js) so the whole run is revertible.
 */

import { createSseRunner } from '../../lib/sseUtils.js';
import { runStagedLLM, extractJson } from '../../lib/stageRunner.js';
import {
  scoreEvaluation, decideKeepRevert, shouldStopPolish, resolveCycles,
  SAFE_POLISH_CUT_TYPES, POLISH_DEFAULTS,
} from '../../lib/writersRoomPolish.js';
import { planCutsForSection, applyCutsToText } from '../pipeline/applyCuts.js';
import { getWorkWithBody, saveDraftBody } from './local.js';
import { KIND_META, buildWorkContext, evaluateProse } from './evaluator.js';
import { writeSnapshot, appendPolishRun } from './polishStore.js';
import { nowIso } from './_shared.js';

// Re-export the storage surface the route needs so it has a single import site.
export { getPolishHistory, revertToSnapshot, listSnapshots } from './polishStore.js';

const runner = createSseRunner({ logLabel: 'wr polish' });

export const attachClient = (workId, res) => runner.attachClient(workId, res);
export const isPolishActive = (workId) => runner.isActive(workId);
export const cancelPolish = (workId) => runner.cancel(workId);

// ---------- prompt-input builders (pure) ----------

// The revise stage's WHAT TO KEEP block: the evaluation's strengths + logline,
// so a rewrite doesn't sand off what already works. Falls back to a generic
// preservation note when the evaluation surfaced no explicit strengths.
export function buildKeepGuidance(evaluation) {
  const lines = [];
  if (typeof evaluation?.logline === 'string' && evaluation.logline.trim()) {
    lines.push(`- Core story: ${evaluation.logline.trim()}`);
  }
  for (const s of Array.isArray(evaluation?.strengths) ? evaluation.strengths : []) {
    if (typeof s === 'string' && s.trim()) lines.push(`- ${s.trim()}`);
  }
  if (lines.length === 0) {
    return "- The draft's existing voice, plot beats, character moments, and structure.";
  }
  return lines.join('\n');
}

// The revise stage's revision brief: the evaluation's open issues + suggestions,
// rendered as an actionable checklist. Empty → a light-copy-edit instruction so
// the model doesn't invent changes.
export function buildRevisionBrief(evaluation) {
  const lines = [];
  for (const iss of Array.isArray(evaluation?.issues) ? evaluation.issues : []) {
    if (!iss || typeof iss !== 'object') continue;
    const sev = typeof iss.severity === 'string' ? iss.severity.toUpperCase() : 'ISSUE';
    const cat = typeof iss.category === 'string' ? ` ${iss.category}` : '';
    const note = typeof iss.note === 'string' ? iss.note.trim() : '';
    if (note) lines.push(`- [${sev}${cat}] ${note}`);
  }
  for (const sug of Array.isArray(evaluation?.suggestions) ? evaluation.suggestions : []) {
    if (!sug || typeof sug !== 'object') continue;
    const rec = typeof sug.recommendation === 'string' ? sug.recommendation.trim() : '';
    if (rec) lines.push(`- ${rec}`);
  }
  if (lines.length === 0) {
    return '- No specific issues flagged — perform a light copy-edit only; tighten obvious wordiness.';
  }
  return lines.join('\n');
}

// Strip an accidental markdown fence / preamble from a returnsJson:false prose
// response (mirrors evaluator SHAPERS.format's fence handling).
function cleanProse(raw) {
  let text = String(raw ?? '').trim();
  const fence = text.match(/^```(?:markdown|md|text)?\s*([\s\S]*?)```$/);
  if (fence) text = fence[1].trim();
  return text;
}

// ---------- passes ----------

async function runCutsPass(body, work) {
  const { content } = await runStagedLLM(
    KIND_META.cuts.stage,
    { work, draftBody: body, returnsJson: true },
    { source: 'writers-room-cuts' },
  );
  const parsed = extractJson(content);
  const findings = Array.isArray(parsed?.findings) ? parsed.findings : [];
  // Map the cut findings onto the applyCuts contract ({ anchorQuote, subtype })
  // and apply ONLY the safe types mechanically — the same OVER-EXPLAIN +
  // REDUNDANT subset the pipeline auto-applies.
  const cuts = findings.map((f) => ({ anchorQuote: f?.anchorQuote, subtype: f?.cutType }));
  const { applicable, refused } = planCutsForSection(body, cuts, {
    safeTypesOnly: true,
    allowTypes: SAFE_POLISH_CUT_TYPES,
  });
  const newBody = applicable.length > 0 ? applyCutsToText(body, applicable) : body;
  return { body: newBody, findings: findings.length, applied: applicable.length, refused: refused.length };
}

async function runRevisePass(body, evaluation, work) {
  const { content } = await runStagedLLM(
    KIND_META.revise.stage,
    {
      work,
      draftBody: body,
      keepGuidance: buildKeepGuidance(evaluation),
      revisionBrief: buildRevisionBrief(evaluation),
      returnsJson: false,
    },
    { source: 'writers-room-revise' },
  );
  const revised = cleanProse(content);
  // A model that returns an empty body must NOT wipe the draft — fall back to
  // the input body so a degenerate response is treated as "no change".
  return { body: revised && revised.trim() ? revised : body };
}

// ---------- runner ----------

/**
 * Kick off a Polish run for a work. Returns `{ runId, alreadyRunning }`
 * immediately; progress lands via SSE. Re-calling while a run is in flight
 * resolves to the existing runId.
 */
export function startPolish(workId, opts = {}) {
  const cycles = resolveCycles(opts.cycles);
  const minKeepDelta = Number.isFinite(opts.minKeepDelta) ? opts.minKeepDelta : POLISH_DEFAULTS.minKeepDelta;
  const plateauDelta = Number.isFinite(opts.plateauDelta) ? opts.plateauDelta : POLISH_DEFAULTS.plateauDelta;

  return runner.start(workId, async ({ runId, record, broadcast }) => {
    const startedMs = Date.now();
    const startedAt = nowIso();
    const { manifest, body: originalBody } = await getWorkWithBody(workId);
    if (!originalBody || !originalBody.trim()) {
      broadcast({ type: 'error', runId, error: 'Cannot polish an empty draft — write some prose first' });
      return;
    }
    const draft = (manifest.drafts || []).find((d) => d.id === manifest.activeDraftVersionId);
    const work = buildWorkContext(manifest, draft);

    broadcast({ type: 'start', runId, cycles, wordCount: work.wordCount });

    // Baseline evaluation + immutable pre-polish snapshot (the safety point).
    const baseEval = await evaluateProse({ body: originalBody, work });
    const baselineScore = scoreEvaluation(baseEval.result);
    const baseline = await writeSnapshot(workId, { body: originalBody, label: 'Pre-polish', score: baselineScore });
    broadcast({ type: 'baseline', runId, score: baselineScore, snapshotId: baseline.id });
    console.log(`✨ wr polish start work=${workId.slice(0, 14)}… cycles=${cycles} baseline=${baselineScore}`);

    let currentBody = originalBody;
    let currentScore = baselineScore;
    let currentEval = baseEval.result;
    let finalSnapshotId = baseline.id;
    let stopReason = 'max-cycles';
    const cycleLog = [];

    for (let cycle = 1; cycle <= cycles; cycle += 1) {
      if (record.cancelRequested) { stopReason = 'canceled'; break; }
      const cycleMs = Date.now();
      const beforeScore = currentScore;
      broadcast({ type: 'cycle:start', runId, cycle, cycles, beforeScore });

      // 1. cuts (mechanical, safe subset)
      const cuts = await runCutsPass(currentBody, work);
      if (record.cancelRequested) { stopReason = 'canceled'; break; }
      broadcast({ type: 'cycle:cuts', runId, cycle, applied: cuts.applied, refused: cuts.refused, findings: cuts.findings });

      // 2. revise (brief-driven, uses the current evaluation)
      const revised = await runRevisePass(cuts.body, currentEval, work);
      if (record.cancelRequested) { stopReason = 'canceled'; break; }
      broadcast({ type: 'cycle:revise', runId, cycle });

      // 3. re-evaluate + gate
      const afterEval = await evaluateProse({ body: revised.body, work });
      const afterScore = scoreEvaluation(afterEval.result);
      const decision = decideKeepRevert(beforeScore, afterScore, { minKeepDelta });

      let snapshotId = null;
      if (decision.keep) {
        const snap = await writeSnapshot(workId, { body: revised.body, label: `Cycle ${cycle}`, score: afterScore });
        snapshotId = snap.id;
        finalSnapshotId = snap.id;
        currentBody = revised.body;
        currentScore = afterScore;
        currentEval = afterEval.result;
      }

      const entry = {
        cycle,
        beforeScore,
        afterScore,
        kept: decision.keep,
        delta: decision.delta,
        reason: decision.reason,
        applied: cuts.applied,
        refused: cuts.refused,
        snapshotId,
        ms: Date.now() - cycleMs,
      };
      cycleLog.push(entry);
      broadcast({ type: 'cycle:complete', runId, ...entry });
      console.log(`✨ wr polish cycle ${cycle}/${cycles} work=${workId.slice(0, 14)}… ${decision.keep ? 'kept' : 'reverted'} before=${beforeScore} after=${afterScore} Δ=${decision.delta ?? '—'} (${entry.ms}ms)`);

      const stop = shouldStopPolish({ cycle, cycles, kept: decision.keep, delta: decision.delta, plateauDelta });
      if (stop.stop) { stopReason = stop.reason; break; }
    }

    const canceled = record.cancelRequested;
    const changed = currentBody !== originalBody;
    // Persist the final kept body to the active draft only if a cycle improved
    // it AND the run wasn't canceled mid-flight (a canceled run leaves the draft
    // exactly as the user left it — every kept state is still in snapshots).
    if (changed && !canceled) {
      await saveDraftBody(workId, currentBody);
    }

    const durationMs = Date.now() - startedMs;
    await appendPolishRun(workId, {
      id: runId,
      startedAt,
      completedAt: nowIso(),
      status: canceled ? 'canceled' : 'complete',
      stopReason: canceled ? 'canceled' : stopReason,
      requestedCycles: cycles,
      baselineSnapshotId: baseline.id,
      baselineScore,
      finalSnapshotId,
      finalScore: currentScore,
      keptCycles: cycleLog.filter((c) => c.kept).length,
      changed: changed && !canceled,
      cycles: cycleLog,
      durationMs,
    });

    broadcast({
      type: canceled ? 'canceled' : 'complete',
      runId,
      baselineScore,
      finalScore: currentScore,
      changed: changed && !canceled,
      keptCycles: cycleLog.filter((c) => c.kept).length,
      snapshotId: finalSnapshotId,
      stopReason: canceled ? 'canceled' : stopReason,
      completedAt: nowIso(),
      durationMs,
    });
    console.log(`✨ wr polish ${canceled ? 'canceled' : 'complete'} work=${workId.slice(0, 14)}… baseline=${baselineScore} final=${currentScore} changed=${changed && !canceled} reason=${stopReason} (${durationMs}ms)`);
  });
}

// Export internals for tests.
export const __testing = { runs: runner.runs };
