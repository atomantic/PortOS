// One realtime (speech-to-speech) Voice call: relays microphone and reply audio between a browser socket and the
// sidecar, and answers the voice's `delegate` hand-offs with the regular Voice tool pipeline (text only), whose
// result the voice then speaks. The voice handles turn-taking and barge-in itself.
import WebSocket from 'ws';
import { ensureRealtimeSidecar, scheduleRealtimeIdleStop } from './realtimeRuntime.js';

const MAX_TASK_CHARS = 2000;
const MAX_RESULT_CHARS = 1500;
// Sidecar events worth showing the call UI; the rest (turn checks, prefill timings) stay in the sidecar.
const FORWARDED_EVENTS = new Set(['first_audio', 'barge_in', 'reply_start', 'merge_abort', 'error']);

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
 * @param {Function} [args.connect]  WebSocket factory (tests)
 * @param {Function} [args.ensureSidecar]
 */
export const openRealtimeCall = async ({ cfg, emit, runDelegate, connect = (url, options) => new WebSocket(url, options), ensureSidecar = ensureRealtimeSidecar }) => {
  const { url, token } = await ensureSidecar(cfg.realtime, { persona: realtimePersona(cfg) });
  const ws = connect(url, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
  ws.binaryType = 'nodebuffer';
  let closed = false;
  const pending = new Set();

  const ready = new Promise((resolve, reject) => {
    const fail = (err) => reject(err instanceof Error ? err : new Error('Realtime voice closed before it was ready'));
    ws.once('error', fail);
    ws.once('close', fail);
    ws.on('message', function first(data, isBinary) {
      if (isBinary) return;
      try {
        if (JSON.parse(String(data)).type === 'ready') { ws.off('message', first); ws.off('error', fail); resolve(); }
      } catch { /* not JSON: keep waiting */ }
    });
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
    output = String(output).slice(0, MAX_RESULT_CHARS);
    emit('voice:realtime:result', { callId, task: text, text: output });
    if (!closed && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'tool_result', call_id: callId, output }));
  };

  ws.on('message', (data, isBinary) => {
    if (isBinary) { emit('voice:realtime:audio', { pcm: data, sampleRate: 24000 }); return; }
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (msg.type === 'interrupt') emit('voice:realtime:interrupt', {});
    else if (msg.type === 'reply') emit('voice:realtime:reply', { text: msg.text || '', cancelled: Boolean(msg.cancelled) });
    else if (msg.type === 'delegate') {
      const job = handleDelegate(String(msg.call_id || ''), msg.task).finally(() => pending.delete(job));
      pending.add(job);
    } else if (msg.type === 'event' && FORWARDED_EVENTS.has(msg.ev)) {
      emit('voice:realtime:event', { ev: msg.ev, afterSilenceS: msg.after_silence_s ?? null, followup: Boolean(msg.followup) });
    }
  });
  ws.on('close', () => {
    if (closed) return;
    closed = true;
    emit('voice:realtime:state', { active: false, reason: 'sidecar-closed' });
  });
  ws.on('error', (err) => console.log(`🗣️ voice.realtime.socket ${err.message}`));

  await ready;
  emit('voice:realtime:state', { active: true });

  return {
    /** Microphone PCM16 mono at 16 kHz. */
    pushAudio(buf) {
      if (!closed && ws.readyState === WebSocket.OPEN) ws.send(buf);
    },
    interrupt() {
      if (!closed && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'interrupt' }));
    },
    close() {
      if (closed) return;
      closed = true;
      ws.close();
      scheduleRealtimeIdleStop();
      emit('voice:realtime:state', { active: false, reason: 'hangup' });
    },
  };
};
