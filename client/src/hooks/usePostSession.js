import { useState, useCallback, useRef } from 'react';
import { generatePostDrill, submitPostSession } from '../services/api';
import toast from 'react-hot-toast';

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

  const startSession = useCallback(async (drillConfigs) => {
    // drillConfigs: [{ type, config, timeLimitSec }]
    setState(STATES.LOADING);
    setDrills(drillConfigs);
    setCurrentDrillIndex(0);
    setDrillResults([]);
    setSavedSession(null);

    const first = drillConfigs[0];
    const drill = await generatePostDrill(first.type, first.config).catch(err => {
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
  }, []);

  const submitAnswer = useCallback((value) => {
    if (state !== STATES.DRILLING || !currentDrill) return;

    const q = currentDrill.questions[currentQuestionIndex];
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
    if (currentQuestionIndex + 1 >= currentDrill.questions.length) {
      finishDrill(newAnswers);
    } else {
      setCurrentQuestionIndex(currentQuestionIndex + 1);
      questionStartRef.current = Date.now();
    }
  }, [state, currentDrill, currentQuestionIndex, answers, finishDrill]);

  const skipQuestion = useCallback(() => {
    submitAnswer(null);
  }, [submitAnswer]);

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

  const nextDrill = useCallback(async () => {
    const nextIndex = currentDrillIndex + 1;
    setCurrentDrillIndex(nextIndex);
    setState(STATES.LOADING);

    const next = drills[nextIndex];
    const drill = await generatePostDrill(next.type, next.config).catch(err => {
      toast.error(`Failed to generate drill: ${err.message}`);
      setState(STATES.IDLE);
      return null;
    });
    if (!drill) return;
    setCurrentDrill({ ...drill, timeLimitSec: next.timeLimitSec });
    setCurrentQuestionIndex(0);
    setAnswers([]);
    questionStartRef.current = Date.now();
    drillStartRef.current = Date.now();
    setState(STATES.DRILLING);
  }, [currentDrillIndex, drills]);

  const timeExpired = useCallback(() => {
    if (state !== STATES.DRILLING || !currentDrill) return;

    // Mark remaining questions as unanswered
    const remaining = currentDrill.questions.slice(currentQuestionIndex).map(q => ({
      prompt: q.prompt,
      expected: q.expected,
      answered: null,
      correct: false,
      responseMs: 0
    }));

    const finalAnswers = [...answers, ...remaining];
    setAnswers(finalAnswers);
    finishDrill(finalAnswers);
  }, [state, currentDrill, currentQuestionIndex, answers, finishDrill]);

  const saveSession = useCallback(async (tags = {}) => {
    setState(STATES.SAVING);
    const session = await submitPostSession({
      cadence: 'daily',
      modules: ['mental-math'],
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
    saveSession,
    reset
  };
}
