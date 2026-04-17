// Browser-side voice capture + playback. Supports two modes:
//   - Push-to-talk: MediaRecorder, manual start/stop.
//   - Continuous:   AudioWorklet + energy VAD auto-submits on silence,
//                   and fires barge-in (voice:interrupt + stopPlayback) when
//                   the user starts talking over the bot.
// Both emit 'voice:turn' over Socket.IO and play incoming TTS via Web Audio.

import socket from './socket';

let stream = null;
let recorder = null;
let chunks = [];
let audioCtx = null;
let playQueue = Promise.resolve();
let currentSource = null;
let ttsQueueDepth = 0;
// Timestamp after which the post-TTS echo-tail window ends. See VAD.ttsTailMs.
let ttsCooldownUntil = 0;
// Raised when a turn is cancelled (barge-in, explicit interrupt, reset, new
// text turn); cleared when the server emits voice:transcript for the next
// turn. While raised, incoming voice:tts:audio is dropped — prevents
// in-flight chunks from the old turn overlaying the new turn's audio.
let rejectingTts = false;

const pickMime = () => {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  for (const m of candidates) {
    if (window.MediaRecorder && window.MediaRecorder.isTypeSupported?.(m)) return m;
  }
  return 'audio/webm';
};

const ensureCtx = () => {
  if (!audioCtx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctor();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
};

const stopPlayback = () => {
  if (currentSource) {
    try { currentSource.stop(); } catch { /* already stopped */ }
    currentSource = null;
  }
  playQueue = Promise.resolve();
  ttsQueueDepth = 0;
  ttsCooldownUntil = 0;
  // Any chunks still in-flight from the cancelled turn must not be played —
  // they'll arrive asynchronously after we've torn down local playback.
  rejectingTts = true;
};

// whisper.cpp only accepts 16-bit PCM WAV — it has no built-in audio decoder.
// Decode whatever MediaRecorder produced, downmix to mono, resample to 16 kHz,
// and hand-encode a minimal WAV header.
const TARGET_SAMPLE_RATE = 16000;

const encodePcmToWav = (float32, sampleRate) => {
  const n = float32.length;
  const buffer = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buffer);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + n * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, n * 2, true);

  let off = 44;
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return buffer;
};

const blobToWav16k = async (blob) => {
  const bytes = await blob.arrayBuffer();
  const decodeCtx = new (window.AudioContext || window.webkitAudioContext)();
  const decoded = await decodeCtx.decodeAudioData(bytes);
  decodeCtx.close();

  // OfflineAudioContext handles resampling natively when we render at the target rate.
  const frames = Math.ceil(decoded.duration * TARGET_SAMPLE_RATE);
  const offline = new OfflineAudioContext(1, frames, TARGET_SAMPLE_RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  const pcm = rendered.getChannelData(0);

  // Peak amplitude surfaces dead-mic / too-quiet situations that whisper would
  // otherwise silently transcribe as [BLANK_AUDIO].
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) {
    const a = Math.abs(pcm[i]);
    if (a > peak) peak = a;
  }

  return { wav: encodePcmToWav(pcm, TARGET_SAMPLE_RATE), peak };
};

const enqueuePlay = async (bytes) => {
  const ctx = ensureCtx();
  // decodeAudioData consumes its buffer — clone so we don't mutate the socket frame
  const copy = bytes.slice(0);
  const buffer = await ctx.decodeAudioData(copy);
  ttsQueueDepth += 1;
  playQueue = playQueue.then(() => new Promise((resolve) => {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.onended = () => {
      if (currentSource === src) currentSource = null;
      ttsQueueDepth = Math.max(0, ttsQueueDepth - 1);
      // Skip the tail when we're rejecting (playback was torn down) —
      // there's no real audio left for a room echo to trail off from.
      if (ttsQueueDepth === 0 && !rejectingTts) {
        ttsCooldownUntil = performance.now() + VAD.ttsTailMs;
      }
      resolve();
    };
    currentSource = src;
    src.start();
  }));
};

const isTtsActive = () => ttsQueueDepth > 0 || currentSource !== null;
const isInTtsEchoWindow = () => isTtsActive() || performance.now() < ttsCooldownUntil;

socket.on('voice:tts:audio', ({ wav }) => {
  if (rejectingTts) return; // stale chunk from a cancelled turn — drop it
  // socket.io serializes Node Buffers to ArrayBuffer/Uint8Array in the browser
  const ab = wav instanceof ArrayBuffer
    ? wav
    : wav?.buffer instanceof ArrayBuffer
      ? wav.buffer
      : null;
  if (!ab) return;
  enqueuePlay(ab).catch((err) => console.warn('[voice] playback failed:', err));
});

// voice:transcript marks the start of a new turn's outputs — any pending
// rejection from a previous cancellation should be lifted now so this turn's
// TTS chunks actually play.
socket.on('voice:transcript', () => { rejectingTts = false; });

export const startCapture = async () => {
  if (recorder) return;
  // Barge-in: abort any in-flight turn and silence current playback
  socket.emit('voice:interrupt');
  stopPlayback();

  // autoGainControl is critical — without it, quiet mics record near-silent audio
  // that whisper transcribes as [BLANK_AUDIO].
  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  const mimeType = pickMime();
  chunks = [];
  recorder = new MediaRecorder(stream, { mimeType });
  recorder.addEventListener('dataavailable', (e) => { if (e.data.size > 0) chunks.push(e.data); });
  recorder.start(250);
  return { mimeType };
};

export const stopCapture = async () => {
  if (!recorder) return null;
  const rec = recorder;
  recorder = null;

  await new Promise((resolve) => {
    rec.addEventListener('stop', resolve, { once: true });
    rec.stop();
  });
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;

  const blob = new Blob(chunks, { type: rec.mimeType });
  chunks = [];
  if (blob.size < 800) return null; // discard sub-25ms empty recordings

  const { wav, peak } = await blobToWav16k(blob);
  socket.emit('voice:turn', { audio: wav, mimeType: 'audio/wav' });
  return { mimeType: 'audio/wav', size: wav.byteLength, sourceSize: blob.size, peak };
};

export const sendText = (text) => {
  const trimmed = (text || '').trim();
  if (!trimmed) return;
  stopPlayback();
  socket.emit('voice:text', { text: trimmed });
};

export const interrupt = () => {
  socket.emit('voice:interrupt');
  stopPlayback();
};

export const resetConversation = () => {
  socket.emit('voice:reset');
  stopPlayback();
};

export const isCapturing = () => recorder !== null;

/**
 * Subscribe to voice events. Returns an unsubscribe function.
 * Events: voice:transcript, voice:llm:delta, voice:llm:done, voice:error, voice:idle
 */
export const onVoiceEvent = (event, handler) => {
  socket.on(event, handler);
  return () => socket.off(event, handler);
};

export const playWav = (arrayBuffer) => enqueuePlay(arrayBuffer);

// Resolves once every currently-queued TTS chunk has finished playing locally.
// Used by continuous mode to know when to return from 'speaking' → listening.
export const whenPlaybackDrained = () => playQueue.then(() => !isTtsActive());

// ─── Continuous mode (hands-free VAD) ─────────────────────────────────────
// AudioWorklet streams PCM, RMS-based VAD auto-submits on silence, and
// barge-in (voice:interrupt + stopPlayback) fires when the user talks over
// the bot. Thresholds are auto-calibrated from ambient noise at startup.

const VAD = {
  minOnRms: 0.010,
  minOffRms: 0.005,
  maxOnRms: 0.060,
  silenceMs: 600,        // silence duration that ends a turn
  minSpeechMs: 250,      // ignore utterances shorter than this (noise blips)
  preRollMs: 250,        // audio kept before detected speech start
  onsetConfirmMs: 80,    // frames required above onRms before firing speech-start
  calibrationMs: 600,    // ambient-noise sampling window at startup
  bargeInMul: 1.15,      // small bump over onRms during TTS to dampen echo
                         // bleed. Higher blocks real speech with calibrated
                         // thresholds; lower trusts echoCancellation alone.
  ttsTailMs: 300,        // echo-tail window: keep bargeInMul active for this
                         // long after the last TTS chunk ends to ignore reverb.
  maxSpeechMs: 15000,    // runaway-speech watchdog: if silence never registers
                         // (noisy env, stuck state), force submit/discard.
  debug: false,          // window.__portosVadDebug = true to enable logging
};

// Live thresholds (set by calibration, then static for the session).
let onRms = VAD.minOnRms;
let offRms = VAD.minOffRms;
let calibrating = false;
let calibrationSamples = [];
let calibrationUntil = 0;

let lastRmsValue = 0;
let lastDebugLogAt = 0;

let continuousCtx = null;
let continuousStream = null;
let continuousWorkletNode = null;
let continuousSource = null;
let continuousCallbacks = null;
let vadState = 'idle';
let speechChunks = [];
// Fixed-size ring buffer of the last `preRollLimit` frames; avoids the
// O(n) Array.shift() that would otherwise run ~375 times/second.
let preRoll = null;
let preRollLimit = 0;
let preRollIdx = 0;
let preRollFilled = 0;
let silenceStartedAt = 0;
let speechStartedAt = 0;
let onsetFrames = 0;

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

const float32ToWav16k = async (samples, sourceRate) => {
  if (!samples.length) return { wav: null, peak: 0 };
  const frames = Math.ceil(samples.length * TARGET_SAMPLE_RATE / sourceRate);
  const offline = new OfflineAudioContext(1, frames, TARGET_SAMPLE_RATE);
  const buf = offline.createBuffer(1, samples.length, sourceRate);
  buf.getChannelData(0).set(samples);
  const src = offline.createBufferSource();
  src.buffer = buf;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  const pcm = rendered.getChannelData(0);

  let peak = 0;
  for (let i = 0; i < pcm.length; i++) {
    const a = Math.abs(pcm[i]);
    if (a > peak) peak = a;
  }
  return { wav: encodePcmToWav(pcm, TARGET_SAMPLE_RATE), peak };
};

const submitUtterance = async () => {
  if (!speechChunks.length) return;
  const chunksToSubmit = speechChunks;
  speechChunks = [];

  const total = chunksToSubmit.reduce((n, c) => n + c.length, 0);
  const samples = new Float32Array(total);
  let off = 0;
  for (const c of chunksToSubmit) { samples.set(c, off); off += c.length; }

  const rate = continuousCtx?.sampleRate || 48000;
  const { wav, peak } = await float32ToWav16k(samples, rate);
  if (!wav || wav.byteLength < 800) {
    continuousCallbacks?.onSubmit?.({ submitted: false, peak });
    return;
  }
  socket.emit('voice:turn', { audio: wav, mimeType: 'audio/wav' });
  continuousCallbacks?.onSubmit?.({ submitted: true, peak, size: wav.byteLength });
};

const finishCalibration = () => {
  calibrating = false;
  const samples = calibrationSamples;
  calibrationSamples = [];
  if (!samples.length) return;
  samples.sort((a, b) => a - b);
  // Median is robust if the user accidentally speaks during calibration —
  // up to ~50% of frames can be speech without poisoning the floor estimate.
  const floor = samples[Math.floor(samples.length * 0.5)] ?? samples[samples.length - 1];
  offRms = Math.max(VAD.minOffRms, floor * 2.0);
  onRms = Math.min(VAD.maxOnRms, Math.max(VAD.minOnRms, floor * 4.0, offRms * 2));
  // eslint-disable-next-line no-console
  console.log(`🎙️  [vad] calibrated floor=${floor.toFixed(4)} → on=${onRms.toFixed(4)} off=${offRms.toFixed(4)}`);
};

const snapshotPreRoll = () => {
  if (!preRollFilled) return [];
  const out = new Array(preRollFilled);
  const start = preRollFilled < preRollLimit ? 0 : preRollIdx;
  for (let i = 0; i < preRollFilled; i++) out[i] = preRoll[(start + i) % preRollLimit];
  return out;
};

const handleFrame = (frame) => {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  const rms = Math.sqrt(sum / frame.length);
  lastRmsValue = rms;

  preRoll[preRollIdx] = frame;
  preRollIdx = (preRollIdx + 1) % preRollLimit;
  if (preRollFilled < preRollLimit) preRollFilled += 1;

  const now = performance.now();

  if (calibrating) {
    calibrationSamples.push(rms);
    if (now >= calibrationUntil) finishCalibration();
    else return;
  }

  if (VAD.debug && now - lastDebugLogAt > 250) {
    lastDebugLogAt = now;
    // eslint-disable-next-line no-console
    console.log(`[vad] state=${vadState} rms=${rms.toFixed(4)} on=${onRms.toFixed(4)} off=${offRms.toFixed(4)} tts=${isTtsActive()}`);
  }

  if (vadState === 'idle') {
    // Raise the bar while TTS plays AND during the echo tail so neither the
    // bot's live audio nor reverb through the mic trigger a false barge-in.
    const effectiveOnRms = isInTtsEchoWindow() ? onRms * VAD.bargeInMul : onRms;
    if (rms > effectiveOnRms) {
      onsetFrames += 1;
      const frameMs = (frame.length / (continuousCtx?.sampleRate || 48000)) * 1000;
      if (onsetFrames * frameMs >= VAD.onsetConfirmMs) {
        // Confirmed speech onset — barge-in + start capturing
        vadState = 'speaking';
        speechStartedAt = now;
        silenceStartedAt = 0;
        onsetFrames = 0;
        if (isTtsActive()) {
          socket.emit('voice:interrupt');
          stopPlayback();
        }
        speechChunks = snapshotPreRoll();
        continuousCallbacks?.onSpeechStart?.();
      }
    } else {
      onsetFrames = 0;
    }
    return;
  }

  // state === 'speaking'
  speechChunks.push(frame);

  // Watchdog: if silence never crosses offRms (e.g. noisy env, echo tail,
  // stuck mic), force the turn to end so VAD doesn't jam here forever.
  if (now - speechStartedAt >= VAD.maxSpeechMs) {
    vadState = 'idle';
    silenceStartedAt = 0;
    onsetFrames = 0;
    continuousCallbacks?.onSpeechEnd?.();
    if (speechChunks.length) {
      submitUtterance().catch((err) => console.warn('[voice] watchdog submit failed:', err));
    } else {
      continuousCallbacks?.onSubmit?.({ submitted: false, peak: 0, discarded: true });
    }
    return;
  }

  if (rms < offRms) {
    if (!silenceStartedAt) silenceStartedAt = now;
    if (now - silenceStartedAt >= VAD.silenceMs) {
      const speechMs = silenceStartedAt - speechStartedAt;
      vadState = 'idle';
      silenceStartedAt = 0;
      onsetFrames = 0;
      continuousCallbacks?.onSpeechEnd?.();
      if (speechMs >= VAD.minSpeechMs) {
        submitUtterance().catch((err) => console.warn('[voice] submit failed:', err));
      } else {
        // Too short to submit — notify the widget so it leaves 'thinking'
        // instead of waiting for a server response that won't arrive.
        speechChunks = [];
        continuousCallbacks?.onSubmit?.({ submitted: false, peak: 0, discarded: true });
      }
    }
  } else {
    silenceStartedAt = 0;
  }
};

export const startContinuous = async (callbacks = {}) => {
  if (continuousCtx) return;
  continuousCallbacks = callbacks;

  // AGC is intentionally OFF here — it boosts silence to maintain a target
  // output level, which destroys the energy-difference signal the VAD needs.
  continuousStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false,
    },
  });

  const Ctor = window.AudioContext || window.webkitAudioContext;
  continuousCtx = new Ctor();
  if (continuousCtx.state === 'suspended') await continuousCtx.resume();

  // Inline worklet module so we don't need a separate file in the build
  const blobUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
  await continuousCtx.audioWorklet.addModule(blobUrl);
  URL.revokeObjectURL(blobUrl);

  continuousSource = continuousCtx.createMediaStreamSource(continuousStream);
  continuousWorkletNode = new AudioWorkletNode(continuousCtx, 'vad-processor');

  const sampleRate = continuousCtx.sampleRate;
  preRollLimit = Math.max(1, Math.ceil((VAD.preRollMs / 1000) * sampleRate / 128));
  preRoll = new Array(preRollLimit);
  preRollIdx = 0;
  preRollFilled = 0;
  speechChunks = [];
  vadState = 'idle';
  silenceStartedAt = 0;
  speechStartedAt = 0;
  onsetFrames = 0;
  calibrating = true;
  calibrationSamples = [];
  calibrationUntil = performance.now() + VAD.calibrationMs;
  onRms = VAD.minOnRms;
  offRms = VAD.minOffRms;

  continuousWorkletNode.port.onmessage = (e) => handleFrame(e.data);
  continuousSource.connect(continuousWorkletNode);
  // Worklet output must be pulled by the graph or process() stops running;
  // sinking through a zero-gain node keeps it alive without echoing the mic.
  const sink = continuousCtx.createGain();
  sink.gain.value = 0;
  continuousWorkletNode.connect(sink).connect(continuousCtx.destination);
};

export const stopContinuous = async () => {
  if (!continuousCtx) return;
  try {
    continuousSource?.disconnect();
    continuousWorkletNode?.disconnect();
    continuousWorkletNode && (continuousWorkletNode.port.onmessage = null);
  } catch { /* ignore teardown errors */ }
  continuousStream?.getTracks().forEach((t) => t.stop());
  await continuousCtx.close().catch(() => {});
  continuousCtx = null;
  continuousStream = null;
  continuousWorkletNode = null;
  continuousSource = null;
  speechChunks = [];
  preRoll = null;
  preRollIdx = 0;
  preRollFilled = 0;
  vadState = 'idle';
  onsetFrames = 0;
  calibrating = false;
  calibrationSamples = [];
  continuousCallbacks = null;
};

export const isContinuous = () => continuousCtx !== null;

export const getVadLevel = () => lastRmsValue;

// Toggle verbose VAD logging at runtime: window.__portosVadDebug = true
if (typeof window !== 'undefined') {
  Object.defineProperty(window, '__portosVadDebug', {
    configurable: true,
    get: () => VAD.debug,
    set: (v) => { VAD.debug = !!v; },
  });
}

// ─── Web Speech API mode ─────────────────────────────────────────────────
// Browser-native STT via SpeechRecognition. Transcription happens entirely
// in the browser — no whisper.cpp server needed. Final transcripts are sent
// as voice:text (reusing the existing text-input path on the server).

const SpeechRecognition = typeof window !== 'undefined'
  && (window.SpeechRecognition || window.webkitSpeechRecognition);

let webSpeechRecognition = null;
let webSpeechShouldListen = false;
let webSpeechCallbacks = null;
// Chrome fires onend immediately when a mic error, OS permission flicker, or
// driver glitch prevents recognition from ever binding. Blindly calling
// start() from onend in that state hot-loops the CPU. Count consecutive
// restarts that never produced a result and back off.
let webSpeechRestartFailures = 0;
let webSpeechRestartTimer = null;
const WEB_SPEECH_MAX_RESTART_FAILURES = 5;

export const webSpeechSupported = !!SpeechRecognition;

export const startWebSpeechCapture = (callbacks = {}) => {
  if (!SpeechRecognition) return;
  stopWebSpeechCapture();

  // Barge-in: abort any in-flight turn and silence current playback
  socket.emit('voice:interrupt');
  stopPlayback();

  const recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  recognition.onresult = (event) => {
    let interim = '';
    let final = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        final += transcript;
      } else {
        interim += transcript;
      }
    }
    if (interim) callbacks.onInterim?.(interim);
    if (final) {
      callbacks.onInterim?.('');
      callbacks.onFinal?.(final);
      // Any successful result resets the restart-failure counter.
      webSpeechRestartFailures = 0;
      // Send as text — server pipeline skips STT and goes straight to LLM
      sendText(final);
    }
  };

  recognition.onend = () => {
    if (!webSpeechShouldListen) return;
    webSpeechRestartFailures += 1;
    if (webSpeechRestartFailures >= WEB_SPEECH_MAX_RESTART_FAILURES) {
      webSpeechShouldListen = false;
      callbacks.onError?.('restart-loop');
      return;
    }
    // Exponential backoff (50ms → 800ms) so a broken driver doesn't pin the CPU.
    const delay = Math.min(50 * 2 ** (webSpeechRestartFailures - 1), 800);
    clearTimeout(webSpeechRestartTimer);
    webSpeechRestartTimer = setTimeout(() => {
      if (webSpeechShouldListen && webSpeechRecognition === recognition) {
        recognition.start();
      }
    }, delay);
  };

  recognition.onerror = (event) => {
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      webSpeechShouldListen = false;
      callbacks.onError?.(event.error);
    }
    // "no-speech" and "aborted" are expected, ignore them
  };

  webSpeechRecognition = recognition;
  webSpeechShouldListen = true;
  webSpeechCallbacks = callbacks;
  webSpeechRestartFailures = 0;
  recognition.start();
};

export const stopWebSpeechCapture = () => {
  webSpeechShouldListen = false;
  clearTimeout(webSpeechRestartTimer);
  webSpeechRestartTimer = null;
  webSpeechRestartFailures = 0;
  if (webSpeechRecognition) {
    webSpeechRecognition.stop();
    webSpeechRecognition = null;
  }
  webSpeechCallbacks = null;
};

export const isWebSpeechCapturing = () => webSpeechShouldListen;
