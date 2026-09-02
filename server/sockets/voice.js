// Per-socket voice handlers.
// Inbound:  voice:turn | voice:text | voice:interrupt | voice:reset
//           | voice:dictation:set | voice:ui:index | voice:screenshot:result
//           | voice:ui:read-response | voice:output:available | voice:output:claim
// Outbound: voice:transcript | voice:llm:delta | voice:llm:done | voice:tts:audio
//           | voice:tts:cancel | voice:tool | voice:dictation | voice:navigate
//           | voice:ui:click | voice:ui:fill | voice:ui:select | voice:ui:check
//           | voice:ui:read-request
//           | voice:dailyLog:appended | voice:error | voice:idle
//           | voice:screenshot:request
//           | voice:speak | voice:output:primary | voice:output:detached
// Call host (FaceTime Audio bridge):
// Inbound:  voice:call:attach | voice:call:audio | voice:call:detach | voice:call:hangup
// Outbound: voice:call:state | voice:call:tts
// Meeting capture (same page, same audio bridge, no LLM — STT only):
// Inbound:  voice:capture:start | voice:call:audio | voice:capture:stop
// Outbound: voice:capture:state

import { runTurn } from '../services/voice/pipeline.js';
import { getVoiceConfig } from '../services/voice/config.js';
import { registerEchoBuffer, unregisterEchoBuffer } from '../services/voice/echo.js';
import {
  registerVoiceOutputCandidate,
  claimVoiceOutput,
  releaseVoiceOutput,
} from '../services/voice/voiceOutput.js';
import { isIsoDate } from '../services/brainJournal.js';
import { pcmToWavBuffer } from '../lib/chiptuneRender.js';
import { transcribe } from '../services/voice/stt.js';
import { CALL_AUDIO_SAMPLE_RATE, createCallEndpointer, pcmToFloat } from '../services/voice/callEndpointing.js';
import {
  attachHost,
  detachHost,
  endCall,
  getCallContext,
  getCallHost,
  getCallState,
  isCallActive,
  markListening,
  markSpeaking,
  noteCallerSpeech,
  recordTurn,
  setCallStateListener,
  takeCallOpeningLine,
} from '../services/voice/callSession.js';
import { synthesize } from '../services/voice/tts.js';
import {
  attachCaptureHost,
  detachCaptureHost,
  endCapture,
  getCaptureHost,
  isCaptureActive,
  recordUtterance,
  setCaptureStateListener,
  startCapture,
} from '../services/voice/captureSession.js';

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
// One PCM frame from the call host. The page ships ~20 ms of 16 kHz mono Int16
// (640 bytes); 64 KB is two seconds of headroom for a delayed flush and rejects
// a runaway client without ever clipping a normal burst.
const MAX_CALL_FRAME_BYTES = 64 * 1024;

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
    try {
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
    } catch (err) {
      console.error(`❌ voice:turn failed: ${err.message}`);
      socket.emit('voice:error', { stage: 'turn', message: err.message });
    }
  });

  socket.on('voice:text', async (payload = {}) => {
    try {
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
    } catch (err) {
      console.error(`❌ voice:text failed: ${err.message}`);
      socket.emit('voice:error', { stage: 'text', message: err.message });
    }
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
    try {
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
    } catch (err) {
      console.error(`❌ voice:dictation:set failed: ${err.message}`);
      socket.emit('voice:error', { stage: 'dictation', message: err.message });
    }
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

  // A real browser tab announces itself as a possible recipient of proactive
  // (server-initiated) voice output on connect. Only sockets that send this are
  // eligible — registering EVERY connection would make non-playing sockets
  // (e.g. a federated peer's Socket.IO relay client, which lands on the same
  // io.on('connection')) eligible, and electing one as primary would silently
  // route proactive audio into a socket that never plays it. It does NOT become
  // the sole recipient until it claims output (below). See voiceOutput.js.
  socket.on('voice:output:available', () => {
    registerVoiceOutputCandidate(socket);
  });

  // The user's active tab claims proactive voice output — whichever tab is
  // focused/visible (or where the user explicitly clicked "speak here") becomes
  // the single recipient of `voice:speak`. Last claim wins; the previous holder
  // is notified via voice:output:detached so its UI can reflect the handoff.
  socket.on('voice:output:claim', () => {
    claimVoiceOutput(socket);
  });

  // ---------------------------------------------------------------------------
  // Call host — the FaceTime Audio bridge.
  //
  // The page is a plain browser tab reading BlackHole, so it speaks the same
  // socket the widget does. What differs is the shape of the input: a
  // continuous PCM stream with no push-to-talk, endpointed here into the same
  // `runTurn` utterances the microphone produces, and the destination of the
  // reply, which is played into the call rather than out of the speakers.
  // ---------------------------------------------------------------------------
  const call = { endpointer: null, busy: false, ctrl: null };

  // Speak the line the caller was rung to hear, once, as soon as the far end
  // picks up. Without this a mind-placed call connects to silence and the user
  // says "hello?" into a bot that has not been told why it is on the phone.
  const deliverOpeningLine = async () => {
    // Busy is checked BEFORE consuming: taking the line while a turn is in
    // flight would drop it for good. Leaving it pending means the next state
    // emit (that turn's own markListening) retries it.
    if (call.busy) return;
    const line = takeCallOpeningLine();
    if (!line) return;
    call.busy = true;
    markSpeaking();
    try {
      const { wav, latencyMs } = await synthesize(line);
      socket.emit('voice:call:tts', { sentence: line, wav, latencyMs });
      recordTurn('assistant', line);
    } finally {
      call.busy = false;
      markListening();
    }
  };

  const emitCallState = (snapshot) => {
    socket.emit('voice:call:state', snapshot);
    // 'listening' is the first state the poll reaches once the helper reports a
    // connected call. `takeCallOpeningLine` is consume-once, so the repeated
    // state emits this broadcast produces cannot repeat the line.
    if (snapshot?.state === 'listening') {
      deliverOpeningLine().catch((err) => console.error(`❌ voice call: opening line failed: ${err.message}`));
    }
  };

  const runCallUtterance = async (utterance) => {
    call.busy = true;
    markSpeaking();
    call.ctrl?.abort();
    call.ctrl = new AbortController();
    const { signal } = call.ctrl;
    let spoken = '';
    try {
      await runTurn({
        audio: pcmToWavBuffer(pcmToFloat(utterance.pcm), { sampleRate: CALL_AUDIO_SAMPLE_RATE }),
        mimeType: 'audio/wav',
        history: state.history,
        state,
        signal,
        // A mind-placed call carries the mind's own briefing, so the voice on
        // the phone continues that conversation instead of answering cold.
        systemContext: getCallContext(),
        // The pipeline speaks the widget's event vocabulary; only the audio is
        // re-addressed, so persona, tools, and the confirm gate are unchanged.
        emit: (event, data) => {
          if (signal.aborted) return;
          if (event === 'voice:tts:audio') {
            spoken = data?.sentence || spoken;
            socket.emit('voice:call:tts', data);
            return;
          }
          if (event === 'voice:transcript' && data?.text) recordTurn('caller', data.text);
          socket.emit(event, data);
        },
      });
      if (signal.aborted) return;
      if (spoken) recordTurn('assistant', spoken);
    } catch (err) {
      if (signal.aborted) return;
      console.error(`📞 call turn failed: ${err.message}`);
      socket.emit('voice:error', { stage: 'call', message: err.message });
    } finally {
      call.busy = false;
      markListening();
    }
  };

  socket.on('voice:call:attach', async () => {
    try {
      if (!(await ensureEnabled('call'))) return;
      // Mutually exclusive with meeting capture: both want the same BlackHole
      // input device and the same host tab, and a call also wants BlackHole
      // 2ch to talk back through — running both at once would fight over the
      // device rather than fail closed with a clear reason.
      if (isCaptureActive() || getCaptureHost() === socket) {
        socket.emit('voice:call:state', { error: 'capture-active', hostAttached: false, active: false, state: 'idle' });
        return;
      }
      const claim = attachHost(socket);
      if (!claim.ok) {
        // Refused, not displaced: two tabs reading the same device would each
        // answer, and the loser could not tell it had been muted.
        socket.emit('voice:call:state', { error: claim.reason, hostAttached: false, active: false, state: 'idle' });
        return;
      }
      call.endpointer = createCallEndpointer();
      setCallStateListener(emitCallState);
      emitCallState(claim.state);
    } catch (err) {
      console.error(`❌ voice:call:attach failed: ${err.message}`);
      socket.emit('voice:error', { stage: 'call', message: err.message });
    }
  });

  socket.on('voice:call:audio', async (payload = {}) => {
    try {
      const asCallHost = getCallHost() === socket && call.endpointer;
      const asCaptureHost = getCaptureHost() === socket && capture.endpointer;
      if (!asCallHost && !asCaptureHost) return;
      const { pcm } = payload || {};
      const bytes = audioByteLength(pcm);
      if (!bytes || bytes > MAX_CALL_FRAME_BYTES) return;
      const view = Buffer.isBuffer(pcm) || ArrayBuffer.isView(pcm)
        ? new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2))
        : new Int16Array(pcm);

      if (asCallHost) {
        const utterance = call.endpointer.push(view);
        // Barge-in: the caller talking over a reply cancels it, exactly as
        // pressing the widget's interrupt does.
        if (call.endpointer.speaking && call.busy) {
          call.ctrl?.abort();
          state.pendingDestructive = null;
          socket.emit('voice:interrupt', { reason: 'barge-in' });
        }
        if (!utterance) return;
        noteCallerSpeech();
        if (call.busy) return;
        await runCallUtterance(utterance);
        return;
      }

      // Meeting capture: STT only, never the LLM/tools pipeline (no
      // cold-bootstrap AI calls — see AGENTS.md). Utterances are queued and
      // transcribed one at a time so a burst of speech can't run two whisper
      // requests concurrently and interleave the transcript out of order.
      const utterance = capture.endpointer.push(view);
      if (utterance) enqueueCaptureUtterance(utterance);
    } catch (err) {
      console.error(`❌ voice:call:audio failed: ${err.message}`);
    }
  });

  socket.on('voice:call:detach', async () => {
    try {
      call.endpointer = null;
      emitCallState(await detachHost(socket));
    } catch (err) {
      // Socket.IO hands a listener's promise to nobody: an unguarded throw in
      // here surfaces as an unhandled rejection, which Node terminates the
      // process for — taking every agent run, PTY session and media job with
      // it. A detach during a live call funnels into endCall(), the same
      // teardown voice:call:hangup guards below for exactly this reason. Emit
      // the current state anyway so the client's call widget leaves its
      // detaching state instead of hanging.
      console.error(`❌ voice:call:detach failed: ${err.message}`);
      emitCallState(getCallState());
    }
  });

  // Hang up the active call from any tab, not just the one carrying the
  // audio — the Mind tab's "Hang up" button is not the call host. Routed
  // through endCall() (not a raw facetimeBridge.hangup()) so the session is
  // cleaned up the same way any other end-of-call is: journal write, mind
  // handoff, state reset. A no-op when nothing is active.
  socket.on('voice:call:hangup', async () => {
    try {
      if (isCallActive()) await endCall('user-hangup');
    } catch (err) {
      console.error(`❌ voice:call:hangup failed: ${err.message}`);
    }
  });

  // ---------------------------------------------------------------------------
  // Meeting capture — the same call-host page's other mode. Reads the same
  // BlackHole 16ch device and rides the same `voice:call:audio` PCM frames,
  // but only transcribes: it never runs the LLM/tools pipeline and never
  // plays anything back. Stopping finalizes whatever is still buffered in the
  // endpointer, then writes the transcript to the journal and the inbox.
  // ---------------------------------------------------------------------------
  const capture = { endpointer: null, queue: Promise.resolve() };

  const emitCaptureState = (snapshot) => socket.emit('voice:capture:state', snapshot);

  const runCaptureUtterance = async (utterance) => {
    try {
      const { text } = await transcribe(
        pcmToWavBuffer(pcmToFloat(utterance.pcm), { sampleRate: CALL_AUDIO_SAMPLE_RATE }),
        { mimeType: 'audio/wav' },
      );
      if (text) emitCaptureState(recordUtterance(text));
    } catch (err) {
      console.error(`🎙️ capture transcribe failed: ${err.message}`);
      socket.emit('voice:error', { stage: 'capture', message: err.message });
    }
  };

  // Serialize onto a per-socket queue (AGENTS.md: async handlers mutating
  // shared module-level state must not fire concurrently) rather than
  // dropping an utterance that arrives mid-transcription — a dropped chunk
  // here is lost meeting content, not a superseded turn like call barge-in.
  const enqueueCaptureUtterance = (utterance) => {
    capture.queue = capture.queue.then(() => runCaptureUtterance(utterance));
    return capture.queue;
  };

  socket.on('voice:capture:start', async () => {
    try {
      if (!(await ensureEnabled('capture'))) return;
      if (isCallActive() || getCallHost() === socket) {
        socket.emit('voice:capture:state', { error: 'call-active', hostAttached: false, active: false, state: 'idle' });
        return;
      }
      const claim = attachCaptureHost(socket);
      if (!claim.ok) {
        socket.emit('voice:capture:state', { error: claim.reason, hostAttached: false, active: false, state: 'idle' });
        return;
      }
      const started = startCapture(socket);
      if (!started.ok) {
        socket.emit('voice:capture:state', { error: started.reason, hostAttached: true, active: false, state: 'idle' });
        return;
      }
      capture.endpointer = createCallEndpointer();
      capture.queue = Promise.resolve();
      setCaptureStateListener(emitCaptureState);
      emitCaptureState(started.state);
    } catch (err) {
      console.error(`❌ voice:capture:start failed: ${err.message}`);
      socket.emit('voice:error', { stage: 'capture', message: err.message });
    }
  });

  socket.on('voice:capture:stop', async () => {
    try {
      if (getCaptureHost() !== socket) return;
      // Finalize whatever speech is still buffered rather than dropping the
      // last few seconds of the meeting on the floor.
      const pending = capture.endpointer?.flush();
      if (pending) enqueueCaptureUtterance(pending);
      await capture.queue.catch(() => {});
      capture.endpointer = null;
      const ended = await endCapture('stopped');
      emitCaptureState(ended);
      emitCaptureState(await detachCaptureHost(socket));
    } catch (err) {
      console.error(`❌ voice:capture:stop failed: ${err.message}`);
      socket.emit('voice:error', { stage: 'capture', message: err.message });
    }
  });

  socket.on('disconnect', () => {
    // Drop this tab from the voice-output registry; if it was the sole
    // recipient, output is promoted to another live tab so proactive audio
    // keeps exactly one home.
    releaseVoiceOutput(socket);
    state.ctrl?.abort();
    call.ctrl?.abort();
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
    // A closed tab is a detached host: the call loses its audio path, so the
    // session ends rather than running on deaf.
    if (getCallHost() === socket) {
      call.endpointer = null;
      detachHost(socket).catch((err) => console.error(`❌ voice call detach failed: ${err.message}`));
    }
    // Same for meeting capture — best-effort, no final flush of whatever was
    // still mid-utterance (matches the call path above, which drops its own
    // in-flight endpointer buffer on disconnect the same way).
    if (getCaptureHost() === socket) {
      capture.endpointer = null;
      detachCaptureHost(socket).catch((err) => console.error(`❌ voice capture detach failed: ${err.message}`));
    }
  });
};

// Re-exported for the call-host page's own smoke checks and for tests that
// assert the frame cap without standing up a socket.
export { MAX_CALL_FRAME_BYTES };
