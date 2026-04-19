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
import { appendJournal, getToday } from '../brainJournal.js';

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
    // speak as if it did. Small models (Qwen3-4B etc.) frequently *narrate*
    // the action — they say "Opening your daily log" without ever issuing
    // the tool_call. Be explicit about navigation/dictation verbs in
    // addition to the original capture/save verbs, and tell the model not
    // to echo or paraphrase the user's request as its own reply.
    lines.push(
      'You have tools for acting on the user\'s behalf. ' +
      'You MUST call the matching tool whenever the user requests an action — ' +
      'never describe the action in words instead of calling the tool. ' +
      'Trigger phrases that REQUIRE a tool call: ' +
      '"open"/"go to"/"take me to"/"show me"/"navigate to" → matching navigation tool (e.g., daily_log_open with startDictation=false). ' +
      'INTENT TO CREATE / WRITE in the daily log — phrases like "let\'s make a daily log", "let\'s make a new daily log", "start a daily log", "I want to make a log entry", "let me log something today", "new daily log", "let me add to my log" → call daily_log_open with startDictation=true. After this single tool call, STOP TALKING and let the user dictate freely — the dictation system handles every following utterance automatically without you. Do NOT say "I\'ll append it" or "what would you like to add" — the user already knows. Just confirm in one short sentence ("Daily log open, dictating now.") and stay quiet. ' +
      'When the user is asking you to write something specific into the log right now (e.g., "add to my log: I went to the gym", "note in today\'s log that X") → call daily_log_append with the exact text — never just say "Appending …" without actually issuing the tool call. ' +
      '"save"/"capture"/"add"/"remember"/"note"/"file"/"log it" → matching capture tool (e.g., brain_capture, meatspace_log_*, daily_log_append, goal_log_note). ' +
      '"start dictation"/"dictate"/"record my log" → daily_log_start_dictation. ' +
      '"what time"/"what day"/"what date" → time_now. ' +
      '"what are my goals"/"my goals" → goal_list. ' +
      '"is anything crashed"/"pm2 status"/"are services up" → pm2_status. ' +
      'NEVER reply with just the user\'s request echoed back (e.g., user says "open my daily log" — do NOT reply "open my daily log"; CALL daily_log_open). ' +
      'NEVER paraphrase the action as your reply ("Sure, opening your daily log now") without first calling the actual tool. ' +
      'After the tool runs, confirm briefly in one short sentence. ' +
      'If you reference the brain inbox, call it "brain inbox" (not "green inbox").'
    );
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

// Short correlation id so overlapping turns in the logs can be told apart
// (user interrupts, late-arriving retries). 5 chars of base36 randomness is
// plenty for single-user PortOS.
const shortId = () => Math.random().toString(36).slice(2, 7);

export const runTurn = async ({ audio, text, mimeType, source, history = [], emit, signal, state }) => {
  const cfg = await getVoiceConfig();
  if (signal?.aborted) return { transcript: '', reply: '' };

  const turnStart = Date.now();
  const turnId = shortId();
  const elapsed = () => Date.now() - turnStart;
  const tlog = (msg) => console.log(`🎙️ [${turnId}] ${msg} +${elapsed()}ms`);

  tlog(`turn.start source=${text ? 'text' : 'audio'} ${text ? `chars=${String(text).length}` : `bytes=${audio?.byteLength || audio?.length || 0} mime=${mimeType || '—'}`}`);

  let userText = text;
  let sttLatencyMs = 0;
  if (!userText) {
    tlog(`stt.start`);
    const stt = await transcribe(audio, { mimeType, signal });
    sttLatencyMs = stt.latencyMs;
    userText = isNonSpeechMarker(stt.text) ? '' : stt.text;
    tlog(`stt.done ${sttLatencyMs}ms chars=${userText.length} text="${userText.slice(0, 80)}${userText.length > 80 ? '…' : ''}"`);
    emit('voice:transcript', { text: userText, latencyMs: stt.latencyMs });
  } else {
    // VoiceWidget treats transcripts with source !== 'text' as server-STT
    // output and appends them to the chat log. Web Speech already appended
    // the user's words locally on onFinal, so reclassifying this echo as
    // 'voice' would duplicate the message. Keep `source` stable and expose
    // the caller's routing hint separately so dictation/Origin-aware code
    // can still distinguish typed vs spoken without breaking chat history.
    tlog(`input.text chars=${userText.length} source=${source || 'text'} text="${userText.slice(0, 80)}${userText.length > 80 ? '…' : ''}"`);
    emit('voice:transcript', {
      text: userText,
      latencyMs: 0,
      source: 'text',
      inputSource: source || 'text',
    });
  }

  if (!userText) {
    tlog(`done empty-input stt=${sttLatencyMs}ms`);
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
    // STT can return whitespace-only transcripts (Whisper on silent audio,
    // trailing partials). Don't fire a bogus append event with { entry: null };
    // just go idle and wait for the next utterance.
    if (!trimmed) {
      emit('voice:idle', { reason: 'empty-transcript' });
      return { transcript: userText, reply: '' };
    }
    if (STOP_DICTATION_RE.test(trimmed)) {
      state.dictation = { enabled: false, date: null };
      emit('voice:dictation', { enabled: false });
      const reply = 'Dictation off.';
      const { wav, latencyMs } = await synthesize(reply, { signal });
      // Report the real synth latency so the client's TTS timing stats
      // reflect actual work, not a hardcoded zero.
      if (!signal?.aborted) emit('voice:tts:audio', { sentence: reply, wav, latencyMs });
      emit('voice:llm:delta', { delta: reply });
      emit('voice:llm:done', { text: reply });
      emit('voice:idle', { reason: 'turn-complete' });
      return { transcript: userText, reply };
    }
    // Defensive: dictation can be enabled without a date (e.g. UI toggle
    // without a date, or tool side-effect missing one). Default to today so
    // we never throw here and kill the user's dictation turn.
    let date = state.dictation.date;
    if (!date) {
      date = await getToday();
      state.dictation.date = date;
      console.warn(`🎙️  dictation missing date; defaulting to ${date}`);
      emit('voice:dictation', { enabled: true, date });
    }
    const entry = await appendJournal(date, trimmed, { source: 'voice' });
    // Ship only the delta (new segment + metadata) rather than the full
    // entry. `entry.content` and `entry.segments` grow over the day, so
    // emitting the whole record per utterance would push socket payload
    // size and serialization cost toward O(n²) during long dictation
    // sessions. The client patches local state from these fields.
    const segments = Array.isArray(entry?.segments) ? entry.segments : [];
    const segment = segments.length ? segments[segments.length - 1] : null;
    emit('voice:dailyLog:appended', {
      date,
      text: trimmed,
      segment,
      segmentCount: segments.length,
      updatedAt: entry?.updatedAt,
    });
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
  let ttsIdx = 0;
  const speak = async (sentence) => {
    if (signal?.aborted || !sentence) return;
    const i = ++ttsIdx;
    const t0 = Date.now();
    tlog(`tts.start #${i} chars=${sentence.length}`);
    const { wav, latencyMs } = await synthesize(sentence, { signal });
    if (signal?.aborted) return;
    ttsTimings.push(latencyMs);
    tlog(`tts.done  #${i} ${latencyMs}ms synth+queue=${Date.now() - t0}ms`);
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

    const iterStart = Date.now();
    let firstDeltaAt = null;
    let deltaChars = 0;
    tlog(`llm.start iter=${iter + 1}/${maxIterations} model=${cfg.llm.model} tools=${toolSpecs?.length || 0} msgs=${messages.length}`);
    const llm = await streamChat(messages, {
      model: cfg.llm.model,
      signal,
      tools: toolSpecs,
      tag: turnId,
      onDelta: (delta) => {
        if (firstDeltaAt === null) {
          firstDeltaAt = Date.now();
          tlog(`llm.ttft  iter=${iter + 1} ${firstDeltaAt - iterStart}ms model=${lastLlm?.model || cfg.llm.model}`);
        }
        deltaChars += delta.length;
        emit('voice:llm:delta', { delta });
        flushSentence(delta);
      },
    });
    if (!firstLlm) firstLlm = llm;
    lastLlm = llm;
    tlog(`llm.done  iter=${iter + 1} ${Date.now() - iterStart}ms model=${llm.model} text=${(llm.text || '').length}c spoken=${deltaChars}c tool_calls=${llm.toolCalls?.length || 0} finish=${llm.finishReason ?? '—'}`);
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
        const argSummary = Object.keys(args).length ? Object.entries(args).map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 40)}`).join(' ') : '—';
        tlog(`tool.start ${tc.function.name} ${argSummary}`);
        result = await dispatchTool(tc.function.name, args, ctx);
        const ms = Date.now() - t0;
        toolRuns.push({ name: tc.function.name, ok: true, ms });
        tlog(`tool.done  ${tc.function.name} ok ${ms}ms`);
      } catch (err) {
        const ms = Date.now() - t0;
        result = { ok: false, error: err.message };
        toolRuns.push({ name: tc.function.name, ok: false, ms, error: err.message });
        tlog(`tool.fail  ${tc.function.name} ${ms}ms err="${err.message}"`);
      }
      // Apply server-side side-effects (dictation state) and forward
      // client-facing side-effects (navigation) over the socket.
      for (const fx of ctx.sideEffects) {
        if (fx.type === 'dictation' && state) {
          // When disabling dictation, clear the date so it can't leak to the
          // UI or be picked up by the next enable. A stale date is worse than
          // null — it can cause surprising "jumped back to April 17" behavior.
          const enabled = !!fx.enabled;
          state.dictation = {
            enabled,
            date: enabled ? (fx.date || state.dictation?.date || null) : null,
          };
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
    `🎙️ [${turnId}] turn.summary ${inputKind} ${totalMs}ms — ` +
    `stt=${sttLatencyMs}ms · ` +
    `llm[${lastLlm?.model}] ttft=${firstLlm?.ttfbMs ?? '—'}ms total=${lastLlm?.totalMs}ms finish=${lastLlm?.finishReason ?? '—'} · ` +
    `tts=${ttsTotal}ms (${ttsTimings.length} sentences)` +
    toolSummary
  );

  // Surface the silent-empty-reply case — most commonly caused by picking a
  // model that doesn't speak the OpenAI tool-calling API (e.g., IBM Granite,
  // which emits `<tool_call>[...]</tool_call>` inline in content), especially
  // when many tools are attached and the model bails with a zero-length
  // stream. Without this the user sees their transcript, then silence.
  if (!signal?.aborted && !finalText.trim() && toolRuns.length === 0) {
    const hint = toolsEnabled
      ? `Model ${lastLlm?.model || cfg.llm.model} returned no response. It may not support OpenAI tool-calling with ${toolSpecs?.length || 0} tools — try a tool-use model (Qwen2.5-Instruct, Hermes-3, Mistral) or disable voice tools in Settings.`
      : `Model ${lastLlm?.model || cfg.llm.model} returned no response.`;
    console.warn(`🎙️  empty LLM output — ${hint}`);
    emit('voice:error', { stage: 'llm', message: hint });
  }

  emit('voice:llm:done', { text: finalText, model: lastLlm?.model, ttfbMs: firstLlm?.ttfbMs });
  emit('voice:idle', { reason: 'turn-complete' });
  return { transcript: userText, reply: finalText };
};
