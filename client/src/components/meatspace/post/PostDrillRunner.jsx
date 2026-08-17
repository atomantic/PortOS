import { useState, useEffect, useRef, useCallback } from 'react';
import { CheckCircle, XCircle } from 'lucide-react';

import { MEMORY_DRILL_TYPES, DRILL_LABELS } from './constants';
import { powersBreakdownFromPrompt } from '../../../lib/powersBreakdown.js';

function PowersLesson({ prompt }) {
  const breakdown = powersBreakdownFromPrompt(prompt);
  if (!breakdown || breakdown.fallback) return null;
  return (
    <div className="mt-3 w-full max-w-md rounded-lg border border-port-accent/30 bg-port-bg p-3 text-left">
      <div className="mb-2 text-xs font-semibold text-port-accent">{breakdown.label}</div>
      <ol className="space-y-1 text-sm font-mono text-gray-300">
        {breakdown.steps.map((step, index) => <li key={`${step}-${index}`}>{step}</li>)}
      </ol>
    </div>
  );
}

function AppliedNumeracyLesson({ method }) {
  if (!method) return null;
  return (
    <div className="mt-3 w-full max-w-md rounded-lg border border-port-accent/30 bg-port-bg p-3 text-left text-sm text-gray-300">
      <div className="mb-1 text-xs font-semibold text-port-accent">Shortest method</div>
      {method}
    </div>
  );
}

export default function PostDrillRunner({ session }) {
  const {
    currentDrill,
    currentQuestionIndex,
    currentDrillIndex,
    drillCount,
    state,
    isTraining,
    lastAnswer,
    submitAnswer,
    skipQuestion,
    acknowledgeAnswer,
    timeExpired
  } = session;

  const [inputValue, setInputValue] = useState('');
  const [blankValues, setBlankValues] = useState({});
  const [timeLeft, setTimeLeft] = useState(0);
  const inputRef = useRef(null);
  const timerRef = useRef(null);
  const timeExpiredRef = useRef(timeExpired);

  const timeLimitMs = (currentDrill?.timeLimitSec || 120) * 1000;
  const totalQuestions = currentDrill?.questions?.length || 0;
  const question = currentDrill?.questions?.[currentQuestionIndex];
  const isFillBlankQuestion = currentDrill?.type === 'memory-fill-blank'
    && Array.isArray(question?.answers)
    && question.answers.length > 0;

  // Keep ref current to avoid stale closure in timer
  useEffect(() => {
    timeExpiredRef.current = timeExpired;
  }, [timeExpired]);

  // Timer (disabled in training mode — no time pressure)
  useEffect(() => {
    if (state !== 'drilling' || !currentDrill) return;

    if (isTraining) {
      setTimeLeft(0);
      return;
    }

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
  }, [state, currentDrill, currentDrillIndex, isTraining]);

  // Auto-focus input on question change
  useEffect(() => {
    setInputValue('');
    setBlankValues({});
    inputRef.current?.focus();
  }, [currentQuestionIndex, currentDrillIndex]);

  const handleSubmit = useCallback((e) => {
    e.preventDefault();
    if (isFillBlankQuestion) {
      const values = question.answers.map(answer => ({
        index: answer.index,
        value: blankValues[answer.index] || null,
      }));
      if (!values.some(entry => entry.value != null)) return;
      submitAnswer(values);
      return;
    }
    if (inputValue.trim() === '') return;
    submitAnswer(inputValue.trim());
  }, [blankValues, inputValue, isFillBlankQuestion, question, submitAnswer]);

  if (state === 'loading') {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Loading drill...</div>
      </div>
    );
  }

  if (state !== 'drilling' || !currentDrill) return null;

  // MEMORY_DRILL_TYPES now includes 'memory-fill-blank' (issue #2099/#2116),
  // so the explicit extra check this used to need is gone.
  const isTextDrill = MEMORY_DRILL_TYPES.includes(currentDrill.type);
  const isAppliedNumeracy = currentDrill.type === 'applied-numeracy';
  const timePct = timeLimitMs > 0 ? (timeLeft / timeLimitMs) * 100 : 0;
  const progressPct = totalQuestions > 0 ? ((currentQuestionIndex + 1) / totalQuestions) * 100 : 0;

  // Timer bar color
  let timerColor = 'bg-port-accent';
  if (timePct <= 10) timerColor = 'bg-port-error';
  else if (timePct <= 25) timerColor = 'bg-port-warning';

  // Training mode: show feedback overlay
  if (isTraining && lastAnswer) {
    const structuredAnswers = Array.isArray(lastAnswer.answered) ? lastAnswer.answered : null;
    const structuredCorrect = structuredAnswers?.filter(answer => answer.correct).length;
    return (
      <div className="max-w-lg mx-auto space-y-6">
        <div className="flex items-center justify-between text-sm text-gray-400">
          <span className="text-port-accent-2">{DRILL_LABELS[currentDrill.type] || currentDrill.type} — Training</span>
          <span>Drill {currentDrillIndex + 1} of {drillCount}</span>
        </div>

        <div className="text-center py-8">
          <div className="text-2xl font-mono text-gray-400 mb-4">{lastAnswer.prompt}</div>
          {lastAnswer.correct ? (
            <div className="flex flex-col items-center gap-2">
              <CheckCircle size={48} className="text-port-success" />
              {structuredAnswers ? (
                <div className="space-y-1 text-left font-mono text-port-success">
                  {structuredAnswers.map(answer => <div key={answer.index}>{answer.value}</div>)}
                </div>
              ) : <div className="text-3xl font-mono font-bold text-port-success">{lastAnswer.answered}</div>}
              <div className="text-sm text-gray-400">
                {structuredAnswers ? `${structuredCorrect} of ${structuredAnswers.length} blanks correct` : 'Correct'}
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3">
              <XCircle size={48} className="text-port-error" />
              {structuredAnswers ? (
                <div className="space-y-1 text-left font-mono text-port-error">
                  {structuredAnswers.map(answer => (
                    <div key={answer.index}>
                      <span className={answer.correct ? 'text-port-success' : 'line-through'}>{answer.value || '—'}</span>
                      {!answer.correct && <span className="text-port-success ml-2">→ {answer.expected}</span>}
                    </div>
                  ))}
                </div>
              ) : lastAnswer.answered != null ? (
                <div className="text-2xl font-mono text-port-error line-through">{lastAnswer.answered}</div>
              ) : (
                <div className="text-sm text-gray-500">Skipped</div>
              )}
              {structuredAnswers ? (
                <div className="text-sm text-gray-400">{structuredCorrect} of {structuredAnswers.length} blanks correct</div>
              ) : (
                <>
                  <div className="text-sm text-gray-400">Expected</div>
                  <div className="text-3xl font-mono font-bold text-port-success">{lastAnswer.expected}</div>
                </>
              )}
              <PowersLesson prompt={lastAnswer.prompt} />
              {/* Hint: break down the calculation */}
              {lastAnswer.prompt && powersBreakdownFromPrompt(lastAnswer.prompt)?.fallback !== false && (
                <div className="text-xs text-gray-500 mt-2 bg-port-bg border border-port-border rounded px-3 py-2">
                  {formatHint(lastAnswer.prompt, lastAnswer.expected)}
                </div>
              )}
            </div>
          )}
          <AppliedNumeracyLesson method={lastAnswer.method} />
        </div>

        <button
          onClick={acknowledgeAnswer}
          autoFocus
          className="w-full px-6 py-3 bg-port-accent-2 hover:bg-port-accent-2/80 text-port-on-accent-2 font-medium rounded-lg transition-colors"
        >
          Next
        </button>

        <div className="space-y-1">
          <div className="flex justify-between text-xs text-gray-500">
            <span>Question {currentQuestionIndex + 1} of {totalQuestions}</span>
            <span>{Math.round(progressPct)}%</span>
          </div>
          <div className="w-full h-1.5 bg-port-border rounded-full overflow-hidden">
            <div className="h-full bg-port-accent-2/60 transition-all" style={{ width: `${progressPct}%` }} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto space-y-6">
      {/* Drill header */}
      <div className="flex items-center justify-between text-sm text-gray-400">
        <span className={isTraining ? 'text-port-accent-2' : ''}>
          {DRILL_LABELS[currentDrill.type] || currentDrill.type}
          {currentDrill.progression && (
            <span className="ml-2 text-xs text-port-accent">
              Lvl {currentDrill.progression.level + 1} · {currentDrill.progression.label}
            </span>
          )}
          {isTraining && ' — Training'}
        </span>
        <span>Drill {currentDrillIndex + 1} of {drillCount}</span>
      </div>

      {/* Timer bar (hidden in training mode) */}
      {!isTraining && (
        <>
          <div className="w-full h-2 bg-port-border rounded-full overflow-hidden">
            <div
              className={`h-full ${timerColor} transition-all duration-100`}
              style={{ width: `${timePct}%` }}
            />
          </div>
          <div className="text-center text-sm text-gray-500">
            {Math.ceil(timeLeft / 1000)}s remaining
          </div>
        </>
      )}

      {/* Question */}
      <div className="text-center py-8">
        {question?.promptLabel && (
          <div className="text-sm text-gray-500 mb-2">{question.promptLabel}</div>
        )}
        <div className="text-4xl font-mono font-bold text-white">
          {question?.prompt}
        </div>
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="space-y-3">
        {isFillBlankQuestion ? (
          <div className="space-y-3">
            <div className="text-sm text-gray-400">Fill every blank. Partial recall earns partial credit.</div>
            {question.answers.map((answer, index) => {
              const inputId = `post-blank-${currentDrillIndex}-${currentQuestionIndex}-${answer.index}`;
              return (
                <div key={answer.index}>
                  <label htmlFor={inputId} className="block text-xs text-gray-500 mb-1">Blank {index + 1}</label>
                  <input
                    id={inputId}
                    ref={index === 0 ? inputRef : undefined}
                    type="text"
                    value={blankValues[answer.index] || ''}
                    onChange={e => setBlankValues(prev => ({ ...prev, [answer.index]: e.target.value }))}
                    placeholder={`Answer for blank ${index + 1}`}
                    autoFocus={index === 0}
                    className="w-full bg-port-bg border border-port-border rounded-lg px-4 py-3 text-xl font-mono text-white text-center placeholder-gray-600 focus:border-port-accent focus:outline-none"
                  />
                </div>
              );
            })}
          </div>
        ) : (
          <input
            ref={inputRef}
            type={isTextDrill || isAppliedNumeracy ? 'text' : 'number'}
            inputMode={isTextDrill ? 'text' : isAppliedNumeracy ? 'decimal' : 'numeric'}
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
            placeholder={isAppliedNumeracy ? 'Number and unit when requested' : 'Answer'}
            aria-label={isAppliedNumeracy ? 'Your numeric answer and unit when requested' : 'Your answer'}
            autoFocus
            className="w-full bg-port-bg border border-port-border rounded-lg px-4 py-3 text-xl font-mono text-white text-center placeholder-gray-600 focus:border-port-accent focus:outline-none"
          />
        )}
        <button
          type="submit"
          disabled={isFillBlankQuestion
            ? !Object.values(blankValues).some(value => value.trim() !== '')
            : inputValue.trim() === ''}
          className={`px-6 py-3 ${isTraining ? 'bg-port-accent-2 hover:bg-port-accent-2/80 text-port-on-accent-2' : 'bg-port-accent hover:bg-port-accent/80 text-white'} disabled:opacity-50 font-medium rounded-lg transition-colors`}
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
            className={`h-full ${isTraining ? 'bg-port-accent-2/60' : 'bg-port-accent/60'} transition-all`}
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>
    </div>
  );
}

function formatHint(prompt, expected) {
  // Break down the calculation for learning
  const match = prompt.match(/^(-?\d+)\s*([+\-x^])\s*(-?\d+)$/);
  if (!match) return `${prompt} = ${expected}`;
  const [, a, op, b] = match;
  if (op === 'x') return `${a} × ${b} = ${expected}`;
  return `${prompt} = ${expected}`;
}
