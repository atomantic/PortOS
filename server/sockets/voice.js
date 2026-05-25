// Per-socket voice handlers.
// Inbound:  voice:turn | voice:text | voice:interrupt | voice:reset
//           | voice:dictation:set | voice:ui:index | voice:screenshot:result
//           | voice:ui:read-response
// Outbound: voice:transcript | voice:llm:delta | voice:llm:done | voice:tts:audio
//           | voice:tool | voice:dictation | voice:navigate
//           | voice:ui:click | voice:ui:fill | voice:ui:select | voice:ui:check
//           | voice:ui:read-request
//           | voice:dailyLog:appended | voice:error | voice:idle
//           | voice:screenshot:request

import { runTurn } from '../services/voice/pipeline.js';
import { getVoiceConfig } from '../services/voice/config.js';
import { registerEchoBuffer, unregisterEchoBuffer } from '../services/voice/echo.js';
import { isIsoDate } from '../services/brainJournal.js';

// Cap by messages (each user utterance + assistant reply is ~2). 24 → ~12 turns.
const HISTORY_MESSAGES = 24;
// Payload size caps. Voice audio is typically 16 kHz mono PCM/WebM (~32 KB/s),
// so 8 MB leaves headroom for ~4 min of audio even in WAV. Text utterances are
// short; 4 KB covers any realistic spoken turn and rejects prompt-stuffing.
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_LEN = 4000;
// Cap on the visible-text snapshot the client ships alongside each UI index.
// Matches `MAX_TEXT_CHARS` in `client/src/services/domIndex.js` so the ~8 KB
// limit documented on the `ui_read` tool is enforced consistently whether the
// truncation happens client-side (well-behaved widget) or server-side here
// (runaway / malicious client). The client already does word-boundary
// truncation; we re-do it server-side so the guarantee holds end-to-end.
const MAX_UI_TEXT_CHARS = 8000;

// Truncate on the last whitespace boundary (space / newline / tab) so the
// tail isn't a partial token, then append an ellipsis. Mirrors the
// client-side truncation in `domIndex.js` so the shape of `ui.text` is
// identical regardless of which side trimmed it. We match ANY whitespace,
// not just space, because the client's `joined` snapshot inserts `\n\n`
// between blocks — a strict space-only search would hard-cut mid-token
// whenever the nearest break is a block separator.
// Exported for direct unit testing without standing up a real socket.
export const truncateOnWordBoundary = (text, max) => {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  // /\s\S*$/ finds the LAST whitespace character (followed by zero or more
  // non-whitespace chars to end-of-string). Returns -1 when no whitespace
  // exists at all (a single mega-token longer than `max`), in which case
  // we hard-cut at `max` rather than emit an empty string.
  const lastWs = cut.search(/\s\S*$/);
  return `${cut.slice(0, lastWs > 0 ? lastWs : max)}…`;
};

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
    ui: null, // { path, title, elements:[{ ref, kind, label, ... }], text?, textOnDemand, updatedAt }
    // Promises awaiting the NEXT voice:ui:index arrival — used by the
    // pipeline to chain ui_* actions within one LLM turn: after firing a
    // ui:click, wait for the client's fresh index before the next tool
    // runs so the LLM can see the modal/new content it just opened.
    uiWaiters: [],
    // Resolvers keyed by requestId, awaiting a voice:screenshot:result for an
    // in-flight ui_describe_visually capture. The server emits
    // voice:screenshot:request with a requestId, the client captures the active
    // tab and replies with the same requestId + a data URL. Keying by id stops
    // a late result from an earlier capture satisfying a newer waiter.
    screenshotWaiters: new Map(),
    // Resolvers keyed by requestId, awaiting a voice:ui:read-response. The
    // ui_read tool emits voice:ui:read-request and parks a resolver here so
    // the heavy visible-text blob is only computed by the client (and shipped
    // over the wire) when actually needed — not eagerly on every index push.
    uiTextWaiters: new Map(),
    // Ring of recently-spoken TTS sentences (with cached trigrams). The
    // pipeline uses this to detect the bot's own voice being echoed back
    // through the user's mic when laptop speakers are in play. The buffer is
    // also registered in the module-scope echo registry so server-broadcast
    // proactive speech can remember itself across every connected socket
    // without needing a per-socket context.
    recentTts: [],
  };
  registerEchoBuffer(state.recentTts);

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
    const raw = payload?.text;
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
    await runTurnWithState({ text, source: payload?.source, errorStage: 'text' });
  });

  socket.on('voice:interrupt', () => {
    state.ctrl?.abort();
    // Clear any pending destructive-confirmation gate — after an interrupt
    // the user's next "yes" should NOT be consumed as confirmation of a
    // stale, abandoned destructive action.
    state.pendingDestructive = null;
    socket.emit('voice:idle', { reason: 'interrupted' });
  });

  socket.on('voice:reset', () => {
    state.ctrl?.abort();
    state.history = [];
    state.dictation = { enabled: false, date: null };
    // Same safety guard as voice:interrupt — a reset wipes conversation
    // context, so a pending destructive click from the prior turn must
    // not survive into the next utterance.
    state.pendingDestructive = null;
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
  //
  // Gated on the same voice.enabled toggle as voice:turn / voice:text: if
  // voice is disabled, turning dictation *on* would leave the UI in a
  // dictating state while subsequent voice turns would be rejected. Force
  // dictation off and surface the error instead. Disabling is always
  // allowed — it's a clean-up path that can run regardless of config.
  socket.on('voice:dictation:set', async (payload) => {
    const { enabled, date } = payload && typeof payload === 'object' ? payload : {};
    if (enabled && !(await ensureEnabled('dictation'))) {
      // Ensure UI and server agree that dictation is off after a blocked
      // enable, otherwise the UI can silently drift into "dictating" state.
      state.dictation = { enabled: false, date: null };
      socket.emit('voice:dictation', { enabled: false });
      return;
    }
    const normalizedDate = isIsoDate(date) ? date : (state.dictation.date || null);
    state.dictation = { enabled: !!enabled, date: enabled ? normalizedDate : null };
    socket.emit('voice:dictation', { enabled: state.dictation.enabled, date: state.dictation.date });
  });

  // Client pushes the current page's DOM index whenever voice is enabled
  // and the user navigates or the DOM mutates. The pipeline injects a
  // compact summary into each LLM turn so it can drive the UI by label
  // (ui_click, ui_fill, ui_select, ui_check).
  socket.on('voice:ui:index', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const { path, title, elements, text, textOnDemand } = payload;
    if (!Array.isArray(elements)) return;
    // Cap elements at 200 to bound prompt size from a malicious or runaway
    // client. (The visible-text `text` field has its own ~8 KB cap, enforced
    // below via `truncateOnWordBoundary(MAX_UI_TEXT_CHARS)` — see the
    // module-level constant for the rationale.)
    const MAX_ELEMENTS = 200;
    const filtered = elements
      .filter((e) => e && typeof e === 'object' && typeof e.ref === 'number' && typeof e.label === 'string')
      .slice(0, MAX_ELEMENTS);
    state.ui = {
      path: typeof path === 'string' ? path.slice(0, 256) : null,
      title: typeof title === 'string' ? title.slice(0, 120) : null,
      elements: filtered,
      // Eager-text legacy path: an index that ships `text` is used as-is by
      // ui_read. Lazy path: `textOnDemand` tells the server it can fetch the
      // visible text on demand via voice:ui:read-request. Exactly one of these
      // is set by the client per the buildIndex() contract.
      text: typeof text === 'string' ? truncateOnWordBoundary(text, MAX_UI_TEXT_CHARS) : null,
      textOnDemand: textOnDemand === true,
      updatedAt: Date.now(),
    };
    if (state.uiWaiters.length) {
      const waiters = state.uiWaiters;
      state.uiWaiters = [];
      waiters.forEach((resolve) => resolve(state.ui));
    }
  });

  // Client replies to a voice:screenshot:request with a base64 data URL of the
  // captured tab (or null if capture failed / the user denied permission). The
  // requestId echoes the request so a late result can't resolve a newer waiter.
  // Cap the payload to bound memory from a runaway/malicious client — a
  // full-screen PNG data URL is typically a few MB, so 16 MB is generous.
  const MAX_SCREENSHOT_BYTES = 16 * 1024 * 1024;
  socket.on('voice:screenshot:result', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const { requestId, dataUrl: raw } = payload;
    const dataUrl = (typeof raw === 'string' && raw.startsWith('data:image/') && raw.length <= MAX_SCREENSHOT_BYTES)
      ? raw
      : null;
    const resolve = state.screenshotWaiters.get(requestId);
    if (resolve) {
      state.screenshotWaiters.delete(requestId);
      resolve(dataUrl);
    }
  });

  // Lazy visible-text reply. The ui_read tool emitted voice:ui:read-request;
  // the client recomputed extractVisibleText on the live DOM and sent it back
  // here. Re-apply the same ~8 KB word-boundary cap server-side so a runaway
  // client can't blow past it, then resolve the matching waiter. Echo of the
  // requestId correlates the response with the awaiting ui_read call.
  socket.on('voice:ui:read-response', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const { requestId, text } = payload;
    const capped = typeof text === 'string' ? truncateOnWordBoundary(text, MAX_UI_TEXT_CHARS) : null;
    const resolve = state.uiTextWaiters.get(requestId);
    if (resolve) {
      state.uiTextWaiters.delete(requestId);
      // Resolve only — caching onto state.ui.text happens inside requestUiText
      // (pipeline.js), which captured the snapshot this read was issued for and
      // caches only if it's still current. Caching here couldn't tell whether
      // the snapshot changed (navigation) between request and response.
      resolve(capped);
    }
  });

  socket.on('disconnect', () => {
    state.ctrl?.abort();
    // Abort any pending UI refresh waiters so their turns don't hang.
    const waiters = state.uiWaiters;
    state.uiWaiters = [];
    waiters.forEach((resolve) => resolve(null));
    // Same for any pending screenshot capture.
    const shotWaiters = Array.from(state.screenshotWaiters.values());
    state.screenshotWaiters.clear();
    shotWaiters.forEach((resolve) => resolve(null));
    // Same for any pending lazy-text read waiters — resolve null so a
    // ui_read awaiting a response that will never arrive doesn't hang.
    const textWaiters = Array.from(state.uiTextWaiters.values());
    state.uiTextWaiters.clear();
    textWaiters.forEach((resolve) => resolve(null));
    unregisterEchoBuffer(state.recentTts);
  });
};
