import { useState, useEffect, useRef, useCallback } from 'react';
import { Brain, Check, X } from 'lucide-react';
import { DRILL_LABELS, nBackBalancedAccuracy } from './constants';

/**
 * Interactive runner for deterministic cognitive drills (n-back, digit-span,
 * stroop). Unlike the math/memory PostDrillRunner (single prompt → typed
 * answer), these are timed, stimulus-driven flows, so each type has its own
 * sub-runner. Every sub-runner assembles a full drill result — `{ module,
 * type, config, drillData, questions, score, totalMs }` — and hands it to
 * `onComplete`. The client score is a local estimate for the immediate results
 * view; the server recomputes it deterministically from `drillData` on save
 * (server/services/meatspacePostCognitive.js). NO provider calls anywhere.
 */
export default function PostCognitiveDrillRunner({ drill, drillIndex, drillCount, onComplete, isTraining }) {
  if (!drill) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Loading drill...</div>
      </div>
    );
  }

  const shared = { drill, drillIndex, drillCount, onComplete, isTraining };
  switch (drill.type) {
    case 'n-back':
      return <NBackRunner {...shared} />;
    case 'digit-span':
      return <DigitSpanRunner {...shared} />;
    case 'stroop':
      return <StroopRunner {...shared} />;
    case 'schulte-table':
      return <SchulteTableRunner {...shared} />;
    case 'mental-rotation':
      return <MentalRotationRunner {...shared} />;
    case 'reaction-time':
      return <ReactionTimeRunner {...shared} />;
    default:
      return <div className="text-port-error text-center py-8">Unsupported cognitive drill: {drill.type}</div>;
  }
}

// Shared header: drill label + position within the session.
function DrillHeader({ type, isTraining, drillIndex, drillCount }) {
  return (
    <div className="flex items-center justify-between text-sm text-gray-400">
      <span className="flex items-center gap-1.5 text-rose-400">
        <Brain size={14} />
        {DRILL_LABELS[type] || type}
        {isTraining && ' — Training'}
      </span>
      <span>Drill {drillIndex + 1} of {drillCount}</span>
    </div>
  );
}

export function localAccuracyScore(questions) {
  if (!questions.length) return 0;
  const correct = questions.filter(q => q.correct).length;
  return Math.round((correct / questions.length) * 100);
}

// Pre-save mirror of the server's signal-detection n-back score (issue #2094):
// balanced accuracy over targets (hit rate) and non-targets (correct-rejection
// rate), so the results screen matches what the save persists instead of raw
// position accuracy (which pays ~70% for never pressing). Delegates to the
// shared answered+correct derivation in constants.js (buildNBackQuestions marks
// `correct` with exactly the identity that derivation relies on).
export function localNBackScore(_drill, questions) {
  const accuracy = nBackBalancedAccuracy(questions);
  return accuracy == null ? 0 : Math.min(100, Math.max(0, Math.round(accuracy * 100)));
}

// Pre-save mirror of the server's latency-based reaction-time score (issue
// #2094): median RT of VALID trials against the mode's reference curve, scaled
// by the valid-trial rate so false starts pull the headline number down.
export function localReactionTimeScore(drill, questions) {
  const mode = drill?.config?.mode === 'choice' ? 'choice' : 'simple';
  const refMs = mode === 'choice' ? 1200 : 600;
  const fastMs = mode === 'choice' ? 400 : 200;
  const valid = questions.filter(q => q.correct && !q.falseStart && (q.responseMs || 0) > 0);
  if (!questions.length || !valid.length) return 0;
  const sorted = valid.map(q => Math.min(q.responseMs, refMs * 3)).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medianMs = sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  const latencyScore = Math.min(100, Math.max(0, (100 * (refMs - medianMs)) / (refMs - fastMs)));
  return Math.round(latencyScore * (valid.length / questions.length));
}

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

// Shared result-assembly shape every sub-runner hands to `onComplete`. The
// server rescores deterministically from `drillData`/`questions` on save
// (server/services/meatspacePostCognitive.js) — this is the client-side
// mirror, and its `index`/`answered`/`responseMs` fields are what that
// rescoring depends on.
export function buildCognitiveResult({ type, drill, questions, totalMs }) {
  // n-back and reaction-time mirror the server's rescoring semantics (SDT
  // balanced accuracy / valid-median latency, issue #2094) so the pre-save
  // results screen doesn't show a number that jumps on save. Other types keep
  // the raw-accuracy approximation (server adds only a small speed bonus).
  const score = type === 'n-back'
    ? localNBackScore(drill, questions)
    : type === 'reaction-time'
      ? localReactionTimeScore(drill, questions)
      : localAccuracyScore(questions);
  return {
    module: 'cognitive',
    type,
    config: drill.config,
    drillData: drill,
    questions,
    score,
    totalMs,
  };
}

// N-BACK — pure result assembly: given the full letter sequence, the lag `n`,
// and the parallel `answers` array (index-aligned with `seq`, each entry
// `{ answered: 'match'|null, responseMs }`), build the scored `questions[]`.
// Only positions `i >= n` have a defined target (there's no "n back" before
// that), so the first `n` letters are excluded — the off-by-one this guards
// against is including/excluding the boundary position `i === n` itself.
export function buildNBackQuestions(seq, n, answers) {
  return seq
    .map((letter, i) => ({ letter, i }))
    .filter(({ i }) => i >= n)
    .map(({ letter, i }) => {
      const a = answers[i] || {};
      const isTarget = seq[i] === seq[i - n];
      const answeredMatch = a.answered === 'match';
      return {
        prompt: letter,
        index: i,
        answered: a.answered ?? null,
        correct: answeredMatch === isTarget,
        responseMs: a.responseMs || 0,
      };
    });
}

// DIGIT SPAN — pure scoring for one recalled sequence. `direction` decides
// whether the expected answer is the digits in shown order ('forward') or
// reversed ('backward') — the bug this guards against is comparing the
// typed answer against the wrong ordering. Returns both the persisted
// `question` (what `finish()` assembles into the result) and the raw
// `expected`/`answeredRaw` strings the training-mode feedback UI displays.
export function scoreDigitSpanRecall({ digits, direction, index, answeredStr, responseMs }) {
  const ordered = direction === 'backward' ? [...digits].reverse() : digits;
  const expected = ordered.join('');
  const answeredRaw = (answeredStr || '').replace(/\D/g, '');
  return {
    question: {
      prompt: `${digits.length}-digit (${direction})`,
      index,
      answered: answeredRaw.length ? answeredRaw : null,
      correct: answeredRaw.length > 0 && answeredRaw === expected,
      responseMs,
      length: digits.length,
    },
    expected,
    answeredRaw,
  };
}

// STROOP — pure scoring for one trial: correct iff the picked color name
// matches the word's INK color (`trial.inkColor`), not the word text itself
// — the bug this guards against is accidentally grading against the word.
export function scoreStroopTrial({ trial, index, colorName, responseMs }) {
  return {
    prompt: trial.word,
    index,
    answered: colorName,
    correct: colorName === trial.inkColor,
    responseMs,
  };
}

// MENTAL ROTATION — pure scoring for one trial: correct iff the picked option
// index is the option that's the SAME shape (just rotated), not a mirror or
// distractor. Mirrors `scoreStroopTrial`'s shape so both trial-based drills
// share one testable pattern.
export function scoreMentalRotationTrial({ trial, index, optionIndex, responseMs }) {
  return {
    prompt: `shape ${trial.shape || ''}`,
    index,
    answered: optionIndex,
    correct: optionIndex === trial.correctIndex,
    responseMs,
  };
}

// =============================================================================
// N-BACK — a letter stream; signal when the current letter matches N steps back
// =============================================================================
function NBackRunner({ drill, drillIndex, drillCount, onComplete, isTraining }) {
  const seq = drill.sequence || [];
  const n = drill.config?.n ?? 2;
  const stimulusMs = drill.config?.stimulusMs || 2500;

  const [pos, setPos] = useState(-1); // -1 = pre-roll
  const [pressed, setPressed] = useState(false); // current stimulus registered a Match press
  const answersRef = useRef(seq.map(() => ({ answered: null, responseMs: 0 })));
  const stimStartRef = useRef(0);
  const startedAtRef = useRef(Date.now());
  const mountedRef = useRef(true);
  const timeoutRef = useRef(null);

  const finish = useCallback(() => {
    const questions = buildNBackQuestions(seq, n, answersRef.current);
    onComplete(buildCognitiveResult({ type: 'n-back', drill, questions, totalMs: Date.now() - startedAtRef.current }));
  }, [drill, seq, n, onComplete]);

  const finishRef = useRef(finish);
  finishRef.current = finish;

  useEffect(() => {
    mountedRef.current = true;
    let i = 0;
    const step = () => {
      if (!mountedRef.current) return;
      if (i >= seq.length) { finishRef.current(); return; }
      const cur = i;
      setPos(cur);
      setPressed(false);
      stimStartRef.current = Date.now();
      timeoutRef.current = setTimeout(() => { i = cur + 1; step(); }, stimulusMs);
    };
    timeoutRef.current = setTimeout(step, 800);
    return () => { mountedRef.current = false; clearTimeout(timeoutRef.current); };
  }, []);

  const registerMatch = useCallback(() => {
    setPos(curPos => {
      if (curPos < n) return curPos;
      const a = answersRef.current[curPos];
      if (a && a.answered !== 'match') {
        a.answered = 'match';
        a.responseMs = Date.now() - stimStartRef.current;
        setPressed(true);
      }
      return curPos;
    });
  }, [n]);

  // Spacebar / Enter registers a match for the current stimulus.
  useEffect(() => {
    const onKey = (e) => {
      if (e.code === 'Space' || e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        registerMatch();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [registerMatch]);

  const decisionTotal = Math.max(0, seq.length - n);
  const decisionDone = pos >= n ? pos - n : 0;
  const progressPct = decisionTotal > 0 ? Math.min(100, (decisionDone / decisionTotal) * 100) : 0;
  const active = pos >= 0 && pos < seq.length;

  return (
    <div className="max-w-lg mx-auto space-y-6">
      <DrillHeader type="n-back" isTraining={isTraining} drillIndex={drillIndex} drillCount={drillCount} />

      <p className="text-center text-sm text-gray-400">
        Press <span className="text-white font-medium">Match</span> (or Space) when the letter matches the one{' '}
        <span className="text-rose-400 font-semibold">{n}</span> step{n !== 1 ? 's' : ''} back.
      </p>

      <div className="text-center py-10">
        {pos < 0 ? (
          <div className="text-xl text-gray-500">Get ready…</div>
        ) : (
          <div className={`text-7xl font-mono font-bold transition-colors ${pressed ? 'text-rose-400' : 'text-white'}`}>
            {seq[pos]}
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={registerMatch}
        disabled={!active || pos < n}
        className="w-full px-6 py-4 bg-rose-500/20 hover:bg-rose-500/30 disabled:opacity-40 disabled:cursor-not-allowed text-rose-300 border border-rose-500/40 font-semibold rounded-lg transition-colors"
      >
        Match
      </button>

      <div className="space-y-1">
        <div className="flex justify-between text-xs text-gray-500">
          <span>{decisionDone} / {decisionTotal} decisions</span>
          <span>{Math.round(progressPct)}%</span>
        </div>
        <div className="w-full h-1.5 bg-port-border rounded-full overflow-hidden">
          <div className="h-full bg-rose-400/60 transition-all" style={{ width: `${progressPct}%` }} />
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// DIGIT SPAN — memorize a shown sequence, then recall it forward/backward
// =============================================================================
function DigitSpanRunner({ drill, drillIndex, drillCount, onComplete, isTraining }) {
  const sequences = drill.sequences || [];
  const direction = drill.config?.direction === 'backward' ? 'backward' : 'forward';
  const showMs = drill.config?.showMs || 1000;

  const [seqIdx, setSeqIdx] = useState(0);
  const [phase, setPhase] = useState('show'); // 'show' | 'recall'
  const [shownIdx, setShownIdx] = useState(-1); // which digit is visible (-1 blank)
  const [input, setInput] = useState('');
  const [feedback, setFeedback] = useState(null); // training-mode reveal
  const answersRef = useRef([]);
  const recallStartRef = useRef(0);
  const startedAtRef = useRef(Date.now());
  const mountedRef = useRef(true);
  const inputRef = useRef(null);

  const finish = useCallback(() => {
    const questions = answersRef.current.filter(Boolean);
    onComplete(buildCognitiveResult({ type: 'digit-span', drill, questions, totalMs: Date.now() - startedAtRef.current }));
  }, [drill, onComplete]);

  const finishRef = useRef(finish);
  finishRef.current = finish;

  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  // Reveal the current sequence one digit at a time, then switch to recall.
  useEffect(() => {
    if (seqIdx >= sequences.length) { finishRef.current(); return; }
    setPhase('show');
    setInput('');
    setFeedback(null);
    setShownIdx(-1);
    const digits = sequences[seqIdx].digits || [];
    const gap = 200;
    const timers = [];
    let t = 600;
    digits.forEach((_, di) => {
      timers.push(setTimeout(() => { if (mountedRef.current) setShownIdx(di); }, t));
      t += showMs;
      timers.push(setTimeout(() => { if (mountedRef.current) setShownIdx(-1); }, t));
      t += gap;
    });
    timers.push(setTimeout(() => {
      if (!mountedRef.current) return;
      setPhase('recall');
      recallStartRef.current = Date.now();
    }, t));
    return () => timers.forEach(clearTimeout);
  }, [seqIdx]);

  useEffect(() => { if (phase === 'recall') inputRef.current?.focus(); }, [phase]);

  const advance = useCallback((answeredStr) => {
    const digits = sequences[seqIdx].digits || [];
    const { question, expected, answeredRaw } = scoreDigitSpanRecall({
      digits,
      direction,
      index: seqIdx,
      answeredStr,
      responseMs: Date.now() - recallStartRef.current,
    });
    answersRef.current[seqIdx] = question;
    if (isTraining) {
      setFeedback({ expected, answered: answeredRaw, correct: question.correct });
    } else {
      setSeqIdx(i => i + 1);
    }
  }, [sequences, seqIdx, direction, isTraining]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (phase !== 'recall' || feedback) return;
    advance(input);
  };

  const digits = sequences[seqIdx]?.digits || [];
  const progressPct = sequences.length > 0 ? (seqIdx / sequences.length) * 100 : 0;

  return (
    <div className="max-w-lg mx-auto space-y-6">
      <DrillHeader type="digit-span" isTraining={isTraining} drillIndex={drillIndex} drillCount={drillCount} />

      <p className="text-center text-sm text-gray-400">
        Memorize the digits, then type them{' '}
        <span className="text-rose-400 font-semibold">{direction === 'backward' ? 'in reverse' : 'in order'}</span>.
      </p>

      <div className="text-center py-10 min-h-[8rem] flex items-center justify-center">
        {phase === 'show' ? (
          <div className="text-7xl font-mono font-bold text-white tabular-nums">
            {shownIdx >= 0 ? digits[shownIdx] : ''}
          </div>
        ) : feedback ? (
          <div className="flex flex-col items-center gap-2">
            {feedback.correct
              ? <Check size={40} className="text-port-success" />
              : <X size={40} className="text-port-error" />}
            <div className="text-sm text-gray-400">Expected</div>
            <div className="text-3xl font-mono font-bold text-port-success tracking-widest">{feedback.expected}</div>
            {!feedback.correct && feedback.answered && (
              <div className="text-lg font-mono text-port-error line-through">{feedback.answered}</div>
            )}
          </div>
        ) : (
          <div className="text-xl text-gray-500">Recall the {direction === 'backward' ? 'reversed ' : ''}sequence</div>
        )}
      </div>

      {phase === 'recall' && !feedback && (
        <form onSubmit={handleSubmit} className="flex gap-3">
          <input
            ref={inputRef}
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={input}
            onChange={e => setInput(e.target.value.replace(/\D/g, ''))}
            placeholder="Digits"
            autoFocus
            className="flex-1 bg-port-bg border border-port-border rounded-lg px-4 py-3 text-2xl font-mono text-white text-center tracking-widest placeholder-gray-600 focus:border-rose-400 focus:outline-none"
          />
          <button type="submit" className="px-6 py-3 bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 border border-rose-500/40 font-medium rounded-lg transition-colors">
            Enter
          </button>
        </form>
      )}

      {phase === 'recall' && !feedback && (
        <div className="text-center">
          <button onClick={() => advance('')} className="text-sm text-gray-500 hover:text-gray-300 transition-colors">
            Skip
          </button>
        </div>
      )}

      {feedback && (
        <button
          onClick={() => setSeqIdx(i => i + 1)}
          autoFocus
          className="w-full px-6 py-3 bg-port-accent-2 hover:bg-port-accent-2/80 text-port-on-accent-2 font-medium rounded-lg transition-colors"
        >
          Next
        </button>
      )}

      <div className="space-y-1">
        <div className="flex justify-between text-xs text-gray-500">
          <span>Round {Math.min(seqIdx + 1, sequences.length)} of {sequences.length}</span>
          <span>{Math.round(progressPct)}%</span>
        </div>
        <div className="w-full h-1.5 bg-port-border rounded-full overflow-hidden">
          <div className="h-full bg-rose-400/60 transition-all" style={{ width: `${progressPct}%` }} />
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// STROOP — name the INK color of a color-word (ignore what the word says)
// =============================================================================
function StroopRunner({ drill, drillIndex, drillCount, onComplete, isTraining }) {
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
            onClick={acknowledge}
            autoFocus
            className="w-full px-6 py-3 bg-port-accent-2 hover:bg-port-accent-2/80 text-port-on-accent-2 font-medium rounded-lg transition-colors"
          >
            Next
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {options.map((opt, i) => (
            <button
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

// =============================================================================
// SCHULTE TABLE — scan a shuffled grid and tap 1, 2, 3... in sequence
// =============================================================================
function SchulteTableRunner({ drill, drillIndex, drillCount, onComplete, isTraining }) {
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
    if (value !== current) {
      setFlash(value);
      clearTimeout(flashTimeoutRef.current);
      flashTimeoutRef.current = setTimeout(() => setFlash(null), 200);
      return;
    }
    // Advance the ref immediately (synchronously) so a second handleClick call
    // racing in before this render commits sees the bumped value, not `current`.
    targetRef.current = current + 1;
    questionsRef.current.push({
      prompt: `${current}`,
      index: current - 1,
      answered: current,
      correct: true,
      responseMs: Date.now() - stepStartRef.current,
    });
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

// =============================================================================
// MENTAL ROTATION — pick the shape that's the SAME, just rotated (not mirrored)
// =============================================================================
function MentalRotationRunner({ drill, drillIndex, drillCount, onComplete, isTraining }) {
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
                onClick={acknowledge}
                autoFocus
                className="w-full px-6 py-3 bg-port-accent-2 hover:bg-port-accent-2/80 text-port-on-accent-2 font-medium rounded-lg transition-colors"
              >
                Next
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {trial.options.map((cells, i) => (
                <button
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

// =============================================================================
// REACTION TIME — simple (react ASAP) or choice (react to the lit target) RT
// =============================================================================
function ReactionTimeRunner({ drill, drillIndex, drillCount, onComplete, isTraining }) {
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
  const mountedRef = useRef(true);
  // Separate refs: the "reveal the stimulus" timer (armed per trial) and the
  // "advance to the next trial" timer (armed on response) must never share one
  // ref — overwriting a shared ref on response leaves the reveal timer's
  // callback un-cancelled, so a false start can leak a stale setPhase('go')
  // into a later trial once the ref no longer points at it.
  const armTimeoutRef = useRef(null);
  const advanceTimeoutRef = useRef(null);
  const advancingRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimeout(armTimeoutRef.current);
      clearTimeout(advanceTimeoutRef.current);
    };
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
  useEffect(() => {
    const onKey = (e) => {
      if (phase === 'result') return;
      if (mode === 'simple') {
        if (e.code === 'Space' || e.key === ' ' || e.key === 'Enter') { e.preventDefault(); respond(0); }
      } else {
        const idx = parseInt(e.key, 10) - 1;
        if (Number.isInteger(idx) && idx >= 0 && idx < choices) { e.preventDefault(); respond(idx); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, mode, choices, respond]);

  const progressPct = trials.length > 0 ? (trialIdx / trials.length) * 100 : 0;

  return (
    <div className="max-w-lg mx-auto space-y-6">
      <DrillHeader type="reaction-time" isTraining={isTraining} drillIndex={drillIndex} drillCount={drillCount} />

      <p className="text-center text-sm text-gray-400">
        {mode === 'choice'
          ? <>Wait for a target box to light up, then press its number — <span className="text-rose-400 font-semibold">as fast as you can</span>.</>
          : <>Wait for the signal, then press <span className="text-white font-medium">Space</span> (or tap) — <span className="text-rose-400 font-semibold">as fast as you can</span>.</>}
      </p>

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
              const isTarget = i === trials[trialIdx]?.target;
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => respond(i)}
                  className={`flex items-center justify-center gap-2 px-4 py-6 rounded-lg border font-semibold transition-colors ${
                    isTarget
                      ? 'bg-port-success/80 hover:bg-port-success border-port-success text-white'
                      : 'bg-port-card border-port-border text-gray-500'
                  }`}
                >
                  {i + 1}
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
