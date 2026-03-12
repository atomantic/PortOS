import { useState, useCallback, useRef } from 'react';
import { generatePostDrill, submitPostSession, scorePostLlmDrill, submitTrainingEntry } from '../services/api';
import toast from 'react-hot-toast';
import { LLM_DRILL_TYPES, DRILL_TO_DOMAIN } from '../components/meatspace/post/constants';

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
    const drill = await generatePostDrill(first.type, first.config, first.providerId, first.model).catch(err => {
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

    const result = {
      module: 'mental-math',
      type: currentDrill.type,
      config: currentDrill.config,
      questions: finalAnswers,
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
    const isTextAnswer = typeof q.expected === 'string';

    // For estimation drills, check within tolerance
    let correct;
    let answered;
    if (isTextAnswer) {
      answered = value;
      correct = value !== null && String(value).toLowerCase().trim() === String(q.expected).toLowerCase().trim();
    } else if (currentDrill.type === 'estimation') {
      const num = value === null ? null : Number(value);
      answered = (num !== null && isNaN(num)) ? null : num;
      const tolerance = (currentDrill.config?.tolerancePct || 10) / 100;
      correct = answered !== null && Math.abs(answered - q.expected) <= Math.abs(q.expected * tolerance);
    } else {
      const num = value === null ? null : Number(value);
      answered = (num !== null && isNaN(num)) ? null : num;
      correct = answered === q.expected;
    }

    const answer = {
      prompt: q.prompt,
      expected: q.expected,
      answered,
      correct,
      responseMs
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
    const drill = await generatePostDrill(next.type, next.config, next.providerId, next.model).catch(err => {
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
      responseMs: 0
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
        timeLimitMs, drillConfig?.providerId, drillConfig?.model
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

  const saveSession = useCallback(async (tags = {}) => {
    setState(STATES.SAVING);

    // Training mode: log each drill to the training log, don't save scored session
    if (isTraining) {
      for (const r of drillResults) {
        const questionCount = r.questions?.length || r.responses?.length || 0;
        const correctCount = r.questions?.filter(q => q.correct)?.length ?? 0;
        await submitTrainingEntry({
          module: r.module,
          drillType: r.type,
          questionCount,
          correctCount,
          totalMs: r.totalMs || 0,
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
    }).catch(err => {
      toast.error(`Failed to save session: ${err.message}`);
      setState(STATES.COMPLETE);
      return null;
    });
    if (!session) return null;
    setSavedSession(session);
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
    saveSession,
    reset
  };
}
