// useSingToScore — capture a sung melody from the mic and transcribe it into
// PortOS lead-sheet notation.
//
// Lifecycle: `start()` opens the mic (its own getUserMedia — sing-to-score is a
// standalone capture, distinct from a recording take), counts in with the shared
// metronome so the singer knows where beat 1 is, then runs a pitch tracker that
// accumulates `{ tMs, hz, clarity }` frames relative to the first music beat.
// `stop()` ends capture and runs the pure `transcribePitchTrack` pipeline,
// returning the lead-sheet body for the UI to preview + insert.
//
// All Web Audio + rAF resources (mic stream, analyser graph, tracker loop,
// metronome) tear down on stop AND on unmount (the deferred-work teardown rule
// in AGENTS.md) so nothing dangles after navigation-away.

import { useCallback, useEffect, useRef, useState } from 'react';
import { createStreamAnalyser, openAnalysisMic } from '../lib/audioRecorder.js';
import { createPitchTracker } from '../lib/pitchDetect.js';
import { createMetronome, clampBpm, timeSignatureFromScore, DEFAULT_BPM } from '../lib/metronome.js';
import { transcribePitchTrack } from '../lib/singToScore.js';
import useAudioSessionClaim from './useAudioSessionClaim.js';
import useAsyncCaptureGuard from './useAsyncCaptureGuard.js';
import useMounted from './useMounted.js';

// Phases the UI renders distinct states for.
export const SING_IDLE = 'idle';
export const SING_COUNT_IN = 'countIn';
export const SING_RECORDING = 'recording';

// Pull a pitch frame this often during capture (ms). Faster than rAF-tied so the
// track density is stable across machines; the segmenter is timestamp-driven so
// the exact rate only affects resolution, not correctness.
const FRAME_INTERVAL_MS = 30;
// Count-in length before capture begins (bars). One bar is the conventional lead.
const COUNT_IN_BARS = 1;

// Monotonic-ish wall clock for frame timestamps; `performance.now()` is more
// precise but may be absent in some test/SSR contexts, so fall back to Date.
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * @param {object} opts
 * @param {number|string} [opts.tempo] — song BPM (defaults to 120 when absent).
 * @param {string} [opts.score] — current score text, for the time signature.
 * @param {string} [opts.musicKey] — key name for enharmonic spelling (e.g. "Eb").
 * @returns {{
 *   phase: string, beat: number|null, result: string|null,
 *   error: string|null, micProcessing: object|null,
 *   start: () => Promise<void>, stop: () => void,
 *   reset: () => void,
 * }}
 */
export default function useSingToScore({ tempo, score = '', musicKey = 'C' } = {}) {
  const [phase, setPhase] = useState(SING_IDLE);
  const [beat, setBeat] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  // What the browser actually applied to the capture stream — a stage left on
  // despite ANALYSIS_AUDIO_CONSTRAINTS is why a transcription can come back off.
  const [micProcessing, setMicProcessing] = useState(null);

  const mountedRef = useMounted();
  const streamRef = useRef(null);     // mic stream we own + must stop
  const analyserRef = useRef(null);   // { close } analyser graph
  const trackerRef = useRef(null);    // { stop } pitch tracker loop
  const metronomeRef = useRef(null);  // { stop } count-in metronome
  const trackRef = useRef([]);        // accumulated { tMs, hz, clarity } frames
  const captureStartRef = useRef(0);  // performance.now() at first music beat
  const capturingRef = useRef(false); // gate frames until the count-in completes

  // Held for exactly the window our own mic stream is open, symmetric with
  // `voiceClient` / `audioRecorder`. Sing-to-score is safe on `auto` only
  // because no `playback` claimant happens to share its route today — an
  // accident of routing, not an invariant, and `playback` REFUSES capture. See
  // the audio-session note in lib/audioContext.js.
  const { claim: claimSession, release: releaseSession } = useAudioSessionClaim('play-and-record');

  const bpm = clampBpm(tempo) ?? DEFAULT_BPM;
  const timeSig = timeSignatureFromScore(score);

  // Tear down every live resource. Safe to call repeatedly (idempotent refs).
  const teardown = useCallback(() => {
    if (metronomeRef.current) { metronomeRef.current.stop(); metronomeRef.current = null; }
    if (trackerRef.current) { trackerRef.current.stop(); trackerRef.current = null; }
    if (analyserRef.current) { analyserRef.current.close(); analyserRef.current = null; }
    if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
    releaseSession();
    capturingRef.current = false;
  }, [releaseSession]);

  const resetAfterCancel = useCallback(() => {
    trackRef.current = [];
    if (!mountedRef.current) return;
    setPhase(SING_IDLE);
    setBeat(null);
  }, [mountedRef]);

  // Invalidate an in-flight permission request before tearing down. A browser
  // can resolve getUserMedia after this hook unmounts; that continuation owns
  // its stream until it sees this generation change and stops it itself.
  const {
    tryStart,
    settleStart,
    isCurrent,
    cancel,
  } = useAsyncCaptureGuard({ teardown, onCancel: resetAfterCancel });

  // Finalize: stop everything, run the transcription over the captured track.
  const finish = useCallback(() => {
    teardown();
    const track = trackRef.current;
    const dsl = transcribePitchTrack(track, {
      bpm,
      key: musicKey,
      beatsPerBar: timeSig.beats,
      beatValue: timeSig.beatValue,
    });
    if (!mountedRef.current) return;
    setPhase(SING_IDLE);
    setBeat(null);
    setResult(dsl || '');
  }, [bpm, musicKey, timeSig.beats, timeSig.beatValue, teardown, mountedRef]);

  const stop = useCallback(() => {
    if (phase === SING_IDLE) return;
    finish();
  }, [phase, finish]);

  const start = useCallback(async () => {
    if (phase !== SING_IDLE) return;
    const requestGeneration = tryStart();
    if (requestGeneration === null) return;
    setError(null);
    setResult(null);
    // Drop the previous capture's report up front — see useSingToVerify.
    setMicProcessing(null);
    trackRef.current = [];

    // Resolved (and null-checked) BEFORE the claim: on an insecure origin
    // `navigator.mediaDevices` is undefined, and reaching through it throws
    // synchronously — past a claim, that leaves the document pinned
    // record-capable with no release left to call. Mirrors useSingToVerify.
    const getUserMedia = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
    if (!getUserMedia) {
      settleStart(requestGeneration);
      if (mountedRef.current) setError('Microphone access requires a secure browser connection');
      return;
    }

    // Claimed BEFORE getUserMedia — an output-only `playback` session held by a
    // player elsewhere on the page would refuse the request outright — and
    // handed back on every path that never reaches teardown() (the unmount bail
    // below is belt-and-suspenders: the hook already releases on unmount).
    claimSession();
    const opened = await openAnalysisMic({ getUserMedia }).catch((err) => {
      if (settleStart(requestGeneration)) {
        releaseSession();
        if (mountedRef.current) setError(err?.message || 'Microphone access denied');
      }
      return null;
    });
    if (!opened) return;
    const { stream: src, processing } = opened;
    if (!mountedRef.current || !isCurrent(requestGeneration)) {
      src.getTracks().forEach((track) => track.stop());
      if (isCurrent(requestGeneration)) releaseSession();
      return;
    }
    settleStart(requestGeneration);
    streamRef.current = src;
    setMicProcessing(processing);

    const graph = createStreamAnalyser(src);
    analyserRef.current = graph;

    // Accumulate frames only after the count-in. `capturingRef` flips on the
    // first music downbeat; `captureStartRef` anchors t=0 there so onsets are
    // relative to beat 1 of the bar.
    trackerRef.current = createPitchTracker(graph.analyser, {
      intervalMs: FRAME_INTERVAL_MS,
      // Transcription wants the raw per-frame track: a single clarity gate (no
      // acquire/hold hysteresis) and an immediate null on an unclear frame (no
      // release-window hold), so a dropout is a real gap the segmenter can see
      // rather than a stale held pitch. The tuner's hysteresis defaults are for
      // the live readout, not the captured signal.
      holdClarity: 0.9,
      releaseFrames: 0,
      onUpdate: (u) => {
        if (!capturingRef.current) return;
        const tMs = nowMs() - captureStartRef.current;
        trackRef.current.push({ tMs, hz: u.hz, clarity: u.clarity });
      },
    });

    setPhase(SING_COUNT_IN);
    const metro = createMetronome({
      bpm,
      beatsPerBar: timeSig.beats,
      beatValue: timeSig.beatValue,
      countInBars: COUNT_IN_BARS,
      onBeat: (info) => {
        if (!mountedRef.current) return;
        setBeat(info.beat);
      },
      onCountInComplete: () => {
        if (!mountedRef.current) return;
        captureStartRef.current = nowMs();
        capturingRef.current = true;
        setPhase(SING_RECORDING);
      },
    });
    metronomeRef.current = metro;
    await metro.start().catch((err) => {
      // A cancellation or fresh request may have already torn this capture
      // down. Do not let its late failure tear down a newer session.
      if (!isCurrent(requestGeneration)) return;
      if (mountedRef.current) setError(err?.message || 'Could not start audio');
      teardown();
      if (mountedRef.current) setPhase(SING_IDLE);
    });
  }, [phase, bpm, timeSig.beats, timeSig.beatValue, teardown, mountedRef, claimSession, releaseSession, tryStart, settleStart, isCurrent]);

  // Clear a produced result (after the user inserts or discards it).
  const reset = useCallback(() => {
    setResult(null);
    setError(null);
    setMicProcessing(null);
  }, []);

  // Belt-and-suspenders: cancel everything on unmount so a navigation-away
  // mid-permission or mid-capture can't leave the mic open or a loop running.
  // A ref keeps the effect's dep list empty (run cleanup exactly once on
  // unmount) while still calling the latest cancellation callback.
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;
  useEffect(() => () => cancelRef.current(), []);

  return { phase, beat, result, error, micProcessing, start, stop, reset };
}
