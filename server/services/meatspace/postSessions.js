/** Scores, saves, and runs post-processing for completed POST sessions. */

import { randomUUID } from 'crypto';
import { LLM_DRILL_TYPES, MEMORY_DRILL_TYPES, POST_SUPPORTED_MEMORY_TYPES } from '../../lib/postDrillTypes.js';
import { normalizePostLlmEvaluation } from '../../lib/postLlmContracts.js';
import { COGNITIVE_DRILL_TYPES, scoreCognitiveDrill } from './meatspacePostCognitive.js';
import { applySessionToMemoryItems, normalizeMemoryQuestionResults } from './meatspacePostMemory.js';
import { userLocalToday as localToday } from '../userTimezone.js';
import { saveStoredPostSession } from '../postRunStore.js';
import { getPostBenchmarkForm, assertBenchmarkSession } from './postBenchmark.js';
import { getPostConfig } from './postConfig.js';
import { loadSessions } from './postSessionHistory.js';
import { syncReviewScheduleForSession } from './postProgress.js';
import { scoreDrill } from './postDrillGenerators.js';

export async function submitPostSession(sessionData) {
  const config = await getPostConfig();
  const data = await loadSessions();
  const nowDate = new Date();
  const now = nowDate.toISOString();
  // Stamp the session's day in the user's local timezone, so `completedToday`
  // and the day-keyed streak/stats math classify it by the local day the user
  // actually completed it — not the server's UTC day (issue #2681). Derive the
  // day from the SAME `nowDate` used for startedAt/completedAt so a midnight
  // boundary can't split the day key and the timestamps onto different days.
  const todayLocal = await localToday(nowDate);

  // Strip client-provided score/correct — plus every separated metric field
  // (issue #2094) — and recompute server-side. Stripping up front means the
  // LLM/memory branches (which trust the client `score` but never carry these
  // metrics) can't persist stale client-sent values that stats aggregation
  // would then prefer over a questions[] derivation.
  const rawTasks = Array.isArray(sessionData.tasks) ? sessionData.tasks : [];
  assertBenchmarkSession(sessionData.benchmark, rawTasks, sessionData.modules);
  // A math drill's time limit is normally the user's live, editable
  // mentalMath.drillTypes[type].timeLimitSec — but a benchmark's speed bonus
  // must come from the REGISTERED form, or the same protocol/version/scorer
  // could still score differently across runs if the user edits their
  // configured time limit in between (issue #4442 codex review). Resolved
  // once here; assertBenchmarkSession already confirmed the form exists and
  // matches when sessionData.benchmark is present.
  const benchmarkForm = sessionData.benchmark ? getPostBenchmarkForm(sessionData.benchmark.formId) : null;
  const rescoredTasks = rawTasks.map(t => {
    const {
      score: _score, correct: _correct,
      accuracy: _acc, completion: _comp, avgResponseMs: _avg,
      answeredCount: _ac, totalCount: _tc, attemptCount: _attempts, errorCount: _errors,
      medianMs: _med, bestMs: _best, span: _span,
      hits: _h, misses: _m, falseAlarms: _fa, correctRejections: _cr,
      omissions: _omissions, commissionErrors: _commissionErrors,
      switchCostMs: _switchCost, switchAccuracy: _switchAccuracy, repeatAccuracy: _repeatAccuracy,
      congruencyCostMs: _congruencyCost, congruentAccuracy: _congruentAccuracy,
      incongruentAccuracy: _incongruentAccuracy, falseAlarmRate: _falseAlarmRate,
      latencyDistributionMs: _latencyDistribution,
      ...rest
    } = t || {};

    // LLM drills: score was computed server-side via /post/score-llm and
    // passed back by the client. Re-scoring here would add latency + cost.
    // This is a single-user internal tool so client score trust is acceptable.
    // The evaluation field and per-response llmScore/llmFeedback contain the server-generated breakdown.
    if (LLM_DRILL_TYPES.includes(rest.type)) {
      if (!Number.isFinite(t.score)) {
        throw new Error(`Cannot store ${rest.type} result without a validated score`);
      }
      return {
        ...rest,
        evaluation: normalizePostLlmEvaluation(rest.evaluation),
        score: t.score,
      };
    }

    // Memory drills: trust client-side scoring only for supported types
    if (POST_SUPPORTED_MEMORY_TYPES.includes(rest.type)) {
      return {
        ...rest,
        // Multi-blank fill-in-the-blank results carry one indexed response per
        // generated blank. Recompute the question-level flag before storing so
        // history and later readers cannot turn one correct blank into a full
        // prompt pass.
        questions: normalizeMemoryQuestionResults(rest.questions || []),
        score: t.score || 0,
      };
    }
    // Unsupported memory drills: preserve data, zero score.
    if (MEMORY_DRILL_TYPES.includes(rest.type)) {
      return { ...rest, score: 0 };
    }

    // Cognitive drills: deterministic — recompute the answer key from the
    // generated drillData (never trust client `correct`/`score`). Spread the
    // full scored bundle so the separated metrics (accuracy/completion/
    // avgResponseMs, plus n-back SDT counts and reaction-time median/best) are
    // persisted alongside the blended score (issue #2094).
    if (COGNITIVE_DRILL_TYPES.includes(rest.type)) {
      const scored = scoreCognitiveDrill(rest.type, rest.drillData, rest.questions || []);
      return { ...rest, ...scored, scorerProvenance: 'server-deterministic' };
    }

    // Math drills: strip correct from individual questions and rescore
    const sanitizedQuestions = (rest.questions || []).map(q => {
      const { correct: _qCorrect, ...qRest } = q;
      return qRest;
    });
    const benchmarkTimeLimitSec = benchmarkForm?.tasks.find(bt => bt.type === rest.type)?.timeLimitSec;
    const drillConfig = config.mentalMath?.drillTypes?.[rest.type] || {};
    const timeLimitMs = (benchmarkTimeLimitSec ?? drillConfig.timeLimitSec ?? 120) * 1000;
    const scored = scoreDrill(rest.type, sanitizedQuestions, timeLimitMs, rest.config || drillConfig);
    return { ...rest, ...scored };
  });

  // Idempotent submit: the client generates the session id (uuid) and sends it,
  // so a retry after a dropped response upserts the SAME record instead of
  // pushing a duplicate. An id is only trusted here to key the upsert — every
  // scored field is still recomputed server-side above. Absent id (legacy
  // clients / direct service callers) falls back to a fresh uuid.
  const sessionId = sessionData.id || randomUUID();
  const existingIndex = data.sessions.findIndex(s => s.id === sessionId);
  let isNewSession = existingIndex < 0;
  const existing = isNewSession ? null : data.sessions[existingIndex];
  const requestedStartedAtMs = Date.parse(sessionData.startedAt || '');
  const requestedStartedAt = Number.isFinite(requestedStartedAtMs)
    && requestedStartedAtMs <= nowDate.getTime()
    && nowDate.getTime() - requestedStartedAtMs <= 24 * 60 * 60 * 1000
    ? new Date(requestedStartedAtMs).toISOString()
    : now;
  const startedAt = existing?.startedAt ?? requestedStartedAt;
  const startedAtMs = Date.parse(startedAt);
  const actualDurationMs = Number.isFinite(startedAtMs)
    ? Math.max(0, nowDate.getTime() - startedAtMs)
    : 0;

  let session = {
    id: sessionId,
    // Preserve the ORIGINAL day/start on an idempotent re-submit — a retry that
    // crosses midnight (or just arrives later) must not move the session to a
    // new date, which would corrupt history ordering and streak math. Only a
    // fresh insert stamps "now".
    date: existing?.date ?? todayLocal,
    startedAt,
    completedAt: now,
    durationMs: rescoredTasks.reduce((sum, t) => sum + (t.totalMs || 0), 0),
    actualDurationMs,
    cadence: sessionData.cadence || 'daily',
    modules: sessionData.modules,
    tasks: rescoredTasks,
    // Benchmark scoring is fixed by the protocol, never by the user's live
    // scoring.weights config — otherwise two "compatible" (same protocol/
    // version/scorer) runs scored under different weight configs would land
    // in the same trend as though they were on one scale (issue #4442 codex
    // review). Quick/Test/Train sessions keep the configured weights.
    score: computeSessionScore(rescoredTasks, sessionData.benchmark ? undefined : config.scoring?.weights),
    tags: sessionData.tags || {},
    ...(sessionData.conditions && Object.keys(sessionData.conditions).length
      ? { conditions: sessionData.conditions }
      : {}),
    ...(sessionData.plan ? { plan: sessionData.plan } : {}),
    ...(sessionData.benchmark ? { benchmark: sessionData.benchmark } : {}),
  };

  const stored = await saveStoredPostSession(session);
  session = stored.session;
  isNewSession = stored.isNew;
  console.log(`🧪 POST session ${isNewSession ? 'saved' : 'updated'}: score=${session.score} modules=${session.modules.join(',')}`);

  // A memory drill completed inside this session IS a review — mirror the
  // dedicated MemoryBuilder practice flow (submitPractice) and advance each
  // drilled item's spaced-repetition schedule (plus chunk/element mastery from
  // the per-question attribution usePostSession's submitAnswer preserves), so it
  // reschedules and clears from "Due Today". applySessionToMemoryItems reads and
  // writes the shared memory-items file exactly once for the whole session.
  //
  // Two invariants around this call:
  //  1. Only on a NEW session — a retry (same id) re-upserts the durable record
  //     but must NOT re-advance schedules a second time, or a dropped-response
  //     retry would double-count the review.
  //  2. Isolated so it can NEVER 500 an already-persisted session. This runs
  //     AFTER the durable write, so a memory-file failure here is post-response
  //     bookkeeping — log it single-line and still return 200. (Sanctioned
  //     try/catch: the session is already saved; there is nothing to roll back.)
  if (isNewSession) {
    // Pre-filter to POST-supported memory tasks with a memoryItemId — the exact
    // gate the prior per-task loop used, so a future generation-only memory
    // drill is never scheduled even if it somehow carries an id.
    const memoryTasks = rescoredTasks.filter(t => POST_SUPPORTED_MEMORY_TYPES.includes(t.type) && t.memoryItemId);
    try {
      await applySessionToMemoryItems(memoryTasks, new Date(now));
    } catch (err) {
      console.error(`❌ POST session memory post-processing failed (session ${sessionId} still saved): ${err.message}`);
    }
    // Reconcile the skill re-verification schedule (issue #2096): upsert newly-
    // mastered skills, record any maintenance-review reps in this session, and
    // reset the staleness clock for mastered skills actively practiced here.
    // Runs AFTER the memory update above so mastery reflects this session.
    // Isolated so it can never 500 an already-persisted session.
    try {
      await syncReviewScheduleForSession(session, new Date(now));
    } catch (err) {
      console.error(`❌ POST session review-schedule sync failed (session ${sessionId} still saved): ${err.message}`);
    }
  }

  return session;
}

/**
 * Blend a session's per-task scores into one headline number, weighted by
 * each task's module (`config.scoring.weights`, issue #2099). A module absent
 * from `weights` (or a non-numeric entry) defaults to 1.0, so an all-uniform
 * (or empty/missing) weights map reproduces the exact old unweighted mean —
 * existing configs and sessions score identically until a user actually
 * adjusts a weight.
 */
function computeSessionScore(tasks, weights = {}) {
  const valid = (tasks || []).filter(t => typeof t.score === 'number' && !Number.isNaN(t.score));
  if (!valid.length) return 0;
  let totalWeighted = 0;
  let totalWeight = 0;
  for (const t of valid) {
    const w = typeof weights?.[t.module] === 'number' ? weights[t.module] : 1.0;
    totalWeighted += t.score * w;
    totalWeight += w;
  }
  // All-zero weights (every touched module explicitly zeroed) would otherwise
  // divide by zero — fall back to 0 rather than NaN.
  if (!totalWeight) return 0;
  return Math.round(totalWeighted / totalWeight);
}
