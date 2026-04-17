// One conversational turn: audio → STT → streaming LLM (with tool-calling
// loop) → sentence-boundary TTS. If the model emits tool_calls, each is
// executed server-side, the result is appended to the message list, and the
// LLM is called again — up to cfg.llm.tools.maxIterations rounds.
// Caller supplies an `emit` callback (sockets/voice.js passes socket.emit)
// and an AbortSignal; aborting tears down the LLM stream and skips pending
// sentences.

import { transcribe } from './stt.js';
import { synthesize } from './tts.js';
import { streamChat } from './llm.js';
import { getVoiceConfig } from './config.js';
import { getToolSpecs, dispatchTool } from './tools.js';
import { appendJournal } from '../brainJournal.js';

const buildSystemPrompt = (cfg) => {
  if (!cfg.llm.usePersonality) return cfg.llm.systemPrompt;
  const p = cfg.llm.personality || {};
  const name = p.name || 'your Chief of Staff';
  const role = p.role || 'Chief of Staff';
  const lines = [
    `You are ${name}, ${role} for the user.`,
    'Your replies are spoken aloud — keep them short and use plain prose. No markdown, no lists, no headings, no code fences.',
  ];
  if (p.speechStyle) lines.push(`Speech style: ${p.speechStyle}.`);
  if (Array.isArray(p.traits) && p.traits.length) lines.push(`Personality: ${p.traits.join(', ')}.`);
  if (cfg.llm.tools?.enabled) {
    // Critical: with tools on, the model must ACTUALLY call them, not just
    // speak as if it did. Confirm only *after* a tool call succeeds.
    lines.push('You have tools for acting on the user\'s behalf (for example, saving to the brain inbox). When the user asks you to save, capture, add, remember, note, or file something, you MUST call the matching tool — do not just reply in words. After the tool runs, confirm briefly in one short sentence using the exact words the user said. If you reference the brain inbox, call it "brain inbox" (not "green inbox" or any other near-homophone).');
  } else {
    // Prevent hallucinated actions when tools are disabled.
    lines.push('You cannot take actions right now — no tools are enabled. If the user asks you to save, add, or remember something, acknowledge the request and honestly say you can\'t file it yourself yet. Do not claim to have done anything.');
  }
  if (p.customPrompt) lines.push(p.customPrompt);
  return lines.join(' ');
};

const SENTENCE_RE = /[.!?\n](?:\s+|$)/;

// Exported for unit testing — the sentence-boundary logic is too central to
// leave untested.
export const splitSentences = (buffer) => {
  const out = [];
  let rest = buffer;
  while (true) {
    const m = rest.match(SENTENCE_RE);
    if (!m || m.index === undefined) break;
    const end = m.index + m[0].length;
    const sentence = rest.slice(0, end).trim();
    if (sentence) out.push(sentence);
    rest = rest.slice(end);
  }
  return { sentences: out, remainder: rest };
};

/**
 * Run one turn.
 *
 * @param {object} args
 * @param {Buffer} args.audio        — utterance audio bytes
 * @param {string} args.mimeType     — e.g. 'audio/webm', 'audio/wav'
 * @param {Array}  args.history      — prior conversation messages
 * @param {(event:string, payload:any) => void} args.emit
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{ transcript: string, reply: string }>}
 */
// Whisper tags non-speech as bracketed markers like [BLANK_AUDIO], [MUSIC],
// [LAUGHTER], [INAUDIBLE]. Treat those as empty so we don't waste an LLM turn.
export const isNonSpeechMarker = (text) => /^\s*\[[A-Z_ ]+\]\s*$/i.test(text);

// Recognize spoken phrases that should end dictation without going through the
// LLM. Intentionally narrow — "I'm done writing" shouldn't match.
const STOP_DICTATION_RE = /^(stop|end|exit|cancel|pause)\s+(dictation|dictating|logging|recording)[\.\!\s]*$/i;

export const runTurn = async ({ audio, text, mimeType, source, history = [], emit, signal, state }) => {
  const cfg = await getVoiceConfig();
  if (signal?.aborted) return { transcript: '', reply: '' };

  const turnStart = Date.now();

  let userText = text;
  let sttLatencyMs = 0;
  if (!userText) {
    const stt = await transcribe(audio, { mimeType, signal });
    sttLatencyMs = stt.latencyMs;
    userText = isNonSpeechMarker(stt.text) ? '' : stt.text;
    emit('voice:transcript', { text: userText, latencyMs: stt.latencyMs });
  } else {
    emit('voice:transcript', { text: userText, latencyMs: 0, source: 'text' });
  }

  if (!userText) {
    console.log(`🎙️  voice: empty input (stt=${sttLatencyMs}ms)`);
    emit('voice:idle', { reason: 'empty-transcript' });
    return { transcript: '', reply: '' };
  }
  if (signal?.aborted) return { transcript: userText, reply: '' };

  // Dictation mode short-circuits the LLM: the user's speech goes straight
  // into the daily-log entry unless they say the stop phrase, which ends
  // dictation and falls through to a normal confirmation turn.
  //
  // Only applies to spoken input. Typed input (the "Read back" button,
  // assistant-issued sendText, manual typing) bypasses dictation so the
  // user can still drive the app while dictation is live. Web Speech mode
  // hands transcripts over as voice:text with source='voice', so we honor
  // that hint in addition to the no-text case.
  const isSpokenInput = !text || source === 'voice';
  if (isSpokenInput && state?.dictation?.enabled) {
    const trimmed = userText.trim();
    if (STOP_DICTATION_RE.test(trimmed)) {
      state.dictation = { enabled: false, date: null };
      emit('voice:dictation', { enabled: false });
      const reply = 'Dictation off.';
      const { wav } = await synthesize(reply, { signal });
      if (!signal?.aborted) emit('voice:tts:audio', { sentence: reply, wav, latencyMs: 0 });
      emit('voice:llm:delta', { delta: reply });
      emit('voice:llm:done', { text: reply });
      emit('voice:idle', { reason: 'turn-complete' });
      return { transcript: userText, reply };
    }
    const date = state.dictation.date;
    const entry = await appendJournal(date, trimmed, { source: 'voice' });
    emit('voice:dailyLog:appended', { date, text: trimmed, entry });
    console.log(`🎙️  dictation → journal[${date}] +${trimmed.length} chars`);
    emit('voice:idle', { reason: 'dictation-appended' });
    return { transcript: userText, reply: '' };
  }

  const messages = [
    { role: 'system', content: buildSystemPrompt(cfg) },
    ...history,
    { role: 'user', content: userText },
  ];

  const toolsEnabled = !!cfg.llm.tools?.enabled;
  const toolSpecs = toolsEnabled ? getToolSpecs() : undefined;
  const maxIterations = Math.max(1, cfg.llm.tools?.maxIterations ?? 3);

  let pending = '';
  const ttsTimings = [];
  const speak = async (sentence) => {
    if (signal?.aborted || !sentence) return;
    const { wav, latencyMs } = await synthesize(sentence, { signal });
    if (signal?.aborted) return;
    ttsTimings.push(latencyMs);
    emit('voice:tts:audio', { sentence, wav, latencyMs });
  };

  let synthQueue = Promise.resolve();
  const flushSentence = (delta) => {
    pending += delta;
    const { sentences, remainder } = splitSentences(pending);
    pending = remainder;
    for (const s of sentences) {
      synthQueue = synthQueue.then(() => speak(s)).catch((err) => {
        // Barge-in aborts the turn mid-synthesis — Kokoro throws Error('aborted')
        // and Piper rejects 'piper synthesis aborted'. That's expected, not a
        // real failure, so don't surface it as voice:error.
        if (signal?.aborted || /aborted/i.test(err?.message || '')) return;
        emit('voice:error', { stage: 'tts', message: err.message });
      });
    }
  };

  let firstLlm = null;
  let lastLlm = null;
  let finalText = '';
  const toolRuns = []; // [{ name, ok, ms, error }]

  for (let iter = 0; iter < maxIterations; iter++) {
    if (signal?.aborted) break;

    const llm = await streamChat(messages, {
      model: cfg.llm.model,
      signal,
      tools: toolSpecs,
      onDelta: (delta) => {
        emit('voice:llm:delta', { delta });
        flushSentence(delta);
      },
    });
    if (!firstLlm) firstLlm = llm;
    lastLlm = llm;
    // Accumulate spoken text across tool-calling iterations. The old single-
    // assignment version dropped every earlier segment, so the persisted
    // `reply` (and next turn's history) diverged from what the user actually
    // heard when the model spoke before/between tool calls.
    if (llm.text) finalText += (finalText ? ' ' : '') + llm.text;

    if (!llm.toolCalls?.length) break;

    // Assign stable IDs up-front so the assistant's tool_calls[].id and each
    // tool response's tool_call_id are guaranteed to match, even when the
    // upstream stream omitted tc.id. Previously the fallback `call_<index>`
    // was computed only at the tool-response side, so the assistant entry
    // could carry a different id and the next LLM iteration wouldn't pair
    // the result with the call.
    const callsWithIds = llm.toolCalls.map((tc, i) => ({
      ...tc,
      resolvedId: tc.id || `call_${iter}_${tc.index ?? i}`,
    }));

    // Persist the assistant's tool-call turn, then execute each call and
    // feed the result back as a 'tool' message for the next iteration.
    messages.push({
      role: 'assistant',
      content: llm.text || null,
      tool_calls: callsWithIds.map((tc) => ({
        id: tc.resolvedId,
        type: tc.type,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      })),
    });

    for (const tc of callsWithIds) {
      if (signal?.aborted) break;
      const t0 = Date.now();
      let result;
      let args = {};
      const ctx = { sideEffects: [] };
      try {
        args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        result = await dispatchTool(tc.function.name, args, ctx);
        toolRuns.push({ name: tc.function.name, ok: true, ms: Date.now() - t0 });
      } catch (err) {
        result = { ok: false, error: err.message };
        toolRuns.push({ name: tc.function.name, ok: false, ms: Date.now() - t0, error: err.message });
      }
      // Apply server-side side-effects (dictation state) and forward
      // client-facing side-effects (navigation) over the socket.
      for (const fx of ctx.sideEffects) {
        if (fx.type === 'dictation' && state) {
          state.dictation = { enabled: !!fx.enabled, date: fx.date || state.dictation?.date || null };
          emit('voice:dictation', { enabled: state.dictation.enabled, date: state.dictation.date });
        } else if (fx.type === 'navigate') {
          emit('voice:navigate', { path: fx.path });
        }
      }
      emit('voice:tool', { name: tc.function.name, args, result });
      messages.push({
        role: 'tool',
        tool_call_id: tc.resolvedId,
        content: JSON.stringify(result),
      });
    }
  }

  if (pending.trim()) synthQueue = synthQueue.then(() => speak(pending.trim()));
  await synthQueue;

  const totalMs = Date.now() - turnStart;
  const ttsTotal = ttsTimings.reduce((a, b) => a + b, 0);
  const inputKind = text ? 'text' : 'voice';
  const toolSummary = toolRuns.length
    ? ` · tools=${toolRuns.map((r) => `${r.name}(${r.ok ? `${r.ms}ms` : 'err'})`).join(',')}`
    : '';
  console.log(
    `🎙️  ${inputKind} turn ${totalMs}ms — ` +
    `stt=${sttLatencyMs}ms · ` +
    `llm[${lastLlm?.model}] ttft=${firstLlm?.ttfbMs ?? '—'}ms total=${lastLlm?.totalMs}ms · ` +
    `tts=${ttsTotal}ms (${ttsTimings.length} sentences)` +
    toolSummary
  );

  emit('voice:llm:done', { text: finalText, model: lastLlm?.model, ttfbMs: firstLlm?.ttfbMs });
  emit('voice:idle', { reason: 'turn-complete' });
  return { transcript: userText, reply: finalText };
};
