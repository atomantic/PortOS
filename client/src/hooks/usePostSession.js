import { useState, useCallback, useRef } from 'react';
import { generatePostDrill, submitPostSession, scorePostLlmDrill, submitTrainingEntry } from '../services/api';
import toast from '../components/ui/Toast';
import {
  LLM_DRILL_TYPES, MEMORY_DRILL_TYPES, DRILL_TO_DOMAIN, countLlmCorrect,
  WORDPLAY_LLM_DRILL_TYPES, LLM_TRAINING_CORRECT_THRESHOLD,
} from '../components/meatspace/post/constants';

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
  const [state, setState] = useState(STATES.IDLE);
  const [drills, setDrills] = useState([]); // queued drill configs
  const [currentDrillIndex, setCurrentDrillIndex] = useState(0);
  const [currentDrill, setCurrentDrill] = useState(null); // generated questions
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [answers, setAnswers] = useState([]); // answers for current drill
  const [drillResults, setDrillResults] = useState([]); // completed drill results
  const [sessionScore, setSessionScore] = useState(0);
  const [savedSession, setSavedSession] = useState(null);
  const [isTraining, setIsTraining] = useState(false);
  const [lastAnswer, setLastAnswer] = useState(null); // { correct, expected, answered } for training feedback
  const questionStartRef = useRef(Date.now());
  const drillStartRef = useRef(Date.now());
  const finishDrillRef = useRef(null);

  const startSession = useCallback(async (drillConfigs, training = false) => {
    // drillConfigs: [{ type, config, timeLimitSec }]
    if (!drillConfigs?.length) {
      toast.error('No drills configured');
      return;
    }
    setState(STATES.LOADING);
    setIsTraining(training);
    setDrills(drillConfigs);
    setCurrentDrillIndex(0);
    setDrillResults([]);
    setSavedSession(null);
    setLastAnswer(null);

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

    // Compute score
    const correct = finalAnswers.filter(a => a.correct).length;
    const total = finalAnswers.length;
    const correctRatio = total > 0 ? correct / total : 0;
    const answered = finalAnswers.filter(a => a.answered !== null);
    const totalResponseMs = answered.reduce((sum, a) => sum + a.responseMs, 0);
    const avgResponseMs = answered.length > 0 ? totalResponseMs / answered.length : timeLimitMs;
    const speedBonus = Math.max(0, 1 - avgResponseMs / timeLimitMs);
    const score = Math.min(100, Math.max(0, Math.round((correctRatio * 0.8 + speedBonus * 0.2) * 100)));

    const isMemoryDrill = MEMORY_DRILL_TYPES.includes(currentDrill.type);
    const result = {
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
    const isTextAnswer = typeof q.expected === 'string' || hasFillBlankAnswers;

    // For estimation drills, check within tolerance
    let correct;
    let answered;
    // Fill-blank element attribution: which specific answers[] entry the
    // user's guess matched (if any) — set only on an unambiguous correct
    // match, since a wrong guess against a multi-blank prompt can't be
    // attributed to any one blank/element (issue #2099 codex review).
    let matchedElement;
    if (hasFillBlankAnswers) {
      answered = value;
      const normalized = value !== null ? String(value).toLowerCase().trim() : '';
      // q.answers holds ACCEPTABLE-WORD OBJECTS ({ index, word, element }), not
      // scalars — comparing via String(a) on an object always produced
      // "[object Object]" so this could never match, silently scoring every
      // fill-blank answer wrong (issue #2116). Compare against the object's
      // `.word` (falling back to the raw value for a plain-string entry, for
      // forward/backward compatibility with any other producer).
      const matched = q.answers.find(a => String(a?.word ?? a).toLowerCase().trim() === normalized);
      correct = !!matched;
      matchedElement = matched?.element ?? null;
    } else if (isTextAnswer) {
      answered = value;
      correct = value !== null && String(value).toLowerCase().trim() === String(q.expected).toLowerCase().trim();
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
      expected: q.expected,
      answered,
      correct,
      responseMs,
      ...memoryAttribution(q),
      // Fill-blank's per-answer element (see matchedElement above) takes
      // priority over memoryAttribution(q)'s question-level element field
      // (which fill-blank questions never carry — only memory-element-flash
      // does), so mergeMasteryFromSession can credit the matched element.
      ...(matchedElement != null ? { element: matchedElement } : {})
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
    const remaining = (currentDrill.questions || []).slice(currentQuestionIndex).map(q => ({
      prompt: q.prompt,
      expected: q.expected,
      answered: null,
      correct: false,
      responseMs: 0,
      ...memoryAttribution(q)
    }));

    const finalAnswers = [...answers, ...remaining];
    setAnswers(finalAnswers);
    finishDrillRef.current(finalAnswers);
  }, [state, currentDrill, currentQuestionIndex, answers]);

  const completeLlmDrill = useCallback(async (drillResult) => {
    const isLlm = LLM_DRILL_TYPES.includes(drillResult.type);
    let scoredResult = drillResult;

    if (isLlm && drillResult.responses?.length > 0) {
      setState(STATES.LOADING);
      const drillConfig = drills[currentDrillIndex];
      const timeLimitMs = (drillConfig?.timeLimitSec || 120) * 1000;
      const scoreResult = await scorePostLlmDrill(
        drillResult.type, drillResult.drillData, drillResult.responses,
        timeLimitMs, drillConfig?.providerId, drillConfig?.model, { silent: true }
      ).catch(err => {
        toast.error(`LLM scoring failed: ${err.message}`);
        return null;
      });

      if (scoreResult) {
        scoredResult = {
          ...drillResult,
          score: scoreResult.score,
          responses: scoreResult.questions || drillResult.responses,
          evaluation: scoreResult.evaluation
        };
      } else {
        scoredResult = { ...drillResult, score: 0 };
      }
    }

    const newResults = [...drillResults, scoredResult];
    setDrillResults(newResults);

    if (currentDrillIndex + 1 < drills.length) {
      setState(STATES.BETWEEN_DRILLS);
    } else {
      setSessionScore(computeSessionScoreFromResults(newResults));
      setState(STATES.COMPLETE);
    }
  }, [drillResults, currentDrillIndex, drills]);

  // Interactive cognitive drills (n-back / digit-span / stroop) build their own
  // fully-formed result (questions + local score) and hand it back here. Unlike
  // LLM drills there is no async scoring call — the server recomputes the score
  // deterministically from drillData on submit. Mirrors completeLlmDrill's
  // advance/complete bookkeeping.
  const completeCognitiveDrill = useCallback((drillResult) => {
    const newResults = [...drillResults, drillResult];
    setDrillResults(newResults);

    if (currentDrillIndex + 1 < drills.length) {
      setState(STATES.BETWEEN_DRILLS);
    } else {
      setSessionScore(computeSessionScoreFromResults(newResults));
      setState(STATES.COMPLETE);
    }
  }, [drillResults, currentDrillIndex, drills]);

  const saveSession = useCallback(async (tags = {}) => {
    setState(STATES.SAVING);

    // Training mode: log each drill to the training log, don't save scored session
    if (isTraining) {
      for (const r of drillResults) {
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
        await submitTrainingEntry({
          module: r.module,
          drillType: r.type,
          questionCount,
          correctCount,
          totalMs: r.totalMs || 0,
          ...(questions ? { questions } : {}),
        }).catch(() => {});
      }
      toast.success('Training session logged');
      setState(STATES.SAVED);
      return { training: true };
    }

    const modules = [...new Set(drillResults.map(r => r.module))];
    const session = await submitPostSession({
      cadence: 'daily',
      modules,
      tasks: drillResults,
      tags
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
  }, [drillResults, isTraining]);

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
    setLastAnswer(null);
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
