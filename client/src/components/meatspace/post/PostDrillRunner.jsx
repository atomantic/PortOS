import { useState, useEffect, useRef, useCallback } from 'react';

const DRILL_LABELS = {
  'doubling-chain': 'Doubling Chain',
  'serial-subtraction': 'Serial Subtraction',
  'multiplication': 'Multiplication',
  'powers': 'Powers',
  'estimation': 'Estimation'
};

export default function PostDrillRunner({ session }) {
  const {
    currentDrill,
    currentQuestionIndex,
    currentDrillIndex,
    drillCount,
    state,
    submitAnswer,
    skipQuestion,
    timeExpired
  } = session;

  const [inputValue, setInputValue] = useState('');
  const [timeLeft, setTimeLeft] = useState(0);
  const inputRef = useRef(null);
  const timerRef = useRef(null);
  const timeExpiredRef = useRef(timeExpired);

  const timeLimitMs = (currentDrill?.timeLimitSec || 120) * 1000;
  const totalQuestions = currentDrill?.questions?.length || 0;

  // Keep ref current to avoid stale closure in timer
  useEffect(() => {
    timeExpiredRef.current = timeExpired;
  }, [timeExpired]);

  // Timer
  useEffect(() => {
    if (state !== 'drilling' || !currentDrill) return;

    const startTime = Date.now();
    const limit = (currentDrill.timeLimitSec || 120) * 1000;
    setTimeLeft(limit);

    timerRef.current = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, limit - elapsed);
      setTimeLeft(remaining);
      if (remaining <= 0) {
        clearInterval(timerRef.current);
        timeExpiredRef.current();
      }
    }, 100);

    return () => clearInterval(timerRef.current);
  }, [state, currentDrill, currentDrillIndex]);

  // Auto-focus input on question change
  useEffect(() => {
    setInputValue('');
    inputRef.current?.focus();
  }, [currentQuestionIndex, currentDrillIndex]);

  const handleSubmit = useCallback((e) => {
    e.preventDefault();
    if (inputValue.trim() === '') return;
    submitAnswer(inputValue.trim());
  }, [inputValue, submitAnswer]);

  if (state === 'loading') {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Loading drill...</div>
      </div>
    );
  }

  if (state !== 'drilling' || !currentDrill) return null;

  const question = currentDrill.questions[currentQuestionIndex];
  const timePct = timeLimitMs > 0 ? (timeLeft / timeLimitMs) * 100 : 0;
  const progressPct = totalQuestions > 0 ? ((currentQuestionIndex + 1) / totalQuestions) * 100 : 0;

  // Timer bar color
  let timerColor = 'bg-port-accent';
  if (timePct <= 10) timerColor = 'bg-port-error';
  else if (timePct <= 25) timerColor = 'bg-port-warning';

  return (
    <div className="max-w-lg mx-auto space-y-6">
      {/* Drill header */}
      <div className="flex items-center justify-between text-sm text-gray-400">
        <span>{DRILL_LABELS[currentDrill.type] || currentDrill.type}</span>
        <span>Drill {currentDrillIndex + 1} of {drillCount}</span>
      </div>

      {/* Timer bar */}
      <div className="w-full h-2 bg-port-border rounded-full overflow-hidden">
        <div
          className={`h-full ${timerColor} transition-all duration-100`}
          style={{ width: `${timePct}%` }}
        />
      </div>

      {/* Time remaining */}
      <div className="text-center text-sm text-gray-500">
        {Math.ceil(timeLeft / 1000)}s remaining
      </div>

      {/* Question */}
      <div className="text-center py-8">
        <div className="text-4xl font-mono font-bold text-white">
          {question?.prompt}
        </div>
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="flex gap-3">
        <input
          ref={inputRef}
          type="number"
          inputMode="numeric"
          value={inputValue}
          onChange={e => setInputValue(e.target.value)}
          placeholder="Answer"
          autoFocus
          className="flex-1 bg-port-bg border border-port-border rounded-lg px-4 py-3 text-xl font-mono text-white text-center placeholder-gray-600 focus:border-port-accent focus:outline-none"
        />
        <button
          type="submit"
          disabled={inputValue.trim() === ''}
          className="px-6 py-3 bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 text-white font-medium rounded-lg transition-colors"
        >
          Enter
        </button>
      </form>

      {/* Skip */}
      <div className="text-center">
        <button
          onClick={skipQuestion}
          className="text-sm text-gray-500 hover:text-gray-300 transition-colors"
        >
          Skip
        </button>
      </div>

      {/* Progress bar */}
      <div className="space-y-1">
        <div className="flex justify-between text-xs text-gray-500">
          <span>Question {currentQuestionIndex + 1} of {totalQuestions}</span>
          <span>{Math.round(progressPct)}%</span>
        </div>
        <div className="w-full h-1.5 bg-port-border rounded-full overflow-hidden">
          <div
            className="h-full bg-port-accent/60 transition-all"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>
    </div>
  );
}
