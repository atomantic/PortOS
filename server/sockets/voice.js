// Per-socket voice handlers.
// Inbound:  voice:turn | voice:text | voice:interrupt | voice:reset
// Outbound: voice:transcript | voice:llm:delta | voice:llm:done | voice:tts:audio
//           | voice:tool | voice:error | voice:idle

import { runTurn } from '../services/voice/pipeline.js';
import { getVoiceConfig } from '../services/voice/config.js';
import { isIsoDate } from '../services/brainJournal.js';

// Cap by messages (each user utterance + assistant reply is ~2). 24 → ~12 turns.
const HISTORY_MESSAGES = 24;
// Payload size caps. Voice audio is typically 16 kHz mono PCM/WebM (~32 KB/s),
// so 8 MB leaves headroom for ~4 min of audio even in WAV. Text utterances are
// short; 4 KB covers any realistic spoken turn and rejects prompt-stuffing.
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_LEN = 4000;

const audioByteLength = (audio) => {
  if (Buffer.isBuffer(audio)) return audio.byteLength;
  if (audio instanceof ArrayBuffer) return audio.byteLength;
  if (ArrayBuffer.isView(audio)) return audio.byteLength;
  return 0;
};

export const registerVoiceHandlers = (socket) => {
  const state = {
    history: [],
    ctrl: null,
    dictation: { enabled: false, date: null },
  };

  const pushHistory = (role, content) => {
    if (!content) return;
    state.history.push({ role, content });
    if (state.history.length > HISTORY_MESSAGES) {
      state.history = state.history.slice(-HISTORY_MESSAGES);
    }
  };

  const runTurnWithState = async ({ audio, mimeType, text, source, errorStage }) => {
    state.ctrl?.abort();
    state.ctrl = new AbortController();
    const { signal } = state.ctrl;

    const emit = (event, data) => {
      if (signal.aborted) return;
      socket.emit(event, data);
    };

    try {
      const { transcript, reply } = await runTurn({
        audio, mimeType, text, source, history: state.history, emit, signal, state,
      });
      // Don't persist transcript/reply when the turn was aborted or superseded
      // by a newer turn — the user interrupted, and that output shouldn't
      // re-enter context on the next turn.
      if (signal.aborted || state.ctrl?.signal !== signal) return;
      // Skip history push while dictating — the transcripts aren't part of
      // the conversation with the CoS, just raw journal content. An exception:
      // the stop-dictation reply IS a normal assistant turn, push both sides.
      if (!state.dictation.enabled || reply) {
        pushHistory('user', transcript);
        pushHistory('assistant', reply);
      }
    } catch (err) {
      if (signal.aborted) return;
      console.error(`🎙️  ${errorStage} failed: ${err.message}`);
      socket.emit('voice:error', { stage: errorStage, message: err.message });
      socket.emit('voice:idle', { reason: 'error' });
    }
  };

  // Gate voice:turn / voice:text on the Settings voice.enabled toggle so the
  // disabled state isn't merely "don't provision PM2" — disabled clients can't
  // run the LLM/TTS pipeline either. Small race (config change mid-turn) is
  // acceptable: the per-turn check runs at event dispatch, not inside the
  // streaming loop.
  const ensureEnabled = async (stage) => {
    const cfg = await getVoiceConfig();
    if (cfg.enabled) return true;
    socket.emit('voice:error', { stage, message: 'voice mode disabled' });
    return false;
  };

  socket.on('voice:turn', async (payload = {}) => {
    if (!(await ensureEnabled('turn'))) return;
    const { audio, mimeType: rawMime } = payload;
    if (!audio) {
      socket.emit('voice:error', { stage: 'turn', message: 'audio is required' });
      return;
    }
    const size = audioByteLength(audio);
    if (!size) {
      socket.emit('voice:error', { stage: 'turn', message: 'audio is empty or unrecognized' });
      return;
    }
    if (size > MAX_AUDIO_BYTES) {
      socket.emit('voice:error', { stage: 'turn', message: `audio too large (${size} > ${MAX_AUDIO_BYTES} bytes)` });
      return;
    }
    // Normalize mimeType — reject anything that isn't a plain string to keep
    // downstream HTTP multipart stable.
    const mimeType = typeof rawMime === 'string' && rawMime.length <= 64 ? rawMime : 'audio/wav';
    // Preserve TypedArray byteOffset/byteLength so a sliced Uint8Array view
    // doesn't drag unrelated bytes from its underlying ArrayBuffer.
    let buffer;
    if (Buffer.isBuffer(audio)) buffer = audio;
    else if (audio instanceof ArrayBuffer) buffer = Buffer.from(audio);
    else if (ArrayBuffer.isView(audio)) buffer = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
    else buffer = Buffer.from(audio);
    await runTurnWithState({ audio: buffer, mimeType, errorStage: 'turn' });
  });

  socket.on('voice:text', async (payload = {}) => {
    if (!(await ensureEnabled('text'))) return;
    const raw = payload.text;
    if (typeof raw !== 'string' && typeof raw !== 'number') {
      socket.emit('voice:error', { stage: 'text', message: 'text is required' });
      return;
    }
    const text = String(raw).trim();
    if (!text) {
      socket.emit('voice:error', { stage: 'text', message: 'text is required' });
      return;
    }
    if (text.length > MAX_TEXT_LEN) {
      socket.emit('voice:error', { stage: 'text', message: `text too long (${text.length} > ${MAX_TEXT_LEN} chars)` });
      return;
    }
    await runTurnWithState({ text, source: payload.source, errorStage: 'text' });
  });

  socket.on('voice:interrupt', () => {
    state.ctrl?.abort();
    socket.emit('voice:idle', { reason: 'interrupted' });
  });

  socket.on('voice:reset', () => {
    state.ctrl?.abort();
    state.history = [];
    state.dictation = { enabled: false, date: null };
    socket.emit('voice:dictation', { enabled: false });
    socket.emit('voice:idle', { reason: 'reset' });
  });

  // Explicit UI control — user toggled dictation from the Daily Log page.
  // Validate the date to prevent malformed values from flowing into
  // appendJournal(), which would throw and break the dictation turn. Fall
  // back to the existing state date (or null to let the pipeline default to
  // today) rather than storing garbage. Read the payload defensively — a
  // client emitting `null` or a primitive would otherwise crash the
  // destructure before our validation runs.
  socket.on('voice:dictation:set', (payload) => {
    const { enabled, date } = payload && typeof payload === 'object' ? payload : {};
    const normalizedDate = isIsoDate(date) ? date : (state.dictation.date || null);
    state.dictation = { enabled: !!enabled, date: enabled ? normalizedDate : null };
    socket.emit('voice:dictation', { enabled: state.dictation.enabled, date: state.dictation.date });
  });

  socket.on('disconnect', () => {
    state.ctrl?.abort();
  });
};
