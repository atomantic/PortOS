import { useState, useCallback, useRef, useEffect } from 'react';
import { generatePostDrill, submitPostSession, scorePostLlmDrill, submitTrainingRun } from '../services/api';
import toast from '../components/ui/Toast';
import { uuidv4 } from '../lib/uuid.js';
import {
  LLM_DRILL_TYPES, MEMORY_DRILL_TYPES, DRILL_TO_DOMAIN, countLlmCorrect,
  WORDPLAY_LLM_DRILL_TYPES, LLM_TRAINING_CORRECT_THRESHOLD, appliedNumeracyAnswerCorrect,
} from '../components/meatspace/post/constants';

// sessionStorage key for the single in-progress run. Single-user tool → one
// active run at a time, so a single key is enough. Restored on refresh so a
// mid-drill reload resumes the same drill queue + completed results, and a
// reload on the completed-but-unsaved results screen keeps the results.
const RUN_STORAGE_KEY = 'post.activeRun';
// Only an active or completed-unsaved run is worth resuming. A run that was
// still generating a drill (`loading`) lost its in-flight request to the
// reload, and an `idle`/`saved` run has nothing live to restore.
const RESTORABLE_STATES = new Set(['drilling', 'between-drills', 'complete']);

// The server validates this id with Zod `.uuid()`, so it has to stay
// spec-valid on the insecure origins where `crypto.randomUUID` is undefined —
// which is exactly what `uuidv4` guarantees.
const newRunId = () => uuidv4();

function loadRunSnapshot() {
  if (typeof sessionStorage === 'undefined') return null;
  const raw = sessionStorage.getItem(RUN_STORAGE_KEY);
  if (!raw) return null;
  let snap;
  try { snap = JSON.parse(raw); } catch { return null; } // corrupt storage → start fresh
  if (!snap || typeof snap !== 'object') return null;
  if (snap.state === 'saving') {
    // Both scored and training saves use stable client run/attempt ids, so an
    // interrupted request can safely return to the results screen and retry.
    snap.state = 'complete';
  }
  if (!RESTORABLE_STATES.has(snap.state)) return null;
  return snap;
}

function clearRunSnapshot() {
  if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(RUN_STORAGE_KEY);
}

function computeSessionScoreFromResults(results) {
  if (!results.length) return 0;
  // Group by domain — if any drills have domain info, use weighted avg per domain
  const byDomain = {};
  let hasDomains = false;
  for (const r of results) {
    const dk = DRILL_TO_DOMAIN[r.type];
    if (dk) {
      hasDomains = true;
      if (!byDomain[dk]) byDomain[dk] = [];
      byDomain[dk].push(r.score || 0);
    }
  }
  if (hasDomains && Object.keys(byDomain).length > 1) {
    // Average within each domain, then average across domains (equal weight per domain)
    const domainAvgs = Object.values(byDomain).map(scores =>
      Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
    );
    return Math.round(domainAvgs.reduce((a, b) => a + b, 0) / domainAvgs.length);
  }
  // Fallback: simple average
  return Math.round(results.reduce((s, r) => s + (r.score || 0), 0) / results.length);
}

// Memory drill questions carry chunk/element attribution the server needs to
// bucket mastery bookkeeping (item.mastery.chunks / item.mastery.elements) —
// chunkId on memory-sequence questions (via findChunkForLine), element on
// memory-element-flash questions. Non-memory questions never have these, so
// this only adds fields when present rather than sending explicit nulls.
function memoryAttribution(q) {
  const attrs = {};
  if (q?.chunkId != null) attrs.chunkId = q.chunkId;
  if (q?.element != null) attrs.element = q.element;
  return attrs;
}

function normalizeFillBlankValue(value) {
  return String(value ?? '').toLowerCase().trim();
}

function fillBlankAnswerKeys(question) {
  return (question?.answers || []).map((answer, fallbackIndex) => ({
    index: Number.isInteger(answer?.index) ? answer.index : fallbackIndex,
    expected: String(answer?.word ?? answer),
    ...(answer?.element != null ? { element: answer.element } : {}),
  }));
}

/**
 * Build one response for every generated blank. A scalar value is the legacy
 * client contract: match it to one indexed blank and never let it satisfy the
 * whole prompt. Structured values are keyed by answer index and missing values
 * remain explicit misses so the server can derive partial credit consistently.
 */
export function buildFillBlankAnswerEntries(question, value) {
  const keys = fillBlankAnswerKeys(question);
  if (!keys.length) return [];

  if (Array.isArray(value) || value === null) {
    const submitted = new Map((Array.isArray(value) ? value : keys.map(key => ({ index: key.index, value: null })))
      .map(entry => [entry?.index, entry?.value]));
    return keys.map(key => {
      const raw = submitted.get(key.index);
      const answered = raw == null || String(raw).trim() === '' ? null : String(raw).trim();
      return {
        index: key.index,
        value: answered,
        expected: key.expected,
        correct: answered !== null && normalizeFillBlankValue(answered) === normalizeFillBlankValue(key.expected),
        ...(key.element == null ? {} : { element: key.element }),
      };
    });
  }

  const answered = value == null || String(value).trim() === '' ? null : String(value).trim();
  const matched = answered === null
    ? null
    : keys.find(key => normalizeFillBlankValue(key.expected) === normalizeFillBlankValue(answered));
  const target = matched || keys[0];
  return [{
    index: target.index,
    value: answered,
    expected: target.expected,
    correct: matched != null,
    ...(matched?.element == null ? {} : { element: matched.element }),
  }];
}

function hasAnsweredValue(value) {
  if (Array.isArray(value)) return value.some(entry => entry?.value != null && String(entry.value).trim() !== '');
  return value !== null && value !== undefined;
}

/** Count fill-blank credit by generated blank, with scalar legacy fallback. */
export function countFillBlankAnswers(answers = []) {
  const entries = answers.flatMap(answer => Array.isArray(answer?.answered) ? answer.answered : [answer]);
  return {
    correct: entries.filter(entry => entry?.correct).length,
    total: entries.length,
  };
}

// States: idle → loading → drilling → between-drills → complete → saving → saved
const STATES = {
  IDLE: 'idle',
  LOADING: 'loading',
  DRILLING: 'drilling',
  BETWEEN_DRILLS: 'between-drills',
  COMPLETE: 'complete',
  SAVING: 'saving',
  SAVED: 'saved'
};

export function usePostSession() {
  // Seed once from any persisted in-progress run so a refresh mid-drill (or on
  // the completed-unsaved results screen) resumes instead of dropping the run.
  const [restored] = useState(loadRunSnapshot);
  const [state, setState] = useState(restored?.state ?? STATES.IDLE);
  const [drills, setDrills] = useState(restored?.drills ?? []); // queued drill configs
  const [currentDrillIndex, setCurrentDrillIndex] = useState(restored?.currentDrillIndex ?? 0);
  const [currentDrill, setCurrentDrill] = useState(restored?.currentDrill ?? null); // generated questions
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(restored?.currentQuestionIndex ?? 0);
  const [answers, setAnswers] = useState(restored?.answers ?? []); // answers for current drill
  const [drillResults, setDrillResults] = useState(restored?.drillResults ?? []); // completed drill results
  const [sessionScore, setSessionScore] = useState(restored?.sessionScore ?? 0);
  const [savedSession, setSavedSession] = useState(null);
  const [isTraining, setIsTraining] = useState(restored?.isTraining ?? false);
  // Run id doubles as the client-generated session id (idempotent submit) and
  // the /post/session/:id results URL — so a saved session's URL === its run id.
  const [runId, setRunId] = useState(restored?.runId ?? null);
  const [conditions, setConditions] = useState(restored?.conditions ?? {}); // session conditions captured at launch
  const [sessionPlan, setSessionPlan] = useState(restored?.sessionPlan ?? null);
  const [benchmark, setBenchmark] = useState(restored?.benchmark ?? null);
  const [lastAnswer, setLastAnswer] = useState(null); // { correct, expected, answered } for training feedback
  // Seed the timing refs from the restored snapshot so a mid-drill refresh keeps
  // measuring elapsed time from the ORIGINAL question/drill start — otherwise the
  // in-flight question's responseMs (and the drill's totalMs) would reset to 0 on
  // reload, under-counting time and inflating the speed bonus.
  const questionStartRef = useRef(restored?.questionStartedAt ?? Date.now());
  const drillStartRef = useRef(restored?.drillStartedAt ?? Date.now());
  const runStartedAtRef = useRef(restored?.runStartedAt ?? null);
  const runCompletedAtRef = useRef(restored?.runCompletedAt ?? null);
  const finishDrillRef = useRef(null);

  // Persist the live run to sessionStorage on every meaningful change; clear it
  // once idle/saved (nothing live to resume). Kept minimal — only the fields
  // needed to rebuild the runner and results screen after a reload.
  useEffect(() => {
    if (state === STATES.IDLE || state === STATES.SAVED) {
      clearRunSnapshot();
      return;
    }
    // While a drill is generating (initial start, next drill, or LLM scoring),
    // do NOT overwrite the last stable snapshot: `loading` isn't restorable, and
    // the in-flight request can't be resumed — but the COMPLETED results already
    // captured in the prior drilling/between-drills snapshot must survive a
    // refresh during generation. Keeping the last good snapshot lets a refresh
    // resume at the between-drills screen instead of dropping the whole run.
    if (state === STATES.LOADING) return;
    if (typeof sessionStorage === 'undefined') return;
    sessionStorage.setItem(RUN_STORAGE_KEY, JSON.stringify({
      runId, state, drills, currentDrillIndex, currentDrill, currentQuestionIndex,
      answers, drillResults, sessionScore, isTraining, conditions, sessionPlan,
      benchmark,
      // Persist the timing anchors (mutated synchronously on each question/drill
      // transition, just before the state change that fires this effect) so a
      // refresh resumes the clock instead of restarting it.
      questionStartedAt: questionStartRef.current,
      drillStartedAt: drillStartRef.current,
      runStartedAt: runStartedAtRef.current,
      runCompletedAt: runCompletedAtRef.current,
    }));
  }, [runId, state, drills, currentDrillIndex, currentDrill, currentQuestionIndex, answers, drillResults, sessionScore, isTraining, conditions, sessionPlan, benchmark]);

  const startSession = useCallback(async (drillConfigs, training = false, sessionConditions = {}, plan = null, benchmarkMetadata = null) => {
    // drillConfigs: [{ type, config, timeLimitSec }]
    if (!drillConfigs?.length) {
      toast.error('No drills configured');
      return;
    }
    setState(STATES.LOADING);
    setIsTraining(training);
    setSessionPlan(plan || null);
    setBenchmark(training ? null : benchmarkMetadata || null);
    setDrills(drillConfigs);
    setCurrentDrillIndex(0);
    setDrillResults([]);
    setSavedSession(null);
    setLastAnswer(null);
    runStartedAtRef.current = new Date().toISOString();
    runCompletedAtRef.current = null;
    // New run → new client-side id (also the future /post/session/:id) and the
    // conditions to submit, so both survive a mid-run refresh via the snapshot.
    setRunId(newRunId());
    setConditions(sessionConditions || {});

    const first = drillConfigs[0];
    const drill = await generatePostDrill(first.type, first.config, first.providerId, first.model, { silent: true }).catch(err => {
      toast.error(`Failed to generate drill: ${err.message}`);
      setState(STATES.IDLE);
      return null;
    });
    if (!drill) return;
    setCurrentDrill({ ...drill, timeLimitSec: first.timeLimitSec });
    setCurrentQuestionIndex(0);
    setAnswers([]);
    questionStartRef.current = Date.now();
    drillStartRef.current = Date.now();
    setState(STATES.DRILLING);
    return drill;
  }, []);

  const finishDrill = useCallback((finalAnswers) => {
    const totalMs = Date.now() - drillStartRef.current;
    const timeLimitMs = (currentDrill?.timeLimitSec || 120) * 1000;

    // Compute score. Multi-blank recall earns one unit per generated blank;
    // question-level correctness remains an all-blanks pass/fail flag for
    // review display and legacy readers.
    const isFillBlank = currentDrill.type === 'memory-fill-blank';
    const scored = isFillBlank
      ? countFillBlankAnswers(finalAnswers)
      : { correct: finalAnswers.filter(a => a.correct).length, total: finalAnswers.length };
    const { correct, total } = scored;
    const correctRatio = total > 0 ? correct / total : 0;
    const answered = finalAnswers.filter(a => hasAnsweredValue(a.answered));
    const totalResponseMs = answered.reduce((sum, a) => sum + a.responseMs, 0);
    const avgResponseMs = answered.length > 0 ? totalResponseMs / answered.length : timeLimitMs;
    const speedBonus = Math.max(0, 1 - avgResponseMs / timeLimitMs);
    const score = Math.min(100, Math.max(0, Math.round((correctRatio * 0.8 + speedBonus * 0.2) * 100)));

    const isMemoryDrill = MEMORY_DRILL_TYPES.includes(currentDrill.type);
    const result = {
      id: newRunId(),
      module: isMemoryDrill ? 'memory' : 'mental-math',
      type: currentDrill.type,
      config: currentDrill.config,
      questions: finalAnswers,
      // Memory drills: carry the drilled item's id through to session submit so
      // the server can map this review back to it and advance its
      // spaced-repetition schedule (mirrors the MemoryBuilder practice flow).
      ...(isMemoryDrill && currentDrill.memoryItemId ? { memoryItemId: currentDrill.memoryItemId } : {}),
      score,
      totalMs
    };

    const newResults = [...drillResults, result];
    setDrillResults(newResults);

    // Check if there are more drills
    if (currentDrillIndex + 1 < drills.length) {
      setState(STATES.BETWEEN_DRILLS);
    } else {
      runCompletedAtRef.current = new Date().toISOString();
      setSessionScore(computeSessionScoreFromResults(newResults));
      setState(STATES.COMPLETE);
    }
  }, [currentDrill, drillResults, currentDrillIndex, drills]);

  // Keep ref current so submitAnswer and timeExpired always call the latest finishDrill
  finishDrillRef.current = finishDrill;

  const submitAnswer = useCallback((value) => {
    if (state !== STATES.DRILLING || !currentDrill) return;

    const q = currentDrill.questions?.[currentQuestionIndex];
    if (!q) return;
    const responseMs = Date.now() - questionStartRef.current;
    const hasFillBlankAnswers = Array.isArray(q.answers) && q.answers.length > 0;
    const isAppliedNumeracy = currentDrill.type === 'applied-numeracy';
    const isTextAnswer = typeof q.expected === 'string' || hasFillBlankAnswers || isAppliedNumeracy;

    // For estimation drills, check within tolerance
    let correct;
    let answered;
    if (hasFillBlankAnswers) {
      const entries = buildFillBlankAnswerEntries(q, value);
      answered = entries;
      correct = entries.length > 0 && entries.every(entry => entry.correct);
    } else if (isTextAnswer) {
      answered = value;
      correct = isAppliedNumeracy
        ? appliedNumeracyAnswerCorrect(value, q)
        : value !== null && String(value).toLowerCase().trim() === String(q.expected).toLowerCase().trim();
    } else if (currentDrill.type === 'estimation') {
      const raw = (value === null || String(value).trim() === '') ? null : Number(value);
      answered = (raw !== null && isNaN(raw)) ? null : raw;
      const tolerance = (currentDrill.config?.tolerancePct || 10) / 100;
      correct = answered !== null && Math.abs(answered - q.expected) <= Math.abs(q.expected * tolerance);
    } else {
      const raw = (value === null || String(value).trim() === '') ? null : Number(value);
      answered = (raw !== null && isNaN(raw)) ? null : raw;
      correct = answered === q.expected;
    }

    const answer = {
      prompt: q.prompt,
      expected: q.answerDisplay || q.expected,
      answered,
      correct,
      responseMs,
      ...(q.method ? { method: q.method } : {}),
      ...memoryAttribution(q),
    };

    const newAnswers = [...answers, answer];
    setAnswers(newAnswers);

    // Training mode: pause to show feedback before advancing
    if (isTraining) {
      setLastAnswer(answer);
      return;
    }

    // Check if drill is complete
    if (currentQuestionIndex + 1 >= (currentDrill.questions?.length ?? 0)) {
      finishDrillRef.current(newAnswers);
    } else {
      setCurrentQuestionIndex(currentQuestionIndex + 1);
      questionStartRef.current = Date.now();
    }
  }, [state, currentDrill, currentQuestionIndex, answers, isTraining]);

  const skipQuestion = useCallback(() => {
    submitAnswer(null);
  }, [submitAnswer]);

  // Training mode: advance to next question after user sees feedback
  const acknowledgeAnswer = useCallback(() => {
    setLastAnswer(null);
    if (currentQuestionIndex + 1 >= (currentDrill?.questions?.length ?? 0)) {
      finishDrillRef.current(answers);
    } else {
      setCurrentQuestionIndex(currentQuestionIndex + 1);
      questionStartRef.current = Date.now();
    }
  }, [currentQuestionIndex, currentDrill, answers]);

  const nextDrill = useCallback(async () => {
    const nextIndex = currentDrillIndex + 1;
    setCurrentDrillIndex(nextIndex);
    setState(STATES.LOADING);

    const next = drills[nextIndex];
    const drill = await generatePostDrill(next.type, next.config, next.providerId, next.model, { silent: true }).catch(err => {
      toast.error(`Failed to generate drill: ${err.message}`);
      setState(STATES.IDLE);
      return null;
    });
    if (!drill) return false;
    setCurrentDrill({ ...drill, timeLimitSec: next.timeLimitSec });
    setCurrentQuestionIndex(0);
    setAnswers([]);
    questionStartRef.current = Date.now();
    drillStartRef.current = Date.now();
    setState(STATES.DRILLING);
    return true;
  }, [currentDrillIndex, drills]);

  const timeExpired = useCallback(() => {
    if (state !== STATES.DRILLING || !currentDrill) return;

    // Mark remaining questions as unanswered
    const remaining = (currentDrill.questions || []).slice(currentQuestionIndex).map(q => {
      const hasFillBlankAnswers = Array.isArray(q.answers) && q.answers.length > 0;
      const answered = hasFillBlankAnswers ? buildFillBlankAnswerEntries(q, null) : null;
      return {
        prompt: q.prompt,
        expected: q.answerDisplay || q.expected,
        answered,
        correct: false,
        responseMs: 0,
        ...(q.method ? { method: q.method } : {}),
        ...memoryAttribution(q)
      };
    });

    const finalAnswers = [...answers, ...remaining];
    setAnswers(finalAnswers);
    finishDrillRef.current(finalAnswers);
  }, [state, currentDrill, currentQuestionIndex, answers]);

  const completeLlmDrill = useCallback(async (drillResult) => {
    const isLlm = LLM_DRILL_TYPES.includes(drillResult.type);
    const hasReusableTrainingScore = isTraining
      && Number.isFinite(drillResult.score)
      && drillResult.evaluation?.scores?.length === drillResult.responses?.length
      && drillResult.evaluation?.provenance != null
      && drillResult.responses?.every((response) => Number.isFinite(response.llmScore));
    let scoredResult = drillResult;

    if (isLlm && drillResult.responses?.length > 0 && !hasReusableTrainingScore) {
      const drillConfig = drills[currentDrillIndex];
      const timeLimitMs = (drillConfig?.timeLimitSec || 120) * 1000;
      const scoreResult = await scorePostLlmDrill(
        drillResult.type, drillResult.drillData, drillResult.responses,
        timeLimitMs, drillConfig?.providerId, drillConfig?.model, { silent: true }
      ).catch(err => {
        toast.error(`LLM scoring failed: ${err.message}`);
        throw err;
      });

      scoredResult = {
        ...drillResult,
        score: scoreResult.score,
        responses: scoreResult.questions,
        evaluation: scoreResult.evaluation
      };
    }

    scoredResult = { ...scoredResult, id: scoredResult.id || newRunId() };
    const newResults = [...drillResults, scoredResult];
    setDrillResults(newResults);

    if (currentDrillIndex + 1 < drills.length) {
      setState(STATES.BETWEEN_DRILLS);
    } else {
      runCompletedAtRef.current = new Date().toISOString();
      setSessionScore(computeSessionScoreFromResults(newResults));
      setState(STATES.COMPLETE);
    }
    return scoredResult;
  }, [drillResults, currentDrillIndex, drills, isTraining]);

  // Interactive cognitive drills (n-back / digit-span / stroop) build their own
  // fully-formed result (questions + local score) and hand it back here. Unlike
  // LLM drills there is no async scoring call — the server recomputes the score
  // deterministically from drillData on submit. Mirrors completeLlmDrill's
  // advance/complete bookkeeping.
  const completeCognitiveDrill = useCallback((drillResult) => {
    const newResults = [...drillResults, { ...drillResult, id: drillResult.id || newRunId() }];
    setDrillResults(newResults);

    if (currentDrillIndex + 1 < drills.length) {
      setState(STATES.BETWEEN_DRILLS);
    } else {
      runCompletedAtRef.current = new Date().toISOString();
      setSessionScore(computeSessionScoreFromResults(newResults));
      setState(STATES.COMPLETE);
    }
  }, [drillResults, currentDrillIndex, drills]);

  const saveSession = useCallback(async (overrideConditions = {}) => {
    setState(STATES.SAVING);
    // Prefer the conditions captured at launch (survive a refresh via the
    // snapshot); an explicit arg still wins per-key for a live save.
    const finalConditions = { ...conditions, ...(overrideConditions || {}) };

    // Training mode: one validated batch + one transaction for the whole run.
    // Stable run/attempt ids make a failed-response retry idempotent.
    if (isTraining) {
      const trainingRunId = runId || newRunId();
      const attempts = drillResults.map((r, index) => {
        const questionCount = r.questions?.length || r.responses?.length || 0;
        // LLM drills score via completeLlmDrill, which stores the scored
        // responses under `r.responses` (with an `llmScore` field) rather
        // than `r.questions` (with a boolean `correct`) — the two shapes come
        // from two different result-building paths (finishDrill vs
        // completeLlmDrill). Reading `.correct` off `r.questions` for an LLM
        // drill always found `undefined`, so every LLM training entry
        // (including wordplay) silently logged correctCount=0 regardless of
        // actual performance (issue #2097).
        const isLlmDrill = LLM_DRILL_TYPES.includes(r.type);
        const correctCount = isLlmDrill
          ? countLlmCorrect(r.responses || [])
          : (r.questions?.filter(q => q.correct)?.length ?? 0);
        // Per-question breakdown (issue #2114) — the standalone Wordplay tab
        // (WordplayTrainer.jsx) already threads this through; extend the same
        // breakdown to the in-session runner's completed wordplay rounds so
        // both entry points populate it, not just the standalone tab. Scoped
        // to the four wordplay types since those are the only ones whose
        // `r.responses` entries (post-completeLlmDrill) carry a prompt/response
        // shape a future dashboard could render per-question.
        const questions = WORDPLAY_LLM_DRILL_TYPES.includes(r.type)
          ? (r.responses || []).map(resp => ({
            prompt: resp.prompt,
            response: resp.response,
            items: resp.items,
            responseMs: resp.responseMs,
            score: resp.llmScore != null ? resp.llmScore : undefined,
            feedback: resp.llmFeedback,
            correct: (resp.llmScore ?? 0) >= LLM_TRAINING_CORRECT_THRESHOLD,
          }))
          : undefined;
        const answeredCount = isLlmDrill
          ? (r.responses || []).length
          : (r.questions || []).filter((question) => question?.answered != null).length;
        const inputMode = r.inputMode || (
          isLlmDrill || MEMORY_DRILL_TYPES.includes(r.type) || r.type === 'applied-numeracy'
            ? 'text'
            : r.module === 'cognitive' ? 'interactive' : 'numeric'
        );
        return {
          id: r.id || `${trainingRunId}:attempt:${index}`,
          module: r.module,
          drillType: r.type,
          ...(r.memoryItemId ? { memoryItemId: r.memoryItemId } : {}),
          difficulty: r.config || null,
          configVersion: r.configVersion || null,
          questionCount,
          correctCount,
          latencyMs: r.totalMs || 0,
          ...(r.drillData ? { drillData: r.drillData } : {}),
          correct: questionCount > 0 ? correctCount === questionCount : null,
          score: r.score !== undefined ? r.score : (questionCount > 0 ? (correctCount / questionCount) * 100 : null),
          completion: r.completion !== undefined ? r.completion : (questionCount > 0 ? answeredCount / questionCount : null),
          hintUsed: (r.questions || []).some((question) => question?.hintUsed === true),
          confidence: r.confidence ?? null,
          inputMode,
          scorerProvenance: isLlmDrill ? 'server-llm' : 'client-deterministic',
          ...Object.fromEntries([
            'accuracy', 'avgResponseMs', 'answeredCount', 'totalCount', 'attemptCount', 'errorCount',
            'medianMs', 'bestMs', 'span', 'hits', 'misses', 'omissions', 'commissionErrors',
            'falseAlarms', 'correctRejections', 'switchCostMs', 'switchAccuracy', 'repeatAccuracy',
            'congruencyCostMs', 'congruentAccuracy', 'incongruentAccuracy', 'falseAlarmRate',
            'latencyDistributionMs',
          ].filter(key => r[key] !== undefined).map(key => [key, r[key]])),
          ...((questions || Array.isArray(r.questions)) ? { questions: questions || r.questions } : {}),
        };
      });
      const training = await submitTrainingRun({
        id: trainingRunId,
        mode: 'training',
        ...(runStartedAtRef.current ? { startedAt: runStartedAtRef.current } : {}),
        ...(runCompletedAtRef.current ? { completedAt: runCompletedAtRef.current } : {}),
        planned: {
          modules: [...new Set(attempts.map((attempt) => attempt.module))],
          drillTypes: attempts.map((attempt) => attempt.drillType),
        },
        attempts,
      }, { silent: true }).catch((err) => {
        toast.error(`Failed to save training session: ${err.message}`);
        setState(STATES.COMPLETE);
        return null;
      });
      if (!training) return null;
      setSavedSession(training);
      toast.success('Training session logged');
      setState(STATES.SAVED);
      return { ...training, training: true };
    }

    const modules = [...new Set(drillResults.map(r => r.module))];
    const session = await submitPostSession({
      // Client-generated id → an auto-retry after a dropped response upserts the
      // same record server-side instead of double-recording the session.
      id: runId || newRunId(),
      cadence: 'daily',
      modules,
      tasks: drillResults,
      conditions: finalConditions,
      startedAt: new Date(runStartedAtRef.current).toISOString(),
      ...(sessionPlan ? { plan: sessionPlan } : {}),
      ...(benchmark ? { benchmark } : {}),
    }, { silent: true }).catch(err => {
      toast.error(`Failed to save session: ${err.message}`);
      setState(STATES.COMPLETE);
      return null;
    });
    if (!session) return null;
    setSavedSession(session);
    // Replace the pre-save estimate (computeSessionScoreFromResults, a plain
    // per-domain average) with the server's authoritative score — which now
    // additionally honors configured per-module scoring.weights (issue
    // #2099). Without this, PostSessionResults keeps showing the local
    // estimate even in the SAVED state, silently diverging from the score
    // that was actually persisted/toasted whenever weights aren't uniform
    // (issue #2099 codex review).
    setSessionScore(session.score);
    toast.success(`POST complete — score: ${session.score}`);
    setState(STATES.SAVED);
    return session;
  }, [drillResults, isTraining, conditions, runId, sessionPlan, benchmark]);

  const reset = useCallback(() => {
    setState(STATES.IDLE);
    setDrills([]);
    setCurrentDrillIndex(0);
    setCurrentDrill(null);
    setCurrentQuestionIndex(0);
    setAnswers([]);
    setDrillResults([]);
    setSessionScore(0);
    setSavedSession(null);
    setIsTraining(false);
    setRunId(null);
    runStartedAtRef.current = null;
    runCompletedAtRef.current = null;
    setConditions({});
    setSessionPlan(null);
    setBenchmark(null);
    setLastAnswer(null);
    clearRunSnapshot();
  }, []);

  return {
    state,
    currentDrill,
    currentQuestionIndex,
    currentDrillIndex,
    drills,
    drillCount: drills.length,
    answers,
    drillResults,
    sessionScore,
    savedSession,
    isTraining,
    runId,
    sessionPlan,
    benchmark,
    lastAnswer,
    startSession,
    submitAnswer,
    skipQuestion,
    acknowledgeAnswer,
    nextDrill,
    timeExpired,
    completeLlmDrill,
    completeCognitiveDrill,
    saveSession,
    reset
  };
}
