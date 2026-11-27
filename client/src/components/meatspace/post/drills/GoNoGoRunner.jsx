import { useState, useEffect, useRef, useCallback } from 'react';
import useMounted from '../../../../hooks/useMounted';
import useKeyCapture from '../../../../hooks/useKeyCapture';
import { isPressKey } from '../../../../lib/a11yKeyboard.js';
import { buildCognitiveResult, scoreGoNoGoTrial } from '../cognitiveScoring';
import DrillHeader from './DrillHeader';

export default function GoNoGoRunner({ drill, drillIndex, drillCount, onComplete, isTraining }) {
  const trials = drill.trials || [];
  const stimulusMs = drill.config?.stimulusMs || 600;
  const deadlineMs = drill.config?.responseDeadlineMs || 1400;
  const [trialIdx, setTrialIdx] = useState(0);
  const [visible, setVisible] = useState(true);
  const [feedback, setFeedback] = useState(null);
  const [accepting, setAccepting] = useState(true);
  const questionsRef = useRef([]);
  const trialStartRef = useRef(Date.now());
  const startedAtRef = useRef(Date.now());
  const acceptingRef = useRef(false);
  const hideTimerRef = useRef(null);
  const deadlineTimerRef = useRef(null);
  const advanceTimerRef = useRef(null);
  const finishedRef = useRef(false);
  const mountedRef = useMounted();

  const finish = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    onComplete(buildCognitiveResult({ type: 'go-no-go', drill, questions: questionsRef.current, totalMs: Date.now() - startedAtRef.current }));
  }, [drill, onComplete]);
  const finishRef = useRef(finish);
  finishRef.current = finish;

  const record = useCallback((pressed) => {
    if (!acceptingRef.current) return;
    acceptingRef.current = false;
    setAccepting(false);
    clearTimeout(hideTimerRef.current);
    clearTimeout(deadlineTimerRef.current);
    const question = scoreGoNoGoTrial({
      trial: trials[trialIdx],
      index: trialIdx,
      pressed,
      responseMs: pressed ? Date.now() - trialStartRef.current : deadlineMs,
    });
    questionsRef.current.push(question);
    setFeedback(question.correct ? (pressed ? 'Go' : 'Held') : pressed ? 'No-go lure' : 'Missed go signal');
    setVisible(false);
    const isLast = trialIdx + 1 >= trials.length;
    advanceTimerRef.current = setTimeout(() => {
      if (!mountedRef.current) return;
      if (isLast) finishRef.current(); else setTrialIdx(index => index + 1);
    }, isTraining ? 700 : 250);
  }, [deadlineMs, isTraining, trialIdx, trials]);
  const recordRef = useRef(record);
  recordRef.current = record;

  useEffect(() => {
    if (trialIdx >= trials.length) { finishRef.current(); return undefined; }
    acceptingRef.current = true;
    setAccepting(true);
    trialStartRef.current = Date.now();
    setVisible(true);
    setFeedback(null);
    hideTimerRef.current = setTimeout(() => {
      if (mountedRef.current) setVisible(false);
    }, stimulusMs);
    deadlineTimerRef.current = setTimeout(() => recordRef.current(false), deadlineMs);
    return () => {
      acceptingRef.current = false;
      clearTimeout(hideTimerRef.current);
      clearTimeout(deadlineTimerRef.current);
      clearTimeout(advanceTimerRef.current);
    };
  }, [deadlineMs, stimulusMs, trialIdx, trials]);

  // Claimed in the capture phase so the voice widget's global push-to-talk
  // hotkey (Space by default) can't open the mic on every go press.
  useKeyCapture({
    onKeyDown: (event) => {
      if (!isPressKey(event)) return false;
      recordRef.current(true);
      return true;
    },
  });

  const trial = trials[trialIdx];
  const symbolLabel = { '●': 'filled circle', '◉': 'ringed circle', '■': 'filled square' }[trial?.symbol] || 'signal';
  const toneClass = trial?.tone === 'red' ? 'text-port-error' : trial?.tone === 'amber' ? 'text-port-warning' : 'text-port-success';
  const progressPct = trials.length ? (trialIdx / trials.length) * 100 : 0;
  return (
    <div className="max-w-lg mx-auto space-y-6">
      <DrillHeader type="go-no-go" isTraining={isTraining} drillIndex={drillIndex} drillCount={drillCount} />
      <p className="text-center text-sm text-gray-400">Press for <span className="text-port-success font-medium">green go</span>. Withhold for red or amber no-go lures.</p>
      <button
        type="button"
        aria-label={symbolLabel}
        onClick={() => recordRef.current(true)}
        disabled={!accepting}
        className="mx-auto w-48 h-48 rounded-2xl border border-port-border bg-port-card flex items-center justify-center disabled:opacity-70 motion-reduce:transition-none"
      >
        <span role="status" aria-live="polite" className={`text-8xl ${visible ? toneClass : 'text-transparent'}`}>
          {visible ? trial?.symbol : '·'}
        </span>
      </button>
      <div className={`text-center min-h-6 ${feedback && !questionsRef.current.at(-1)?.correct ? 'text-port-error' : 'text-port-success'}`} role="status" aria-live="polite">{feedback || 'Ready'}</div>
      <div className="space-y-1">
        <div className="flex justify-between text-xs text-gray-500"><span>Trial {Math.min(trialIdx + 1, trials.length)} of {trials.length}</span><span>{Math.round(progressPct)}%</span></div>
        <div className="w-full h-1.5 bg-port-border rounded-full overflow-hidden"><div className="h-full bg-rose-400/60 transition-all motion-reduce:transition-none" style={{ width: `${progressPct}%` }} /></div>
      </div>
    </div>
  );
}
