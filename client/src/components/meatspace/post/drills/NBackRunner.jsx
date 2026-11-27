import { useState, useEffect, useRef, useCallback } from 'react';
import useMounted from '../../../../hooks/useMounted';
import useKeyCapture from '../../../../hooks/useKeyCapture';
import { isPressKey } from '../../../../lib/a11yKeyboard.js';
import { clamp } from '../../../../utils/formatters';
import { buildCognitiveResult, buildNBackQuestions } from '../cognitiveScoring';
import DrillHeader from './DrillHeader';

/**
 * Ink colors the n-back stimulus rotates through, as a REINFORCING onset cue on
 * top of the blank gap in `NBackRunner` (which is what actually guarantees the
 * cue — see the comment on its step loop).
 *
 * Theme foreground tokens rather than literal Tailwind hues: `index.css`
 * collapses every literal hue family (`text-sky-*`, `text-amber-*`, …) onto
 * these same semantic tokens with `!important` under `html[data-port-theme]`,
 * so a literal palette would still render as ~5 colors. Rose/red is deliberately
 * absent — it stays the Match-press accent. These are the most colors available,
 * and a low-chroma theme can still render two of them close together (on
 * `black-ice-terminal-day` every token is a shade of green), which is exactly
 * why color is the reinforcement here and never the guarantee.
 */
export const NBACK_INK_COLORS = [
  'text-port-text',
  'text-port-accent',
  'text-port-accent-2',
  'text-port-success',
  'text-port-warning',
];

/**
 * A per-position ink color for the letter stream, where no two ADJACENT
 * positions share a color.
 *
 * The assignment is a function of POSITION ONLY, never of the letter: coloring
 * by letter would paint every n-back target the same as its match and hand the
 * answer away. Random rather than a fixed cycle for the same reason — a
 * predictable rotation is a free positional counter, and counting position is
 * part of what the drill is measuring.
 */
export function buildNBackInkSequence(length, random = Math.random) {
  const out = [];
  for (let i = 0; i < length; i += 1) {
    const choices = i === 0 ? NBACK_INK_COLORS : NBACK_INK_COLORS.filter(c => c !== out[i - 1]);
    // Clamp rather than trust `random()` — a 1.0 would index past the end and
    // emit `undefined`, silently dropping the color class.
    out.push(choices[clamp(Math.floor(random() * choices.length), 0, choices.length - 1)]);
  }
  return out;
}

export default function NBackRunner({ drill, drillIndex, drillCount, onComplete, isTraining }) {
  const seq = drill.sequence || [];
  const n = drill.config?.n ?? 2;
  const stimulusMs = drill.config?.stimulusMs || 2500;

  // Each stimulus window is split into a visible span and a short blank one, so
  // the letter actually LEAVES the screen before the next arrives. The total
  // window is unchanged, so the drill's cadence and every recorded responseMs
  // keep their old meaning. The gap is a fifth of the window, floored at 120ms
  // so it stays perceptible and capped at 400ms so it never eats a long one;
  // `Math.floor(stimulusMs / 2)` keeps the letter on screen at least as long as
  // the gap even at an absurdly short configured window.
  const isiMs = Math.min(Math.floor(stimulusMs / 2), clamp(Math.round(stimulusMs * 0.2), 120, 400));
  const showMs = stimulusMs - isiMs;

  const [pos, setPos] = useState(-1); // -1 = pre-roll
  const [blank, setBlank] = useState(false); // in the gap between two stimuli
  const [pressed, setPressed] = useState(false); // current stimulus registered a Match press
  const answersRef = useRef(seq.map(() => ({ answered: null, responseMs: 0 })));
  // Drawn once for the whole stream (lazy ref, not useMemo): re-rolling mid-run
  // would recolor the letter already on screen, which reads as a new stimulus.
  const inkRef = useRef(null);
  if (inkRef.current === null) inkRef.current = buildNBackInkSequence(seq.length);
  const stimStartRef = useRef(0);
  const startedAtRef = useRef(Date.now());
  const mountedRef = useMounted();
  const timeoutRef = useRef(null);

  const finish = useCallback(() => {
    const questions = buildNBackQuestions(seq, n, answersRef.current);
    onComplete(buildCognitiveResult({ type: 'n-back', drill, questions, totalMs: Date.now() - startedAtRef.current }));
  }, [drill, seq, n, onComplete]);

  const finishRef = useRef(finish);
  finishRef.current = finish;

  // Show the letter, blank the slot, then advance. The blank is the whole point:
  // without it the letter never leaves the screen, so a repeat ("A G T T")
  // redraws an identical glyph in place and the second T reads as the first one
  // still sitting there — the one event this drill scores goes unseen. Every
  // other timed runner in this file already blanks between stimuli (digit-span's
  // `gap`, go/no-go's `setVisible(false)`, reaction-time's `waiting` phase);
  // n-back was the outlier. A press during the gap still belongs to the letter
  // that just showed, which is why `pos` holds through it.
  useEffect(() => {
    let i = 0;
    const step = () => {
      if (!mountedRef.current) return;
      if (i >= seq.length) { finishRef.current(); return; }
      const cur = i;
      setPos(cur);
      setBlank(false);
      setPressed(false);
      stimStartRef.current = Date.now();
      timeoutRef.current = setTimeout(() => {
        if (!mountedRef.current) return;
        setBlank(true);
        timeoutRef.current = setTimeout(() => { i = cur + 1; step(); }, isiMs);
      }, showMs);
    };
    timeoutRef.current = setTimeout(step, 800);
    return () => clearTimeout(timeoutRef.current);
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

  // Spacebar / Enter registers a match for the current stimulus. Claimed in the
  // capture phase so the voice widget's global push-to-talk hotkey (Space by
  // default) can't open the mic on every match press.
  useKeyCapture({
    onKeyDown: (e) => {
      if (!isPressKey(e)) return false;
      registerMatch();
      return true;
    },
  });

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
          // `invisible` rather than dropping the glyph: the gap must not collapse
          // the line box, or the controls below jump on every stimulus. No
          // `transition-colors` — the recolor reinforces the onset, so it has to
          // land with the letter rather than cross-fade into it. A Match press is
          // acknowledged with a ring instead of by recoloring the glyph, which
          // would mask the ink cue on the one press that matters.
          <div
            className={`inline-block rounded-xl border-2 px-6 py-1 ${
              pressed ? 'border-port-success/70 bg-port-success/10' : 'border-transparent'
            }`}
          >
            <span className={`text-7xl font-mono font-bold ${blank ? 'invisible' : inkRef.current[pos]}`}>
              {seq[pos]}
            </span>
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
