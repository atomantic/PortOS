// useSongTraining — drives a song training run: pick a scope (the whole song or
// one section), count the singer in, walk that scope's notated score in tempo,
// grade it against the live mic (reusing useColorMatch), and — when the run
// finishes — fold the take's accuracy into the rolling progress history.
//
// It does NOT re-implement grading or the timing loop: useColorMatch (#1025)
// already counts in with the metronome (#1024), walks the score, and grades each
// note against the pitch tracker (#1022). This hook owns only the training
// concerns layered on top: which scope is being trained (a sliced section score
// or the whole song), looping a scope (auto-restart after a run completes), and
// committing the finished summary to the progress aggregate via songProgress.js.
//
// The committed progress is surfaced through `onProgress` (the parent merges it
// into the song draft and persists on Save) so this hook stays free of any HTTP
// concern — same store-up-to-the-parent shape SongRecordings uses.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseScore } from '../lib/scoreNotation.js';
import { recordAttempt } from '../lib/songProgress.js';
import useColorMatch from './useColorMatch.js';
import useMounted from './useMounted.js';

/**
 * @param {object} args
 * @param {string} args.scopeId        — section id or WHOLE_SONG_SCOPE.
 * @param {string} args.scopeScore     — the lead-sheet text for the scope (a
 *                                        sliced section, or the full score).
 * @param {MediaStream|null} args.stream — live mic stream to grade against.
 * @param {number|null} [args.tempo]   — BPM override (else score tempo).
 * @param {boolean} [args.loop=false]  — auto-restart the run when it finishes.
 * @param {object} [args.progress]     — current song progress aggregate.
 * @param {(next:object)=>void} [args.onProgress] — called with the next progress
 *                                        aggregate after a graded run completes.
 * @returns {{ running, countingIn, noteColors, summary, activeIndex, lastSummary,
 *             start, stop }}
 */
export default function useSongTraining({
  scopeId,
  scopeScore = '',
  stream = null,
  tempo = null,
  loop = false,
  progress = null,
  onProgress,
}) {
  const parsed = useMemo(() => parseScore(scopeScore || ''), [scopeScore]);
  const bpm = Number.isFinite(tempo) && tempo > 0 ? tempo : null;

  // The most recently committed take summary — kept after the colorMatch hook
  // resets between loop iterations, so the readout persists across a loop gap.
  const [lastSummary, setLastSummary] = useState(null);

  const mountedRef = useMounted();
  // Latest values the completion handler reads — refs so the stable
  // useColorMatch summary-effect below doesn't need them in its dep array
  // (which would re-fire commit on every scope/loop change).
  const scopeRef = useRef(scopeId);
  const loopRef = useRef(loop);
  const progressRef = useRef(progress);
  const onProgressRef = useRef(onProgress);
  useEffect(() => { scopeRef.current = scopeId; }, [scopeId]);
  useEffect(() => { loopRef.current = loop; }, [loop]);
  useEffect(() => { progressRef.current = progress; }, [progress]);
  useEffect(() => { onProgressRef.current = onProgress; }, [onProgress]);

  const {
    running, countingIn, noteColors, summary, activeIndex, start: startMatch, stop,
  } = useColorMatch({ score: parsed, stream, bpm });

  // When a color-match run finishes it sets a non-null `summary` and clears
  // `running`. That edge is the commit point: fold the take into the rolling
  // history (songProgress drops zero-note takes itself), surface the next
  // aggregate to the parent, and — when looping — re-arm after a short beat so
  // the singer gets a fresh count-in. Gate on the summary identity so a single
  // finished run commits exactly once.
  const committedRef = useRef(null);
  const relaunchRef = useRef(null);
  useEffect(() => {
    if (running || !summary || committedRef.current === summary) return;
    committedRef.current = summary;
    setLastSummary(summary);
    const next = recordAttempt(progressRef.current, scopeRef.current, summary);
    onProgressRef.current?.(next);
    if (loopRef.current && stream) {
      relaunchRef.current = setTimeout(() => {
        if (mountedRef.current && loopRef.current && stream) startMatch();
      }, 600);
    }
  }, [summary, running, stream, startMatch, mountedRef]);

  // A new run clears the prior commit guard so its summary commits when it ends.
  const start = useCallback(() => {
    committedRef.current = null;
    startMatch();
  }, [startMatch]);

  // Cancel a pending loop relaunch on stop / unmount / loop-off so a deferred
  // restart can't fire after the user stopped (the deferred-work staleness +
  // unmount guard from CLAUDE.md).
  const clearRelaunch = useCallback(() => {
    if (relaunchRef.current != null) { clearTimeout(relaunchRef.current); relaunchRef.current = null; }
  }, []);
  const stopTraining = useCallback(() => { clearRelaunch(); stop(); }, [clearRelaunch, stop]);
  useEffect(() => { if (!loop) clearRelaunch(); }, [loop, clearRelaunch]);
  useEffect(() => () => clearRelaunch(), [clearRelaunch]);

  return {
    running, countingIn, noteColors, summary, activeIndex, lastSummary,
    start, stop: stopTraining,
  };
}
