// Stream complete sentences through a per-turn TTS queue and emit canonical spoken replies.

import { anyAbortSignal } from '../../lib/requestAbort.js';
import { rememberTtsSentence } from './echo.js';
import { synthesizeAgentSpeech } from './channelAgent.js';

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

const reportTtsError = (err, signal, emit) => {
  // Piper can reject with a plain Error when synthesis is interrupted.
  if (signal?.aborted || err?.name === 'AbortError' || /aborted/i.test(err?.message || '')) return;
  emit('voice:error', { stage: 'tts', message: err?.message ?? String(err) });
};

// Canonical replies still complete in text when the synthesizer is unavailable.
export const emitSyntheticReply = async ({ reply, signal, recentTts, emit }) => {
  if (signal?.aborted) return;
  const audio = await synthesizeAgentSpeech(reply, { signal }).catch((err) => reportTtsError(err, signal, emit));
  if (signal?.aborted) return;
  if (audio) {
    if (recentTts) rememberTtsSentence(recentTts, reply);
    emit('voice:tts:audio', { sentence: reply, wav: audio.wav, latencyMs: audio.latencyMs });
  }
  emit('voice:llm:delta', { delta: reply });
  emit('voice:llm:done', { text: reply });
  emit('voice:idle', { reason: 'turn-complete' });
};

export const createTurnTtsSpeaker = ({ signal, state, emit, tlog }) => {
  let pending = '';
  const ttsTimings = [];
  let ttsIdx = 0;
  // Stop audio on LLM failure without making the socket treat it as a barge-in.
  const ttsController = new AbortController();
  const ttsSignal = anyAbortSignal([signal, ttsController.signal]);
  const cancel = (reason) => {
    if (ttsSignal.aborted) return;
    ttsController.abort();
    emit('voice:tts:cancel', { reason });
  };
  const speak = async (sentence) => {
    if (ttsSignal.aborted) return;
    const i = ++ttsIdx;
    const t0 = Date.now();
    tlog(`tts.start #${i} chars=${sentence.length}`);
    const { wav, latencyMs } = await synthesizeAgentSpeech(sentence, { signal: ttsSignal });
    if (ttsSignal.aborted) return;
    ttsTimings.push(latencyMs);
    tlog(`tts.done  #${i} ${latencyMs}ms synth+queue=${Date.now() - t0}ms`);
    // Track what we just said so the next inbound transcript can be checked
    // for echo. Done before emit so an immediately-arriving STT result on
    // the next event-loop tick already sees this sentence in the buffer.
    if (state?.recentTts) rememberTtsSentence(state.recentTts, sentence);
    emit('voice:tts:audio', { sentence, wav, latencyMs });
  };

  let synthQueue = Promise.resolve();
  const enqueueSpeak = (sentence) => {
    if (!sentence) return;
    synthQueue = synthQueue.then(() => speak(sentence)).catch((err) => reportTtsError(err, ttsSignal, emit));
  };
  const appendDelta = (delta) => {
    const { sentences, remainder } = splitSentences(pending + delta);
    pending = remainder;
    for (const sentence of sentences) enqueueSpeak(sentence);
  };

  const drain = () => {
    enqueueSpeak(pending.trim());
    return synthQueue;
  };

  return { appendDelta, cancel, drain, ttsTimings };
};
