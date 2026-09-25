import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  attachClient,
  beginPromptProgress,
  emitPromptProgress,
  finishPromptProgress,
  isChannelOpen,
  CHANNEL_IDLE_MS,
  __testing,
} from './deckPromptProgress.js';

// Minimal Express `res` stand-in: records the SSE frames written to it and
// exposes the `req` close hook the attach path registers against.
function fakeRes() {
  const closeHandlers = [];
  return {
    written: [],
    ended: false,
    headers: null,
    writeHead(status, headers) { this.headers = { status, ...headers }; },
    write(chunk) { this.written.push(chunk); },
    end() { this.ended = true; },
    req: { on: (evt, fn) => { if (evt === 'close') closeHandlers.push(fn); } },
    fireClose: () => closeHandlers.forEach((fn) => fn()),
  };
}

const framesOf = (res) => res.written.map((c) => JSON.parse(c.replace(/^data: /, '').trim()));

describe('deck prompt progress channel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __testing.reset();
  });
  afterEach(() => {
    __testing.reset();
    vi.useRealTimers();
  });

  it('emits are a no-op when nobody is subscribed', () => {
    expect(isChannelOpen('deck-1')).toBe(false);
    expect(() => emitPromptProgress('deck-1', { type: 'chunk' })).not.toThrow();
    expect(() => finishPromptProgress('deck-1', { type: 'complete' })).not.toThrow();
    expect(__testing.channels.size).toBe(0);
  });

  it('attaching opens the channel so the subscriber never races the POST', () => {
    const res = fakeRes();
    expect(attachClient('deck-1', res)).toBe(true);
    expect(isChannelOpen('deck-1')).toBe(true);
    expect(res.headers.status).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/event-stream');

    emitPromptProgress('deck-1', { type: 'chunk', written: 12, requested: 79 });
    expect(framesOf(res)).toEqual([{ type: 'chunk', written: 12, requested: 79 }]);
  });

  it('replays the latest frame when POST reserves the channel before the subscriber connects', () => {
    beginPromptProgress('deck-1');
    emitPromptProgress('deck-1', { type: 'start', requested: 79, chunks: 7 });
    emitPromptProgress('deck-1', { type: 'chunk', written: 12, requested: 79, chunk: 1, chunks: 7 });

    const res = fakeRes();
    attachClient('deck-1', res);
    expect(framesOf(res)).toEqual([{ type: 'chunk', written: 12, requested: 79, chunk: 1, chunks: 7 }]);

    emitPromptProgress('deck-1', { type: 'chunk', written: 24, requested: 79, chunk: 2, chunks: 7 });
    expect(framesOf(res).at(-1)).toEqual({ type: 'chunk', written: 24, requested: 79, chunk: 2, chunks: 7 });
  });

  it('keeps channels separate per deck', () => {
    const first = fakeRes();
    const second = fakeRes();
    attachClient('deck-1', first);
    attachClient('deck-2', second);
    emitPromptProgress('deck-1', { type: 'chunk', written: 1, requested: 2 });
    expect(framesOf(first)).toHaveLength(1);
    expect(framesOf(second)).toHaveLength(0);
  });

  it('a terminal frame ends the stream after the replay grace window', () => {
    const res = fakeRes();
    attachClient('deck-1', res);
    emitPromptProgress('deck-1', { type: 'start', requested: 79 });
    finishPromptProgress('deck-1', { type: 'complete', written: 79, requested: 79 });
    expect(framesOf(res).at(-1)).toEqual({ type: 'complete', written: 79, requested: 79 });
    expect(res.ended).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(res.ended).toBe(true);
    expect(isChannelOpen('deck-1')).toBe(false);
  });

  it('reaps a reservation that never sees a generation start', () => {
    const res = fakeRes();
    attachClient('deck-1', res);
    vi.advanceTimersByTime(CHANNEL_IDLE_MS + 1);
    expect(isChannelOpen('deck-1')).toBe(false);
    expect(res.ended).toBe(true);
  });

  it('does not reap a channel once frames are flowing', () => {
    const res = fakeRes();
    attachClient('deck-1', res);
    emitPromptProgress('deck-1', { type: 'start', requested: 79 });
    vi.advanceTimersByTime(CHANNEL_IDLE_MS * 3);
    expect(isChannelOpen('deck-1')).toBe(true);
    expect(res.ended).toBe(false);
  });
});
