import { useState, useEffect, useRef, useCallback } from 'react';
import { Check, X } from 'lucide-react';
import useMounted from '../../../../hooks/useMounted';
import useKeyCapture from '../../../../hooks/useKeyCapture';
import { isPressKey } from '../../../../lib/a11yKeyboard.js';
import { buildCognitiveResult } from '../cognitiveScoring';
import DrillHeader from './DrillHeader';

export default function ReactionTimeRunner({ drill, drillIndex, drillCount, onComplete, isTraining }) {
  const trials = drill.trials || [];
  const mode = drill.config?.mode === 'choice' ? 'choice' : 'simple';
  const choices = drill.config?.choices || 3;

  const [trialIdx, setTrialIdx] = useState(0);
  const [phase, setPhase] = useState('waiting'); // 'waiting' | 'go' | 'result'
  const [lastResult, setLastResult] = useState(null);
  const answersRef = useRef([]);
  const stimulusShownRef = useRef(false);
  const goStartRef = useRef(0);
  const startedAtRef = useRef(Date.now());
  const mountedRef = useMounted();
  // Separate refs: the "reveal the stimulus" timer (armed per trial) and the
  // "advance to the next trial" timer (armed on response) must never share one
  // ref — overwriting a shared ref on response leaves the reveal timer's
  // callback un-cancelled, so a false start can leak a stale setPhase('go')
  // into a later trial once the ref no longer points at it.
  const armTimeoutRef = useRef(null);
  const advanceTimeoutRef = useRef(null);
  const advancingRef = useRef(false);

  useEffect(() => () => {
    clearTimeout(armTimeoutRef.current);
    clearTimeout(advanceTimeoutRef.current);
  }, []);

  const finish = useCallback(() => {
    const questions = answersRef.current.filter(Boolean);
    onComplete(buildCognitiveResult({ type: 'reaction-time', drill, questions, totalMs: Date.now() - startedAtRef.current }));
  }, [drill, onComplete]);

  const finishRef = useRef(finish);
  finishRef.current = finish;

  // Arm each trial: wait `delayMs` (randomized server-side so onset can't be
  // anticipated), then reveal the stimulus. Capture the timer in a local
  // variable so this effect's cleanup always cancels ITS OWN timer, even if
  // `armTimeoutRef.current` was reassigned in the meantime.
  useEffect(() => {
    if (trialIdx >= trials.length) { finishRef.current(); return; }
    advancingRef.current = false;
    stimulusShownRef.current = false;
    setPhase('waiting');
    setLastResult(null);
    const delay = trials[trialIdx]?.delayMs || 1000;
    const revealTimer = setTimeout(() => {
      if (!mountedRef.current) return;
      stimulusShownRef.current = true;
      goStartRef.current = Date.now();
      setPhase('go');
    }, delay);
    armTimeoutRef.current = revealTimer;
    return () => clearTimeout(revealTimer);
  }, [trialIdx]);

  const recordAndAdvance = useCallback((result) => {
    if (advancingRef.current) return;
    advancingRef.current = true;
    // A false start fires this before the reveal timer elapses — cancel it so
    // it can't flip `phase`/`stimulusShownRef` on a later trial.
    clearTimeout(armTimeoutRef.current);
    answersRef.current[trialIdx] = {
      prompt: mode === 'choice' ? `target ${trials[trialIdx]?.target ?? ''}` : 'react',
      index: trialIdx,
      ...result,
    };
    setLastResult(result);
    setPhase('result');
    const isLast = trialIdx + 1 >= trials.length;
    advanceTimeoutRef.current = setTimeout(() => {
      if (!mountedRef.current) return;
      if (isLast) finishRef.current(); else setTrialIdx(i => i + 1);
    }, isTraining ? 900 : 500);
  }, [trialIdx, trials, mode, isTraining]);

  const respond = useCallback((choiceIndex) => {
    if (advancingRef.current) return;
    if (!stimulusShownRef.current) {
      recordAndAdvance({ answered: null, correct: false, responseMs: 0, falseStart: true });
      return;
    }
    const responseMs = Date.now() - goStartRef.current;
    if (mode === 'choice') {
      const target = trials[trialIdx]?.target;
      recordAndAdvance({ answered: choiceIndex, correct: choiceIndex === target, responseMs, falseStart: false });
    } else {
      recordAndAdvance({ answered: 'react', correct: true, responseMs, falseStart: false });
    }
  }, [mode, trialIdx, trials, recordAndAdvance]);

  // Space (simple mode) or number keys 1..N (choice mode) register a response.
  // Claimed in the capture phase so the voice widget's global push-to-talk
  // hotkey (Space by default) can't open the mic on every reaction press.
  useKeyCapture({
    onKeyDown: (e) => {
      const idx = mode === 'simple' ? (isPressKey(e) ? 0 : -1) : parseInt(e.key, 10) - 1;
      if (!Number.isInteger(idx) || idx < 0 || idx >= (mode === 'simple' ? 1 : choices)) return false;
      // Claim the key through the between-trials result phase too, so a user
      // still tapping after the trial ended doesn't leak the press to the voice
      // hotkey — just don't record it against the trial that already resolved.
      if (phase !== 'result') respond(idx);
      return true;
    },
  });

  const target = trials[trialIdx]?.target;
  const progressPct = trials.length > 0 ? (trialIdx / trials.length) * 100 : 0;

  return (
    <div className="max-w-lg mx-auto space-y-6">
      <DrillHeader type="reaction-time" isTraining={isTraining} drillIndex={drillIndex} drillCount={drillCount} />

      <p className="text-center text-sm text-gray-400">
        {mode === 'choice'
          ? <>Wait for a box marked GO, then press its number — <span className="text-rose-400 font-semibold">as fast as you can</span>.</>
          : <>Wait for the signal, then press <span className="text-white font-medium">Space</span> (or tap) — <span className="text-rose-400 font-semibold">as fast as you can</span>.</>}
      </p>

      {mode === 'choice' && (
        <div role="status" className="sr-only">
          {phase === 'go' && Number.isInteger(target) && `Target ${target + 1} — Go`}
        </div>
      )}

      <div className="py-8 min-h-[10rem] flex flex-col items-center justify-center gap-4">
        {phase === 'waiting' && (
          <button
            type="button"
            onClick={() => respond(0)}
            aria-label="Wait for the signal"
            className="w-32 h-32 rounded-full bg-port-border/30 text-gray-500 text-sm flex items-center justify-center"
          >
            Wait…
          </button>
        )}

        {phase === 'go' && mode === 'simple' && (
          <button
            type="button"
            onClick={() => respond(0)}
            className="w-32 h-32 rounded-full bg-port-success/80 hover:bg-port-success text-white font-bold text-lg transition-colors"
          >
            GO!
          </button>
        )}

        {phase === 'go' && mode === 'choice' && (
          <div className="grid grid-cols-2 gap-3 w-full">
            {Array.from({ length: choices }, (_, i) => {
              const isTarget = i === target;
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => respond(i)}
                  aria-label={isTarget ? `Target ${i + 1} — Go` : `Choice ${i + 1}`}
                  className={`flex items-center justify-center gap-2 px-4 py-6 rounded-lg border font-semibold transition-colors ${
                    isTarget
                      ? 'bg-port-success/80 hover:bg-port-success border-port-success text-white ring-2 ring-white scale-[1.02]'
                      : 'bg-port-card border-port-border text-gray-500'
                  }`}
                >
                  {i + 1}
                  {isTarget && <span className="text-xs">GO</span>}
                </button>
              );
            })}
          </div>
        )}

        {phase === 'result' && lastResult && (
          <div className={`flex flex-col items-center gap-2 ${lastResult.correct ? 'text-port-success' : 'text-port-error'}`}>
            {lastResult.correct ? <Check size={32} /> : <X size={32} />}
            <div className="text-sm">
              {lastResult.falseStart ? 'Too soon!' : lastResult.correct ? `${lastResult.responseMs}ms` : 'Wrong'}
            </div>
          </div>
        )}
      </div>

      <div className="space-y-1">
        <div className="flex justify-between text-xs text-gray-500">
          <span>Trial {Math.min(trialIdx + 1, trials.length)} of {trials.length}</span>
          <span>{Math.round(progressPct)}%</span>
        </div>
        <div className="w-full h-1.5 bg-port-border rounded-full overflow-hidden">
          <div className="h-full bg-rose-400/60 transition-all" style={{ width: `${progressPct}%` }} />
        </div>
      </div>
    </div>
  );
}
