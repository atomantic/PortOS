// Browser audio recording → 16 kHz mono WAV → base64, for one-shot memo
// capture (catalog voice ingest). whisper.cpp accepts WAV only, so we decode
// whatever MediaRecorder produced and resample to 16 kHz mono before encoding.
//
// This is deliberately NOT coupled to services/voiceClient.js — that module's
// recorder is wired to the live voice-agent socket pipeline (echo gating, VAD,
// streaming TTS). This is a standalone "record a clip, get a WAV" helper.

import { resumeAudioContext, acquireAudioSession } from './audioContext.js';

const TARGET_SAMPLE_RATE = 16000;

// Pick a MediaRecorder mime the browser supports; Safari lands on mp4, others
// on webm/opus. We re-decode to WAV regardless, so the intermediate codec
// only needs to be recordable + decodable by Web Audio.
export function pickRecordingMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  for (const m of candidates) {
    if (window.MediaRecorder && window.MediaRecorder.isTypeSupported?.(m)) return m;
  }
  return 'audio/webm';
}

// Encode a mono Float32 PCM buffer to a 16-bit WAV ArrayBuffer.
export function encodePcmToWav(float32, sampleRate = TARGET_SAMPLE_RATE) {
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
}

// Decode a recorded blob (any Web-Audio-decodable codec) → 16 kHz mono WAV.
// Returns `{ wav: ArrayBuffer, peak: number }`; peak amplitude surfaces a
// dead/too-quiet mic before we waste a Whisper round-trip on silence.
export async function blobToWav16k(blob) {
  const bytes = await blob.arrayBuffer();
  const decodeCtx = new (window.AudioContext || window.webkitAudioContext)();
  const decoded = await decodeCtx.decodeAudioData(bytes).finally(() => {
    decodeCtx.close().catch(() => {});
  });
  const frames = Math.ceil(decoded.duration * TARGET_SAMPLE_RATE);
  const offline = new OfflineAudioContext(1, frames, TARGET_SAMPLE_RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
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
}

// Base64-encode an ArrayBuffer in chunks (avoids the call-stack blowup of
// String.fromCharCode(...bigArray) on multi-second recordings).
export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Tap a live `AnalyserNode` off an existing `MediaStream` — for the live tuner,
 * which must read the SAME mic the recorder already opened rather than calling
 * getUserMedia a second time (a second stream prompts again / fights the first).
 * Returns `{ analyser, context, close }`; `close()` tears down the analyser graph
 * and AudioContext but leaves the stream alone (the recorder owns the stream's
 * lifetime). Caller MUST call `close()` on stop/unmount (deferred-work cleanup).
 */
export function createStreamAnalyser(stream, { fftSize = 2048 } = {}) {
  const context = new (window.AudioContext || window.webkitAudioContext)();
  // A context created outside a user gesture (e.g. in a render-driven effect)
  // can start `suspended` — or, on iOS, `'interrupted'`; resume so frame reads
  // aren't browser-dependent. Fire-and-forget: the analyser is read per frame,
  // so a late resume just means the first frames read zeros.
  resumeAudioContext(context).catch(() => {});
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = fftSize;
  source.connect(analyser); // no connection to destination — we only read frames
  return {
    analyser,
    context,
    close: () => {
      source.disconnect();
      analyser.disconnect();
      context.close().catch(() => {});
    },
  };
}

/**
 * Start recording from the default microphone. Returns a handle whose
 * `stop()` resolves to `{ audioBase64, peak, mimeType, durationMs }` — a
 * 16 kHz mono WAV base64 string ready to POST. The handle also exposes the live
 * `stream` so an analyser (live tuner) can tap the same mic without opening a
 * second one. The caller is responsible for calling `stop()` (or `cancel()` to
 * discard). Throws if mic access is denied.
 */
export async function startMemoRecording() {
  // Claimed BEFORE getUserMedia — an output-only `playback` session held by a
  // play-along elsewhere on the page would refuse the request outright — and
  // handed back if the mic is denied, since neither stop() nor cancel() runs
  // when this throws. See the audio-session note in audioContext.js.
  const releaseSession = acquireAudioSession('play-and-record');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    .catch((err) => { releaseSession(); throw err; });
  const mimeType = pickRecordingMimeType();
  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks = [];
  const startedAt = Date.now();
  recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
  recorder.start();

  // Both exit paths (stop and cancel) run this, and the release is idempotent.
  const teardown = () => {
    stream.getTracks().forEach((t) => t.stop());
    releaseSession();
  };

  return {
    stream,
    stop: () => new Promise((resolve, reject) => {
      recorder.onstop = async () => {
        teardown();
        try {
          const blob = new Blob(chunks, { type: mimeType });
          const { wav, peak } = await blobToWav16k(blob);
          resolve({
            audioBase64: arrayBufferToBase64(wav),
            mimeType: 'audio/wav',
            peak,
            durationMs: Date.now() - startedAt,
          });
        } catch (err) {
          reject(err);
        }
      };
      recorder.stop();
    }),
    cancel: () => { teardown(); try { recorder.stop(); } catch { /* already stopped */ } },
  };
}

/**
 * Constraints every PITCH-ANALYSIS mic opens with. The browser's default
 * capture chain is tuned for speech intelligibility, not signal analysis: AGC
 * rides the level the tuner's clarity gate reads, noise suppression chews
 * sustained vowels and soft onsets, and echo cancellation can gate the mic
 * outright while a reference melody plays back. Plain booleans, NOT `{ exact }`
 * — a browser that can't honor one must still open the mic rather than fail
 * closed; `openAnalysisMic` reports back what actually stuck.
 *
 * Deliberately NOT applied to `startMemoRecording` — that capture feeds Whisper
 * transcription, where the speech-tuned chain helps.
 */
export const ANALYSIS_AUDIO_CONSTRAINTS = Object.freeze({
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
});

const PROCESSING_KEYS = ['echoCancellation', 'noiseSuppression', 'autoGainControl'];

/**
 * Read back which processing stages the browser ACTUALLY applied to a capture
 * stream. Each key is `true` (on despite the constraint), `false` (honored), or
 * `null` when the browser doesn't report it — Firefox omits keys from
 * `getSettings()`, and unknown must not collapse into "off" or every such
 * browser would silently claim clean audio.
 */
export function readAppliedProcessing(stream) {
  const track = stream?.getAudioTracks?.()?.[0] ?? stream?.getTracks?.()?.[0];
  const settings = track?.getSettings?.();
  return Object.fromEntries(PROCESSING_KEYS.map((key) => [
    key,
    typeof settings?.[key] === 'boolean' ? settings[key] : null,
  ]));
}

/** True only when a stage is KNOWN to still be on — `null` (unknown) never warns. */
export function hasUnwantedProcessing(processing) {
  return PROCESSING_KEYS.some((key) => processing?.[key] === true);
}

/**
 * Open a microphone for pitch/signal analysis with the browser's processing
 * chain requested off, and report what it actually applied. Returns
 * `{ stream, processing }`; rejects exactly like `getUserMedia` does, so call
 * sites keep their existing `.catch()` + re-entrancy guards.
 *
 * Pass `getUserMedia` when the caller already resolved (and null-checked) it —
 * reaching through `navigator.mediaDevices` throws synchronously on an insecure
 * origin, and the capture hooks must do that check before claiming the audio
 * session.
 */
export async function openAnalysisMic({ getUserMedia } = {}) {
  const open = getUserMedia
    || navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
  if (!open) throw new Error('Microphone access requires a secure browser connection');
  const stream = await open({ audio: { ...ANALYSIS_AUDIO_CONSTRAINTS } });
  return { stream, processing: readAppliedProcessing(stream) };
}
