// Browser audio recording → 16 kHz mono WAV → base64, for one-shot memo
// capture (catalog voice ingest). whisper.cpp accepts WAV only, so we decode
// whatever MediaRecorder produced and resample to 16 kHz mono before encoding.
//
// This is deliberately NOT coupled to services/voiceClient.js — that module's
// recorder is wired to the live voice-agent socket pipeline (echo gating, VAD,
// streaming TTS). This is a standalone "record a clip, get a WAV" helper.

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
 * Start recording from the default microphone. Returns a handle whose
 * `stop()` resolves to `{ audioBase64, peak, mimeType, durationMs }` — a
 * 16 kHz mono WAV base64 string ready to POST. The caller is responsible for
 * calling `stop()` (or `cancel()` to discard). Throws if mic access is denied.
 */
export async function startMemoRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mimeType = pickRecordingMimeType();
  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks = [];
  const startedAt = Date.now();
  recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
  recorder.start();

  const teardown = () => stream.getTracks().forEach((t) => t.stop());

  return {
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
