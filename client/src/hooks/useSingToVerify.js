// useSingToVerify — capture a sung phrase and align it note-for-note against an
// existing score, without changing the score until the user accepts pitches.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createStreamAnalyser } from '../lib/audioRecorder.js';
import { createMetronome, clampBpm, DEFAULT_BPM } from '../lib/metronome.js';
import { createPitchTracker } from '../lib/pitchDetect.js';
import { parseScore } from '../lib/scoreNotation.js';
import { alignSingToVerify } from '../lib/singToVerify.js';
import useAudioSessionClaim from './useAudioSessionClaim.js';
import useMounted from './useMounted.js';

export const VERIFY_IDLE = 'idle';
export const VERIFY_COUNT_IN = 'countIn';
export const VERIFY_RECORDING = 'recording';

const FRAME_INTERVAL_MS = 30;
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export default function useSingToVerify({ score: scoreText = '', tempo } = {}) {
  const [phase, setPhase] = useState(VERIFY_IDLE);
  const [beat, setBeat] = useState(null);
  const [rows, setRows] = useState([]);
  const [error, setError] = useState(null);

  const score = useMemo(() => parseScore(scoreText), [scoreText]);
  const mountedRef = useMounted();
  const streamRef = useRef(null);
  const analyserRef = useRef(null);
  const trackerRef = useRef(null);
  const metronomeRef = useRef(null);
  const trackRef = useRef([]);
  const captureStartRef = useRef(0);
  const startBarRef = useRef(1);
  const capturingRef = useRef(false);
  const startPendingRef = useRef(false);
  const requestGenerationRef = useRef(0);

  const bpm = clampBpm(tempo ?? score.tempo) ?? DEFAULT_BPM;

  // Held for exactly the window our own mic stream is open, symmetric with
  // `voiceClient` / `audioRecorder` — see the audio-session note in
  // lib/audioContext.js.
  const { claim: claimSession, release: releaseSession } = useAudioSessionClaim('play-and-record');

  const teardown = useCallback(() => {
    if (metronomeRef.current) { metronomeRef.current.stop(); metronomeRef.current = null; }
    if (trackerRef.current) { trackerRef.current.stop(); trackerRef.current = null; }
    if (analyserRef.current) { analyserRef.current.close(); analyserRef.current = null; }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    releaseSession();
    capturingRef.current = false;
  }, [releaseSession]);

  const cancel = useCallback(() => {
    requestGenerationRef.current += 1;
    startPendingRef.current = false;
    teardown();
    trackRef.current = [];
    if (!mountedRef.current) return;
    setPhase(VERIFY_IDLE);
    setBeat(null);
  }, [teardown, mountedRef]);

  const stop = useCallback(() => {
    if (phase === VERIFY_IDLE) return;
    const captureEndMs = capturingRef.current
      ? Math.max(0, nowMs() - captureStartRef.current)
      : 0;
    teardown();
    const nextRows = alignSingToVerify(score, trackRef.current, {
      bpm,
      startBar: startBarRef.current,
      captureEndMs,
    });
    if (!mountedRef.current) return;
    setRows(nextRows);
    setPhase(VERIFY_IDLE);
    setBeat(null);
  }, [phase, score, bpm, teardown, mountedRef]);

  const start = useCallback(async (startBar = 1) => {
    if (phase !== VERIFY_IDLE || startPendingRef.current) return;
    startPendingRef.current = true;
    const requestGeneration = ++requestGenerationRef.current;
    setError(null);
    setRows([]);
    trackRef.current = [];
    startBarRef.current = startBar;

    const getUserMedia = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
    if (!getUserMedia) {
      startPendingRef.current = false;
      if (mountedRef.current) setError('Microphone access requires a secure browser connection');
      return;
    }
    // Claimed BEFORE getUserMedia — an output-only `playback` session held by a
    // player elsewhere on the page would refuse the request outright — and
    // handed back on every path that never reaches teardown(). The release is
    // gated on this request still being the current one for the same reason the
    // state updates are: a `cancel()` (or unmount) already ran teardown, and a
    // newer start()'s own claim now owns the slot, so releasing from a
    // superseded request would drop THAT claim instead of ours.
    claimSession();
    const stream = await getUserMedia({ audio: true }).catch((err) => {
      if (requestGeneration === requestGenerationRef.current) {
        startPendingRef.current = false;
        releaseSession();
        if (mountedRef.current) setError(err?.message || 'Microphone access denied');
      }
      return null;
    });
    if (!stream) return;
    if (!mountedRef.current || requestGeneration !== requestGenerationRef.current) {
      stream.getTracks().forEach((track) => track.stop());
      if (requestGeneration === requestGenerationRef.current) releaseSession();
      return;
    }
    startPendingRef.current = false;
    streamRef.current = stream;

    const graph = createStreamAnalyser(stream);
    analyserRef.current = graph;
    trackerRef.current = createPitchTracker(graph.analyser, {
      intervalMs: FRAME_INTERVAL_MS,
      holdClarity: 0.9,
      releaseFrames: 0,
      onUpdate: (update) => {
        if (!capturingRef.current) return;
        trackRef.current.push({
          tMs: nowMs() - captureStartRef.current,
          hz: update.hz,
          clarity: update.clarity,
        });
      },
    });

    setPhase(VERIFY_COUNT_IN);
    const metronome = createMetronome({
      bpm,
      beatsPerBar: score.time.beats,
      beatValue: score.time.beatValue,
      countInBars: 1,
      onBeat: (info) => {
        if (mountedRef.current) setBeat(info.beat);
      },
      onCountInComplete: () => {
        if (!mountedRef.current) return;
        captureStartRef.current = nowMs();
        capturingRef.current = true;
        setPhase(VERIFY_RECORDING);
      },
    });
    metronomeRef.current = metronome;
    await metronome.start().catch((err) => {
      // Same generation gate as the getUserMedia paths above, for the same
      // reason: a cancel()/restart during this await already tore THIS request
      // down, so an ungated teardown() here would stop the newer request's mic
      // stream and release the session claim it now holds.
      if (requestGeneration !== requestGenerationRef.current) return;
      if (mountedRef.current) setError(err?.message || 'Could not start audio');
      teardown();
      if (mountedRef.current) setPhase(VERIFY_IDLE);
    });
  }, [phase, bpm, score.time.beats, score.time.beatValue, teardown, mountedRef, claimSession, releaseSession]);

  const reset = useCallback(() => {
    setRows([]);
    setError(null);
  }, []);

  const toggleAccept = useCallback((index) => {
    setRows((current) => current.map((row) =>
      row.index === index && row.sung ? { ...row, accepted: !row.accepted } : row));
  }, []);

  const acceptAll = useCallback(() => {
    setRows((current) => current.map((row) => row.sung ? { ...row, accepted: true } : row));
  }, []);

  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;
  useEffect(() => () => cancelRef.current(), []);

  return { phase, beat, rows, error, start, stop, cancel, reset, toggleAccept, acceptAll };
}
