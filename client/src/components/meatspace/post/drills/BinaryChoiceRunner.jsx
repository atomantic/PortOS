import { useState, useEffect, useRef, useCallback } from 'react';
import useMounted from '../../../../hooks/useMounted';
import { shouldIgnoreGlobalKey } from '../../../../lib/a11yKeyboard.js';
import { buildCognitiveResult, scoreFlankerTrial, scoreTaskSwitchTrial } from '../cognitiveScoring';
import DrillHeader from './DrillHeader';

export default function BinaryChoiceRunner({ type, drill, drillIndex, drillCount, onComplete, isTraining }) {
  const trials = drill.trials || [];
  const cueDelayMs = type === 'task-switching' ? (drill.config?.cueStimulusIntervalMs || 700) : 0;
  const deadlineMs = drill.config?.responseDeadlineMs || 1800;
  const [trialIdx, setTrialIdx] = useState(0);
  const [phase, setPhase] = useState(cueDelayMs ? 'cue' : 'stimulus');
  const [feedback, setFeedback] = useState(null);
  const questionsRef = useRef([]);
  const stimulusStartRef = useRef(0);
  const startedAtRef = useRef(Date.now());
  const acceptingRef = useRef(false);
  const cueTimerRef = useRef(null);
  const deadlineTimerRef = useRef(null);
  const advanceTimerRef = useRef(null);
  const finishedRef = useRef(false);
  const mountedRef = useMounted();

  const finish = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    onComplete(buildCognitiveResult({ type, drill, questions: questionsRef.current, totalMs: Date.now() - startedAtRef.current }));
  }, [type, drill, onComplete]);
  const finishRef = useRef(finish);
  finishRef.current = finish;

  const recordAnswer = useCallback((answer) => {
    if (!acceptingRef.current) return;
    acceptingRef.current = false;
    clearTimeout(deadlineTimerRef.current);
    const trial = trials[trialIdx];
    const responseMs = stimulusStartRef.current ? Date.now() - stimulusStartRef.current : deadlineMs;
    const question = type === 'task-switching'
      ? scoreTaskSwitchTrial({ trial, index: trialIdx, answer, responseMs })
      : scoreFlankerTrial({ trial, index: trialIdx, answer, responseMs });
    questionsRef.current.push(question);
    setFeedback(question.correct ? 'Correct' : answer == null ? 'Too slow' : `Center answer: ${question.expected}`);
    setPhase('feedback');
    const isLast = trialIdx + 1 >= trials.length;
    advanceTimerRef.current = setTimeout(() => {
      if (!mountedRef.current) return;
      if (isLast) finishRef.current(); else setTrialIdx(index => index + 1);
    }, isTraining ? 700 : 250);
  }, [deadlineMs, isTraining, trialIdx, trials, type]);
  const recordRef = useRef(recordAnswer);
  recordRef.current = recordAnswer;

  useEffect(() => {
    if (trialIdx >= trials.length) { finishRef.current(); return undefined; }
    acceptingRef.current = false;
    setFeedback(null);
    setPhase(cueDelayMs ? 'cue' : 'stimulus');
    const reveal = () => {
      if (!mountedRef.current) return;
      stimulusStartRef.current = Date.now();
      acceptingRef.current = true;
      setPhase('stimulus');
      deadlineTimerRef.current = setTimeout(() => recordRef.current(null), deadlineMs);
    };
    if (cueDelayMs) cueTimerRef.current = setTimeout(reveal, cueDelayMs);
    else reveal();
    return () => {
      acceptingRef.current = false;
      clearTimeout(cueTimerRef.current);
      clearTimeout(deadlineTimerRef.current);
      clearTimeout(advanceTimerRef.current);
    };
  }, [cueDelayMs, deadlineMs, trialIdx, trials]);

  useEffect(() => {
    const onKey = (event) => {
      if (phase !== 'stimulus' || shouldIgnoreGlobalKey(event)) return;
      if (event.key === 'ArrowLeft' || event.key.toLowerCase() === 'a') {
        event.preventDefault();
        recordRef.current('left');
      } else if (event.key === 'ArrowRight' || event.key.toLowerCase() === 'd') {
        event.preventDefault();
        recordRef.current('right');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase]);

  const trial = trials[trialIdx];
  const activeRule = drill.rules?.find(rule => rule.id === trial?.rule);
  const leftLabel = type === 'task-switching' ? activeRule?.values?.[0] || 'Left' : 'Left';
  const rightLabel = type === 'task-switching' ? activeRule?.values?.[1] || 'Right' : 'Right';
  const shape = trial?.stimulus?.shape === 'triangle'
    ? (trial?.stimulus?.fill === 'outline' ? '△' : '▲')
    : (trial?.stimulus?.fill === 'outline' ? '○' : '●');
  const flankerCount = Math.max(1, drill.config?.flankerStrength || 2);
  const arrow = direction => direction === 'left' ? '←' : '→';
  const progressPct = trials.length ? (trialIdx / trials.length) * 100 : 0;

  return (
    <div className="max-w-lg mx-auto space-y-6">
      <DrillHeader type={type} isTraining={isTraining} drillIndex={drillIndex} drillCount={drillCount} />
      <p className="text-center text-sm text-gray-400">
        {type === 'task-switching'
          ? <>Use the <span className="text-white font-medium">cued rule</span>; ignore the other attributes.</>
          : <>Answer the direction of the <span className="text-white font-medium">center arrow</span>; ignore the flankers.</>}
      </p>

      <div className="min-h-[11rem] flex flex-col items-center justify-center gap-5" role="status" aria-live="polite">
        {type === 'task-switching' && (
          <div className="rounded-full border border-rose-500/40 bg-rose-500/10 px-5 py-2 text-sm font-semibold uppercase tracking-wider text-rose-200">
            Rule: {trial?.rule || '—'}
          </div>
        )}
        {phase === 'cue' && <div className="text-gray-500">Get ready…</div>}
        {phase === 'stimulus' && type === 'task-switching' && trial && (
          <div
            aria-label={[trial.stimulus.color, trial.stimulus.fill, trial.stimulus.shape].filter(Boolean).join(' ')}
            className="text-8xl leading-none motion-reduce:transition-none"
            style={{ color: trial.stimulus.color === 'blue' ? '#3b82f6' : '#f97316' }}
          >
            {shape}
          </div>
        )}
        {phase === 'stimulus' && type === 'flanker' && trial && (
          <div
            aria-label={`Center arrow ${trial.target}`}
            className="flex items-center font-mono text-5xl text-white motion-reduce:transition-none"
            style={{ gap: `${Math.max(0.2, (drill.config?.flankerDistance || 2) * 0.3)}rem` }}
          >
            <span className="text-gray-500" aria-hidden="true">{arrow(trial.flanker).repeat(flankerCount)}</span>
            <span>{arrow(trial.target)}</span>
            <span className="text-gray-500" aria-hidden="true">{arrow(trial.flanker).repeat(flankerCount)}</span>
          </div>
        )}
        {phase === 'feedback' && (
          <div className={feedback === 'Correct' ? 'text-port-success' : 'text-port-error'}>{feedback}</div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <button type="button" onClick={() => recordRef.current('left')} disabled={phase !== 'stimulus'} className="px-5 py-4 rounded-lg border border-port-border bg-port-card hover:bg-port-bg disabled:opacity-40 text-white font-medium">
          ← {leftLabel}
        </button>
        <button type="button" onClick={() => recordRef.current('right')} disabled={phase !== 'stimulus'} className="px-5 py-4 rounded-lg border border-port-border bg-port-card hover:bg-port-bg disabled:opacity-40 text-white font-medium">
          {rightLabel} →
        </button>
      </div>

      <div className="space-y-1">
        <div className="flex justify-between text-xs text-gray-500"><span>Trial {Math.min(trialIdx + 1, trials.length)} of {trials.length}</span><span>{Math.round(progressPct)}%</span></div>
        <div className="w-full h-1.5 bg-port-border rounded-full overflow-hidden"><div className="h-full bg-rose-400/60 transition-all motion-reduce:transition-none" style={{ width: `${progressPct}%` }} /></div>
      </div>
    </div>
  );
}
