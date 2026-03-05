import { useState, useCallback, useRef } from 'react';
import { generatePostDrill, submitPostSession, scorePostLlmDrill } from '../services/api';
import toast from 'react-hot-toast';

const LLM_DRILL_TYPES = ['word-association', 'story-recall', 'verbal-fluency', 'wit-comeback', 'pun-wordplay'];

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
  const questionStartRef = useRef(Date.now());
  const drillStartRef = useRef(Date.now());
  const finishDrillRef = useRef(null);

  const startSession = useCallback(async (drillConfigs) => {
    // drillConfigs: [{ type, config, timeLimitSec }]
    if (!drillConfigs?.length) {
      toast.error('No drills configured');
      return;
    }
    setState(STATES.LOADING);
    setDrills(drillConfigs);
    setCurrentDrillIndex(0);
    setDrillResults([]);
    setSavedSession(null);

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
      // Session complete
      const avgScore = Math.round(newResults.reduce((s, r) => s + r.score, 0) / newResults.length);
      setSessionScore(avgScore);
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
    const numValue = value === null ? null : Number(value);

    // For estimation drills, check within tolerance
    let correct;
    if (currentDrill.type === 'estimation') {
      const tolerance = (currentDrill.config?.tolerancePct || 10) / 100;
      correct = numValue !== null && Math.abs(numValue - q.expected) <= Math.abs(q.expected * tolerance);
    } else {
      correct = numValue === q.expected;
    }

    const answer = {
      prompt: q.prompt,
      expected: q.expected,
      answered: numValue,
      correct,
      responseMs
    };

    const newAnswers = [...answers, answer];
    setAnswers(newAnswers);

    // Check if drill is complete
    if (currentQuestionIndex + 1 >= (currentDrill.questions?.length ?? 0)) {
      finishDrillRef.current(newAnswers);
    } else {
      setCurrentQuestionIndex(currentQuestionIndex + 1);
      questionStartRef.current = Date.now();
    }
  }, [state, currentDrill, currentQuestionIndex, answers]);

  const skipQuestion = useCallback(() => {
    submitAnswer(null);
  }, [submitAnswer]);

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
      const avgScore = Math.round(newResults.reduce((s, r) => s + (r.score || 0), 0) / newResults.length);
      setSessionScore(avgScore);
      setState(STATES.COMPLETE);
    }
  }, [drillResults, currentDrillIndex, drills]);

  const saveSession = useCallback(async (tags = {}) => {
    setState(STATES.SAVING);
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
  }, [drillResults]);

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
  }, []);

  return {
    state,
    currentDrill,
    currentQuestionIndex,
    currentDrillIndex,
    drillCount: drills.length,
    answers,
    drillResults,
    sessionScore,
    savedSession,
    startSession,
    submitAnswer,
    skipQuestion,
    nextDrill,
    timeExpired,
    completeLlmDrill,
    saveSession,
    reset
  };
}
