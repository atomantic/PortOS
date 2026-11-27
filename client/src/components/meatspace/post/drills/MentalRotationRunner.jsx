import { useState, useEffect, useRef, useCallback } from 'react';
import { Check, X } from 'lucide-react';
import { shouldIgnoreGlobalKey } from '../../../../lib/a11yKeyboard.js';
import { buildCognitiveResult, scoreMentalRotationTrial } from '../cognitiveScoring';
import DrillHeader from './DrillHeader';

// Renders a `[x, y]` cell list (mental-rotation shapes) as a small filled-cell
// grid within a `size x size` box — no images/canvas, just CSS grid squares.
function ShapeGrid({ cells, size = 4, cellPx = 14 }) {
  const filled = new Set((cells || []).map(([x, y]) => `${x},${y}`));
  return (
    <div
      className="grid gap-0.5"
      style={{ gridTemplateColumns: `repeat(${size}, ${cellPx}px)`, gridTemplateRows: `repeat(${size}, ${cellPx}px)` }}
    >
      {Array.from({ length: size * size }, (_, i) => {
        const x = i % size;
        const y = Math.floor(i / size);
        return (
          <div key={i} className={`rounded-sm ${filled.has(`${x},${y}`) ? 'bg-rose-400' : 'bg-port-border/30'}`} />
        );
      })}
    </div>
  );
}

export default function MentalRotationRunner({ drill, drillIndex, drillCount, onComplete, isTraining }) {
  const trials = drill.trials || [];
  const gridSize = drill.config?.gridSize || 4;

  const [trialIdx, setTrialIdx] = useState(0);
  const [feedback, setFeedback] = useState(null); // { correct, expected, isLast } training reveal
  const answersRef = useRef([]);
  const trialStartRef = useRef(Date.now());
  const startedAtRef = useRef(Date.now());
  const advancingRef = useRef(false);

  const finish = useCallback(() => {
    const questions = answersRef.current.filter(Boolean);
    onComplete(buildCognitiveResult({ type: 'mental-rotation', drill, questions, totalMs: Date.now() - startedAtRef.current }));
  }, [drill, onComplete]);

  const finishRef = useRef(finish);
  finishRef.current = finish;

  useEffect(() => { trialStartRef.current = Date.now(); advancingRef.current = false; }, [trialIdx]);

  const answer = useCallback((optionIndex) => {
    if (advancingRef.current || feedback) return;
    const trial = trials[trialIdx];
    if (!trial) return;
    const question = scoreMentalRotationTrial({ trial, index: trialIdx, optionIndex, responseMs: Date.now() - trialStartRef.current });
    answersRef.current[trialIdx] = question;
    const isLast = trialIdx + 1 >= trials.length;
    if (isTraining) {
      setFeedback({ correct: question.correct, expected: trial.correctIndex, isLast });
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
      const optionCount = trials[trialIdx]?.options?.length || 0;
      const idx = parseInt(e.key, 10) - 1;
      if (Number.isInteger(idx) && idx >= 0 && idx < optionCount) {
        e.preventDefault();
        answer(idx);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [feedback, trials, trialIdx, answer, acknowledge]);

  const trial = trials[trialIdx];
  const progressPct = trials.length > 0 ? (trialIdx / trials.length) * 100 : 0;

  return (
    <div className="max-w-lg mx-auto space-y-6">
      <DrillHeader type="mental-rotation" isTraining={isTraining} drillIndex={drillIndex} drillCount={drillCount} />

      <p className="text-center text-sm text-gray-400">
        Which shape below is the <span className="text-white font-medium">SAME</span> shape, just rotated — not mirrored?
      </p>

      {trial ? (
        <>
          <div className="flex justify-center py-4">
            <ShapeGrid cells={trial.target} size={gridSize} />
          </div>

          {feedback ? (
            <div className="space-y-4">
              <div className={`flex items-center justify-center gap-2 ${feedback.correct ? 'text-port-success' : 'text-port-error'}`}>
                {feedback.correct ? <Check size={24} /> : <X size={24} />}
                <span className="text-sm">{feedback.correct ? 'Correct' : `Option ${feedback.expected + 1} was the match`}</span>
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
              {trial.options.map((cells, i) => (
                <button
                  type="button"
                  key={i}
                  onClick={() => answer(i)}
                  className="flex flex-col items-center gap-1 px-4 py-4 bg-port-card hover:bg-port-bg border border-port-border rounded-lg transition-colors"
                >
                  <ShapeGrid cells={cells} size={gridSize} />
                  <span className="text-xs text-gray-600">{i + 1}</span>
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="text-gray-500 text-center py-8">Done</div>
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
