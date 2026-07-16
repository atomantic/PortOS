// Browser-side voice capture + playback. Supports two modes:
//   - Push-to-talk: MediaRecorder, manual start/stop.
//   - Continuous:   AudioWorklet + energy VAD auto-submits on silence,
//                   and fires barge-in (voice:interrupt + stopPlayback) when
//                   the user starts talking over the bot.
// Both emit 'voice:turn' over Socket.IO and play incoming TTS via Web Audio.

import socket from './socket';
import { subscribeVisibility } from '../hooks/useVisibilityEvent.js';

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
// Generation counter for speakSynthesized (fast-path trigger/Nano replies).
// Bumped on every new synthesized reply AND on stopPlayback, so a reply whose
// TTS fetch is still in flight when a newer turn (or a barge-in) supersedes it
// is dropped instead of playing over/after the newer audio.
let synthGen = 0;

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
  // Supersede any fast-path synthesized reply whose fetch is still in flight.
  synthGen += 1;
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
  // Chain .finally() so a decode failure (unsupported codec, corrupt blob)
  // still releases the AudioContext — otherwise repeated failures leak a
  // context per retry.
  const decoded = await decodeCtx.decodeAudioData(bytes).finally(() => {
    decodeCtx.close().catch(() => {});
  });

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

// Ring of recently-spoken TTS sentences (with cached trigrams). Echo
// detection uses two stacked filters:
//   1. Length gate: utterances < MIN_TOKENS_FOR_ECHO_CHECK words bypass the
//      check entirely, so short barge-ins ("wait", "stop", "hold on") still
//      interrupt the bot even if those words appear in TTS.
//   2. Trigram overlap: for longer utterances, require ≥ 2 shared 3-word
//      windows with a recent TTS sentence. Two contiguous 3-word matches
//      are strong evidence — coincidental overlap on common words rarely
//      produces multiple shared trigrams. A clean substring match also
//      counts (handles the case where STT picks up a clean slice of TTS).
//
// This client gate runs only on the Web Speech path where transcripts are
// produced in-browser and sent as voice:text. Whisper-based continuous mode
// sends audio to the server, so its echo gate lives in
// server/services/voice/echo.js — KEEP THE TWO IN SYNC. Both implement the
// same algorithm so tuning one (threshold, window, tokenizer) requires the
// other to match.
const TTS_ECHO_MEMORY_MS = 8000;
const MIN_TOKENS_FOR_ECHO_CHECK = 4;
const MIN_SHARED_TRIGRAMS = 2;
const recentTtsSentences = [];

const tokenizeForEcho = (s) => (s || '')
  .toLowerCase()
  .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  .split(/\s+/)
  .filter(Boolean);

const buildTrigrams = (tokens) => {
  if (tokens.length < 3) return [];
  const out = [];
  for (let i = 0; i + 3 <= tokens.length; i++) {
    out.push(`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`);
  }
  return out;
};

const rememberTtsSentence = (sentence) => {
  const tokens = tokenizeForEcho(sentence);
  if (!tokens.length) return;
  const now = performance.now();
  while (recentTtsSentences.length && now - recentTtsSentences[0].t > TTS_ECHO_MEMORY_MS) {
    recentTtsSentences.shift();
  }
  recentTtsSentences.push({
    text: tokens.join(' '),
    trigrams: new Set(buildTrigrams(tokens)),
    t: now,
  });
};

const looksLikeTtsEcho = (text) => {
  // Headphone setups have no acoustic echo path — the speaker output goes
  // into the user's ears, not the open air around the mic. Bypass the
  // content gate entirely so we never misclassify the user's actual speech.
  if (audioRoute.likelyHeadset) return false;

  const tokens = tokenizeForEcho(text);
  if (tokens.length < MIN_TOKENS_FOR_ECHO_CHECK) return false;
  const heardText = tokens.join(' ');
  const heardTrigrams = buildTrigrams(tokens);
  if (!heardTrigrams.length) return false;
  const now = performance.now();
  for (const entry of recentTtsSentences) {
    if (now - entry.t > TTS_ECHO_MEMORY_MS) continue;
    if (entry.text.includes(heardText)) return true;
    let shared = 0;
    for (const tg of heardTrigrams) {
      if (entry.trigrams.has(tg)) {
        shared += 1;
        if (shared >= MIN_SHARED_TRIGRAMS) return true;
      }
    }
  }
  return false;
};

// ─── Audio route detection (headset vs built-in) ────────────────────────
// Headphones eliminate the speaker-into-mic acoustic path that causes the
// echo loop, so we can relax echo gates when we're confident the user is
// on a headset. Default-tight on uncertainty: a false "headset" detection
// re-opens the loop, while a false "built-in" detection only makes barge-in
// slightly less twitchy.
//
// Strong signal: the active mic shares a `groupId` with an audiooutput
// device AND the device label looks headset-y (AirPods, headset, buds, …).
// `groupId` alone isn't enough — a laptop's built-in mic + built-in speakers
// also share a groupId. Labels alone aren't enough either — a custom-named
// device ("Adam's USB Mic") won't match. Both required → high confidence.

const HEADSET_LABEL_RE = /(headphone|headset|airpods|buds|earphone|in[- ]?ear|jabra|sennheiser|bose|sony wh-|sony wf-)/i;
const BUILTIN_LABEL_RE = /(macbook|built[- ]?in|internal)/i;

const audioRoute = {
  likelyHeadset: false,
  label: null,
  reason: 'not detected',
  checkedAt: 0,
};

const detectAudioRoute = async (activeStream) => {
  if (!navigator.mediaDevices?.enumerateDevices) {
    audioRoute.likelyHeadset = false;
    audioRoute.reason = 'enumerateDevices unsupported';
    return audioRoute;
  }
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  const mics = devices.filter((d) => d.kind === 'audioinput');
  const outs = devices.filter((d) => d.kind === 'audiooutput');
  const settings = activeStream?.getAudioTracks?.()?.[0]?.getSettings?.() || {};
  const activeMic = mics.find((d) => d.deviceId === settings.deviceId)
    || mics.find((d) => d.deviceId === 'default')
    || mics[0];
  if (!activeMic) {
    audioRoute.likelyHeadset = false;
    audioRoute.reason = 'no active mic';
    return audioRoute;
  }
  const sameGroup = activeMic.groupId
    && outs.some((o) => o.groupId === activeMic.groupId);
  const label = activeMic.label || '';
  const headsetByLabel = HEADSET_LABEL_RE.test(label);
  const builtInByLabel = BUILTIN_LABEL_RE.test(label);
  // Require BOTH groupId match AND headset-y label, AND not explicitly a
  // built-in device. This is the conservative configuration.
  audioRoute.likelyHeadset = !!(sameGroup && headsetByLabel && !builtInByLabel);
  audioRoute.label = label;
  audioRoute.reason = audioRoute.likelyHeadset
    ? 'groupId+label match'
    : `sameGroup=${!!sameGroup} headsetByLabel=${headsetByLabel} builtInByLabel=${builtInByLabel}`;
  audioRoute.checkedAt = performance.now();
  console.log(`🎧 [voice] audio route: ${audioRoute.likelyHeadset ? 'headset' : 'open-air'} (${audioRoute.reason}) label="${label}"`);
  return audioRoute;
};

// Re-detect when the user plugs/unplugs hardware mid-session. Without this,
// disconnecting headphones leaves us in "headset" mode and the loop returns.
if (typeof navigator !== 'undefined' && navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', () => {
    // We don't have an active stream reference here, so re-detect against
    // whatever device the next getUserMedia() picks. Until then, be safe
    // and assume open-air.
    audioRoute.likelyHeadset = false;
    audioRoute.reason = 'devicechange — pending re-detect';
  });
}

// Live introspection from the browser console: `window.__portosAudioRoute`.
// Mirrors the existing `__portosVadDebug` pattern so both diagnostics live
// at the same handle.
if (typeof window !== 'undefined') {
  Object.defineProperty(window, '__portosAudioRoute', {
    configurable: true,
    get: () => ({ ...audioRoute }),
  });
}

// socket.io may deliver a plain ArrayBuffer, a sliced TypedArray/DataView,
// or a serialized Buffer-like { type: 'Buffer', data: [...] }. Using the raw
// `wav.buffer` for a sliced view would pass extra bytes to decodeAudioData,
// causing intermittent decode failures; always hand off an exact slice.
const toExactArrayBuffer = (wav) => {
  if (wav instanceof ArrayBuffer) return wav;
  if (ArrayBuffer.isView(wav)) {
    return wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength);
  }
  if (wav?.type === 'Buffer' && Array.isArray(wav.data)) {
    return new Uint8Array(wav.data).buffer;
  }
  return null;
};

socket.on('voice:tts:audio', ({ sentence, wav }) => {
  if (rejectingTts) return; // stale chunk from a cancelled turn — drop it
  rememberTtsSentence(sentence);
  const ab = toExactArrayBuffer(wav);
  if (!ab) return;
  enqueuePlay(ab).catch((err) => console.warn('[voice] playback failed:', err));
});

// Proactive CoS speech. Server-pushed lines (alerts/briefings/reminders) come
// in on a separate channel so the client can render a distinct visual cue;
// VoiceWidget decides whether/how to display them (toast + history appending).
// Reuse the same audio playback queue + TTS echo memory as user-initiated
// turns so mic barge-in (voice:interrupt → stopPlayback) cancels proactive
// audio for free.
//
// NOTE: deliberately NOT gated by `rejectingTts`. That flag suppresses stale
// chunks from a CANCELLED turn (it stays sticky after stopPlayback() until the
// next voice:transcript), but a proactive alert is its own event — gating it
// would silently drop reminders/briefings whenever the user had recently
// interrupted a turn, which is exactly when proactive nudges are most useful.
const proactiveListeners = new Set();
socket.on('voice:speak', ({ sentence, wav, priority, source, ts }) => {
  rememberTtsSentence(sentence);
  const ab = toExactArrayBuffer(wav);
  if (!ab) return;
  enqueuePlay(ab).catch((err) => console.warn('[voice] proactive playback failed:', err));
  for (const fn of proactiveListeners) {
    fn({ sentence, priority: priority || 'normal', source: source || 'cos', ts: ts || Date.now() });
  }
});

// Subscribe to proactive-speech UI events. Returns an unsubscribe function.
// The CoS speech audio plays unconditionally (it's the whole point), but
// surfaces (toast, pill, conversation pane) decide independently whether to
// render a visual hint.
export const onProactiveSpeech = (handler) => {
  proactiveListeners.add(handler);
  return () => proactiveListeners.delete(handler);
};

// ─── Voice-output ownership (single-recipient proactive speech) ────────────
// Proactive server-pushed lines (voice:speak) must play on exactly ONE tab —
// otherwise every open tab and every federated machine speaks the same reminder
// at once. The server routes voice:speak to a single designated "primary" tab;
// the tab the user is actively looking at claims that role. We claim on focus,
// on becoming visible, and on (re)connect while visible — so audio follows the
// user's attention — and expose an explicit claim() for a "speak on this tab"
// button. The server confirms ownership with voice:output:primary and tells the
// displaced tab via voice:output:detached.
let isVoiceOutputPrimary = false;
const voiceOutputPrimaryListeners = new Set();

const notifyVoiceOutputPrimary = () => {
  for (const fn of voiceOutputPrimaryListeners) fn(isVoiceOutputPrimary);
};

export const claimVoiceOutput = () => {
  if (socket.connected) socket.emit('voice:output:claim');
};

// Announce this browser tab as a voice-output surface so the server registers
// it as a proactive-audio candidate. Sent unconditionally (even for a
// backgrounded, never-focused tab) so audio still has a home when no tab has
// claimed — but ONLY real browser tabs load this module, so non-playing sockets
// (e.g. a federated peer's Socket.IO relay) never announce and can't be elected.
const announceVoiceOutputAvailable = () => {
  if (socket.connected) socket.emit('voice:output:available');
};

// Subscribe to voice-output ownership changes. Fires immediately with the
// current value so a late subscriber (widget mount) reflects state without
// waiting for the next handoff. Returns an unsubscribe function.
export const onVoiceOutputPrimary = (handler) => {
  voiceOutputPrimaryListeners.add(handler);
  handler(isVoiceOutputPrimary);
  return () => voiceOutputPrimaryListeners.delete(handler);
};

socket.on('voice:output:primary', () => {
  if (isVoiceOutputPrimary) return;
  isVoiceOutputPrimary = true;
  notifyVoiceOutputPrimary();
});
socket.on('voice:output:detached', () => {
  if (!isVoiceOutputPrimary) return;
  isVoiceOutputPrimary = false;
  notifyVoiceOutputPrimary();
});

// Claim on focus / visibility so proactive audio follows the active tab. Reuse
// the shared visibility singleton (one document-level listener for the whole
// app) rather than adding another `visibilitychange` handler. `focus` has no
// shared singleton, so it stays a direct listener. Guard for non-browser
// (test/SSR) contexts.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('focus', claimVoiceOutput);
  subscribeVisibility((state) => { if (state === 'visible') claimVoiceOutput(); });
  // The socket may already be connected by the time this module loads; the
  // connect handler below re-announces on every (re)connect.
  announceVoiceOutputAvailable();
}

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
  // Run after permission is granted — `enumerateDevices` only returns
  // device labels post-grant, and the headset heuristic relies on labels.
  detectAudioRoute(stream).catch(() => {});
  const mimeType = pickMime();
  chunks = [];
  recorder = new MediaRecorder(stream, { mimeType });
  recorder.addEventListener('dataavailable', (e) => { if (e.data.size > 0) chunks.push(e.data); });
  recorder.start(250);
  return { mimeType };
};

export const stopCapture = async ({ submit = true } = {}) => {
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
  // Mode-switch cancellation (e.g. user toggled hands-free mid-utterance):
  // drop the buffered audio instead of submitting a partial sentence.
  if (!submit) return null;
  if (blob.size < 800) return null; // discard sub-25ms empty recordings

  const { wav, peak } = await blobToWav16k(blob);
  socket.emit('voice:turn', { audio: wav, mimeType: 'audio/wav' });
  return { mimeType: 'audio/wav', size: wav.byteLength, sourceSize: blob.size, peak };
};

export const sendText = (text, source = 'text') => {
  const trimmed = (text || '').trim();
  if (!trimmed) return;
  stopPlayback();
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
  // Re-register as a voice-output candidate on every (re)connect — a fresh
  // socket has no server-side candidacy until this tab announces again.
  announceVoiceOutputAvailable();
  // On (re)connect, re-claim voice output if this tab is the one the user is
  // looking at — otherwise a reconnect could leave audio pointed at a stale
  // primary. Only a visible+focused tab claims so a backgrounded reconnect
  // doesn't steal output from the foreground tab.
  if (typeof document !== 'undefined'
    && document.visibilityState === 'visible'
    && (document.hasFocus?.() ?? true)) {
    claimVoiceOutput();
  }
});

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

// Persistent, user-authorized screen-capture stream for the voice agent's
// ui_describe_visually tool. getDisplayMedia is the only browser-native way to
// grab WebGL/canvas content (CyberCity, charts) without a heavy DOM-to-canvas
// dependency — but browsers REQUIRE a transient user gesture to call it, and the
// screenshot request is server-initiated (mid voice turn), not a click. So the
// user authorizes a capture stream ONCE via a click (enableVisionCapture, which
// the VoiceWidget wires to a button), we keep that stream alive, and
// captureScreenForVision grabs a frame from it on demand without re-prompting.
let visionStream = null;
// Optional callback invoked whenever the authorized stream ends — either via
// disableVisionCapture() or because the user clicked "Stop sharing" in the
// browser's own chrome (track 'ended'). Lets the UI sync its toggle state
// instead of going stale until the next screenshot request.
let onVisionEndedCb = null;

const clearVisionStream = ({ notify = true } = {}) => {
  const stream = visionStream;
  // Null the global BEFORE stopping tracks: t.stop() synchronously fires the
  // track 'ended' handler, and that handler no-ops unless `visionStream === its
  // own stream` — so clearing first keeps a caller-initiated stop (notify:false)
  // from re-entering via the 'ended' path and firing onVisionCaptureEnded.
  visionStream = null;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  if (notify && typeof onVisionEndedCb === 'function') onVisionEndedCb();
};

// True when a live, user-authorized capture stream is available to grab frames.
export const isVisionCaptureEnabled = () => !!(visionStream && visionStream.active);

// Register a callback fired when the capture stream ends (user stops sharing via
// the browser, or disableVisionCapture runs). Pass null to clear. Returns an
// unsubscribe fn for symmetry with the other subscribe helpers.
export const onVisionCaptureEnded = (cb) => {
  onVisionEndedCb = typeof cb === 'function' ? cb : null;
  return () => { onVisionEndedCb = null; };
};

// Authorize a screen-capture stream. MUST be called from within a user gesture
// (a click handler) — getDisplayMedia rejects outside transient activation,
// which is exactly why the server-initiated screenshot path can't call it.
// Returns true once a live stream is authorized. The stream self-clears when the
// user stops sharing via the browser's own chrome (track 'ended') so the next
// enable re-prompts instead of grabbing a dead track.
export const enableVisionCapture = async () => {
  if (!navigator.mediaDevices?.getDisplayMedia) return false;
  if (isVisionCaptureEnabled()) return true;
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: 'browser' },
    audio: false,
  }).catch(() => null);
  if (!stream) return false;
  visionStream = stream;
  // User-stopped (browser chrome) → clear + notify the UI so the toggle flips.
  // Guard on `visionStream === stream` so a late 'ended' from a SUPERSEDED
  // stream (quick disable→re-enable) can't tear down the newer capture session.
  stream.getVideoTracks().forEach((t) => t.addEventListener('ended', () => {
    if (visionStream === stream) clearVisionStream();
  }, { once: true }));
  return true;
};

// Stop and release the authorized capture stream (widget teardown / user
// toggle-off). Caller-initiated, so it does NOT fire onVisionCaptureEnded — the
// caller already owns the state change (and on unmount the cb is gone).
export const disableVisionCapture = () => clearVisionStream({ notify: false });

// Grab one frame from the authorized vision stream as a JPEG data URL. Returns
// null when no stream is authorized yet (the caller prompts the user to enable
// it) or on any frame-grab failure, so ui_describe_visually degrades to a clear
// "I can't see your screen" rather than crashing.
export const captureScreenForVision = async () => {
  if (typeof document === 'undefined' || !isVisionCaptureEnabled()) return null;
  const video = document.createElement('video');
  video.srcObject = visionStream;
  video.muted = true;
  const playing = await video.play().then(() => true).catch(() => false);
  if (!playing) return null;
  // One frame is enough; give the decoder a tick to paint dimensions.
  await new Promise((resolve) => setTimeout(resolve, 120));
  const w = video.videoWidth || 1280;
  const h = video.videoHeight || 720;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const cctx = canvas.getContext('2d');
  video.pause();
  if (!cctx) return null;
  cctx.drawImage(video, 0, 0, w, h);
  // JPEG @ 0.8 keeps the payload well under the server's 16 MB cap even at 4K.
  return canvas.toDataURL('image/jpeg', 0.8);
};

// Reply to a server voice:screenshot:request. Always emits a result (data URL
// or null) so the server-side waiter resolves instead of timing out. Echo the
// requestId so the server resolves the matching waiter and a late reply can't
// satisfy a newer capture.
export const sendScreenshotResult = (requestId, dataUrl) => {
  socket.emit('voice:screenshot:result', { requestId, dataUrl: dataUrl || null });
};

export const playWav = (arrayBuffer) => enqueuePlay(arrayBuffer);

// Speak arbitrary text through the server's configured TTS WITHOUT running the
// LLM. Used by the fast-resolution cascade to voice trigger confirmations and
// on-device Nano replies (see voiceFastPath.js). Reuses the same playback queue
// + echo memory as server-streamed TTS, so barge-in (stopPlayback) and
// echo-suppression keep working exactly as they do for normal turns. Resolves
// once the audio is decoded and queued (not when playback finishes).
export const speakSynthesized = async (text, { engine, voice, rate, signal } = {}) => {
  const clean = (text || '').trim();
  if (!clean) return false;
  // Claim this generation; a newer reply or a stopPlayback/barge-in bumps
  // synthGen and supersedes us (checked after the fetch).
  const gen = ++synthGen;
  // We're starting a fresh reply — lift any sticky rejection left by a prior
  // barge-in (normally cleared by voice:transcript, which a client-side turn
  // never emits), then remember the sentence so the next inbound STT result
  // that echoes it back through the mic is suppressed.
  rejectingTts = false;
  rememberTtsSentence(clean);
  const body = { text: clean };
  if (engine) body.engine = engine;
  if (voice) body.voice = voice;
  if (typeof rate === 'number') body.rate = rate;
  const res = await fetch('/api/voice/public/synthesize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`synthesize failed: ${res.status}`);
  const wav = await res.arrayBuffer();
  // Superseded while the synth was in flight — drop this stale audio rather than
  // playing it over/after the newer turn's reply.
  if (gen !== synthGen) return false;
  await enqueuePlay(wav);
  return true;
};

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
  ttsTailMs: 700,        // echo-tail window: keep bargeInMul active for this
                         // long after the last TTS chunk ends to ignore
                         // room reverb. 300ms was too short for typical
                         // rooms — the bot's final syllable kept trailing
                         // back through the mic and getting transcribed.
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
    console.log(`[vad] state=${vadState} rms=${rms.toFixed(4)} on=${onRms.toFixed(4)} off=${offRms.toFixed(4)} tts=${isTtsActive()}`);
  }

  if (vadState === 'idle') {
    // Raise the bar while TTS plays AND during the echo tail so neither the
    // bot's live audio nor reverb through the mic trigger a false barge-in.
    // Skip the bump entirely on a confirmed headset — there's no acoustic
    // path from speaker to mic, so the user can interrupt at normal volume.
    const inEcho = isInTtsEchoWindow() && !audioRoute.likelyHeadset;
    const effectiveOnRms = inEcho ? onRms * VAD.bargeInMul : onRms;
    const effectiveConfirmMs = inEcho ? VAD.bargeInOnsetConfirmMs : VAD.onsetConfirmMs;
    if (rms > effectiveOnRms) {
      onsetFrames += 1;
      const frameMs = (frame.length / (continuousCtx?.sampleRate || 48000)) * 1000;
      if (onsetFrames * frameMs >= effectiveConfirmMs) {
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
  detectAudioRoute(continuousStream).catch(() => {});

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
// Chrome fires onend immediately when a mic error, OS permission flicker, or
// driver glitch prevents recognition from ever binding. Blindly calling
// start() from onend in that state hot-loops the CPU. Count consecutive
// restarts that never produced a result and back off.
let webSpeechRestartFailures = 0;
let webSpeechRestartTimer = null;
const WEB_SPEECH_MAX_RESTART_FAILURES = 5;

export const webSpeechSupported = !!SpeechRecognition;

// BCP-47 tag that SpeechRecognition expects. Short codes like 'en' → 'en-US',
// 'es' → 'es-ES', 'fr' → 'fr-FR'. Anything already region-tagged or unknown
// passes through; finally fall back to navigator.language then en-US.
const SHORT_LANG_TO_BCP47 = { en: 'en-US', es: 'es-ES', fr: 'fr-FR', de: 'de-DE', it: 'it-IT', pt: 'pt-BR', ja: 'ja-JP', ko: 'ko-KR', zh: 'zh-CN' };
const resolveRecognitionLang = (configured) => {
  const raw = (configured || '').trim();
  if (raw.includes('-')) return raw;
  if (raw && SHORT_LANG_TO_BCP47[raw.toLowerCase()]) return SHORT_LANG_TO_BCP47[raw.toLowerCase()];
  if (typeof navigator !== 'undefined' && navigator.language) return navigator.language;
  return 'en-US';
};

export const startWebSpeechCapture = ({ language, ...callbacks } = {}) => {
  if (!SpeechRecognition) return;
  stopWebSpeechCapture();

  // Barge-in: abort any in-flight turn and silence current playback
  socket.emit('voice:interrupt');
  stopPlayback();

  const recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  // Honor cfg.stt.language (threaded in by VoiceWidget) so a user on a
  // non-English locale doesn't silently get US English STT.
  recognition.lang = resolveRecognitionLang(language);

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
      webSpeechRestartFailures = 0;
      // Drop finals that are the bot's own TTS echoed back through the mic.
      // Two gates: (1) TTS is currently playing or within the echo tail, or
      // (2) the text is a substring of a recently-spoken sentence. The
      // content gate catches late echoes that sneak past the time window.
      const ttsActive = isInTtsEchoWindow();
      if (ttsActive || looksLikeTtsEcho(final)) {
        console.warn(`🔇 [voice] dropping TTS echo "${final.trim()}" (ttsActive=${ttsActive})`);
        return;
      }
      callbacks.onFinal?.(final);
      // Fast-resolution cascade: when the caller supplies routeFinal it OWNS
      // this turn (triage through trigger/Nano/server itself). Otherwise fall
      // back to the default — send straight to the server pipeline.
      // source='voice' so the server still treats this as a spoken utterance
      // for dictation-mode routing — the text path otherwise bypasses it.
      if (typeof callbacks.routeFinal === 'function') callbacks.routeFinal(final);
      else sendText(final, 'voice');
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
};

export const isWebSpeechCapturing = () => webSpeechShouldListen;
