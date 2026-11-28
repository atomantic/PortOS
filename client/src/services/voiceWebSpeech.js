/** Manage browser-native speech recognition and forward final transcripts or route them locally. */

import socket from './socket';
import { acquireAudioSession } from '../lib/audioContext.js';
import { cancelVoicePlayback, isInTtsEchoWindow, looksLikeTtsEcho } from './voicePlayback.js';

// ─── Web Speech API mode ─────────────────────────────────────────────────
// Browser-native STT via SpeechRecognition. Transcription happens entirely
// in the browser — no whisper.cpp server needed. Final transcripts are sent
// as voice:text (reusing the existing text-input path on the server).

const SpeechRecognition = typeof window !== 'undefined'
  && (window.SpeechRecognition || window.webkitSpeechRecognition);

let releaseWebSpeechSession = null;
let webSpeechRecognition = null;
let webSpeechShouldListen = false;
let webSpeechGeneration = 0;
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

export const startWebSpeechCapture = ({ language, ...callbacks } = {}, getCaptureOwnerGuard, sendText) => {
  if (!SpeechRecognition) return;
  stopWebSpeechCapture();
  const isOwnerCurrent = getCaptureOwnerGuard();
  const generation = ++webSpeechGeneration;

  // Barge-in: abort any in-flight turn and silence current playback
  socket.emit('voice:interrupt');
  cancelVoicePlayback();

  const recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  // Honor cfg.stt.language (threaded in by VoiceWidget) so a user on a
  // non-English locale doesn't silently get US English STT.
  recognition.lang = resolveRecognitionLang(language);

  recognition.onresult = (event) => {
    if (!isOwnerCurrent() || webSpeechGeneration !== generation || webSpeechRecognition !== recognition) return;
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
    if (!webSpeechShouldListen
      || !isOwnerCurrent()
      || webSpeechGeneration !== generation
      || webSpeechRecognition !== recognition) return;
    webSpeechRestartFailures += 1;
    if (webSpeechRestartFailures >= WEB_SPEECH_MAX_RESTART_FAILURES) {
      // Full teardown, not a bare flag flip: every caller-side cleanup is gated
      // on isWebSpeechCapturing(), so clearing the flag without releasing the
      // audio-session claim strands it — pinning the document to
      // 'play-and-record' for the rest of the page session, which outranks the
      // 'playback' claim a SongBook play-along needs to beat the silent switch.
      stopWebSpeechCapture();
      callbacks.onError?.('restart-loop');
      return;
    }
    // Exponential backoff (50ms → 800ms) so a broken driver doesn't pin the CPU.
    const delay = Math.min(50 * 2 ** (webSpeechRestartFailures - 1), 800);
    clearTimeout(webSpeechRestartTimer);
    webSpeechRestartTimer = setTimeout(() => {
      if (webSpeechShouldListen
        && isOwnerCurrent()
        && webSpeechGeneration === generation
        && webSpeechRecognition === recognition) {
        recognition.start();
      }
    }, delay);
  };

  recognition.onerror = (event) => {
    if (!isOwnerCurrent() || webSpeechGeneration !== generation || webSpeechRecognition !== recognition) return;
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      // Same reason as onend's restart-cap branch: release the claim here or a
      // denied mic leaves the session pinned record-capable forever.
      stopWebSpeechCapture();
      callbacks.onError?.(event.error);
    }
    // "no-speech" and "aborted" are expected, ignore them
  };

  webSpeechRecognition = recognition;
  webSpeechShouldListen = true;
  webSpeechRestartFailures = 0;
  // The recognizer opens the mic itself — no getUserMedia here to hang a claim
  // off — so it needs the same record-capable session the other two capture
  // paths take, or an output-only session held by a play-along gets its request
  // refused. Held for the whole recognition lifetime, including the auto-restart
  // cycles, since those re-open the mic too.
  releaseWebSpeechSession?.();
  releaseWebSpeechSession = acquireAudioSession('play-and-record');
  recognition.start();
};

export const stopWebSpeechCapture = () => {
  webSpeechGeneration += 1;
  webSpeechShouldListen = false;
  clearTimeout(webSpeechRestartTimer);
  webSpeechRestartTimer = null;
  webSpeechRestartFailures = 0;
  if (webSpeechRecognition) {
    try { webSpeechRecognition.stop(); } catch { /* already stopped */ }
    webSpeechRecognition = null;
  }
  releaseWebSpeechSession?.();
  releaseWebSpeechSession = null;
};

export const isWebSpeechCapturing = () => webSpeechShouldListen;

export function disposeWebSpeechCapture() {
  const recognition = webSpeechRecognition;
  webSpeechRecognition = null;
  webSpeechGeneration += 1;
  webSpeechShouldListen = false;
  clearTimeout(webSpeechRestartTimer);
  webSpeechRestartTimer = null;
  try { recognition?.stop(); } catch { /* already stopped */ }
  releaseWebSpeechSession?.();
  releaseWebSpeechSession = null;
}
