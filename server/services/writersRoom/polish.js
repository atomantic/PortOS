/**
 * Writers Room — autonomous "Polish" loop (CWQE Phase 9, #2173).
 *
 * Brings the pipeline's adversarial quality loop to a single freeform Writers
 * Room work: evaluate → cuts → apply safe cuts → revise → re-evaluate →
 * keep/revert, for a configurable number of cycles with plateau-stop. Composes
 * the #2168 cut applier (via the shared server/lib/editorial/cutApplier.js) and
 * the `evaluate`/`cuts`/`revise` prose passes (evaluator.js `KIND_META`).
 *
 * AI-provider policy: the loop only runs from the explicit user-triggered
 * `POST /works/:id/polish/start` action — never from boot or a background job.
 *
 * Revertibility: every cycle writes an IMMUTABLE body snapshot under
 * data/writers-room/works/<id>/snapshots/ before mutating the active draft, so
 * the keep/revert gate (and a manual UI revert) can always restore prior prose.
 */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { readFile, readdir } from 'fs/promises';
import { PATHS, atomicWrite, ensureDir, safeJSONParse } from '../../lib/fileUtils.js';
import { createSseRunner } from '../../lib/sseUtils.js';
import { computeSlopPenalty } from '../../lib/editorial/slopScore.js';
import { planCutsForSection, applyCutsToText, SAFE_CUT_TYPES } from '../../lib/editorial/cutApplier.js';
import { runProsePass } from './evaluator.js';
import { getWorkWithBody, saveDraftBody, countWords } from './local.js';
import { nowIso, badRequest, notFound, assertValidWorkId, wrWorkDir } from './_shared.js';

// ---------- tunables ----------

export const DEFAULT_CYCLES = 1;
export const MAX_CYCLES = 3;
// Stop early once a cycle's kept-quality gain drops below this (autonovel's
// Δ-plateau convergence, scaled for a single work rather than a whole series).
export const DEFAULT_PLATEAU_THRESHOLD = 0.5;
export const DEFAULT_CUT_TARGET_PERCENT = 10;
export const DEFAULT_MIN_CUTS = 8;
export const DEFAULT_MAX_CUTS = 20;

const SNAP_ID_RE = /^wr-snap-[0-9a-f-]+$/i;

// ---------- pure scoring / decision helpers (unit-tested) ----------

// Weighted issue penalty from an `evaluate` pass, mapped to a 0–100 score
// (higher = cleaner). Severities follow the evaluate prompt's contract.
export const SEVERITY_WEIGHT = Object.freeze({ major: 3, moderate: 2, minor: 1 });

export function scoreEvaluation(result) {
  const issues = Array.isArray(result?.issues) ? result.issues : [];
  const penalty = issues.reduce((sum, i) => sum + (SEVERITY_WEIGHT[i?.severity] ?? 1), 0);
  return Math.max(0, 100 - penalty);
}

/**
 * Composite quality score: the LLM evaluate score minus the free deterministic
 * "AI slop" penalty (autonovel's dual immune system — the mechanical layer
 * catches what the judge normalizes away). Higher is better.
 */
export function computeQualityScore(evaluateResult, body) {
  return Math.round((scoreEvaluation(evaluateResult) - computeSlopPenalty(body || '')) * 100) / 100;
}

// Keep the revision only if it did not regress the composite score, else revert
// the cycle's snapshot. Ties keep the new draft (the loop made forward progress
// on cuts even at an equal score).
export function decideKeepRevert(preScore, postScore) {
  return postScore >= preScore ? 'keep' : 'revert';
}

// Converged when the kept-quality gain for this cycle is below the plateau
// threshold — a reverted cycle (gain 0) always plateaus.
export function shouldStopPlateau(preScore, keptScore, threshold = DEFAULT_PLATEAU_THRESHOLD) {
  return Math.abs(keptScore - preScore) < threshold;
}

// Map shaped `cuts` findings to the applier's `{ anchorQuote, subtype }` shape.
export function mapFindingsToCuts(findings) {
  return (Array.isArray(findings) ? findings : [])
    .filter((f) => f && typeof f.anchorQuote === 'string' && f.anchorQuote.trim() && f.cutType)
    .map((f) => ({ anchorQuote: f.anchorQuote, subtype: f.cutType }));
}

/**
 * Build the revision brief the `revise` pass rewrites against — PROBLEM /
 * WHAT TO KEEP / WHAT TO CHANGE / VOICE RULES / TARGET, composed from the
 * evaluate result and the cut pass. The WHAT TO KEEP section (strengths +
 * protected passage) is what stops the rewrite from destroying good material.
 * Pure — no I/O — so the composition is unit-testable.
 */
export function buildRevisionBrief({ evaluate = {}, cuts = {}, wordCount = 0 } = {}) {
  const lines = [];
  const issues = Array.isArray(evaluate.issues) ? evaluate.issues : [];
  const strengths = Array.isArray(evaluate.strengths) ? evaluate.strengths : [];
  const suggestions = Array.isArray(evaluate.suggestions) ? evaluate.suggestions : [];
  const themes = Array.isArray(evaluate.themes) ? evaluate.themes : [];
  // Cut findings NOT auto-applied (non-safe types) still describe fat to trim
  // by hand during the rewrite.
  const residualCuts = (Array.isArray(cuts.findings) ? cuts.findings : [])
    .filter((f) => f.cutType && !SAFE_CUT_TYPES.includes(f.cutType));

  lines.push('## PROBLEM');
  if (issues.length === 0 && residualCuts.length === 0) {
    lines.push('- No blocking issues flagged — tighten and sharpen without changing the story.');
  }
  for (const i of issues.slice(0, 8)) {
    lines.push(`- (${i.severity || 'note'}/${i.category || 'general'}) ${i.note || ''}`.trimEnd());
  }
  for (const c of residualCuts.slice(0, 8)) {
    lines.push(`- (cut/${c.cutType}) ${c.problem || 'Trim this passage.'} — "${(c.anchorQuote || '').slice(0, 120)}"`);
  }
  if (cuts.loosestPassage) {
    lines.push(`- Worst offender to tighten: "${String(cuts.loosestPassage).slice(0, 160)}"`);
  }

  lines.push('', '## WHAT TO KEEP');
  if (cuts.tightestPassage) {
    lines.push(`- Protected passage — do NOT cut or weaken: "${String(cuts.tightestPassage).slice(0, 200)}"`);
  }
  for (const s of strengths.slice(0, 6)) lines.push(`- ${s}`);
  if (strengths.length === 0 && !cuts.tightestPassage) {
    lines.push('- Preserve the strongest imagery, voice, and any dialogue that reveals character.');
  }

  lines.push('', '## WHAT TO CHANGE');
  if (suggestions.length === 0) {
    lines.push('- Cut over-explanation and redundancy; let action and dialogue carry the meaning.');
  }
  for (const s of suggestions.slice(0, 8)) {
    lines.push(`- ${s.target ? `[${s.target}] ` : ''}${s.recommendation || ''}`.trimEnd());
  }

  lines.push('', '## VOICE RULES');
  if (evaluate.logline) lines.push(`- Keep the logline true: ${evaluate.logline}`);
  if (themes.length) lines.push(`- Preserve the established themes: ${themes.join(', ')}`);
  lines.push('- Match the existing narrative voice, tense, and POV exactly.');

  lines.push('', '## TARGET');
  lines.push(`- Aim for roughly ${wordCount} words — tightened. Do NOT pad back the fat that was cut.`);

  return lines.join('\n');
}

// ---------- snapshot storage ----------

const snapshotsDir = (workId) => {
  assertValidWorkId(workId);
  return join(wrWorkDir(workId), 'snapshots');
};
const snapshotPath = (workId, id) => join(snapshotsDir(workId), `${id}.json`);

function buildSnapshot({ workId, cycle, phase, label, body, evaluate = null, qualityScore = null }) {
  return {
    id: `wr-snap-${randomUUID()}`,
    workId,
    cycle,
    phase: phase || null,
    label: label || null,
    wordCount: countWords(body || ''),
    qualityScore,
    // Keep a compact echo of the evaluate result so the history UI can show the
    // score breakdown without re-running a pass.
    evaluate: evaluate ? { issues: evaluate.issues || [], strengths: evaluate.strengths || [] } : null,
    body: String(body ?? ''),
    createdAt: nowIso(),
  };
}

async function saveSnapshot(workId, snap) {
  await ensureDir(snapshotsDir(workId));
  await atomicWrite(snapshotPath(workId, snap.id), snap);
  return snap;
}

const summarizeSnapshot = (s) => ({
  id: s.id,
  workId: s.workId,
  cycle: s.cycle,
  phase: s.phase,
  label: s.label,
  wordCount: s.wordCount,
  qualityScore: s.qualityScore,
  createdAt: s.createdAt,
});

export async function listSnapshots(workId) {
  const dir = snapshotsDir(workId);
  await ensureDir(dir);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const ids = entries
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => e.name.replace(/\.json$/, ''))
    .filter((id) => SNAP_ID_RE.test(id));
  const loaded = await Promise.all(ids.map((id) => loadSnapshot(workId, id)));
  return loaded
    .filter(Boolean)
    .map(summarizeSnapshot)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

async function loadSnapshot(workId, id) {
  if (!SNAP_ID_RE.test(id)) return null;
  const content = await readFile(snapshotPath(workId, id), 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (content === null) return null;
  return safeJSONParse(content, null, { allowArray: false, logError: true, context: snapshotPath(workId, id) });
}

export async function getSnapshot(workId, id) {
  if (!SNAP_ID_RE.test(id)) throw badRequest('Invalid snapshot id');
  const snap = await loadSnapshot(workId, id);
  if (!snap) throw notFound('Snapshot');
  return snap;
}

/**
 * Restore a body snapshot into the active draft. Used by the keep/revert gate
 * AND the manual UI revert control. Returns the updated manifest + body.
 */
export async function revertToSnapshot(workId, snapshotId) {
  const snap = await getSnapshot(workId, snapshotId);
  const { manifest, body } = await saveDraftBody(workId, snap.body);
  console.log(`↩️ wr polish: reverted work ${workId.slice(0, 14)}… to snapshot ${snapshotId.slice(0, 14)}… (${countWords(body)} words)`);
  return { manifest, body, snapshot: summarizeSnapshot(snap) };
}

// ---------- run options ----------

export function resolvePolishOptions(opts = {}) {
  const cyclesRaw = Number.isInteger(opts.cycles) ? opts.cycles : DEFAULT_CYCLES;
  return {
    cycles: Math.max(1, Math.min(MAX_CYCLES, cyclesRaw)),
    plateauThreshold: typeof opts.plateauThreshold === 'number' && opts.plateauThreshold >= 0
      ? opts.plateauThreshold
      : DEFAULT_PLATEAU_THRESHOLD,
    cutTargetPercent: Number.isInteger(opts.cutTargetPercent) ? opts.cutTargetPercent : DEFAULT_CUT_TARGET_PERCENT,
    minCuts: Number.isInteger(opts.minCuts) ? opts.minCuts : DEFAULT_MIN_CUTS,
    maxCuts: Number.isInteger(opts.maxCuts) ? opts.maxCuts : DEFAULT_MAX_CUTS,
  };
}

// ---------- SSE runner ----------

const polishRunner = createSseRunner({ logLabel: 'wr polish' });

export const isPolishActive = (workId) => polishRunner.isActive(workId);
export const attachClient = (workId, res) => polishRunner.attachClient(workId, res);
export const cancelPolish = (workId) => polishRunner.cancel(workId);
export const __testing = { runs: polishRunner.runs };

const workContext = (manifest, body) => ({
  id: manifest.id,
  title: manifest.title,
  kind: manifest.kind,
  status: manifest.status,
  wordCount: countWords(body || ''),
});

/**
 * Start (or coalesce onto an in-flight) Polish run for a work. Returns the
 * createSseRunner `{ runId, alreadyRunning }`. The route pre-validates the work
 * exists and has a non-empty body before calling this so an empty draft gets a
 * clean 400 rather than an SSE error frame.
 */
export function startPolish(workId, opts = {}) {
  const cfg = resolvePolishOptions(opts);
  return polishRunner.start(workId, async ({ runId, signal, broadcast }) => {
    const isCanceled = () => signal.aborted;
    const emitCanceled = () => broadcast({ type: 'canceled', runId, canceledAt: nowIso() });

    broadcast({ type: 'start', runId, cycles: cfg.cycles, at: nowIso() });

    const loaded = await getWorkWithBody(workId);
    let body = loaded.body || '';
    const ctx = () => workContext(loaded.manifest, body);

    // Baseline evaluation + snapshot.
    broadcast({ type: 'phase', cycle: 0, phase: 'evaluate', label: 'Baseline evaluation' });
    let evalResult = (await runProsePass('evaluate', { work: ctx(), draftBody: body })).result;
    let currentScore = computeQualityScore(evalResult, body);
    const baseline = await saveSnapshot(workId, buildSnapshot({
      workId, cycle: 0, phase: 'baseline', label: 'Baseline', body, evaluate: evalResult, qualityScore: currentScore,
    }));
    broadcast({ type: 'baseline', runId, score: currentScore, snapshotId: baseline.id, wordCount: countWords(body) });

    const reports = [];
    for (let c = 1; c <= cfg.cycles; c += 1) {
      if (isCanceled()) { emitCanceled(); return; }

      const preScore = currentScore;
      const preBody = body;
      const preEval = evalResult;
      const cycleStart = Date.now();
      // Immutable pre-cycle snapshot — the revert target for both the gate and
      // the manual UI control.
      const preSnap = await saveSnapshot(workId, buildSnapshot({
        workId, cycle: c, phase: 'pre', label: `Cycle ${c} · before`, body: preBody, evaluate: preEval, qualityScore: preScore,
      }));

      // 1. Adversarial cut pass.
      broadcast({ type: 'phase', cycle: c, phase: 'cuts', label: 'Adversarial cut pass' });
      const cutsResult = (await runProsePass('cuts', {
        work: ctx(), draftBody: preBody,
        cutTargetPercent: cfg.cutTargetPercent, minCuts: cfg.minCuts, maxCuts: cfg.maxCuts,
      })).result;
      if (isCanceled()) { emitCanceled(); return; }

      // 2. Mechanically apply the SAFE cut types (OVER-EXPLAIN + REDUNDANT).
      const { applicable, refused } = planCutsForSection(
        preBody, mapFindingsToCuts(cutsResult.findings), { safeTypesOnly: true, allowTypes: SAFE_CUT_TYPES },
      );
      const cutBody = applicable.length ? applyCutsToText(preBody, applicable) : preBody;
      console.log(`✂️ wr polish: cycle ${c} cuts found=${(cutsResult.findings || []).length} applied=${applicable.length} refused=${refused.length}`);
      broadcast({
        type: 'cuts', cycle: c, found: (cutsResult.findings || []).length,
        applied: applicable.length, refused: refused.length, fatPercentage: cutsResult.fatPercentage,
      });

      // 3. Brief-driven revision (receives the cut body as raw material).
      broadcast({ type: 'phase', cycle: c, phase: 'revise', label: 'Brief-driven revision' });
      const brief = buildRevisionBrief({ evaluate: preEval, cuts: cutsResult, wordCount: countWords(cutBody) });
      const revised = (await runProsePass('revise', { work: ctx(), draftBody: cutBody, brief })).result;
      const revisedBody = (revised.revisedBody && revised.revisedBody.trim()) ? revised.revisedBody : cutBody;
      if (isCanceled()) { emitCanceled(); return; }

      // Persist tentatively so a re-evaluate reads the same on-disk body.
      await saveDraftBody(workId, revisedBody);

      // 4. Re-evaluate + keep/revert gate.
      broadcast({ type: 'phase', cycle: c, phase: 'reevaluate', label: 'Re-evaluation' });
      const postEval = (await runProsePass('evaluate', { work: ctx(), draftBody: revisedBody })).result;
      const postScore = computeQualityScore(postEval, revisedBody);
      const decision = decideKeepRevert(preScore, postScore);

      if (decision === 'revert') {
        await saveDraftBody(workId, preBody);
        body = preBody;
        evalResult = preEval;
        currentScore = preScore;
      } else {
        body = revisedBody;
        evalResult = postEval;
        currentScore = postScore;
      }

      const report = {
        cycle: c,
        preScore, postScore, keptScore: currentScore, decision,
        cutsApplied: applicable.length,
        wordCountBefore: countWords(preBody),
        wordCountAfter: countWords(body),
        snapshotId: preSnap.id,
        ms: Date.now() - cycleStart,
      };
      reports.push(report);
      console.log(`📝 wr polish: cycle ${c} ${decision} pre=${preScore} post=${postScore} kept=${currentScore} (${report.ms}ms)`);
      broadcast({ type: 'cycle', ...report });

      // 5. Plateau stop — converged when the kept gain is below threshold.
      if (shouldStopPlateau(preScore, currentScore, cfg.plateauThreshold)) {
        broadcast({ type: 'plateau', cycle: c, delta: Math.round(Math.abs(currentScore - preScore) * 100) / 100 });
        break;
      }
    }

    broadcast({
      type: 'complete', runId, cyclesRun: reports.length, finalScore: currentScore,
      wordCount: countWords(body), reports, completedAt: nowIso(),
    });
  });
}
