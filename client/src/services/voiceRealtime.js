/**
 * Realtime (speech-to-speech) Voice Call transport: 16 kHz PCM16 microphone up, gapless 24 kHz PCM16 reply audio down.
 *
 * Turn-taking and barge-in happen in the voice model. Each mic frame carries `far`, what the speaker played over the same
 * 20 ms (see voicePlaybackReference.js), so the voice does not mistake its own echo for the user talking over it. The
 * browser's echo canceller stays the one echo-cancellation stage; the reference only raises the voice's speech threshold.
 * Without a reliable reference (no AudioWorklet output tap or no getOutputTimestamp) frames go up without `far`.
 *
 * Reply audio arrives tagged with the voice's reply id and this side owns the playout clock: the voice judges whether a
 * finished reply is still being heard from generation time, but the browser schedules the audio itself (and waits for the
 * avatar before each segment), so when the voice reports that the user started speaking after a reply finished
 * generating, this side stops that reply if it is still playing here, and reports how much of each stopped reply was
 * heard so the voice's history matches it.
 */
import socket from './socket';
import { markVoiceTiming } from './voiceTimingDebug.js';
import { getVoiceOutputVisualizer, getVoiceVolume, isVoiceMuted, onVoiceAudioPrefs } from './voicePlayback.js';
import { encodePcmToWav } from '../lib/audioRecorder.js';
import { captureTimeMs, createPlaybackReference, deviceTimeMs, inputLatencyOf, supportsPlaybackReference } from './voicePlaybackReference.js';

const MIC_RATE = 16000;
const OUT_RATE = 24000;
const FRAME_SAMPLES = 320; // 20 ms at 16 kHz
// With the Voice Call avatar running, reply audio is played in short segments, each one rendered to lip-synced frames first
// (the avatar takes a whole WAV). The first segment of a reply is short so speech starts soon; later ones are longer so
// the avatar keeps up, and any segment goes out early when the queued audio is about to run dry.
const AVATAR_FIRST_SEGMENT_S = 0.6;
const AVATAR_SEGMENT_S = 1.6;
const AVATAR_LOW_WATER_S = 0.35;
const AVATAR_READY_WAIT_MS = 750;
// Replies kept for interrupts and onsets that name them; a stopped one also drops audio that arrives after its interrupt.
const RECENT_REPLIES = 16;

// The mic processor posts each input block with its context frame, so capture time is known. The tap sits between the
// output gain and the speaker, passes audio through unchanged and posts what it rendered, with its frame.
const WORKLET_SOURCE = `
class RealtimeMic extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) this.port.postMessage({ ch: ch.slice(0), frame: currentFrame });
    return true;
  }
}
registerProcessor('portos-realtime-mic', RealtimeMic);
class RealtimePlaybackTap extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const ch = inputs[0] && inputs[0][0];
    const out = outputs[0] && outputs[0][0];
    if (ch && ch.length) {
      if (out) out.set(ch);
      this.port.postMessage({ ch: ch.slice(0), frame: currentFrame });
    }
    return true;
  }
}
registerProcessor('portos-realtime-tap', RealtimePlaybackTap);
`;

// A realtime call owns the microphone and the conversation. The voice widget listens for this event and stops its own
// listening and speech, so the regular pipeline does not answer the same words as a second conversation.
export const REALTIME_ACTIVE_EVENT = 'portos:voice-realtime';
let activeCalls = 0;
let liveCall = false;
const activeStoppers = new Set();
const broadcast = () => {
  if (typeof window.dispatchEvent === 'function') {
    const active = activeCalls > 0;
    window.dispatchEvent(new CustomEvent(REALTIME_ACTIVE_EVENT, { detail: { active, connecting: active && !liveCall } }));
  }
};
const announce = (delta) => {
  activeCalls = Math.max(0, activeCalls + delta);
  if (!activeCalls) liveCall = false;
  broadcast();
};
const announceLive = (live) => {
  if (live === liveCall) return;
  liveCall = live;
  broadcast();
};
/** True while a realtime call has started but its voice model is not answering yet (loading). */
export const isRealtimeCallConnecting = () => activeCalls > 0 && !liveCall;
/** True from the moment a realtime call starts (model still loading included) until it ends. */
export const isRealtimeCallActive = () => activeCalls > 0;
/** Hang up any active realtime call from an external surface (such as the handset End button). */
export const stopActiveRealtimeCalls = () => {
  for (const stop of [...activeStoppers]) stop();
};

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
  if (!bytes) return new Float32Array(0);
  let view;
  if (bytes instanceof ArrayBuffer) {
    view = new Int16Array(bytes, 0, Math.floor(bytes.byteLength / 2));
  } else if (ArrayBuffer.isView(bytes)) {
    view = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + (bytes.byteLength & ~1)));
  } else {
    return new Float32Array(0);
  }
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
  announce(1);
  let announced = true;
  const release = () => { if (announced) { announced = false; announce(-1); } };
  const Ctor = window.AudioContext || window.webkitAudioContext;
  let micCtx;
  let outCtx;
  let source;
  let node;
  let tap = null;
  const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
  try {
    micCtx = new Ctor({ sampleRate: MIC_RATE });
    outCtx = new Ctor({ sampleRate: OUT_RATE });
    await micCtx.audioWorklet.addModule(url);
    source = micCtx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(micCtx, 'portos-realtime-mic');
    source.connect(node);
    if (supportsPlaybackReference(micCtx, outCtx)) {
      // The tap is optional: without it the call runs on the browser's echo cancellation alone.
      try {
        await outCtx.audioWorklet.addModule(url);
        tap = new AudioWorkletNode(outCtx, 'portos-realtime-tap');
      } catch { /* no tap: tap stays null and frames go up without a reference */ }
    }
  } catch (err) {
    // Release the microphone and contexts, or the mic indicator stays on after a failed start.
    source?.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    micCtx?.close().catch(() => {});
    outCtx?.close().catch(() => {});
    release();
    throw err;
  } finally {
    URL.revokeObjectURL(url);
  }

  const reference = tap ? createPlaybackReference({ outRate: OUT_RATE, micRate: MIC_RATE }) : null;
  const inputLatencyS = inputLatencyOf(stream);
  markVoiceTiming(`rt.echo-reference ${reference ? 'on' : 'off'}`);
  if (tap) {
    tap.port.onmessage = ({ data }) => {
      const at = deviceTimeMs(outCtx, data.frame / OUT_RATE);
      if (at !== null) reference.push(data.ch, at);
    };
  }

  let pending = new Float32Array(0);
  let live = false;
  node.port.onmessage = ({ data }) => {
    if (!live || !data?.ch) return;
    const { ch } = data;
    // Capture time of merged[0]: the held-over samples came just before this block.
    const startMs = reference ? captureTimeMs(micCtx, data.frame / MIC_RATE, inputLatencyS) : null;
    const mergedStartMs = startMs === null ? null : startMs - (pending.length * 1000) / MIC_RATE;
    const merged = new Float32Array(pending.length + ch.length);
    merged.set(pending); merged.set(ch, pending.length);
    let offset = 0;
    while (merged.length - offset >= FRAME_SAMPLES) {
      const payload = { pcm: floatToPcm16(merged.subarray(offset, offset + FRAME_SAMPLES)) };
      if (reference) {
        const far = mergedStartMs === null ? new Float32Array(FRAME_SAMPLES) : reference.frame(mergedStartMs + (offset * 1000) / MIC_RATE, FRAME_SAMPLES);
        payload.far = floatToPcm16(far);
      }
      socket.emit('voice:realtime:audio', payload);
      offset += FRAME_SAMPLES;
    }
    pending = merged.slice(offset);
  };

  // Gapless playback: each chunk starts where the previous one ends. Each reply keeps its own clips, sources and avatar
  // animations, so an interrupt for one reply never stops another.
  let nextAt = 0;
  // Output volume and mute follow the voice widget's controls.
  const outGain = outCtx.createGain();
  if (tap) { outGain.connect(tap); tap.connect(outCtx.destination); } else outGain.connect(outCtx.destination);
  const offPrefs = onVoiceAudioPrefs(({ volume, muted }) => { outGain.gain.value = muted ? 0 : volume; });
  outGain.gain.value = isVoiceMuted() ? 0 : getVoiceVolume();

  // replyId -> { id, clips: [{ at, duration }], sources, anims, held (samples not yet scheduled), stopped, halted }
  const replies = new Map();
  const isAudible = (rec) => !rec.stopped
    && (rec.held > 0 || rec.clips.some((c) => c.at + c.duration > outCtx.currentTime));
  // Seconds of the reply that have actually played here, from the same schedule the audio and the avatar follow.
  const playedS = (rec) => {
    const now = outCtx.currentTime;
    const played = rec.clips.reduce((sum, c) => sum + Math.min(c.duration, Math.max(0, now - c.at)), 0);
    return Math.round(played * 1000) / 1000;
  };
  const replyFor = (id) => {
    const known = replies.get(id);
    // Untagged audio (an older sidecar) is one running reply that starts over after an interrupt.
    if (known && !(known.stopped && !id)) return known;
    let release;
    const halted = new Promise((resolve) => { release = resolve; });
    const rec = { id, clips: [], sources: new Set(), anims: new Set(), held: 0, stopped: false, halted, release };
    replies.delete(id);
    replies.set(id, rec);
    for (const [oldId, old] of replies) {
      if (replies.size <= RECENT_REPLIES) break;
      if (old !== rec && !isAudible(old)) replies.delete(oldId);
    }
    return rec;
  };

  const schedule = (samples, rec) => {
    const buffer = outCtx.createBuffer(1, samples.length, OUT_RATE);
    buffer.copyToChannel(samples, 0);
    const src = outCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(outGain);
    const at = Math.max(outCtx.currentTime + 0.03, nextAt);
    src.start(at);
    nextAt = at + buffer.duration;
    rec.clips.push({ at, duration: buffer.duration });
    rec.sources.add(src);
    src.onended = () => rec.sources.delete(src);
    return { at, duration: buffer.duration };
  };

  // Avatar segmenting (only while the avatar renderer is bound).
  let segment = [];
  let segmentSamples = 0;
  let segmentRec = null;
  let firstOfReply = true;
  let avatarChain = Promise.resolve();
  let pendingSegments = 0;
  const emitSegment = () => {
    if (!segmentSamples) return;
    const rec = segmentRec;
    const samples = new Float32Array(segmentSamples);
    let offset = 0;
    for (const part of segment) { samples.set(part, offset); offset += part.length; }
    segment = []; segmentSamples = 0; firstOfReply = false;
    pendingSegments += 1;
    avatarChain = avatarChain.then(async () => {
      if (rec.stopped || stopped) return;
      let anim;
      try { anim = getVoiceOutputVisualizer()?.(encodePcmToWav(samples, OUT_RATE)); } catch { /* the avatar never owns the audio */ }
      // A stopped reply releases the wait at once, so the next reply's segments are not held behind it.
      if (anim) {
        await Promise.race([Promise.resolve(anim.ready).catch(() => {}), rec.halted, new Promise((r) => { setTimeout(r, AVATAR_READY_WAIT_MS); })]);
      }
      if (rec.stopped || stopped) { anim?.stop(); return; }
      rec.held -= samples.length;
      const { at, duration } = schedule(samples, rec);
      if (!anim) return;
      rec.anims.add(anim);
      anim.start(() => outCtx.currentTime - at);
      setTimeout(() => { anim.stop(); rec.anims.delete(anim); }, Math.max(0, (at - outCtx.currentTime + duration) * 1000) + 80);
    }).finally(() => { pendingSegments -= 1; });
  };
  const segmentTimer = setInterval(() => {
    // Only once a reply is already playing, and nothing is waiting on the avatar: then the queue is about to run dry.
    if (segmentSamples && !firstOfReply && !pendingSegments && nextAt > 0 && (nextAt - outCtx.currentTime) < AVATAR_LOW_WATER_S) emitSegment();
  }, 100);

  const stopReply = (rec) => {
    if (rec.stopped) return;
    rec.stopped = true;
    rec.release();
    for (const anim of rec.anims) anim.stop();
    rec.anims.clear();
    for (const src of rec.sources) { try { src.stop(); } catch { /* already ended */ } }
    rec.sources.clear();
    if (segmentRec === rec) { segment = []; segmentSamples = 0; segmentRec = null; firstOfReply = true; }
    nextAt = 0;
    for (const other of replies.values()) {
      if (!other.stopped) for (const c of other.clips) nextAt = Math.max(nextAt, c.at + c.duration);
    }
  };
  const stopAll = () => { for (const rec of replies.values()) stopReply(rec); };
  // Stop a reply that was (or was about to be) heard and tell the voice how much of it played here.
  const cutReply = (rec) => {
    const heard = playedS(rec);
    stopReply(rec);
    if (rec.id) socket.emit('voice:realtime:cut', { replyId: rec.id, playedS: heard });
  };
  // Stop this reply and any older one still playing ahead of it (a follow-up can queue behind a reply's tail), never a
  // newer one. Replies are kept in arrival order.
  const cutThrough = (rec) => {
    for (const older of replies.values()) {
      if (older === rec) break;
      if (isAudible(older)) cutReply(older);
    }
    if (rec.clips.length || rec.held) cutReply(rec);
    else stopReply(rec);
  };
  const onInterrupt = (data) => {
    const id = data?.replyId;
    if (typeof id !== 'string' || !id) { stopAll(); return; }
    const rec = replies.get(id);
    if (!rec) stopReply(replyFor(id)); // a reply not heard yet: drop any audio of it that still arrives
    else if (!rec.stopped) cutThrough(rec);
  };
  // The user started speaking after the voice finished generating this reply. Stop it only if it is still playing here,
  // so finished playback is never cut and an older reply's onset never touches a newer one.
  const onOnset = (data) => {
    const rec = typeof data?.replyId === 'string' ? replies.get(data.replyId) : undefined;
    if (!rec || !isAudible(rec)) return;
    markVoiceTiming('rt.onset stops reply still playing');
    cutThrough(rec);
  };

  let stopped = false;
  const onAudio = (payload) => {
    if (stopped || outCtx.state === 'closed' || !payload?.pcm) return;
    const samples = pcm16ToFloat(payload.pcm);
    if (!samples.length) return;
    const id = typeof payload.replyId === 'string' ? payload.replyId : '';
    if (id && replies.get(id)?.stopped) return;
    const rec = replyFor(id);
    if (!getVoiceOutputVisualizer()) { schedule(samples, rec); return; }
    if (segmentRec && segmentRec !== rec) { emitSegment(); firstOfReply = true; }
    segmentRec = rec;
    segment.push(samples);
    segmentSamples += samples.length;
    rec.held += samples.length;
    if (segmentSamples >= (firstOfReply ? AVATAR_FIRST_SEGMENT_S : AVATAR_SEGMENT_S) * OUT_RATE) emitSegment();
  };
  const teardown = ({ emitStop = true } = {}) => {
    if (stopped) return;
    stopped = true;
    live = false;
    activeStoppers.delete(externalStop);
    release();
    if (emitStop) socket.emit('voice:realtime:stop');
    for (const [event, fn] of Object.entries(listeners)) socket.off(event, fn);
    clearInterval(segmentTimer);
    offPrefs();
    stopAll();
    node.port.onmessage = null;
    if (tap) { tap.port.onmessage = null; tap.disconnect(); }
    source.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    micCtx.close().catch(() => {});
    outCtx.close().catch(() => {});
  };
  const externalStop = () => {
    teardown({ emitStop: true });
    handlers.onState?.({ active: false });
  };
  activeStoppers.add(externalStop);
  const onState = (state) => {
    markVoiceTiming(`rt.state ${state?.error ? 'error' : state?.loading ? 'loading' : state?.active ? 'live' : (state?.reason || 'off')}`);
    live = Boolean(state?.active);
    announceLive(live);
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
    'voice:realtime:interrupt': onInterrupt,
    'voice:realtime:onset': onOnset,
    'voice:realtime:state': onState,
    'voice:realtime:reply': (data) => { emitSegment(); firstOfReply = true; handlers.onReply?.(data); },
    'voice:realtime:delegate': (data) => {
      markVoiceTiming('rt.delegate', { startsTurn: true });
      handlers.onDelegate?.(data);
    },
    'voice:realtime:result': (data) => {
      markVoiceTiming(`rt.result ${data?.text?.length ?? 0}c`);
      handlers.onResult?.(data);
    },
    'voice:realtime:event': (data) => {
      const silence = Number.isFinite(data?.afterSilenceS) ? ` ${Math.round(data.afterSilenceS * 1000)}ms after silence` : '';
      markVoiceTiming(`rt.${data?.ev}${silence}${data?.followup ? ' (follow-up)' : ''}`);
      handlers.onEvent?.(data);
    },
    disconnect: onDisconnect,
  };
  for (const [event, fn] of Object.entries(listeners)) socket.on(event, fn);
  await Promise.all([micCtx.resume(), outCtx.resume()]).catch(() => {});
  if (!stopped && socket.connected === false) onDisconnect();
  else if (!stopped) {
    markVoiceTiming('rt.start', { startsTurn: true });
    socket.emit('voice:realtime:start');
  }

  return {
    stop: () => teardown({ emitStop: true }),
    interrupt() {
      // Every reply still playing is cut; the newest one rides the interrupt, older ones report what was heard of them.
      const heard = [...replies.values()].filter((rec) => rec.id && isAudible(rec)).map((rec) => ({ replyId: rec.id, playedS: playedS(rec) }));
      stopAll();
      const newest = heard.pop();
      for (const older of heard) socket.emit('voice:realtime:cut', older);
      socket.emit('voice:realtime:interrupt', newest ?? {});
    },
  };
};
