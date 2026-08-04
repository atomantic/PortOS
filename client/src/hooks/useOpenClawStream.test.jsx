import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { renderHook, act } from '@testing-library/react';
import { useOpenClawStream } from './useOpenClawStream';
import { getOpenClawMessages, streamOpenClawMessage } from '../services/apiOpenClaw';

vi.mock('../services/apiOpenClaw', () => ({
  getOpenClawMessages: vi.fn(),
  streamOpenClawMessage: vi.fn()
}));

// The hook takes its composer/attachments/sending state as controlled props from
// the owning component (see the hook's own header comment). Wrap it in a small
// harness that owns that state the same way the real component does, so tests
// can drive it through renderHook without reimplementing the component.
function useHarness(overrides = {}) {
  const [selectedSessionId, setSelectedSessionId] = useState(overrides.selectedSessionId ?? 'session-1');
  const [attachments, setAttachments] = useState(overrides.attachments ?? []);
  const [composer, setComposer] = useState(overrides.composer ?? 'hello');
  const [sending, setSending] = useState(false);

  const stream = useOpenClawStream({
    selectedSessionId,
    attachments,
    setAttachments,
    composer,
    setComposer,
    context: overrides.context ?? {},
    apps: overrides.apps ?? [],
    sending,
    setSending,
    onError: overrides.onError ?? (() => {}),
    onSendComplete: overrides.onSendComplete ?? (() => {})
  });

  return { ...stream, setSelectedSessionId, setComposer, composer, sending };
}

const flushMicrotasks = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// loadMessages — stale-response guard (loadingSessionRef)
// =============================================================================

describe('loadMessages stale-session guard', () => {
  it('discards an in-flight load when a newer session load starts before it resolves', async () => {
    let resolveA;
    const promiseA = new Promise(resolve => { resolveA = resolve; });
    let resolveB;
    const promiseB = new Promise(resolve => { resolveB = resolve; });
    getOpenClawMessages.mockImplementation(sessionId =>
      sessionId === 'session-A' ? promiseA : promiseB
    );

    const { result } = renderHook(() => useHarness());

    act(() => { result.current.loadMessages('session-A'); });
    act(() => { result.current.loadMessages('session-B'); });

    // Resolve the OLDER (session-A) request first — the user already moved on
    // to session-B, so this response must be silently discarded.
    await act(async () => {
      resolveA({ messages: [{ id: 'stale', role: 'assistant', content: 'stale response' }] });
      await flushMicrotasks();
    });
    expect(result.current.messages).toEqual([]);
    expect(result.current.messagesLoading).toBe(true); // session-B still pending

    // Now resolve the NEWER (session-B) request — this one should win.
    await act(async () => {
      resolveB({ messages: [{ id: 'fresh', role: 'assistant', content: 'fresh response' }] });
      await flushMicrotasks();
    });
    expect(result.current.messages).toEqual([
      { id: 'fresh', role: 'assistant', content: 'fresh response' }
    ]);
    expect(result.current.messagesLoading).toBe(false);
  });

  it('discards a stale rejection the same way it discards a stale success', async () => {
    let rejectA;
    const promiseA = new Promise((_resolve, reject) => { rejectA = reject; });
    let resolveB;
    const promiseB = new Promise(resolve => { resolveB = resolve; });
    getOpenClawMessages.mockImplementation(sessionId =>
      sessionId === 'session-A' ? promiseA : promiseB
    );
    const onError = vi.fn();

    const { result } = renderHook(() => useHarness({ onError }));

    act(() => { result.current.loadMessages('session-A'); });
    act(() => { result.current.loadMessages('session-B'); });
    onError.mockClear(); // clear the '' resets fired by the two loadMessages calls above

    await act(async () => {
      rejectA(new Error('session-A network error'));
      await flushMicrotasks();
    });
    // The stale rejection must not surface an error for the abandoned session.
    expect(onError).not.toHaveBeenCalled();

    await act(async () => {
      resolveB({ messages: [{ id: 'fresh', role: 'assistant', content: 'fresh' }] });
      await flushMicrotasks();
    });
    expect(result.current.messages).toEqual([{ id: 'fresh', role: 'assistant', content: 'fresh' }]);
  });

  it('clears messages immediately when the session id is falsy', async () => {
    getOpenClawMessages.mockResolvedValue({ messages: [{ id: 'x', role: 'user', content: 'x' }] });
    const { result } = renderHook(() => useHarness());

    await act(async () => { await result.current.loadMessages('session-1'); });
    expect(result.current.messages).toHaveLength(1);

    await act(async () => { await result.current.loadMessages(null); });
    expect(result.current.messages).toEqual([]);
    expect(result.current.messagesLoading).toBe(false);
    expect(getOpenClawMessages).toHaveBeenCalledTimes(1); // no fetch for a null session
  });

  it('surfaces a load failure via onError and clears messages', async () => {
    getOpenClawMessages.mockRejectedValue(new Error('boom'));
    const onError = vi.fn();
    const { result } = renderHook(() => useHarness({ onError }));

    await act(async () => { await result.current.loadMessages('session-1'); });
    expect(result.current.messages).toEqual([]);
    expect(onError).toHaveBeenCalledWith('boom');
    expect(result.current.messagesLoading).toBe(false);
  });
});

// =============================================================================
// handleSend — abort-on-unmount cleanup
// =============================================================================

describe('unmount cleanup', () => {
  it('aborts the in-flight stream request when the hook unmounts', async () => {
    let capturedSignal;
    streamOpenClawMessage.mockImplementation((_sessionId, { signal }) => {
      capturedSignal = signal;
      return new Promise(() => {}); // never resolves — simulates an open stream
    });

    const { result, unmount } = renderHook(() => useHarness());

    await act(async () => {
      result.current.handleSend({ preventDefault: () => {} });
      await flushMicrotasks();
    });

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal.aborted).toBe(false);

    unmount();

    expect(capturedSignal.aborted).toBe(true);
  });

  it('does nothing on unmount when no request is in flight', () => {
    const { unmount } = renderHook(() => useHarness());
    expect(() => unmount()).not.toThrow();
  });
});

// =============================================================================
// handleSend — streaming behavior
// =============================================================================

describe('handleSend', () => {
  it('does not send when the composer is empty and there are no attachments', async () => {
    const { result } = renderHook(() => useHarness({ composer: '' }));
    await act(async () => {
      await result.current.handleSend({ preventDefault: () => {} });
    });
    expect(streamOpenClawMessage).not.toHaveBeenCalled();
    expect(result.current.messages).toEqual([]);
  });

  it('accumulates text deltas and marks the message completed on the done event', async () => {
    streamOpenClawMessage.mockImplementation(async (_sessionId, { onEvent }) => {
      onEvent({ event: 'response.output_text.delta', data: 'Hello ' });
      onEvent({ event: 'response.output_text.delta', data: 'world' });
      onEvent({ event: 'done' });
    });
    const onSendComplete = vi.fn();

    const { result } = renderHook(() => useHarness({ onSendComplete }));

    await act(async () => {
      await result.current.handleSend({ preventDefault: () => {} });
    });

    const assistantMessage = result.current.messages.find(m => m.role === 'assistant');
    expect(assistantMessage.content).toBe('Hello world');
    expect(assistantMessage.status).toBe('completed');
    expect(result.current.composer).toBe('');
    expect(onSendComplete).toHaveBeenCalledWith({ sessionId: 'session-1' });
  });

  it('removes the assistant placeholder and reports the error on stream failure', async () => {
    streamOpenClawMessage.mockRejectedValue(new Error('stream exploded'));
    const onError = vi.fn();

    const { result } = renderHook(() => useHarness({ onError }));

    await act(async () => {
      await result.current.handleSend({ preventDefault: () => {} });
    });

    expect(result.current.messages.some(m => m.role === 'assistant')).toBe(false);
    expect(onError).toHaveBeenCalledWith('stream exploded');
  });

  it('keeps a partial response and marks it completed when the user stops the stream', async () => {
    streamOpenClawMessage.mockImplementation(async (_sessionId, { onEvent }) => {
      onEvent({ event: 'response.output_text.delta', data: 'partial' });
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });

    const { result } = renderHook(() => useHarness());

    await act(async () => {
      await result.current.handleSend({ preventDefault: () => {} });
    });

    const assistantMessage = result.current.messages.find(m => m.role === 'assistant');
    expect(assistantMessage.status).toBe('completed');
    expect(assistantMessage.content).toBe('partial');
  });
});
