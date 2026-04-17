// Per-socket voice handlers.
// Inbound:  voice:turn | voice:text | voice:interrupt | voice:reset
// Outbound: voice:transcript | voice:llm:delta | voice:llm:done | voice:tts:audio
//           | voice:error | voice:idle

import { runTurn } from '../services/voice/pipeline.js';

const HISTORY_TURNS = 12; // keep last N messages (user+assistant) per socket

export const registerVoiceHandlers = (socket) => {
  const state = {
    history: [],
    ctrl: null,
    dictation: { enabled: false, date: null },
  };

  const pushHistory = (role, content) => {
    if (!content) return;
    state.history.push({ role, content });
    if (state.history.length > HISTORY_TURNS) {
      state.history = state.history.slice(-HISTORY_TURNS);
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
      // Skip history push while dictating — the transcripts aren't part of
      // the conversation with the CoS, just raw journal content.
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

  socket.on('voice:turn', async (payload = {}) => {
    const { audio, mimeType = 'audio/wav' } = payload;
    if (!audio) {
      socket.emit('voice:error', { stage: 'turn', message: 'audio is required' });
      return;
    }
    const buffer = Buffer.isBuffer(audio)
      ? audio
      : Buffer.from(audio instanceof ArrayBuffer ? audio : audio.buffer || audio);
    await runTurnWithState({ audio: buffer, mimeType, errorStage: 'turn' });
  });

  socket.on('voice:text', async (payload = {}) => {
    const text = (payload.text || '').toString().trim();
    if (!text) {
      socket.emit('voice:error', { stage: 'text', message: 'text is required' });
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
  socket.on('voice:dictation:set', ({ enabled, date } = {}) => {
    state.dictation = { enabled: !!enabled, date: date || null };
    socket.emit('voice:dictation', { enabled: state.dictation.enabled, date: state.dictation.date });
  });

  socket.on('disconnect', () => {
    state.ctrl?.abort();
  });
};
