/** Capture continuous microphone audio and submit utterances detected by the AudioWorklet VAD. */

import socket from './socket';
import { resumeAudioContext, acquireAudioSession } from '../lib/audioContext.js';
import { float32ToWav16k, MAX_VOICE_AUDIO_BYTES } from '../lib/audioRecorder.js';
import { markVoiceTiming } from './voiceTimingDebug.js';
import { cancelVoicePlayback, detectAudioRoute, isHeadsetAudioRoute, isInTtsEchoWindow, isTtsActive } from './voicePlayback.js';

// ─── Continuous mode (hands-free VAD) ─────────────────────────────────────
// AudioWorklet streams PCM, RMS-based VAD auto-submits on silence, and
// barge-in (voice:interrupt + cancelVoicePlayback) fires when the user talks over
// the bot. Thresholds are auto-calibrated from ambient noise at startup.

// Persisted voice.vad overrides (callbacks.vad); anything not a positive number keeps the built-in default.
const vadThreshold = (override, fallback) => (Number.isFinite(override) && override > 0 ? override : fallback);

const VAD = {
  minOnRms: 0.010,
  minOffRms: 0.005,
  maxOnRms: 0.060,
  silenceMs: 600,        // silence duration that ends a turn
  minSpeechMs: 250,      // ignore utterances shorter than this (noise blips)
  preRollMs: 250,        // audio kept before detected speech start
  onsetConfirmMs: 80,    // frames required above onRms before firing speech-start
  bargeInOnsetConfirmMs: 220, // during TTS + echo tail, require longer
                         // sustained signal before confirming barge-in — a
                         // brief leak from the bot's own voice shouldn't
                         // look like the user starting to speak.
  calibrationMs: 600,    // ambient-noise sampling window at startup
  bargeInMul: 2.5,       // multiplier applied to onRms during TTS + echo
                         // tail. Was 1.15 which let loud TTS re-trigger the
                         // VAD; 2.5 still allows deliberate barge-in while
                         // rejecting speaker-to-mic bleed. Lower this only
                         // if users complain barge-in is unresponsive.
  maxSpeechMs: 15000,    // runaway-speech watchdog: if silence never registers
                         // (noisy env, stuck state), force submit/discard.
  debug: false,          // window.__portosVadDebug = true to enable logging
};

// Module-level on purpose: a display reading for the widget's level meter and
// a log throttle — neither is detection state, so neither belongs to an attempt.
let lastRmsValue = 0;
let lastDebugLogAt = 0;

let continuousAttempt = null;

// Detector state for ONE capture attempt (`attempt.vad`). This is the single
// list of starting values; a new attempt gets a fresh record and a detached one
// drops it, so nothing carries over between hands-free sessions.
const createVadState = (sampleRate) => {
  const preRollLimit = Math.max(1, Math.ceil((VAD.preRollMs / 1000) * sampleRate / 128));
  return {
    // Live thresholds (set by calibration, then static for the session).
    onRms: VAD.minOnRms,
    offRms: VAD.minOffRms,
    calibrating: true,
    calibrationSamples: [],
    calibrationUntil: performance.now() + VAD.calibrationMs,
    vadState: 'idle',
    speechChunks: [],
    // Fixed-size ring buffer of the last `preRollLimit` frames; avoids the
    // O(n) Array.shift() that would otherwise run ~375 times/second.
    preRoll: new Array(preRollLimit),
    preRollLimit,
    preRollIdx: 0,
    preRollFilled: 0,
    silenceStartedAt: 0,
    speechStartedAt: 0,
    onsetFrames: 0,
  };
};

const WORKLET_SOURCE = `
class VADProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('vad-processor', VADProcessor);
`;

const isCurrentContinuousAttempt = (attempt) => Boolean(
  attempt?.active
  && attempt.isOwnerCurrent()
  && continuousAttempt === attempt,
);

const settleContinuousStart = (attempt) => {
  attempt.pending = false;
};

// Detach before any asynchronous close. A stale startup may still receive a
// stream later, but it can release only resources on its own attempt.
const detachContinuousAttempt = (attempt) => {
  if (!attempt) return null;
  attempt.active = false;
  settleContinuousStart(attempt);
  if (continuousAttempt === attempt) {
    continuousAttempt = null;
    attempt.vad = null;
  }
  return attempt;
};

const releaseContinuousResources = (attempt) => {
  if (!attempt) return null;
  const { source, workletNode, stream, releaseSession } = attempt;
  attempt.source = null;
  attempt.workletNode = null;
  attempt.stream = null;
  attempt.releaseSession = null;
  try {
    source?.disconnect();
    workletNode?.disconnect();
    if (workletNode) workletNode.port.onmessage = null;
  } catch { /* ignore teardown errors */ }
  stream?.getTracks().forEach((track) => track.stop());
  return releaseSession;
};

const submitUtterance = async (capture) => {
  if (!isCurrentContinuousAttempt(capture)) return;
  const { vad } = capture;
  if (!vad.speechChunks.length) return;
  const chunksToSubmit = vad.speechChunks;
  vad.speechChunks = [];
  markVoiceTiming('speech.end', { startsTurn: true });

  const total = chunksToSubmit.reduce((n, c) => n + c.length, 0);
  const samples = new Float32Array(total);
  let off = 0;
  for (const c of chunksToSubmit) { samples.set(c, off); off += c.length; }

  const rate = capture.context?.sampleRate || 48000;
  const { wav, peak } = await float32ToWav16k(samples, rate);
  if (!isCurrentContinuousAttempt(capture)) return;
  if (!wav || wav.byteLength < 800) {
    capture.callbacks?.onSubmit?.({ submitted: false, peak });
    return;
  }
  if (wav.byteLength > MAX_VOICE_AUDIO_BYTES) {
    capture.refuseLongRecording();
    capture.callbacks?.onSubmit?.({ submitted: false, peak });
    return;
  }
  markVoiceTiming(`audio.sent ${wav.byteLength}B (encoded)`);
  socket.emit('voice:turn', { audio: wav, mimeType: 'audio/wav' });
  capture.callbacks?.onSubmit?.({ submitted: true, peak, size: wav.byteLength });
};

const finishCalibration = (vad) => {
  vad.calibrating = false;
  const samples = vad.calibrationSamples;
  vad.calibrationSamples = [];
  if (!samples.length) return;
  samples.sort((a, b) => a - b);
  // Median is robust if the user accidentally speaks during calibration —
  // up to ~50% of frames can be speech without poisoning the floor estimate.
  const floor = samples[Math.floor(samples.length * 0.5)] ?? samples[samples.length - 1];
  vad.offRms = Math.max(VAD.minOffRms, floor * 2.0);
  vad.onRms = Math.min(VAD.maxOnRms, Math.max(VAD.minOnRms, floor * 4.0, vad.offRms * 2));
  console.log(`🎙️  [vad] calibrated floor=${floor.toFixed(4)} → on=${vad.onRms.toFixed(4)} off=${vad.offRms.toFixed(4)}`);
};

const snapshotPreRoll = ({ preRoll, preRollLimit, preRollIdx, preRollFilled }) => {
  if (!preRollFilled) return [];
  const out = new Array(preRollFilled);
  const start = preRollFilled < preRollLimit ? 0 : preRollIdx;
  for (let i = 0; i < preRollFilled; i++) out[i] = preRoll[(start + i) % preRollLimit];
  return out;
};

// Speech -> idle transition shared by the watchdog and end-of-speech paths.
const returnToIdle = (vad) => {
  vad.vadState = 'idle';
  vad.silenceStartedAt = 0;
  vad.onsetFrames = 0;
};

const handleFrame = (frame, capture) => {
  if (!isCurrentContinuousAttempt(capture)) return;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  const rms = Math.sqrt(sum / frame.length);
  lastRmsValue = rms;

  const { vad } = capture;
  vad.preRoll[vad.preRollIdx] = frame;
  vad.preRollIdx = (vad.preRollIdx + 1) % vad.preRollLimit;
  if (vad.preRollFilled < vad.preRollLimit) vad.preRollFilled += 1;

  const now = performance.now();

  if (vad.calibrating) {
    vad.calibrationSamples.push(rms);
    if (now >= vad.calibrationUntil) finishCalibration(vad);
    else return;
  }

  if (VAD.debug && now - lastDebugLogAt > 250) {
    lastDebugLogAt = now;
    console.log(`[vad] state=${vad.vadState} rms=${rms.toFixed(4)} on=${vad.onRms.toFixed(4)} off=${vad.offRms.toFixed(4)} tts=${isTtsActive()}`);
  }

  if (vad.vadState === 'idle') {
    // Raise the bar while TTS plays AND during the echo tail so neither the
    // bot's live audio nor reverb through the mic trigger a false barge-in.
    // Skip the bump entirely on a confirmed headset — there's no acoustic
    // path from speaker to mic, so the user can interrupt at normal volume.
    const inEcho = isInTtsEchoWindow() && !isHeadsetAudioRoute();
    const effectiveOnRms = inEcho ? vad.onRms * VAD.bargeInMul : vad.onRms;
    const effectiveConfirmMs = inEcho ? VAD.bargeInOnsetConfirmMs : VAD.onsetConfirmMs;
    if (rms > effectiveOnRms) {
      vad.onsetFrames += 1;
      const frameMs = (frame.length / (capture.context?.sampleRate || 48000)) * 1000;
      if (vad.onsetFrames * frameMs >= effectiveConfirmMs) {
        // Confirmed speech onset — barge-in + start capturing
        vad.vadState = 'speaking';
        vad.speechStartedAt = now;
        vad.silenceStartedAt = 0;
        vad.onsetFrames = 0;
        if (isTtsActive()) {
          socket.emit('voice:interrupt');
          cancelVoicePlayback();
        }
        vad.speechChunks = snapshotPreRoll(vad);
        capture.callbacks?.onSpeechStart?.();
      }
    } else {
      vad.onsetFrames = 0;
    }
    return;
  }

  // state === 'speaking'
  vad.speechChunks.push(frame);

  // Watchdog: if silence never crosses offRms (e.g. noisy env, echo tail,
  // stuck mic), force the turn to end so VAD doesn't jam here forever.
  if (now - vad.speechStartedAt >= VAD.maxSpeechMs) {
    returnToIdle(vad);
    capture.callbacks?.onSpeechEnd?.();
    if (vad.speechChunks.length) {
      submitUtterance(capture).catch((err) => console.warn('[voice] watchdog submit failed:', err));
    } else {
      capture.callbacks?.onSubmit?.({ submitted: false, peak: 0, discarded: true });
    }
    return;
  }

  if (rms < vad.offRms) {
    if (!vad.silenceStartedAt) vad.silenceStartedAt = now;
    if (now - vad.silenceStartedAt >= vadThreshold(capture.callbacks?.vad?.endOfSpeechMs, VAD.silenceMs)) {
      const speechMs = vad.silenceStartedAt - vad.speechStartedAt;
      returnToIdle(vad);
      capture.callbacks?.onSpeechEnd?.();
      if (speechMs >= vadThreshold(capture.callbacks?.vad?.minUtteranceMs, VAD.minSpeechMs)) {
        submitUtterance(capture).catch((err) => console.warn('[voice] submit failed:', err));
      } else {
        // Too short to submit — notify the widget so it leaves 'thinking'
        // instead of waiting for a server response that won't arrive.
        vad.speechChunks = [];
        capture.callbacks?.onSubmit?.({ submitted: false, peak: 0, discarded: true });
      }
    }
  } else {
    vad.silenceStartedAt = 0;
  }
};

export const startContinuous = async (callbacks, getCaptureOwnerGuard, refuseLongRecording) => {
  if (continuousAttempt?.context || continuousAttempt?.pending) return;
  const attempt = {
    isOwnerCurrent: getCaptureOwnerGuard(),
    refuseLongRecording,
    active: true,
    pending: true,
    callbacks,
    releaseSession: null,
    stream: null,
    context: null,
    source: null,
    workletNode: null,
    vad: null,
  };
  continuousAttempt = attempt;

  // Claimed BEFORE getUserMedia — an output-only session already in force would
  // refuse the request outright — and handed back on failure, since a denied mic
  // never reaches stopContinuous (the attempt has no context yet).
  attempt.releaseSession = acquireAudioSession('play-and-record');

  // AGC is intentionally OFF here — it boosts silence to maintain a target
  // output level, which destroys the energy-difference signal the VAD needs.
  const nextStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false,
    },
  }).catch((err) => {
    detachContinuousAttempt(attempt);
    releaseContinuousResources(attempt)?.();
    throw err;
  });
  attempt.stream = nextStream;
  if (!isCurrentContinuousAttempt(attempt)) {
    releaseContinuousResources(attempt)?.();
    return null;
  }
  detectAudioRoute(attempt.stream).catch(() => {});

  // Constructors and graph wiring can throw synchronously too. Roll back every
  // partial setup, including one that acquired the mic but never got a context.
  let blobUrl = null;
  try {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    attempt.context = new Ctor();
    await resumeAudioContext(attempt.context);
    if (!isCurrentContinuousAttempt(attempt)) return null;

    // Inline worklet module so we don't need a separate file in the build.
    blobUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
    await attempt.context.audioWorklet.addModule(blobUrl);
    if (!isCurrentContinuousAttempt(attempt)) return null;

    attempt.source = attempt.context.createMediaStreamSource(attempt.stream);
    attempt.workletNode = new AudioWorkletNode(attempt.context, 'vad-processor');

    attempt.vad = createVadState(attempt.context.sampleRate);

    attempt.workletNode.port.onmessage = (e) => handleFrame(e.data, attempt);
    attempt.source.connect(attempt.workletNode);
    // Worklet output must be pulled by the graph or process() stops running;
    // sinking through a zero-gain node keeps it alive without echoing the mic.
    const sink = attempt.context.createGain();
    sink.gain.value = 0;
    attempt.workletNode.connect(sink).connect(attempt.context.destination);
    settleContinuousStart(attempt);
  } catch (err) {
    // A disposed or stopped attempt already released its resources. Its late
    // rejection must not stop a newer capture that has since started.
    if (isCurrentContinuousAttempt(attempt)) await stopContinuous();
    throw err;
  } finally {
    if (blobUrl !== null) URL.revokeObjectURL(blobUrl);
  }
};

export const stopContinuous = async () => {
  const attempt = detachContinuousAttempt(continuousAttempt);
  releaseContinuousResources(attempt)?.();
  // Reset shared state before awaiting close so a retry owns fresh VAD state.
  await Promise.resolve().then(() => attempt?.context?.close?.()).catch(() => {});
};

export const isContinuous = () => continuousAttempt?.context != null;

export const getVadLevel = () => lastRmsValue;

// Toggle verbose VAD logging at runtime: window.__portosVadDebug = true
if (typeof window !== 'undefined') {
  Object.defineProperty(window, '__portosVadDebug', {
    configurable: true,
    get: () => VAD.debug,
    set: (v) => { VAD.debug = !!v; },
  });
}

export function disposeContinuousCapture() {
  const attempt = detachContinuousAttempt(continuousAttempt);
  const releaseSession = releaseContinuousResources(attempt);
  Promise.resolve(attempt?.context?.close?.()).catch(() => {});
  releaseSession?.();
}
