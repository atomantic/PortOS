import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Force the enabled-gate open so the validation tests below deterministically
// exercise the size/text guards (ensureEnabled runs BEFORE every guard; with
// the real config loader the file read fails in this harness and its error
// would mask the guard under test).
vi.mock(import('../services/voice/config.js'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getVoiceConfig: vi.fn(async () => ({ enabled: true })),
  };
});

// The call host speaks its opening line through the real TTS entry point;
// stub it so the suite never loads a speech model.
vi.mock('../services/voice/tts.js', () => ({
  synthesize: vi.fn(async (text) => ({ wav: Buffer.from(`wav:${text}`), latencyMs: 1 })),
}));
// Meeting capture transcribes over the network (whisper.cpp's HTTP server);
// stub it so the capture-routing tests below run offline and deterministically.
vi.mock('../services/voice/stt.js', () => ({ transcribe: vi.fn() }));
// The call-host audio path (runCallUtterance) drives the full LLM/tools
// pipeline; stub it so the barge-in test below can observe exactly what
// signal a call turn was given without a real STT/LLM/TTS round trip.
vi.mock('../services/voice/pipeline.js', () => ({ runTurn: vi.fn(async () => ({})) }));

const { truncateOnWordBoundary, registerVoiceHandlers } = await import('./voice.js');
const {
  getVoiceOutputSocket,
  emitVoiceOutput,
  __resetVoiceOutput,
} = await import('../services/voice/voiceOutput.js');
const { transcribe } = await import('../services/voice/stt.js');
const { runTurn } = await import('../services/voice/pipeline.js');
const {
  attachHost: attachCallHost,
  __resetCallSession,
  __setCallSessionDeps,
  getCallState,
  pollCall,
  startCall,
} = await import('../services/voice/callSession.js');
const {
  __resetCaptureSession,
  __setCaptureSessionDeps,
  getCaptureState,
} = await import('../services/voice/captureSession.js');

// Minimal fake socket: records on() handlers so tests can fire inbound events,
// and captures emit() calls. No real Socket.IO needed — the voice:ui:index /
// voice:ui:read-response handlers are pure state mutations.
const makeFakeSocket = () => {
  const handlers = new Map();
  const emitted = [];
  return {
    on: (event, fn) => { handlers.set(event, fn); },
    emit: (event, payload) => { emitted.push({ event, payload }); },
    fire: (event, payload) => handlers.get(event)?.(payload),
    has: (event) => handlers.has(event),
    emitted,
  };
};

describe('truncateOnWordBoundary', () => {
  it('returns input untouched when shorter than the cap', () => {
    expect(truncateOnWordBoundary('hello world', 100)).toBe('hello world');
  });

  it('returns input untouched when exactly the cap', () => {
    const s = 'a'.repeat(10);
    expect(truncateOnWordBoundary(s, 10)).toBe(s);
  });

  it('truncates on the last space and appends an ellipsis', () => {
    // 'one two three four' length=18; cap=11 → 'one two thr' → last space at 7 → 'one two…'
    const out = truncateOnWordBoundary('one two three four', 11);
    expect(out).toBe('one two…');
  });

  it('falls back to a hard cut when there is no space before the cap', () => {
    // No spaces in the prefix → can't find a word boundary, hard-cut.
    const out = truncateOnWordBoundary('abcdefghij more words', 5);
    expect(out).toBe('abcde…');
  });

  // The client's extractVisibleText joins blocks with '\n\n', so the
  // truncation must find the LAST whitespace of any kind — not just a
  // literal space. Without this, a newline-separated block boundary
  // landing before the cap would still hard-cut mid-token.
  it('truncates on a newline boundary when no later space exists', () => {
    // 'block one\n\nblock two longword' — cap=15 → 'block one\n\nbloc'
    // The last whitespace before the partial 'bloc' is the second \n
    // at index 10. Slice(0,10) = 'block one\n', then '…'.
    const text = 'block one\n\nblock two longword';
    const out = truncateOnWordBoundary(text, 15);
    expect(out.endsWith('…')).toBe(true);
    // Tail (before the ellipsis) is not a partial token from "block two".
    expect(out).not.toMatch(/bloc…$/);
    expect(out.startsWith('block one')).toBe(true);
  });

  it('truncates on a tab boundary when present', () => {
    const text = 'col1\tcol2\tcol3-very-long-cell';
    const out = truncateOnWordBoundary(text, 12);
    expect(out.endsWith('…')).toBe(true);
    // Whatever the tail is, it should not be a partial 'col3-very-long-cell' token.
    expect(out).not.toMatch(/col3-…$/);
  });

  it('matches the documented ~8 KB end-to-end cap', () => {
    // Build a long string of 5-char words separated by spaces.
    const word = 'aaaaa';
    const text = Array(2000).fill(word).join(' ');
    const out = truncateOnWordBoundary(text, 8000);
    // Output never exceeds cap + ellipsis (1 char).
    expect(out.length).toBeLessThanOrEqual(8001);
    expect(out.endsWith('…')).toBe(true);
    // Tail isn't a partial token — character before the ellipsis is in the word charset.
    expect(out[out.length - 2]).toMatch(/[a]/);
  });
});

describe('voice:ui lazy-text socket handlers', () => {
  it('registers the lazy read-response handler', () => {
    const socket = makeFakeSocket();
    registerVoiceHandlers(socket);
    expect(socket.has('voice:ui:index')).toBe(true);
    expect(socket.has('voice:ui:read-response')).toBe(true);
  });

  it('accepts a lazy index (no text, textOnDemand:true) without throwing', () => {
    const socket = makeFakeSocket();
    registerVoiceHandlers(socket);
    expect(() => socket.fire('voice:ui:index', {
      path: '/tasks',
      title: 'Tasks',
      elements: [{ ref: 0, kind: 'button', label: 'Add' }],
      textOnDemand: true,
    })).not.toThrow();
  });

  it('tolerates malformed / unmatched read-response payloads', () => {
    const socket = makeFakeSocket();
    registerVoiceHandlers(socket);
    // Establish a ui snapshot first.
    socket.fire('voice:ui:index', { path: '/x', title: 'X', elements: [], textOnDemand: true });
    expect(() => socket.fire('voice:ui:read-response', null)).not.toThrow();
    expect(() => socket.fire('voice:ui:read-response', 'nope')).not.toThrow();
    // Unmatched requestId — no waiter to resolve, must not throw.
    expect(() => socket.fire('voice:ui:read-response', { requestId: 'missing', text: 'hi' })).not.toThrow();
  });
});

describe('voice:screenshot:result socket handler', () => {
  it('registers the screenshot-result handler', () => {
    const socket = makeFakeSocket();
    registerVoiceHandlers(socket);
    expect(socket.has('voice:screenshot:result')).toBe(true);
  });

  it('tolerates malformed / unmatched screenshot-result payloads', () => {
    const socket = makeFakeSocket();
    registerVoiceHandlers(socket);
    expect(() => socket.fire('voice:screenshot:result', null)).not.toThrow();
    expect(() => socket.fire('voice:screenshot:result', 'nope')).not.toThrow();
    // Unmatched requestId — no waiter parked for it, must not throw (and must
    // not resolve a stale waiter, which is the whole point of the id keying).
    expect(() => socket.fire('voice:screenshot:result', { requestId: 'missing', dataUrl: 'data:image/png;base64,AAAA' })).not.toThrow();
  });
});

describe('voice:turn validation', () => {
  it('emits voice:error when audio exceeds MAX_AUDIO_BYTES', async () => {
    // MAX_AUDIO_BYTES = 8 * 1024 * 1024. Build a Buffer just over the limit.
    const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
    const socket = makeFakeSocket();
    registerVoiceHandlers(socket);
    const oversized = Buffer.alloc(MAX_AUDIO_BYTES + 1);
    await socket.fire('voice:turn', { audio: oversized, mimeType: 'audio/wav' });
    const errors = socket.emitted.filter((e) => e.event === 'voice:error');
    expect(errors).toHaveLength(1);
    expect(errors[0].payload.stage).toBe('turn');
    expect(errors[0].payload.message).toBe(`audio too large (${MAX_AUDIO_BYTES + 1} > ${MAX_AUDIO_BYTES} bytes)`);
  });

  it('emits voice:error when audio is missing', async () => {
    const socket = makeFakeSocket();
    registerVoiceHandlers(socket);
    await socket.fire('voice:turn', { mimeType: 'audio/wav' });
    const errors = socket.emitted.filter((e) => e.event === 'voice:error');
    expect(errors).toHaveLength(1);
    expect(errors[0].payload).toEqual({ stage: 'turn', message: 'audio is required' });
  });
});

describe('voice:text validation', () => {
  it('emits voice:error for text exceeding MAX_TEXT_LEN', async () => {
    const MAX_TEXT_LEN = 4000;
    const socket = makeFakeSocket();
    registerVoiceHandlers(socket);
    const longText = 'x'.repeat(MAX_TEXT_LEN + 1);
    await socket.fire('voice:text', { text: longText });
    const errors = socket.emitted.filter((e) => e.event === 'voice:error');
    expect(errors).toHaveLength(1);
    expect(errors[0].payload.stage).toBe('text');
    expect(errors[0].payload.message).toBe(`text too long (${MAX_TEXT_LEN + 1} > ${MAX_TEXT_LEN} chars)`);
  });

  it('emits voice:error for empty text payload', async () => {
    const socket = makeFakeSocket();
    registerVoiceHandlers(socket);
    await socket.fire('voice:text', { text: '' });
    const errors = socket.emitted.filter((e) => e.event === 'voice:error');
    expect(errors).toHaveLength(1);
    expect(errors[0].payload).toEqual({ stage: 'text', message: 'text is required' });
  });

  it('emits voice:error when text field is absent', async () => {
    const socket = makeFakeSocket();
    registerVoiceHandlers(socket);
    await socket.fire('voice:text', {});
    const errors = socket.emitted.filter((e) => e.event === 'voice:error');
    expect(errors).toHaveLength(1);
    expect(errors[0].payload).toEqual({ stage: 'text', message: 'text is required' });
  });
});

describe('voice:text turn recovery', () => {
  afterEach(() => runTurn.mockClear());

  it('emits voice:error and voice:idle when the LLM deadline expires', async () => {
    const socket = makeFakeSocket();
    registerVoiceHandlers(socket);
    runTurn.mockImplementationOnce(async () => {
      throw new Error('Voice LLM request timed out');
    });

    socket.fire('voice:text', { text: 'hello' });
    await vi.waitFor(() => expect(socket.emitted.filter((e) => e.event === 'voice:idle')).toHaveLength(1));

    expect(socket.emitted.filter((e) => e.event === 'voice:error')).toEqual([{
      event: 'voice:error',
      payload: { stage: 'text', message: 'Voice LLM request timed out' },
    }]);
    expect(socket.emitted.filter((e) => e.event === 'voice:idle')).toEqual([{
      event: 'voice:idle',
      payload: { reason: 'error' },
    }]);
  });
});

describe('voice:output single-recipient wiring', () => {
  beforeEach(() => __resetVoiceOutput());

  it('registers a candidate only after the tab announces voice:output:available', () => {
    const socket = makeFakeSocket();
    registerVoiceHandlers(socket);
    expect(socket.has('voice:output:available')).toBe(true);
    expect(socket.has('voice:output:claim')).toBe(true);
    // A bare connection is NOT a candidate — a non-browser socket (e.g. a peer
    // relay) that never announces must never be elected to receive audio.
    expect(getVoiceOutputSocket()).toBe(null);
    // After announcing, it becomes the (sole) lazily-eligible recipient.
    socket.fire('voice:output:available');
    expect(getVoiceOutputSocket()).toBe(socket);
  });

  it('a connection that never announces is never elected primary', () => {
    const relay = makeFakeSocket(); // stands in for a peer-relay Socket.IO client
    const tab = makeFakeSocket();
    registerVoiceHandlers(relay);
    registerVoiceHandlers(tab);
    tab.fire('voice:output:available');
    // Even though the relay connected, output routes to the real tab.
    const io = { emit: () => { throw new Error('must not broadcast'); } };
    emitVoiceOutput(io, 'voice:speak', { sentence: 'ping' });
    expect(relay.emitted.filter((e) => e.event === 'voice:speak')).toHaveLength(0);
    expect(tab.emitted.filter((e) => e.event === 'voice:speak')).toHaveLength(1);
  });

  it('claiming routes proactive output to the claiming tab, not another', () => {
    const a = makeFakeSocket();
    const b = makeFakeSocket();
    registerVoiceHandlers(a);
    registerVoiceHandlers(b);
    a.fire('voice:output:available');
    b.fire('voice:output:available');
    // b is the active tab and claims output.
    b.fire('voice:output:claim');

    const io = { emit: () => { throw new Error('must not broadcast'); } };
    emitVoiceOutput(io, 'voice:speak', { sentence: 'ping' });
    expect(a.emitted.filter((e) => e.event === 'voice:speak')).toHaveLength(0);
    expect(b.emitted.filter((e) => e.event === 'voice:speak')).toHaveLength(1);
  });

  it('disconnecting the primary promotes another announced tab', () => {
    const a = makeFakeSocket();
    const b = makeFakeSocket();
    registerVoiceHandlers(a);
    registerVoiceHandlers(b);
    a.fire('voice:output:available');
    b.fire('voice:output:available');
    a.fire('voice:output:claim');
    expect(getVoiceOutputSocket()).toBe(a);

    a.fire('disconnect');
    expect(getVoiceOutputSocket()).toBe(b);
  });
});

describe('call host opening line', () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    __resetCallSession();
    __setCallSessionDeps({
      probe: vi.fn(async () => ({ state: 'connected' })),
      call: vi.fn(async () => ({ state: 'dialing' })),
      hangup: vi.fn(async () => ({ state: 'ended' })),
      appendJournal: vi.fn(async () => ({})),
      enqueueMindMessage: vi.fn(async () => ({})),
    });
  });

  it('speaks the line into the call once the far end picks up, and only once', async () => {
    // This is the end of the mind's call path: without it a placed call
    // connects to silence and the user hears nothing at all.
    const host = makeFakeSocket();
    registerVoiceHandlers(host);
    await host.fire('voice:call:attach');

    await startCall({ openingLine: 'This is PortOS about your backups.', origin: 'mind' });
    await pollCall();
    await flush();

    const spoken = host.emitted.filter((e) => e.event === 'voice:call:tts');
    expect(spoken).toHaveLength(1);
    expect(spoken[0].payload.sentence).toBe('This is PortOS about your backups.');

    // Every state transition re-broadcasts; the line must not be repeated.
    await pollCall();
    await flush();
    expect(host.emitted.filter((e) => e.event === 'voice:call:tts')).toHaveLength(1);
  });

  it('says nothing extra on a call the user placed themselves', async () => {
    const host = makeFakeSocket();
    registerVoiceHandlers(host);
    await host.fire('voice:call:attach');

    await startCall();
    await pollCall();
    await flush();

    expect(host.emitted.filter((e) => e.event === 'voice:call:tts')).toHaveLength(0);
  });
});

describe('voice:call:hangup', () => {
  beforeEach(() => {
    __resetCallSession();
    __setCallSessionDeps({
      probe: vi.fn(async () => ({ state: 'connected' })),
      call: vi.fn(async () => ({ state: 'dialing' })),
      hangup: vi.fn(async () => ({ state: 'ended' })),
      appendJournal: vi.fn(async () => ({})),
      enqueueMindMessage: vi.fn(async () => ({})),
    });
  });

  it('ends the active call from any connected socket, not just the one carrying the audio', async () => {
    // The Mind tab's hang-up button is not the call-host tab — this is the
    // socket path it uses instead of a raw facetimeBridge.hangup() call, so
    // the session is cleaned up (journal, mind handoff, state reset) the same
    // way any other end-of-call is.
    const host = makeFakeSocket();
    registerVoiceHandlers(host);
    await host.fire('voice:call:attach');
    await startCall();
    expect(getCallState().active).toBe(true);

    const mindTab = makeFakeSocket();
    registerVoiceHandlers(mindTab);
    await mindTab.fire('voice:call:hangup');

    expect(getCallState().active).toBe(false);
  });

  it('is a no-op when nothing is active', async () => {
    const socket = makeFakeSocket();
    registerVoiceHandlers(socket);
    await expect(socket.fire('voice:call:hangup')).resolves.not.toThrow();
    expect(getCallState().active).toBe(false);
  });
});

describe('voice:capture socket handlers (meeting capture)', () => {
  // ~20 ms of 16 kHz mono, matching the call-host page's frame size (see
  // callAudioBridge.js CALL_FRAME_SAMPLES). Loud enough to clear the
  // endpointer's RMS threshold (0.015) and long enough, over several frames,
  // to clear its 250 ms minimum-utterance floor; the silent run after it
  // clears the 700 ms trailing-silence endpoint.
  const FRAME_SAMPLES = 320;
  const loudFrame = () => {
    const frame = new Int16Array(FRAME_SAMPLES);
    for (let i = 0; i < FRAME_SAMPLES; i += 1) frame[i] = Math.round(Math.sin(i / 8) * 20000);
    return frame;
  };
  const silentFrame = () => new Int16Array(FRAME_SAMPLES);
  const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

  let appendJournal;
  let createInboxLog;

  beforeEach(() => {
    __resetCallSession();
    __resetCaptureSession();
    appendJournal = vi.fn().mockResolvedValue({});
    createInboxLog = vi.fn().mockResolvedValue({ id: 'inbox-1' });
    __setCaptureSessionDeps({
      appendJournal,
      getToday: vi.fn().mockResolvedValue('2026-08-29'),
      createInboxLog,
      now: Date.now,
    });
    transcribe.mockReset();
  });

  afterEach(() => {
    __resetCallSession();
    __resetCaptureSession();
  });

  it('registers the capture start/stop handlers', () => {
    const socket = makeFakeSocket();
    registerVoiceHandlers(socket);
    expect(socket.has('voice:capture:start')).toBe(true);
    expect(socket.has('voice:capture:stop')).toBe(true);
  });

  it('claims the single capture-host slot and refuses a second tab', async () => {
    const first = makeFakeSocket();
    const second = makeFakeSocket();
    registerVoiceHandlers(first);
    registerVoiceHandlers(second);

    await first.fire('voice:capture:start');
    await second.fire('voice:capture:start');

    const refusal = second.emitted.find((e) => e.event === 'voice:capture:state');
    expect(refusal.payload).toMatchObject({ error: 'host-taken' });
  });

  it('refuses to start a capture on a tab already hosting a FaceTime call', async () => {
    const socket = makeFakeSocket();
    registerVoiceHandlers(socket);
    attachCallHost(socket); // same tab already owns the call-host slot

    await socket.fire('voice:capture:start');

    const state = socket.emitted.find((e) => e.event === 'voice:capture:state');
    expect(state.payload).toMatchObject({ error: 'call-active' });
  });

  it('refuses to attach a call host on a tab already capturing', async () => {
    const socket = makeFakeSocket();
    registerVoiceHandlers(socket);
    await socket.fire('voice:capture:start');

    await socket.fire('voice:call:attach');

    const state = socket.emitted.find((e) => e.event === 'voice:call:state');
    expect(state.payload).toMatchObject({ error: 'capture-active' });
  });

  it('transcribes meeting audio through STT only — never the LLM/tools pipeline — and files the journal + inbox on stop', async () => {
    const socket = makeFakeSocket();
    registerVoiceHandlers(socket);
    transcribe.mockResolvedValue({ text: 'let’s ship the capture mode', latencyMs: 5 });

    await socket.fire('voice:capture:start');
    expect(getCaptureState()).toMatchObject({ active: true });

    for (let i = 0; i < 14; i += 1) socket.fire('voice:call:audio', { pcm: loudFrame() });
    for (let i = 0; i < 36; i += 1) socket.fire('voice:call:audio', { pcm: silentFrame() });
    await flushMicrotasks();

    // One STT call for the one utterance — routed away from runTurn entirely,
    // so nothing from the LLM/tools pipeline ever fired.
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(socket.emitted.some((e) => e.event === 'voice:llm:done')).toBe(false);
    const states = socket.emitted.filter((e) => e.event === 'voice:capture:state');
    expect(states.some((e) => e.payload.turns === 1)).toBe(true);

    await socket.fire('voice:capture:stop');

    expect(appendJournal).toHaveBeenCalledTimes(1);
    expect(appendJournal.mock.calls[0][1]).toContain('let’s ship the capture mode');
    expect(appendJournal.mock.calls[0][2]).toEqual({ source: 'voice' });
    expect(createInboxLog).toHaveBeenCalledWith(expect.objectContaining({ status: 'needs_review', source: 'voice' }));
    // No AI provider call anywhere in this flow — createInboxLog never carries
    // classifier metadata, matching the auto-classify-off inbox shape.
    expect(createInboxLog).toHaveBeenCalledWith(expect.not.objectContaining({ ai: expect.anything() }));
  });

  it('ignores voice:call:audio on a tab that never attached either host', () => {
    const socket = makeFakeSocket();
    registerVoiceHandlers(socket);
    expect(() => socket.fire('voice:call:audio', { pcm: loudFrame() })).not.toThrow();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('barge-in aborts the in-flight call turn\'s own signal, not just the widget state.ctrl', async () => {
    // Regression: runCallUtterance previously ran the phone-call pipeline
    // with no AbortController at all (state.ctrl belongs to the
    // browser-widget voice:turn/voice:text path), so the barge-in handler's
    // `state.ctrl?.abort()` was a no-op for calls — the caller talking over
    // a reply never actually cancelled it.
    const socket = makeFakeSocket();
    registerVoiceHandlers(socket);
    await socket.fire('voice:call:attach');

    let capturedSignal;
    let releaseFirstTurn;
    runTurn.mockImplementationOnce(({ signal }) => {
      capturedSignal = signal;
      return new Promise((resolve) => { releaseFirstTurn = resolve; });
    });

    // First utterance: loud frames start a turn, then silence endpoints it —
    // runCallUtterance fires and stays pending (call.busy === true).
    for (let i = 0; i < 14; i += 1) socket.fire('voice:call:audio', { pcm: loudFrame() });
    for (let i = 0; i < 36; i += 1) socket.fire('voice:call:audio', { pcm: silentFrame() });
    await flushMicrotasks();
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal.aborted).toBe(false);

    // Caller talks over the still-in-flight reply — the endpointer reports
    // speaking again while call.busy is true.
    socket.fire('voice:call:audio', { pcm: loudFrame() });
    await flushMicrotasks();

    expect(capturedSignal.aborted).toBe(true);
    expect(socket.emitted.some((e) => e.event === 'voice:interrupt' && e.payload.reason === 'barge-in')).toBe(true);

    releaseFirstTurn({});
    await flushMicrotasks();
  });
});
