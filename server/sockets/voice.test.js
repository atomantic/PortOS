import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const { truncateOnWordBoundary, registerVoiceHandlers } = await import('./voice.js');
const {
  getVoiceOutputSocket,
  emitVoiceOutput,
  __resetVoiceOutput,
} = await import('../services/voice/voiceOutput.js');

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

describe('voice:output single-recipient wiring', () => {
  beforeEach(() => __resetVoiceOutput());

  it('registers the voice:output:claim handler and a candidate on connect', () => {
    const socket = makeFakeSocket();
    registerVoiceHandlers(socket);
    expect(socket.has('voice:output:claim')).toBe(true);
    // Registered as the sole candidate → lazily eligible to receive output.
    expect(getVoiceOutputSocket()).toBe(socket);
  });

  it('claiming routes proactive output to the claiming tab, not another', () => {
    const a = makeFakeSocket();
    const b = makeFakeSocket();
    registerVoiceHandlers(a);
    registerVoiceHandlers(b);
    // b is the active tab and claims output.
    b.fire('voice:output:claim');

    const io = { emit: () => { throw new Error('must not broadcast'); } };
    emitVoiceOutput(io, 'voice:speak', { sentence: 'ping' });
    expect(a.emitted.filter((e) => e.event === 'voice:speak')).toHaveLength(0);
    expect(b.emitted.filter((e) => e.event === 'voice:speak')).toHaveLength(1);
  });

  it('disconnecting the primary promotes another live tab', () => {
    const a = makeFakeSocket();
    const b = makeFakeSocket();
    registerVoiceHandlers(a);
    registerVoiceHandlers(b);
    a.fire('voice:output:claim');
    expect(getVoiceOutputSocket()).toBe(a);

    a.fire('disconnect');
    expect(getVoiceOutputSocket()).toBe(b);
  });
});
