/** Coordinate push-to-talk, capture lifetimes, and the browser voice client interface. */

import socket from './socket';
import { acquireAudioSession } from '../lib/audioContext.js';
import { blobToWav16k, MAX_VOICE_AUDIO_BYTES, RECORDING_TOO_LONG_MESSAGE } from '../lib/audioRecorder.js';
import { cancelVoicePlayback, detectAudioRoute, joinVoiceOutput } from './voicePlayback.js';
import { disposeContinuousCapture, startContinuous as startContinuousVad } from './voiceContinuousVad.js';
import { disposeWebSpeechCapture, startWebSpeechCapture as startSpeechRecognition } from './voiceWebSpeech.js';
import { invalidateVisionCapture } from './voiceVision.js';

export {
  getVoiceVolume,
  setVoiceVolume,
  isVoiceMuted,
  setVoiceMuted,
  onVoiceAudioPrefs,
  getVoiceOutputLevel,
  prepareVoicePlayback,
  bindVoiceOutputVisualizer,
  onProactiveSpeech,
  claimVoiceOutput,
  onVoiceOutputPrimary,
  playWav,
  speakSynthesized,
  whenPlaybackDrained,
  whenVoiceTurnAudioDrained
} from './voicePlayback.js';
export {
  stopContinuous,
  isContinuous,
  getVadLevel
} from './voiceContinuousVad.js';
export {
  webSpeechSupported,
  stopWebSpeechCapture,
  isWebSpeechCapturing
} from './voiceWebSpeech.js';
export {
  isVisionCaptureEnabled,
  onVisionCaptureEnded,
  enableVisionCapture,
  disableVisionCapture,
  captureScreenForVision,
  sendScreenshotResult
} from './voiceVision.js';

// iOS audio-session claims held while a mic stream is open — one per capture
// mode, because push-to-talk and hands-free listening can overlap. `getUserMedia`
// is refused under the output-only `playback` session a play-along holds (the
// VoiceWidget is mounted on EVERY page, so that overlap is routine on the
// SongBook drum pages); claiming `play-and-record` wins the arbiter and keeps
// both working — that session ignores the ring/silent switch too, so whatever is
// playing stays audible. See the audio-session note in lib/audioContext.js.
let releaseCaptureSession = null;

let stream = null;
let recorder = null;
let chunks = [];
let recorderGeneration = 0;
let recorderStartPendingGeneration = null;
let recorderSessionGeneration = null;

// Capture engines are module-level because the widget can be hidden and shown
// without recreating the browser resources. The widget itself is not immortal:
// navigation can unmount it while a permission request, recorder event, VAD
// conversion, or Web Speech restart is still pending. A new owner generation
// makes those late continuations inert before the old owner starts teardown.
let captureOwnerGeneration = 0;

const isOwnerCurrent = (generation) => generation === captureOwnerGeneration;

const getCaptureOwnerGuard = () => {
  const generation = captureOwnerGeneration;
  return () => isOwnerCurrent(generation);
};

const pickMime = () => {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  for (const m of candidates) {
    if (window.MediaRecorder && window.MediaRecorder.isTypeSupported?.(m)) return m;
  }
  return 'audio/webm';
};

export const startCapture = async () => {
  if (recorder || recorderStartPendingGeneration !== null) return;
  const ownerGeneration = captureOwnerGeneration;
  const generation = ++recorderGeneration;
  recorderStartPendingGeneration = generation;
  // Barge-in: abort any in-flight turn and silence current playback
  socket.emit('voice:interrupt');
  cancelVoicePlayback();

  // Claimed BEFORE getUserMedia — an output-only session already in force would
  // refuse the request outright.
  releaseCaptureSession?.();
  const sessionRelease = acquireAudioSession('play-and-record');
  releaseCaptureSession = sessionRelease;
  recorderSessionGeneration = generation;

  // autoGainControl is critical — without it, quiet mics record near-silent audio
  // that whisper transcribes as [BLANK_AUDIO].
  const nextStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  }).catch((err) => {
    // A denied/failed mic never reaches stopCapture (`recorder` is still null),
    // so the claim is handed back here or it pins the document record-capable
    // for the rest of the session.
    if (recorderSessionGeneration === generation) {
      sessionRelease();
      releaseCaptureSession = null;
      recorderSessionGeneration = null;
    }
    if (recorderStartPendingGeneration === generation) recorderStartPendingGeneration = null;
    throw err;
  });
  if (!isOwnerCurrent(ownerGeneration) || recorderGeneration !== generation) {
    nextStream.getTracks().forEach((track) => track.stop());
    if (recorderSessionGeneration === generation) {
      sessionRelease();
      releaseCaptureSession = null;
      recorderSessionGeneration = null;
    }
    if (recorderStartPendingGeneration === generation) recorderStartPendingGeneration = null;
    return null;
  }
  stream = nextStream;
  // Run after permission is granted — `enumerateDevices` only returns
  // device labels post-grant, and the headset heuristic relies on labels.
  detectAudioRoute(stream).catch(() => {});
  const mimeType = pickMime();
  const recordedChunks = [];
  chunks = recordedChunks;
  const nextRecorder = new MediaRecorder(stream, { mimeType });
  recorder = nextRecorder;
  recorderStartPendingGeneration = null;
  nextRecorder.addEventListener('dataavailable', (e) => {
    if (isOwnerCurrent(ownerGeneration) && recorderGeneration === generation && e.data.size > 0) {
      recordedChunks.push(e.data);
    }
  });
  nextRecorder.start(250);
  return { mimeType };
};

export const stopCapture = async ({ submit = true } = {}) => {
  const ownerGeneration = captureOwnerGeneration;
  const generation = recorderGeneration;
  const rec = recorder;
  const capturedStream = stream;
  const recordedChunks = chunks;
  if (!rec) {
    if (recorderStartPendingGeneration === generation) recorderStartPendingGeneration = null;
    recorderGeneration += 1;
    chunks = [];
    capturedStream?.getTracks().forEach((track) => track.stop());
    stream = null;
    if (recorderSessionGeneration === generation) {
      releaseCaptureSession?.();
      releaseCaptureSession = null;
      recorderSessionGeneration = null;
    }
    return null;
  }
  recorder = null;
  recorderStartPendingGeneration = null;
  chunks = [];
  // Stop the tracks before awaiting MediaRecorder's final event. Navigation
  // teardown must release the microphone even if a browser delays that event.
  capturedStream?.getTracks().forEach((track) => track.stop());
  stream = null;
  if (recorderSessionGeneration === generation) {
    releaseCaptureSession?.();
    releaseCaptureSession = null;
    recorderSessionGeneration = null;
  }

  await new Promise((resolve) => {
    rec.addEventListener('stop', resolve, { once: true });
    rec.stop();
  });
  if (recorderGeneration === generation) recorderGeneration += 1;
  const stoppedGeneration = recorderGeneration;
  if (!isOwnerCurrent(ownerGeneration) || stoppedGeneration !== generation + 1) return null;

  const blob = new Blob(recordedChunks, { type: rec.mimeType });
  // Mode-switch cancellation (e.g. user toggled hands-free mid-utterance):
  // drop the buffered audio instead of submitting a partial sentence.
  if (!submit) return null;
  if (blob.size < 800) return null; // discard sub-25ms empty recordings

  const { wav, peak } = await blobToWav16k(blob);
  if (!isOwnerCurrent(ownerGeneration) || recorderGeneration !== stoppedGeneration) return null;
  if (wav.byteLength > MAX_VOICE_AUDIO_BYTES) {
    refuseLongRecording();
    return null;
  }
  socket.emit('voice:turn', { audio: wav, mimeType: 'audio/wav' });
  return { mimeType: 'audio/wav', size: wav.byteLength, sourceSize: blob.size, peak };
};

export const sendText = (text, source = 'text') => {
  const trimmed = (text || '').trim();
  if (!trimmed) return;
  cancelVoicePlayback();
  socket.emit('voice:text', { text: trimmed, source });
};

// Last requested dictation state — used to re-sync the server on socket
// reconnect. Without this, a brief network blip silently flips the server's
// per-connection dictation state back to false while the UI still shows
// "Dictating" — every utterance after the reconnect would be routed to the
// LLM (Conversation panel) instead of appended to the Daily Log.
let lastDictationRequest = { enabled: false, date: null };

export const setDictation = (enabled, date) => {
  lastDictationRequest = { enabled: !!enabled, date: date || null };
  socket.emit('voice:dictation:set', lastDictationRequest);
};

// On every (re)connect, push the latest dictation request back to the server
// so its fresh per-socket state matches the UI. The 'connect' event fires for
// both the initial connection (no-op since enabled=false by default) and
// every reconnect — both are safe to handle the same way.
socket.on('connect', () => {
  if (lastDictationRequest.enabled) {
    socket.emit('voice:dictation:set', lastDictationRequest);
  }
  // A fresh socket has no server-side candidacy until this tab announces
  // again, and a reconnect could otherwise leave audio pointed at a stale
  // primary.
  joinVoiceOutput();
});

export const interrupt = () => {
  socket.emit('voice:interrupt');
  cancelVoicePlayback();
};

export const resetConversation = () => {
  socket.emit('voice:reset');
  cancelVoicePlayback();
};

export const isCapturing = () => recorder !== null;

const localVoiceErrorHandlers = new Set();
const refuseLongRecording = () => {
  for (const handler of localVoiceErrorHandlers) handler({ stage: 'turn', message: RECORDING_TOO_LONG_MESSAGE });
};

/**
 * Subscribe to voice events. Returns an unsubscribe function.
 * Events: voice:transcript, voice:llm:loading, voice:llm:delta, voice:llm:done, voice:error, voice:idle
 */
export const onVoiceEvent = (event, handler) => {
  socket.on(event, handler);
  if (event === 'voice:error') localVoiceErrorHandlers.add(handler);
  return () => {
    socket.off(event, handler);
    if (event === 'voice:error') localVoiceErrorHandlers.delete(handler);
  };
};

export const startContinuous = (callbacks = {}) => (
  startContinuousVad(callbacks, getCaptureOwnerGuard, refuseLongRecording)
);

export const startWebSpeechCapture = (options = {}) => (
  startSpeechRecognition(options, getCaptureOwnerGuard, sendText)
);

/**
 * Invalidate the widget that currently owns capture before its React cleanup
 * awaits the normal cancel path. This is intentionally synchronous: a late
 * permission result, recorder event, VAD conversion, or Web Speech restart
 * must be unable to emit a turn or call a dead widget during that gap.
 */
export const disposeCaptureOwner = () => {
  captureOwnerGeneration += 1;
  invalidateVisionCapture();

  const activeRecorder = recorder;
  recorder = null;
  recorderGeneration += 1;
  recorderStartPendingGeneration = null;
  chunks = [];
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  releaseCaptureSession?.();
  releaseCaptureSession = null;
  recorderSessionGeneration = null;
  try { activeRecorder?.stop(); } catch { /* already stopped */ }

  disposeContinuousCapture();
  disposeWebSpeechCapture();
};
