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
  };

  const pushHistory = (role, content) => {
    if (!content) return;
    state.history.push({ role, content });
    if (state.history.length > HISTORY_TURNS) {
      state.history = state.history.slice(-HISTORY_TURNS);
    }
  };

  const runTurnWithState = async ({ audio, mimeType, text, errorStage }) => {
    state.ctrl?.abort();
    state.ctrl = new AbortController();
    const { signal } = state.ctrl;

    const emit = (event, data) => {
      if (signal.aborted) return;
      socket.emit(event, data);
    };

    try {
      const { transcript, reply } = await runTurn({
        audio, mimeType, text, history: state.history, emit, signal,
      });
      pushHistory('user', transcript);
      pushHistory('assistant', reply);
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
    await runTurnWithState({ text, errorStage: 'text' });
  });

  socket.on('voice:interrupt', () => {
    state.ctrl?.abort();
    socket.emit('voice:idle', { reason: 'interrupted' });
  });

  socket.on('voice:reset', () => {
    state.ctrl?.abort();
    state.history = [];
    socket.emit('voice:idle', { reason: 'reset' });
  });

  socket.on('disconnect', () => {
    state.ctrl?.abort();
  });
};
