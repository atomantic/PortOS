// useColorMatch — drives a color-match session: count the singer in with the
// metronome, walk the notated score in tempo, grade each note against the live
// mic pitch, and expose `noteColors` for the <ScoreSheet> plus a per-take
// accuracy summary for training mode.
//
// It composes the three song-system primitives without re-implementing any of
// them: the metronome (#1024) for the count-in + a shared audio clock, the pitch
// tracker (#1022) for live frequency, and the pure colorMatch lib (#1025) for the
// timeline + grading math. The component owns only React state + lifecycle here;
// all the timing math is in colorMatch.js so it stays testable.
//
// Lifecycle: `start()` builds the timeline, opens an analyser off the passed
// stream, starts the metronome with a one-bar count-in, and — at the count-in's
// downbeat — kicks a rAF loop that reads elapsed audio time, finds the active
// note, grades it, and accumulates the best grade per note (a note "wins" its
// best attempt across the frames it's active). Everything tears down on stop and
// on unmount (the deferred-work teardown rule in CLAUDE.md).

import { useCallback, useEffect, useRef, useState } from 'react';
import { createStreamAnalyser } from '../lib/audioRecorder.js';
import { createPitchTracker } from '../lib/pitchDetect.js';
import { createMetronome, timeSignatureFromScore } from '../lib/metronome.js';
import {
  buildColorMatchTimeline,
  noteAtTime,
  gradeNote,
  summarizeAccuracy,
  GRADE,
} from '../lib/colorMatch.js';
import useMounted from './useMounted.js';

// Rank grades so a note keeps the BEST attempt it was hit with across the frames
// it's active — a singer who slides into pitch shouldn't be graded on the wobble
// they started with. Higher rank = better.
const GRADE_RANK = { [GRADE.MISSED]: 0, [GRADE.OFF]: 1, [GRADE.CLOSE]: 2, [GRADE.IN_TUNE]: 3 };
const bestGrade = (a, b) => ((GRADE_RANK[b] ?? 0) > (GRADE_RANK[a] ?? -1) ? b : a);

/**
 * @param {object} args
 * @param {object} args.score      — parsed score (parseScore output).
 * @param {MediaStream|null} args.stream — live mic stream to grade against.
 * @param {number} [args.bpm]      — tempo override (else score.tempo).
 * @param {number} [args.countInBars=1] — lead-in bars before grading starts.
 * @param {number} [args.a4=440]   — reference pitch.
 * @returns {{ running, countingIn, beat, noteColors, summary, activeIndex, start, stop }}
 */
export default function useColorMatch({ score, stream, bpm = null, countInBars = 1, a4 = 440 }) {
  const [running, setRunning] = useState(false);
  const [countingIn, setCountingIn] = useState(false);
  const [beat, setBeat] = useState(null);        // latest beat descriptor (count-in pulse)
  const [noteColors, setNoteColors] = useState({}); // noteIndex → GRADE (drives the staff)
  const [activeIndex, setActiveIndex] = useState(null);
  const [summary, setSummary] = useState(null);

  const mountedRef = useMounted();
  const metronomeRef = useRef(null);
  const trackerRef = useRef(null);
  const analyserRef = useRef(null);
  const timelineRef = useRef(null);
  const startAudioTimeRef = useRef(null); // metronome audio time of the first music beat
  const pitchRef = useRef({ hz: null });  // latest tracked pitch, read each rAF frame
  const gradesRef = useRef({});           // mutable accumulator; flushed to state
  const cursorRef = useRef(0);            // lower-bound index hint for noteAtTime
  const maxReachedRef = useRef(-1);       // furthest note.index the timeline walked
  const rafRef = useRef(null);

  // Tear down the audio graph, tracker, metronome, and rAF loop. Idempotent.
  const teardown = useCallback(() => {
    if (rafRef.current != null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(rafRef.current);
    }
    rafRef.current = null;
    if (metronomeRef.current) { metronomeRef.current.stop(); metronomeRef.current = null; }
    if (trackerRef.current) { trackerRef.current.stop(); trackerRef.current = null; }
    if (analyserRef.current) { analyserRef.current.close(); analyserRef.current = null; }
    startAudioTimeRef.current = null;
    pitchRef.current = { hz: null };
    cursorRef.current = 0;
  }, []);

  // Stop a session: finalize the accuracy summary from whatever was graded, then
  // tear the audio graph down. Keeps the painted `noteColors` so the singer sees
  // their last result.
  const stop = useCallback(() => {
    teardown();
    if (!mountedRef.current) return;
    // Fill MISSED for every note the timeline WALKED PAST (index <= maxReached)
    // that never received a usable grade — so a note the singer skipped counts
    // against the take. Notes never reached on an early stop stay absent, so
    // they're correctly excluded from the denominator (summarizeAccuracy's
    // contract). Iterate the timeline so we only seed real (non-rest) notes.
    const timeline = timelineRef.current;
    if (timeline && maxReachedRef.current >= 0) {
      const filled = { ...gradesRef.current };
      for (const n of timeline.notes) {
        if (n.index <= maxReachedRef.current && !(n.index in filled)) {
          filled[n.index] = GRADE.MISSED;
        }
      }
      gradesRef.current = filled;
      setNoteColors(filled);
    }
    setSummary(summarizeAccuracy(gradesRef.current));
    setRunning(false);
    setCountingIn(false);
    setActiveIndex(null);
  }, [teardown, mountedRef]);

  // One animation frame while grading: read elapsed time off the metronome's
  // audio clock, find the active note, grade the live pitch against it, keep the
  // best grade for that note, and flush colors to state. Ends the session when
  // the timeline is exhausted.
  const grade = useCallback(() => {
    const timeline = timelineRef.current;
    const ctx = analyserRef.current?.context;
    if (!timeline || !ctx || startAudioTimeRef.current == null) return;

    const elapsedMs = (ctx.currentTime - startAudioTimeRef.current) * 1000;
    if (elapsedMs >= timeline.totalMs) { stop(); return; }

    const hit = noteAtTime(timeline, elapsedMs, cursorRef.current);
    if (hit) {
      cursorRef.current = hit.idx;
      // Track the furthest note the timeline actually reached, so finalize() can
      // fill MISSED for notes WALKED PAST but never sung (they count against the
      // take) while still EXCLUDING notes never reached on an early stop.
      if (hit.note.index > maxReachedRef.current) maxReachedRef.current = hit.note.index;
      const g = gradeNote(pitchRef.current.hz, hit.note.targetHz);
      const prev = gradesRef.current[hit.note.index] ?? GRADE.MISSED;
      const next = bestGrade(prev, g);
      if (next !== prev) {
        gradesRef.current = { ...gradesRef.current, [hit.note.index]: next };
        setNoteColors(gradesRef.current);
      }
      setActiveIndex((cur) => (cur === hit.note.index ? cur : hit.note.index));
    } else {
      setActiveIndex((cur) => (cur === null ? cur : null));
    }
    rafRef.current = requestAnimationFrame(grade);
  }, [stop]);

  // Start a session: requires a live mic stream and a score with notes.
  const start = useCallback(() => {
    if (!stream || running) return;
    const timeline = buildColorMatchTimeline(score, { bpm, a4 });
    if (!timeline.notes.length) return;

    teardown();
    gradesRef.current = {};
    cursorRef.current = 0;
    maxReachedRef.current = -1;
    timelineRef.current = timeline;
    setNoteColors({});
    setSummary(null);
    setActiveIndex(null);
    setRunning(true);
    setCountingIn(countInBars > 0);

    // Tap the SAME recording stream (no second getUserMedia) and start the live
    // pitch tracker; it writes the latest pitch into a ref the rAF loop reads.
    const graph = createStreamAnalyser(stream);
    analyserRef.current = graph;
    trackerRef.current = createPitchTracker(graph.analyser, {
      a4,
      onUpdate: (u) => { pitchRef.current = { hz: u.hz }; },
    });

    const ts = timeSignatureFromScore(score);
    const metro = createMetronome({
      bpm: timeline.bpm, // same resolved tempo the timeline was built at
      beatsPerBar: ts.beats,
      beatValue: ts.beatValue,
      countInBars,
      onBeat: (info) => { if (mountedRef.current) setBeat(info); },
      onCountInComplete: () => {
        // The first music downbeat — anchor the grading clock and start the rAF
        // loop. The metronome and the analyser run on SEPARATE AudioContexts with
        // unrelated `currentTime` origins, so we must anchor to the analyser's own
        // clock (`info.whenAudioTime` is on the metronome's clock and can't be
        // subtracted from the analyser's `currentTime`). This callback fires aligned
        // to the downbeat click, so the analyser's `currentTime` here is the start.
        if (!mountedRef.current) return;
        setCountingIn(false);
        const ctx = analyserRef.current?.context;
        if (!ctx) { stop(); return; }
        startAudioTimeRef.current = ctx.currentTime;
        rafRef.current = requestAnimationFrame(grade);
      },
    });
    metronomeRef.current = metro;
    Promise.resolve(metro.start()).catch(() => { if (mountedRef.current) stop(); });
  }, [stream, running, score, bpm, a4, countInBars, teardown, grade, stop, mountedRef]);

  // A vanished stream (recording stopped) or score change ends an active session.
  useEffect(() => {
    if (running && !stream) stop();
  }, [stream, running, stop]);

  // Tear everything down on unmount.
  useEffect(() => () => teardown(), [teardown]);

  return { running, countingIn, beat, noteColors, summary, activeIndex, start, stop };
}
