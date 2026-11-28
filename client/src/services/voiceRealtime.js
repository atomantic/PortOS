/**
 * Realtime (speech-to-speech) Voice Call transport: 16 kHz PCM16 microphone up, gapless 24 kHz PCM16 reply audio down.
 *
 * Turn-taking and barge-in happen in the voice model; this side only drops buffered audio when the server says the
 * user interrupted.
 */
import socket from './socket';

const MIC_RATE = 16000;
const OUT_RATE = 24000;
const FRAME_SAMPLES = 320; // 20 ms at 16 kHz

const WORKLET_SOURCE = `
class RealtimeMic extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('portos-realtime-mic', RealtimeMic);
`;

/** Float32 [-1, 1] samples to little-endian PCM16 bytes. */
export const floatToPcm16 = (samples) => {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out.buffer;
};

/** PCM16 bytes to Float32 samples. */
export const pcm16ToFloat = (bytes) => {
  const view = bytes instanceof ArrayBuffer ? new Int16Array(bytes, 0, Math.floor(bytes.byteLength / 2))
    : new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + (bytes.byteLength & ~1)));
  const out = new Float32Array(view.length);
  for (let i = 0; i < view.length; i += 1) out[i] = view[i] / 0x8000;
  return out;
};

/**
 * Start a realtime call. Resolves a handle with `stop()`. Status and captions arrive through the callbacks.
 * @param {{ onState?: Function, onReply?: Function, onDelegate?: Function, onResult?: Function, onEvent?: Function }} handlers
 */
export const startRealtimeCall = async (handlers = {}) => {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  const Ctor = window.AudioContext || window.webkitAudioContext;
  let micCtx;
  let outCtx;
  let source;
  let node;
  const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
  try {
    micCtx = new Ctor({ sampleRate: MIC_RATE });
    outCtx = new Ctor({ sampleRate: OUT_RATE });
    await micCtx.audioWorklet.addModule(url);
    source = micCtx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(micCtx, 'portos-realtime-mic');
    source.connect(node);
  } catch (err) {
    // Release the microphone and contexts, or the mic indicator stays on after a failed start.
    source?.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    micCtx?.close().catch(() => {});
    outCtx?.close().catch(() => {});
    throw err;
  } finally {
    URL.revokeObjectURL(url);
  }

  let pending = new Float32Array(0);
  let live = false;
  node.port.onmessage = ({ data }) => {
    if (!live) return;
    const merged = new Float32Array(pending.length + data.length);
    merged.set(pending); merged.set(data, pending.length);
    let offset = 0;
    while (merged.length - offset >= FRAME_SAMPLES) {
      socket.emit('voice:realtime:audio', { pcm: floatToPcm16(merged.subarray(offset, offset + FRAME_SAMPLES)) });
      offset += FRAME_SAMPLES;
    }
    pending = merged.slice(offset);
  };

  // Gapless playback: each chunk starts where the previous one ends; an interrupt stops everything scheduled.
  let nextAt = 0;
  const playing = new Set();
  const flush = () => {
    for (const src of playing) { try { src.stop(); } catch { /* already ended */ } }
    playing.clear();
    nextAt = 0;
  };
  const onAudio = ({ pcm }) => {
    const samples = pcm16ToFloat(pcm);
    if (!samples.length) return;
    const buffer = outCtx.createBuffer(1, samples.length, OUT_RATE);
    buffer.copyToChannel(samples, 0);
    const src = outCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(outCtx.destination);
    const at = Math.max(outCtx.currentTime + 0.03, nextAt);
    src.start(at);
    nextAt = at + buffer.duration;
    playing.add(src);
    src.onended = () => playing.delete(src);
  };
  let stopped = false;
  const teardown = ({ emitStop = true } = {}) => {
    if (stopped) return;
    stopped = true;
    live = false;
    if (emitStop) socket.emit('voice:realtime:stop');
    for (const [event, fn] of Object.entries(listeners)) socket.off(event, fn);
    flush();
    node.port.onmessage = null;
    source.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    micCtx.close().catch(() => {});
    outCtx.close().catch(() => {});
  };
  const onState = (state) => {
    live = Boolean(state?.active);
    if (state?.error || state?.reason === 'sidecar-closed') teardown({ emitStop: false });
    handlers.onState?.(state);
  };
  const onDisconnect = () => {
    if (stopped) return;
    teardown({ emitStop: false });
    handlers.onState?.({ active: false, error: 'Connection to PortOS was lost.' });
  };
  const listeners = {
    'voice:realtime:audio': onAudio,
    'voice:realtime:interrupt': flush,
    'voice:realtime:state': onState,
    'voice:realtime:reply': (data) => handlers.onReply?.(data),
    'voice:realtime:delegate': (data) => handlers.onDelegate?.(data),
    'voice:realtime:result': (data) => handlers.onResult?.(data),
    'voice:realtime:event': (data) => handlers.onEvent?.(data),
    disconnect: onDisconnect,
  };
  for (const [event, fn] of Object.entries(listeners)) socket.on(event, fn);
  await Promise.all([micCtx.resume(), outCtx.resume()]).catch(() => {});
  if (!stopped && socket.connected === false) onDisconnect();
  else if (!stopped) socket.emit('voice:realtime:start');

  return {
    stop: () => teardown({ emitStop: true }),
    interrupt() {
      flush();
      socket.emit('voice:realtime:interrupt');
    },
  };
};
