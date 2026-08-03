import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  attachClient,
  emitStageProgress,
  finishStageProgress,
  isChannelOpen,
  channelKey,
  CHANNEL_IDLE_MS,
  __testing,
} from './textStageProgress.js';

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

describe('text-stage progress channel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __testing.reset();
  });
  afterEach(() => {
    __testing.reset();
    vi.useRealTimers();
  });

  it('emits are a no-op when nobody is subscribed', () => {
    expect(isChannelOpen('issue-1', 'prose')).toBe(false);
    expect(() => emitStageProgress('issue-1', 'prose', { type: 'phase' })).not.toThrow();
    expect(() => finishStageProgress('issue-1', 'prose', { type: 'complete' })).not.toThrow();
    expect(__testing.channels.size).toBe(0);
  });

  it('attaching opens the channel so the subscriber never races the POST', () => {
    const res = fakeRes();
    expect(attachClient('issue-1', 'prose', res)).toBe(true);
    expect(isChannelOpen('issue-1', 'prose')).toBe(true);
    expect(res.headers.status).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/event-stream');

    emitStageProgress('issue-1', 'prose', { type: 'phase', phase: 'generate', attempt: 1 });
    expect(framesOf(res)).toEqual([{ type: 'phase', phase: 'generate', attempt: 1 }]);
  });

  it('keeps channels separate per issue and per stage', () => {
    const prose = fakeRes();
    const script = fakeRes();
    attachClient('issue-1', 'prose', prose);
    attachClient('issue-1', 'comicScript', script);
    emitStageProgress('issue-1', 'prose', { type: 'phase', phase: 'generate' });
    expect(framesOf(prose)).toHaveLength(1);
    expect(framesOf(script)).toHaveLength(0);
    expect(channelKey('issue-1', 'prose')).not.toBe(channelKey('issue-1', 'comicScript'));
  });

  it('replays the last frame to a client that attaches late', () => {
    const first = fakeRes();
    attachClient('issue-1', 'prose', first);
    emitStageProgress('issue-1', 'prose', { type: 'phase', phase: 'judge' });
    const late = fakeRes();
    attachClient('issue-1', 'prose', late);
    expect(framesOf(late)).toEqual([{ type: 'phase', phase: 'judge' }]);
  });

  it('a terminal frame ends the stream after the replay grace window', () => {
    const res = fakeRes();
    attachClient('issue-1', 'prose', res);
    emitStageProgress('issue-1', 'prose', { type: 'start' });
    finishStageProgress('issue-1', 'prose', { type: 'complete', runId: 'run-1' });
    expect(framesOf(res).at(-1)).toEqual({ type: 'complete', runId: 'run-1' });
    expect(res.ended).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(res.ended).toBe(true);
    expect(isChannelOpen('issue-1', 'prose')).toBe(false);
  });

  it('drops trailing frames after the terminal frame but revives on a new run', () => {
    const res = fakeRes();
    attachClient('issue-1', 'prose', res);
    finishStageProgress('issue-1', 'prose', { type: 'complete' });
    emitStageProgress('issue-1', 'prose', { type: 'phase', phase: 'canon' });
    expect(framesOf(res)).toHaveLength(1);

    // A fresh run's `start` reclaims the lingering channel instead of being
    // swallowed by the previous run's terminal state.
    emitStageProgress('issue-1', 'prose', { type: 'start' });
    emitStageProgress('issue-1', 'prose', { type: 'phase', phase: 'generate' });
    expect(framesOf(res)).toHaveLength(3);
    vi.advanceTimersByTime(10_000);
    expect(res.ended).toBe(false);
  });

  it('a new subscriber replaces a finished channel rather than binding to a dead one', () => {
    const first = fakeRes();
    attachClient('issue-1', 'prose', first);
    finishStageProgress('issue-1', 'prose', { type: 'complete' });

    const next = fakeRes();
    attachClient('issue-1', 'prose', next);
    expect(first.ended).toBe(true);
    expect(framesOf(next)).toHaveLength(0);
    emitStageProgress('issue-1', 'prose', { type: 'start' });
    expect(framesOf(next)).toEqual([{ type: 'start' }]);
  });

  it('reaps a reservation that never sees a generation start', () => {
    const res = fakeRes();
    attachClient('issue-1', 'prose', res);
    vi.advanceTimersByTime(CHANNEL_IDLE_MS + 1);
    expect(isChannelOpen('issue-1', 'prose')).toBe(false);
    expect(res.ended).toBe(true);
  });

  it('does not reap a channel once frames are flowing', () => {
    const res = fakeRes();
    attachClient('issue-1', 'prose', res);
    emitStageProgress('issue-1', 'prose', { type: 'start' });
    vi.advanceTimersByTime(CHANNEL_IDLE_MS * 3);
    expect(isChannelOpen('issue-1', 'prose')).toBe(true);
    expect(res.ended).toBe(false);
  });

  it('closes a reservation when its only subscriber disconnects before the run starts', () => {
    const res = fakeRes();
    attachClient('issue-1', 'prose', res);
    res.fireClose();
    expect(isChannelOpen('issue-1', 'prose')).toBe(false);
  });

  it('keeps the channel alive when a subscriber disconnects mid-run', () => {
    const res = fakeRes();
    attachClient('issue-1', 'prose', res);
    emitStageProgress('issue-1', 'prose', { type: 'start' });
    res.fireClose();
    expect(isChannelOpen('issue-1', 'prose')).toBe(true);
  });
});
