import { useState, useEffect, useRef, useCallback } from 'react';
import { Check, X } from 'lucide-react';
import { shouldIgnoreGlobalKey } from '../../../../lib/a11yKeyboard.js';
import { buildCognitiveResult, scoreStroopTrial } from '../cognitiveScoring';
import DrillHeader from './DrillHeader';

export default function StroopRunner({ drill, drillIndex, drillCount, onComplete, isTraining }) {
  const trials = drill.trials || [];
  const options = drill.options || [];

  const [trialIdx, setTrialIdx] = useState(0);
  const [feedback, setFeedback] = useState(null); // { correct } training reveal
  const answersRef = useRef([]);
  const trialStartRef = useRef(Date.now());
  const startedAtRef = useRef(Date.now());
  const advancingRef = useRef(false);

  const finish = useCallback(() => {
    const questions = answersRef.current.filter(Boolean);
    onComplete(buildCognitiveResult({ type: 'stroop', drill, questions, totalMs: Date.now() - startedAtRef.current }));
  }, [drill, onComplete]);

  const finishRef = useRef(finish);
  finishRef.current = finish;

  useEffect(() => { trialStartRef.current = Date.now(); advancingRef.current = false; }, [trialIdx]);

  const answer = useCallback((colorName) => {
    if (advancingRef.current || feedback) return;
    const trial = trials[trialIdx];
    if (!trial) return;
    const question = scoreStroopTrial({ trial, index: trialIdx, colorName, responseMs: Date.now() - trialStartRef.current });
    answersRef.current[trialIdx] = question;
    const isLast = trialIdx + 1 >= trials.length;
    if (isTraining) {
      setFeedback({ correct: question.correct, expected: trial.inkColor, isLast });
    } else {
      advancingRef.current = true;
      if (isLast) finishRef.current(); else setTrialIdx(i => i + 1);
    }
  }, [feedback, trials, trialIdx, isTraining]);

  const acknowledge = useCallback(() => {
    const isLast = feedback?.isLast;
    setFeedback(null);
    if (isLast) finishRef.current(); else setTrialIdx(i => i + 1);
  }, [feedback]);

  // Number keys 1..N pick the matching option.
  useEffect(() => {
    const onKey = (e) => {
      if (shouldIgnoreGlobalKey(e)) return;
      if (feedback) { if (e.key === 'Enter') { e.preventDefault(); acknowledge(); } return; }
      const idx = parseInt(e.key, 10) - 1;
      if (Number.isInteger(idx) && idx >= 0 && idx < options.length) {
        e.preventDefault();
        answer(options[idx].name);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [feedback, options, answer, acknowledge]);

  const trial = trials[trialIdx];
  const progressPct = trials.length > 0 ? (trialIdx / trials.length) * 100 : 0;

  return (
    <div className="max-w-lg mx-auto space-y-6">
      <DrillHeader type="stroop" isTraining={isTraining} drillIndex={drillIndex} drillCount={drillCount} />

      <p className="text-center text-sm text-gray-400">
        Tap the <span className="text-white font-medium">ink color</span> of the word — not what it spells.
      </p>

      <div className="text-center py-12 min-h-[8rem] flex items-center justify-center">
        {trial ? (
          <div className="text-6xl font-bold uppercase tracking-wide" style={{ color: trial.inkHex }}>
            {trial.word}
          </div>
        ) : (
          <div className="text-gray-500">Done</div>
        )}
      </div>

      {feedback ? (
        <div className="space-y-4">
          <div className={`flex items-center justify-center gap-2 ${feedback.correct ? 'text-port-success' : 'text-port-error'}`}>
            {feedback.correct ? <Check size={24} /> : <X size={24} />}
            <span className="text-sm">{feedback.correct ? 'Correct' : `Ink was ${feedback.expected}`}</span>
          </div>
          <button
            type="button"
            onClick={acknowledge}
            className="w-full px-6 py-3 bg-port-accent-2 hover:bg-port-accent-2/80 text-port-on-accent-2 font-medium rounded-lg transition-colors"
          >
            Next
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {options.map((opt, i) => (
            <button
              type="button"
              key={opt.name}
              onClick={() => answer(opt.name)}
              className="flex items-center justify-center gap-2 px-4 py-4 bg-port-card hover:bg-port-bg border border-port-border rounded-lg text-white font-medium capitalize transition-colors"
            >
              <span className="w-4 h-4 rounded-full" style={{ backgroundColor: opt.hex }} aria-hidden="true" />
              {opt.name}
              <span className="text-xs text-gray-600">{i + 1}</span>
            </button>
          ))}
        </div>
      )}

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
