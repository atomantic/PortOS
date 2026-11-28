/** Own browser voice playback, output routing, and echo detection. */

import socket from './socket';
import { throwApiError } from './apiCore.js';
import { subscribeVisibility } from '../hooks/useVisibilityEvent.js';
import { resumeAudioContext } from '../lib/audioContext.js';
import { safeReadStorage, safeWriteStorage } from '../lib/safeStorage.js';
import { markVoiceTiming } from './voiceTimingDebug.js';
import { ECHO_WINDOW_MS, MIN_TOKENS_FOR_ECHO_CHECK, MIN_SHARED_TRIGRAMS, tokenize, trigramsOf } from '../../../server/lib/voiceEcho.js';

let audioCtx = null;
let outputGain = null;
let outputAnalyser = null;
let outputAnalyserBuf = null;
let outputFreqBuf = null;

const VOLUME_KEY = 'portos.voice.volume';
const MUTED_KEY = 'portos.voice.muted';
const DEFAULT_VOICE_VOLUME = 0.85;
// Keep echo suppression active after the last chunk while room reverb decays.
const TTS_ECHO_TAIL_MS = 700;

const readStoredVolume = () => {
  const raw = safeReadStorage(VOLUME_KEY);
  if (raw === null) return DEFAULT_VOICE_VOLUME;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : DEFAULT_VOICE_VOLUME;
};

let voiceVolume = readStoredVolume();
let voiceMuted = safeReadStorage(MUTED_KEY) === '1';
const audioPrefsListeners = new Set();

const applyOutputGain = () => {
  if (!outputGain?.gain) return;
  outputGain.gain.value = voiceMuted ? 0 : voiceVolume;
};

const notifyAudioPrefs = () => {
  const snapshot = { volume: voiceVolume, muted: voiceMuted };
  for (const fn of audioPrefsListeners) fn(snapshot);
};

export const getVoiceVolume = () => voiceVolume;

export const setVoiceVolume = (next) => {
  const numeric = Number(next);
  if (!Number.isFinite(numeric)) return voiceVolume;
  const clamped = Math.round(Math.max(0, Math.min(1, numeric)) * 100) / 100;
  if (clamped === voiceVolume) return voiceVolume;
  voiceVolume = clamped;
  safeWriteStorage(VOLUME_KEY, String(clamped));
  applyOutputGain();
  notifyAudioPrefs();
  return voiceVolume;
};

export const isVoiceMuted = () => voiceMuted;

export const setVoiceMuted = (next) => {
  const flag = Boolean(next);
  if (flag === voiceMuted) return voiceMuted;
  voiceMuted = flag;
  safeWriteStorage(MUTED_KEY, flag ? '1' : '0');
  applyOutputGain();
  notifyAudioPrefs();
  return voiceMuted;
};

export const onVoiceAudioPrefs = (handler) => {
  audioPrefsListeners.add(handler);
  handler({ volume: voiceVolume, muted: voiceMuted });
  return () => audioPrefsListeners.delete(handler);
};

// Live RMS amplitude (0..1) of currently-playing assistant TTS output for the
// transceiver signal meter. Returns 0 when idle, muted, or analyser unavailable.
export const getVoiceOutputLevel = () => {
  if (!outputAnalyser || !outputAnalyserBuf || !isTtsActive() || voiceMuted) return 0;
  if (typeof outputAnalyser.getFloatTimeDomainData === 'function') {
    outputAnalyser.getFloatTimeDomainData(outputAnalyserBuf);
    let sum = 0;
    for (let i = 0; i < outputAnalyserBuf.length; i += 1) {
      const sample = outputAnalyserBuf[i];
      sum += sample * sample;
    }
    return Math.min(1, Math.sqrt(sum / outputAnalyserBuf.length) * 2.2);
  }
  return 0;
};

// Live frequency spectrum bins (0..1) of currently-playing assistant TTS output
// for the transceiver LCD visualizer. Returns null when idle, muted, or unavailable.
export const getVoiceOutputSpectrum = (bars = 12) => {
  if (!outputAnalyser || !outputFreqBuf || !isTtsActive() || voiceMuted) return null;
  if (typeof outputAnalyser.getByteFrequencyData !== 'function') return null;
  outputAnalyser.getByteFrequencyData(outputFreqBuf);
  // Focus on the vocal energy band (first ~65% of bins, roughly 0–7 kHz at 22–24 kHz Nyquist).
  const usable = Math.max(bars, Math.floor(outputFreqBuf.length * 0.65));
  const step = usable / bars;
  const out = new Array(bars);
  for (let i = 0; i < bars; i += 1) {
    const start = Math.floor(i * step);
    const end = Math.max(start + 1, Math.floor((i + 1) * step));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += outputFreqBuf[j];
    out[i] = Math.min(1, (sum / ((end - start) * 255)) * 1.45);
  }
  return out;
};

// One owner for shared playback. Server-turn admission is independent of the
// two invalidation lifetimes: cancellation retires decode/queue work AND
// pending synthesis fetches; a new synthetic reply retires only older fetches.
const playback = {
  queue: Promise.resolve(),
  decoding: new Set(),
  animation: null,
  source: null,
  startedAt: 0,
  depth: 0,
  echoTailUntil: 0,
  acceptsServerTurnAudio: true,
  decodeGeneration: 0,
  synthesisGeneration: 0,
};

const ensureOutputGraph = (ctx) => {
  if (outputGain && outputGain._ctx === ctx) return outputGain;
  outputGain = null;
  outputAnalyser = null;
  outputAnalyserBuf = null;
  outputFreqBuf = null;
  if (typeof ctx.createGain !== 'function') return null;
  const gain = ctx.createGain();
  gain._ctx = ctx;
  gain.gain.value = voiceMuted ? 0 : voiceVolume;
  if (typeof ctx.createAnalyser === 'function') {
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.6;
    gain.connect(analyser);
    analyser.connect(ctx.destination);
    outputAnalyser = analyser;
    outputAnalyserBuf = new Float32Array(analyser.fftSize);
    outputFreqBuf = new Uint8Array(analyser.frequencyBinCount);
  } else {
    gain.connect(ctx.destination);
  }
  outputGain = gain;
  return outputGain;
};

const ensureCtx = () => {
  if (!audioCtx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctor();
  }
  ensureOutputGraph(audioCtx);
  // Fire-and-forget so ensureCtx stays sync — TTS playback schedules against the
  // context a beat later. Covers iOS's `'interrupted'`, not just `'suspended'`.
  resumeAudioContext(audioCtx).catch(() => {});
  return audioCtx;
};

// Call synchronously from the user's tap/submit so WebKit can start playback
// before the asynchronous reply arrives. This never opens the microphone.
export function prepareVoicePlayback() {
  if (!window.AudioContext && !window.webkitAudioContext) return;
  try { ensureCtx(); } catch { /* Native audio unavailable; don't block the typed turn. */ }
}

export const cancelVoicePlayback = () => {
  playback.decodeGeneration += 1;
  playback.animation?.stop();
  playback.animation = null;
  playback.decoding.clear();
  if (playback.source) {
    try { playback.source.stop(); } catch { /* already stopped */ }
    playback.source = null;
  }
  playback.queue = Promise.resolve();
  playback.depth = 0;
  playback.echoTailUntil = 0;
  // Any chunks still in-flight from the cancelled turn must not be played —
  // they'll arrive asynchronously after we've torn down local playback.
  playback.acceptsServerTurnAudio = false;
  // Supersede any fast-path synthesized reply whose fetch is still in flight.
  playback.synthesisGeneration += 1;
};

// A transcript reopens server audio without invalidating any pending work.
const beginServerTurnAudio = () => {
  playback.acceptsServerTurnAudio = true;
};

// Client-side replies have no transcript. Reopen admission and supersede older
// synthesis fetches, while preserving already-decoding/queued playback.
const beginSynthesizedReply = () => {
  const generation = ++playback.synthesisGeneration;
  playback.acceptsServerTurnAudio = true;
  return generation;
};

// Only Voice Call registers a visualizer. It gets assistant output WAV, never mic audio.
let outputVisualizer;
/** The Voice Call avatar's renderer, for an output path (the realtime call) that plays its own audio. */
export const getVoiceOutputVisualizer = () => outputVisualizer;

export function bindVoiceOutputVisualizer(prepare) {
  outputVisualizer = prepare;
  return () => { if (outputVisualizer === prepare) outputVisualizer = undefined; };
}

const waitForAvatar = (ready) => new Promise(resolve => {
  const timer = setTimeout(resolve, 750);
  Promise.resolve(ready).finally(() => { clearTimeout(timer); resolve(); }).catch(() => {});
});

async function playDecodedVoice(buffer, bytes, ctx, generation, animate) {
  if (generation !== playback.decodeGeneration) return;
  let animation;
  if (animate && outputVisualizer) {
    try { animation = outputVisualizer(bytes); } catch { /* Avatar never owns the voice transport. */ }
  }
  playback.animation = animation;
  if (animation) await waitForAvatar(animation.ready);
  if (generation !== playback.decodeGeneration) return;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const sink = ensureOutputGraph(ctx) || ctx.destination;
  src.connect(sink);
  playback.source = src;
  playback.startedAt = ctx.currentTime;
  animation?.start(() => ctx.currentTime - playback.startedAt);
  await new Promise((resolve, reject) => {
    src.onended = resolve;
    try { src.start(); } catch (error) { reject(error); }
  }).catch(error => console.warn('[voice] could not start playback:', error));
  animation?.stop();
  if (generation !== playback.decodeGeneration) return;
  playback.animation = null;
  playback.source = null;
  playback.depth -= 1;
  if (playback.depth === 0 && playback.acceptsServerTurnAudio) {
    playback.echoTailUntil = performance.now() + TTS_ECHO_TAIL_MS;
  }
}

const enqueuePlay = (bytes, { animate = false } = {}) => {
  const generation = playback.decodeGeneration;
  const ctx = ensureCtx();
  // decodeAudioData consumes its buffer; preserve the TTS bytes for Voice Call.
  const decoded = ctx.decodeAudioData(bytes.slice(0)).then(buffer => {
    if (generation !== playback.decodeGeneration) return;
    playback.depth += 1;
    playback.queue = playback.queue.then(() => playDecodedVoice(buffer, bytes, ctx, generation, animate));
  });
  playback.decoding.add(decoded);
  return decoded.finally(() => playback.decoding.delete(decoded));
};

export const isTtsActive = () => playback.depth > 0 || playback.source !== null;
export const isInTtsEchoWindow = () => isTtsActive() || performance.now() < playback.echoTailUntil;

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
// server/services/voice/echo.js. Pure helpers are shared via
// server/lib/voiceEcho.js.
const recentTtsSentences = [];

const rememberTtsSentence = (sentence) => {
  const tokens = tokenize(sentence);
  if (!tokens.length) return;
  const now = performance.now();
  while (recentTtsSentences.length && now - recentTtsSentences[0].t > ECHO_WINDOW_MS) {
    recentTtsSentences.shift();
  }
  recentTtsSentences.push({
    text: tokens.join(' '),
    trigrams: new Set(trigramsOf(tokens)),
    t: now,
  });
};

export const looksLikeTtsEcho = (text) => {
  // Headphone setups have no acoustic echo path — the speaker output goes
  // into the user's ears, not the open air around the mic. Bypass the
  // content gate entirely so we never misclassify the user's actual speech.
  if (audioRoute.likelyHeadset) return false;

  const tokens = tokenize(text);
  if (tokens.length < MIN_TOKENS_FOR_ECHO_CHECK) return false;
  const heardText = tokens.join(' ');
  const heardTrigrams = trigramsOf(tokens);
  if (!heardTrigrams.length) return false;
  const now = performance.now();
  for (const entry of recentTtsSentences) {
    if (now - entry.t > ECHO_WINDOW_MS) continue;
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

export const isHeadsetAudioRoute = () => audioRoute.likelyHeadset;

export const detectAudioRoute = async (activeStream) => {
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

const playServerTurnAudio = ({ sentence, wav }) => {
  if (!playback.acceptsServerTurnAudio) return; // stale chunk from a cancelled turn — drop it
  markVoiceTiming(`tts.recv ${sentence?.length ?? 0}c`);
  rememberTtsSentence(sentence);
  const ab = toExactArrayBuffer(wav);
  if (!ab) return;
  enqueuePlay(ab, { animate: true }).catch((err) => console.warn('[voice] playback failed:', err));
};

socket.on('voice:tts:audio', playServerTurnAudio);

// A provider timeout can happen after earlier sentences were already emitted.
// Clear those browser-side frames too, so recovery does not leave the stale
// reply speaking over the next turn.
socket.on('voice:tts:cancel', () => cancelVoicePlayback());

// Proactive CoS speech. Server-pushed lines (alerts/briefings/reminders) come
// in on a separate channel so the client can render a distinct visual cue;
// VoiceWidget decides whether/how to display them (toast + history appending).
// Reuse the same audio playback queue + TTS echo memory as user-initiated
// turns so mic barge-in (voice:interrupt → cancelVoicePlayback) cancels proactive
// audio for free.
//
// Proactive events bypass server-turn admission without reopening it. A
// canceled turn must not silence later reminders while awaiting a transcript.
const proactiveListeners = new Set();
const playProactiveAudio = ({ sentence, wav, priority, source, ts }) => {
  rememberTtsSentence(sentence);
  const ab = toExactArrayBuffer(wav);
  if (!ab) return;
  enqueuePlay(ab).catch((err) => console.warn('[voice] proactive playback failed:', err));
  for (const fn of proactiveListeners) {
    fn({ sentence, priority: priority || 'normal', source: source || 'cos', ts: ts || Date.now() });
  }
};

socket.on('voice:speak', playProactiveAudio);

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
  // Another tab just took over proactive output. Drain any proactive audio
  // still playing/queued here so the handoff is clean — otherwise this tab
  // keeps speaking a briefing while the new primary starts the next one and
  // both talk at once, breaking the single-recipient contract. Cancellation
  // closes server-turn admission; playProactiveAudio bypasses it, so a future
  // proactive line still plays if this tab later reclaims output.
  cancelVoicePlayback();
});
// A disconnect ends this socket's ownership — the server released it and, on
// reconnect, this tab gets a fresh socket with no claim (it only re-announces
// availability, and re-claims only if focused). Clear the flag so the widget
// doesn't keep showing "speaker" while output is routed to another tab. The
// server's voice:output:detached can't reach an already-disconnected socket, so
// this local reset is the only signal.
socket.on('disconnect', () => {
  if (!isVoiceOutputPrimary) return;
  isVoiceOutputPrimary = false;
  notifyVoiceOutputPrimary();
});

// Register this tab as a voice-output candidate, and claim output when it is
// the tab the user is looking at. Only a visible+focused tab claims, so a
// backgrounded tab never steals output from the foreground one. Both emits are
// no-ops while the socket is down.
export const joinVoiceOutput = () => {
  announceVoiceOutputAvailable();
  if (typeof document !== 'undefined'
    && document.visibilityState === 'visible'
    && (document.hasFocus?.() ?? true)) {
    claimVoiceOutput();
  }
};

// Claim on focus / visibility so proactive audio follows the active tab. Reuse
// the shared visibility singleton (one document-level listener for the whole
// app) rather than adding another `visibilitychange` handler. `focus` has no
// shared singleton, so it stays a direct listener. Guard for non-browser
// (test/SSR) contexts.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('focus', claimVoiceOutput);
  subscribeVisibility((state) => { if (state === 'visible') claimVoiceOutput(); });
  // This module loads lazily (the first time voice is on), usually after the
  // socket connected, so the `connect` handler below has already been missed:
  // join now, or the focused tab stays unclaimed until its next focus event
  // and the first reminder can go to whichever tab announced last.
  joinVoiceOutput();
}

// voice:transcript marks the start of a new turn's outputs — any pending
// rejection from a previous cancellation should be lifted now so this turn's
// TTS chunks actually play.
socket.on('voice:transcript', beginServerTurnAudio);

const playPreviewAudio = (arrayBuffer) => enqueuePlay(arrayBuffer);

export const playWav = (arrayBuffer) => playPreviewAudio(arrayBuffer);

// Speak arbitrary text through the server's configured TTS WITHOUT running the
// LLM. Used by the fast-resolution cascade to voice trigger confirmations and
// on-device Nano replies (see voiceFastPath.js). Reuses the same playback queue
// + echo memory as server-streamed TTS, so barge-in (cancelVoicePlayback) and
// echo-suppression keep working exactly as they do for normal turns. Resolves
// once the audio is decoded and queued (not when playback finishes).
export const speakSynthesized = async (text, { engine, voice, rate, signal, animate = false } = {}) => {
  const clean = (text || '').trim();
  if (!clean) return false;
  const gen = beginSynthesizedReply();
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
  if (!res.ok) await throwApiError(res);
  const wav = await res.arrayBuffer();
  // Superseded while the synth was in flight — drop this stale audio rather than
  // playing it over/after the newer turn's reply.
  if (gen !== playback.synthesisGeneration) return false;
  await enqueuePlay(wav, { animate });
  return true;
};

// Resolves once every currently-queued TTS chunk has finished playing locally.
// Used by continuous mode to know when to return from 'speaking' → listening.
export const whenPlaybackDrained = () => playback.queue.then(() => !isTtsActive());

// voice:idle is sent as soon as the server sends its last WAV; that WAV may
// still be decoding before it becomes visible to the normal playback queue.
export async function whenVoiceTurnAudioDrained() {
  await Promise.allSettled([...playback.decoding]);
  return whenPlaybackDrained();
}
