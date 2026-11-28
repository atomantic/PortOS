// One realtime (speech-to-speech) Voice call: relays microphone and reply audio between a browser socket and the
// sidecar, and answers the voice's `delegate` hand-offs with the regular Voice tool pipeline (text only), whose
// result the voice then speaks. The voice handles turn-taking and barge-in itself; reply audio, interrupts and onsets
// carry the sidecar's reply id so the browser, which owns the playout clock, can stop exactly the reply that was heard.
import WebSocket from 'ws';
import { ensureRealtimeSidecar, scheduleRealtimeIdleStop } from './realtimeRuntime.js';

const MAX_TASK_CHARS = 2000;
const MAX_RESULT_CHARS = 1500;
const READY_TIMEOUT_MS = 15_000;
// Sidecar events worth showing the call UI; the rest (turn checks, prefill timings) stay in the sidecar.
const FORWARDED_EVENTS = new Set(['first_audio', 'barge_in', 'reply_start', 'merge_abort', 'error']);
// The sidecar's reply ids are short hex; anything else is dropped rather than relayed.
const REPLY_ID_RE = /^[0-9a-f]{1,32}$/;
const replyIdOf = (value) => (typeof value === 'string' && REPLY_ID_RE.test(value) ? value : null);

/** The persona line the voice gets, from the same personality settings the text Voice uses. */
export const realtimePersona = (cfg) => {
  if (cfg?.llm?.usePersonality === false) return '';
  const p = cfg?.llm?.personality || {};
  const parts = [`You are ${p.name || 'the assistant'}, ${p.role || 'Chief of Staff'} for the user.`];
  if (p.speechStyle) parts.push(`Speech style: ${p.speechStyle}.`);
  if (Array.isArray(p.traits) && p.traits.length) parts.push(`Personality: ${p.traits.join(', ')}.`);
  return parts.join(' ');
};

/**
 * @param {object} args
 * @param {object} args.cfg  merged Voice config
 * @param {(event: string, data?: any) => void} args.emit  to the caller's socket
 * @param {(task: string) => Promise<string>} args.runDelegate  runs one delegated task, resolves the text to speak
 * @param {AbortSignal} [args.signal]  aborts startup and prevents emitting live state after hang-up
 * @param {(reason: string) => void} [args.onClose]  called when the session closes (hang-up or sidecar close)
 * @param {(url: string, options?: object) => any} [args.connect]  WebSocket factory (tests)
 * @param {Function} [args.ensureSidecar]
 */
export const openRealtimeCall = async ({
  cfg,
  emit,
  runDelegate,
  signal,
  onClose,
  connect = (url, options) => new WebSocket(url, options),
  ensureSidecar = ensureRealtimeSidecar,
  readyTimeoutMs = READY_TIMEOUT_MS,
}) => {
  if (signal?.aborted) return null;
  const { url, token } = await ensureSidecar(cfg.realtime, { persona: realtimePersona(cfg) });
  if (signal?.aborted) {
    scheduleRealtimeIdleStop();
    return null;
  }
  const ws = connect(url, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
  ws.binaryType = 'nodebuffer';
  let closed = false;
  let started = false;
  const pending = new Set();

  const ready = new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(readyTimer);
      ws.off('message', first);
      ws.off('error', onError);
      ws.off('close', onCloseBeforeReady);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      closed = true;
      cleanup();
      try { ws.close(); } catch { /* socket may already be closed */ }
      scheduleRealtimeIdleStop();
      resolve(false);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      closed = true;
      cleanup();
      try { ws.close(); } catch { /* socket may already be closed */ }
      reject(err);
    };
    const onError = (err) => fail(err instanceof Error ? err : new Error('Realtime voice connection error'));
    const onCloseBeforeReady = (_code, reason) => {
      const detail = reason ? String(reason).trim() : '';
      fail(new Error(detail ? `Realtime voice closed before it was ready (${detail})` : 'Realtime voice closed before it was ready'));
    };
    const readyTimer = setTimeout(() => fail(new Error('Realtime voice timed out before it was ready')), readyTimeoutMs);
    readyTimer.unref?.();
    function first(data, isBinary) {
      if (isBinary) return;
      try {
        if (JSON.parse(String(data)).type === 'ready') {
          if (settled) return;
          settled = true;
          started = true;
          cleanup();
          resolve(true);
        }
      } catch { /* not JSON: keep waiting */ }
    }
    ws.once('error', onError);
    ws.once('close', onCloseBeforeReady);
    signal?.addEventListener('abort', onAbort, { once: true });
    ws.on('message', first);
  });

  const handleDelegate = async (callId, task) => {
    const text = String(task || '').slice(0, MAX_TASK_CHARS);
    emit('voice:realtime:delegate', { callId, task: text });
    let output;
    try {
      output = (await runDelegate(text)) || 'Done.';
    } catch (err) {
      output = `That failed: ${err.message}`;
    }
    if (closed) return;
    output = String(output).slice(0, MAX_RESULT_CHARS);
    emit('voice:realtime:result', { callId, task: text, text: output });
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'tool_result', call_id: callId, output }));
  };

  // Binary reply audio belongs to the reply the sidecar last announced with `reply_audio` (one ordered WebSocket).
  let audioReplyId = null;
  ws.on('message', (data, isBinary) => {
    if (isBinary) { emit('voice:realtime:audio', { pcm: data, sampleRate: 24000, replyId: audioReplyId }); return; }
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (msg.type === 'reply_audio') audioReplyId = replyIdOf(msg.reply_id);
    else if (msg.type === 'interrupt') emit('voice:realtime:interrupt', { replyId: replyIdOf(msg.reply_id) });
    else if (msg.type === 'onset') {
      const replyId = replyIdOf(msg.reply_id);
      if (replyId) emit('voice:realtime:onset', { replyId });
    } else if (msg.type === 'reply') {
      emit('voice:realtime:reply', { text: msg.text || '', cancelled: Boolean(msg.cancelled), replyId: replyIdOf(msg.reply_id) });
    }
    else if (msg.type === 'delegate') {
      const job = handleDelegate(String(msg.call_id || ''), msg.task).finally(() => pending.delete(job));
      pending.add(job);
    } else if (msg.type === 'event' && FORWARDED_EVENTS.has(msg.ev)) {
      emit('voice:realtime:event', { ev: msg.ev, afterSilenceS: msg.after_silence_s ?? null, followup: Boolean(msg.followup) });
    }
  });
  ws.on('close', () => {
    if (!started || closed) return;
    closed = true;
    scheduleRealtimeIdleStop();
    onClose?.('sidecar-closed');
    emit('voice:realtime:state', { active: false, reason: 'sidecar-closed' });
  });
  ws.on('error', (err) => console.log(`🗣️ voice.realtime.socket ${err.message}`));

  const isReady = await ready;
  if (!isReady || closed || signal?.aborted) {
    if (!closed) {
      closed = true;
      ws.close();
      scheduleRealtimeIdleStop();
    }
    return null;
  }
  emit('voice:realtime:state', { active: true });

  return {
    /** Microphone PCM16 mono at 16 kHz. */
    pushAudio(buf) {
      if (!closed && ws.readyState === WebSocket.OPEN) ws.send(buf);
    },
    /** Stop talking now; `heard` says which reply the browser stopped and how many seconds of it had played. */
    interrupt(heard) {
      if (closed || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify(heard ? { type: 'interrupt', reply_id: heard.replyId, played_s: heard.playedS } : { type: 'interrupt' }));
    },
    /** The browser stopped a reply the sidecar had judged finished; the sidecar trims its history to what was heard. */
    cut({ replyId, playedS }) {
      if (!closed && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'cut', reply_id: replyId, played_s: playedS }));
    },
    close() {
      if (closed) return;
      closed = true;
      ws.close();
      scheduleRealtimeIdleStop();
      onClose?.('hangup');
      emit('voice:realtime:state', { active: false, reason: 'hangup' });
    },
  };
};
