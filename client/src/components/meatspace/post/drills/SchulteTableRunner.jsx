import { useState, useEffect, useRef, useCallback } from 'react';
import { buildCognitiveResult, scoreSchulteClick } from '../cognitiveScoring';
import DrillHeader from './DrillHeader';

export default function SchulteTableRunner({ drill, drillIndex, drillCount, onComplete, isTraining }) {
  const cells = drill.cells || [];
  const size = drill.config?.size || 5;
  const total = cells.length;

  const [target, setTarget] = useState(1);
  const [flash, setFlash] = useState(null); // value of a just-missed (wrong) click
  const questionsRef = useRef([]);
  const stepStartRef = useRef(Date.now());
  const startedAtRef = useRef(Date.now());
  const flashTimeoutRef = useRef(null);
  // Mirrors `target` synchronously so a double-tap/double-click that fires two
  // handleClick calls before React commits the setTarget update can't both read
  // the same stale `target` and both advance — the second call sees the bumped
  // ref and is treated as a miss instead of a duplicate correct answer.
  const targetRef = useRef(target);

  useEffect(() => () => clearTimeout(flashTimeoutRef.current), []);

  const finish = useCallback(() => {
    onComplete(buildCognitiveResult({
      type: 'schulte-table',
      drill,
      questions: questionsRef.current,
      totalMs: Date.now() - startedAtRef.current,
    }));
  }, [drill, onComplete]);

  const finishRef = useRef(finish);
  finishRef.current = finish;

  const handleClick = useCallback((value) => {
    const current = targetRef.current;
    const question = scoreSchulteClick({
      target: current,
      value,
      responseMs: Date.now() - stepStartRef.current,
    });
    questionsRef.current.push(question);
    if (!question.correct) {
      setFlash(value);
      clearTimeout(flashTimeoutRef.current);
      flashTimeoutRef.current = setTimeout(() => setFlash(null), 200);
      return;
    }
    // Advance the ref immediately (synchronously) so a second handleClick call
    // racing in before this render commits sees the bumped value, not `current`.
    targetRef.current = current + 1;
    stepStartRef.current = Date.now();
    if (current >= total) finishRef.current();
    else setTarget(current + 1);
  }, [total]);

  const found = Math.min(target - 1, total);
  const progressPct = total > 0 ? (found / total) * 100 : 0;

  return (
    <div className="max-w-lg mx-auto space-y-6">
      <DrillHeader type="schulte-table" isTraining={isTraining} drillIndex={drillIndex} drillCount={drillCount} />

      <p className="text-center text-sm text-gray-400">
        Tap the numbers in order — <span className="text-rose-400 font-semibold">1, 2, 3...</span> — as fast as you can.
      </p>

      <div className="flex items-center justify-center gap-2 text-sm text-gray-400">
        <span>Find:</span>
        <span className="text-2xl font-mono font-bold text-white">{Math.min(target, total)}</span>
      </div>

      <div
        className="grid gap-1.5 mx-auto w-full"
        style={{ gridTemplateColumns: `repeat(${size}, minmax(0, 1fr))`, maxWidth: `${size * 3.5}rem` }}
      >
        {cells.map((value, i) => {
          const isDone = value < target;
          const isFlashing = flash === value;
          return (
            <button
              key={i}
              type="button"
              onClick={() => handleClick(value)}
              disabled={isDone}
              className={`aspect-square flex items-center justify-center rounded-md font-mono font-semibold text-sm border transition-colors ${
                isDone
                  ? 'bg-port-success/10 border-port-success/30 text-port-success/50'
                  : isFlashing
                  ? 'bg-port-error/30 border-port-error/60 text-white'
                  : 'bg-port-card border-port-border text-white hover:bg-port-bg'
              }`}
            >
              {value}
            </button>
          );
        })}
      </div>

      <div className="space-y-1">
        <div className="flex justify-between text-xs text-gray-500">
          <span>{found} / {total} found</span>
          <span>{Math.round(progressPct)}%</span>
        </div>
        <div className="w-full h-1.5 bg-port-border rounded-full overflow-hidden">
          <div className="h-full bg-rose-400/60 transition-all" style={{ width: `${progressPct}%` }} />
        </div>
      </div>
    </div>
  );
}
