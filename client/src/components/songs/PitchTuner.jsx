/**
 * PitchTuner — live vocal tuner that shows the note you're singing and how
 * flat/sharp it is, in real time.
 *
 * Two modes, one component:
 *  - **Attached** — when a live recording `stream` is passed in, the tuner taps
 *    an AnalyserNode off that SAME mic stream (via `createStreamAnalyser`) so it
 *    never opens a second getUserMedia (which would re-prompt / fight the
 *    recorder). It mounts read-only inside the record panel and follows the take.
 *  - **Standalone** — with no `stream`, it offers a "Tune" toggle that opens its
 *    own mic just for tuning; nothing is recorded or saved. "Stop" closes it.
 *
 * The needle/note are colored by `tuningQuality` (green in-tune, yellow close,
 * red off) using `--port-*` tokens only. The AnalyserNode + the pitch tracker's
 * rAF loop are torn down on stop, on stream-change, and on unmount (the
 * deferred-work teardown rule in CLAUDE.md) so no audio graph or loop dangles.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Music2, Square } from 'lucide-react';
import toast from '../ui/Toast';
import { createStreamAnalyser } from '../../lib/audioRecorder.js';
import { createPitchTracker, tuningQuality } from '../../lib/pitchDetect.js';

// Map a tuning-quality level to its readout color token + needle fill.
const LEVEL_TONE = {
  'in-tune': 'text-port-success',
  close: 'text-port-warning',
  off: 'text-port-error',
  none: 'text-gray-500',
};
const LEVEL_BAR = {
  'in-tune': 'bg-port-success',
  close: 'bg-port-warning',
  off: 'bg-port-error',
  none: 'bg-port-border',
};

// Cents range the needle spans (a semitone is ±50¢; clamp so a wild glitch
// can't push the needle off the bar).
const CENTS_SPAN = 50;

// Format a detected note as "C♯4" using the same sharp/flat glyphs the score
// renderer uses, falling back to a dash while no pitch is detected.
const noteLabel = (note) => {
  if (!note) return '—';
  const glyph = note.accidental === '#' ? '♯'
    : note.accidental === 'b' ? '♭'
      : note.accidental || '';
  return `${note.letter}${glyph}${note.octave}`;
};

export default function PitchTuner({ stream = null, a4 = 440 }) {
  // `reading` is the latest tracker frame: { note, cents, held } (nulls when no
  // pitch). `held` is true while the tracker is coasting on the last stable
  // reading through a brief dropout — we dim the readout so a held frame reads as
  // "still that note" rather than a fresh detection.
  const [reading, setReading] = useState({ note: null, cents: null, held: false });
  const [standaloneOn, setStandaloneOn] = useState(false);
  const trackerRef = useRef(null);   // active pitch tracker { stop }
  const analyserRef = useRef(null);  // active { close } stream-analyser graph
  const ownStreamRef = useRef(null); // standalone-mode mic stream we own + must stop
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Tear down the tracker loop + analyser graph (but not the stream — see attach).
  const teardownTracker = useCallback(() => {
    if (trackerRef.current) { trackerRef.current.stop(); trackerRef.current = null; }
    if (analyserRef.current) { analyserRef.current.close(); analyserRef.current = null; }
    setReading({ note: null, cents: null, held: false });
  }, []);

  // Attach the tuner to a stream. Returns nothing; teardownTracker() detaches.
  const attach = useCallback((src) => {
    teardownTracker();
    if (!src) return;
    const graph = createStreamAnalyser(src);
    analyserRef.current = graph;
    trackerRef.current = createPitchTracker(graph.analyser, {
      a4,
      // Cap the readout to ~12Hz (the lib's acquire/hold hysteresis, release
      // window, and sticky note label all use their defaults) so the note/cents
      // don't strobe at the 60fps frame rate; the tracker's smoothed value keeps
      // the needle motion fluid between emits.
      updateHz: 12,
      onUpdate: (u) => {
        if (!mountedRef.current) return; // navigation-away guard
        setReading({ note: u.note, cents: u.cents, held: !!u.held });
      },
    });
  }, [a4, teardownTracker]);

  // Recording stream changed (started/stopped): follow it in attached mode.
  // When it goes null we also drop any standalone session — the record panel
  // owns the tuner while a take is live.
  useEffect(() => {
    if (stream) {
      // A recording take takes over — drop any standalone mic we'd opened so it
      // doesn't leak, then follow the recording stream.
      setStandaloneOn(false);
      if (ownStreamRef.current) {
        ownStreamRef.current.getTracks().forEach((t) => t.stop());
        ownStreamRef.current = null;
      }
      attach(stream);
    } else if (!standaloneOn) {
      teardownTracker();
    }
    return () => { if (stream) teardownTracker(); };
    // standaloneOn intentionally omitted. `attach`/`teardownTracker` are
    // referentially stable (their deps bottom out at the empty-dep
    // teardownTracker and the constant a4), so the only live trigger here is
    // `stream` changing — and every branch reads the current standaloneOn. The
    // standalone start/stop paths own their own attach/teardown directly.
  }, [stream, attach, teardownTracker]);

  // Stop standalone tuning: tear down the tracker AND close the mic we opened.
  const stopStandalone = useCallback(() => {
    teardownTracker();
    if (ownStreamRef.current) {
      ownStreamRef.current.getTracks().forEach((t) => t.stop());
      ownStreamRef.current = null;
    }
    setStandaloneOn(false);
  }, [teardownTracker]);

  // Tear everything down on unmount.
  useEffect(() => () => {
    if (trackerRef.current) trackerRef.current.stop();
    if (analyserRef.current) analyserRef.current.close();
    if (ownStreamRef.current) ownStreamRef.current.getTracks().forEach((t) => t.stop());
  }, []);

  const startStandalone = useCallback(async () => {
    // Guard against a double-activation opening two mics (only the last lands in
    // ownStreamRef, leaking the first). The button hides once standaloneOn flips,
    // but a fast double event can re-enter before the re-render.
    if (standaloneOn || trackerRef.current) return;
    const src = await navigator.mediaDevices.getUserMedia({ audio: true }).catch((err) => {
      toast.error(err?.message || 'Microphone access denied');
      return null;
    });
    if (!src) return;
    if (!mountedRef.current) { src.getTracks().forEach((t) => t.stop()); return; }
    ownStreamRef.current = src;
    setStandaloneOn(true);
    attach(src);
  }, [attach, standaloneOn]);

  const active = Boolean(stream) || standaloneOn;
  const quality = tuningQuality(reading.cents);
  // Needle position 0–100% across the bar; 50% is dead-center (in tune). The
  // tracker's sticky note label reports cents relative to the held note, so a
  // wandering pitch can read past ±50¢ — clamp so the needle stays on the bar and
  // the displayed number stays within a semitone.
  const displayCents = Number.isFinite(reading.cents)
    ? Math.max(-CENTS_SPAN, Math.min(CENTS_SPAN, reading.cents))
    : 0;
  const needlePct = 50 + (displayCents / CENTS_SPAN) * 50;
  // Dim the readout while coasting on a held reading through a brief dropout.
  const heldDim = reading.held ? 'opacity-60' : '';

  return (
    <div className="bg-port-card border border-port-border rounded-lg p-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
          <Music2 size={15} className="text-port-accent" /> Tuner
          {stream && <span className="text-xs font-normal text-port-error">● live</span>}
        </h3>
        {/* Standalone toggle — only when NOT attached to a recording stream. */}
        {!stream && (
          standaloneOn ? (
            <button
              type="button"
              onClick={stopStandalone}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-port-error text-white hover:bg-port-error/90"
            >
              <Square size={14} /> Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={startStandalone}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-port-accent text-white hover:bg-port-accent/90"
              title="Open the mic to tune — nothing is recorded"
            >
              <Music2 size={14} /> Tune
            </button>
          )
        )}
      </div>

      {/* Note + cents readout */}
      <div className={`flex items-end justify-center gap-3 mt-3 transition-opacity ${heldDim}`} aria-live="polite">
        <span className={`text-4xl font-bold tabular-nums leading-none ${LEVEL_TONE[quality.level]}`}>
          {noteLabel(reading.note)}
        </span>
        <span className={`text-sm pb-1 ${LEVEL_TONE[quality.level]}`}>
          {Number.isFinite(reading.cents) && reading.note
            ? `${displayCents > 0 ? '+' : ''}${displayCents}¢ · ${quality.label}`
            : active ? 'Listening…' : 'Idle'}
        </span>
      </div>

      {/* Cents needle: a center-anchored bar; the needle slides flat←→sharp. */}
      <div className="relative h-6 mt-3" aria-hidden="true">
        {/* track */}
        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1 bg-port-border rounded-full" />
        {/* center (in-tune) mark */}
        <div className="absolute left-1/2 top-0 bottom-0 w-px bg-gray-500" />
        {/* needle */}
        <div
          className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-1.5 h-5 rounded-full transition-all duration-75 ${LEVEL_BAR[quality.level]}`}
          style={{ left: `${needlePct}%`, opacity: reading.note ? 1 : 0.3 }}
        />
      </div>
      <div className="flex justify-between text-[10px] text-gray-600 mt-1" aria-hidden="true">
        <span>♭ flat</span>
        <span>in tune</span>
        <span>sharp ♯</span>
      </div>
    </div>
  );
}
