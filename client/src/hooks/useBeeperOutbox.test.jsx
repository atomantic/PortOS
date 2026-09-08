import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';
import { renderHook, act, cleanup, waitFor } from '@testing-library/react';

/**
 * The composer's send lifecycle (#36). What matters here is the SHAPE of the
 * two-step flow, not the HTTP: create then send, one send per row ever, and a
 * first-contact refusal surfacing as an inline question rather than an error.
 */

const listOutboxEntries = vi.fn();
const createOutboxEntry = vi.fn();
const sendOutboxEntry = vi.fn();
const discardOutboxEntry = vi.fn();

vi.mock('../services/apiBeeper', () => ({
  listOutboxEntries: (...args) => listOutboxEntries(...args),
  createOutboxEntry: (...args) => createOutboxEntry(...args),
  sendOutboxEntry: (...args) => sendOutboxEntry(...args),
  discardOutboxEntry: (...args) => discardOutboxEntry(...args),
}));

const invalidateHandlers = new Set();
vi.mock('./useBeeperRealtime', () => ({
  default: ({ onInvalidate } = {}) => {
    invalidateHandlers.add(onInvalidate);
    return { realtime: null };
  },
}));

const toastError = vi.fn();
vi.mock('../components/ui/Toast', () => ({
  default: { error: (...args) => toastError(...args), success: vi.fn() },
}));

const useBeeperOutbox = (await import('./useBeeperOutbox.js')).default;

const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';
const ENTRY = { id: 'outbox-1', state: 'approved', body: 'hello there' };

class ApiError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

describe('useBeeperOutbox', () => {
  beforeEach(() => {
    listOutboxEntries.mockReset().mockResolvedValue({ entries: [] });
    createOutboxEntry.mockReset().mockResolvedValue(ENTRY);
    sendOutboxEntry.mockReset().mockResolvedValue({ ...ENTRY, state: 'awaiting-confirmation' });
    discardOutboxEntry.mockReset().mockResolvedValue(undefined);
    toastError.mockReset();
    invalidateHandlers.clear();
  });
  afterEach(cleanup);

  it('creates the durable row first, then sends it exactly once', async () => {
    const onSent = vi.fn();
    const { result } = renderHook(() => useBeeperOutbox(CONVERSATION_ID, { onSent }));

    await act(async () => { await result.current.submit('hello there'); });

    expect(createOutboxEntry).toHaveBeenCalledWith(CONVERSATION_ID, 'hello there', { silent: true });
    expect(sendOutboxEntry).toHaveBeenCalledTimes(1);
    expect(sendOutboxEntry).toHaveBeenCalledWith('outbox-1', { confirmFirstContact: false }, { silent: true });
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(result.current.entries[0].state).toBe('awaiting-confirmation');
  });

  // `sending` is React state and does not update until a re-render, so it
  // cannot stop two calls made inside one render — a double-fired Send button,
  // or Enter racing the click. Beeper has no idempotency key, so the second row
  // would be a second unrecallable message.
  it('latches submit so two calls in one render create and send exactly one row', async () => {
    const { result } = renderHook(() => useBeeperOutbox(CONVERSATION_ID));

    let outcomes;
    await act(async () => {
      outcomes = await Promise.all([
        result.current.submit('hello there'),
        result.current.submit('hello there'),
      ]);
    });

    expect(createOutboxEntry).toHaveBeenCalledTimes(1);
    expect(sendOutboxEntry).toHaveBeenCalledTimes(1);
    // The loser is refused, not queued behind the winner.
    expect(outcomes).toEqual([true, false]);
    expect(result.current.entries).toHaveLength(1);

    // And the latch releases: a later, deliberate send still goes through.
    await act(async () => { await result.current.submit('hello again'); });
    expect(createOutboxEntry).toHaveBeenCalledTimes(2);
  });

  it('surfaces a first-contact refusal as an inline confirmation, then re-sends the SAME row', async () => {
    sendOutboxEntry.mockRejectedValueOnce(new ApiError(
      'This is the first message PortOS has ever sent to this conversation',
      'FIRST_CONTACT_CONFIRMATION_REQUIRED',
    ));
    const { result } = renderHook(() => useBeeperOutbox(CONVERSATION_ID));

    await act(async () => { await result.current.submit('hello there'); });
    // A question, not an error: nothing toasts, and the row is still there.
    expect(result.current.confirmation?.entry.id).toBe('outbox-1');
    expect(toastError).not.toHaveBeenCalled();

    await act(async () => { await result.current.confirmAndSend(); });
    expect(createOutboxEntry).toHaveBeenCalledTimes(1);
    expect(sendOutboxEntry).toHaveBeenLastCalledWith('outbox-1', { confirmFirstContact: true }, { silent: true });
    expect(result.current.confirmation).toBeNull();
  });

  // The reviewer's blocker on #53: a cancelled first-contact confirmation used
  // to leave the row `approved` and in `entries` forever, with no server call
  // and no way to dismiss it — a phantom "Sending…" bubble that survived
  // reloads. Cancel must discard the row, not just clear the local question.
  it('discards the row on Cancel, so it does not linger as a phantom pending send', async () => {
    sendOutboxEntry.mockRejectedValueOnce(new ApiError(
      'This is the first message PortOS has ever sent to this conversation',
      'FIRST_CONTACT_CONFIRMATION_REQUIRED',
    ));
    const { result } = renderHook(() => useBeeperOutbox(CONVERSATION_ID));

    await act(async () => { await result.current.submit('hello there'); });
    expect(result.current.confirmation?.entry.id).toBe('outbox-1');
    expect(result.current.entries).toHaveLength(1);

    await act(async () => { await result.current.cancelConfirmation(); });

    expect(discardOutboxEntry).toHaveBeenCalledWith('outbox-1', { silent: true });
    expect(result.current.confirmation).toBeNull();
    expect(result.current.entries).toHaveLength(0);
    // Cancel never re-sends — it never even reaches the send path a second time.
    expect(sendOutboxEntry).toHaveBeenCalledTimes(1);
  });

  it('refetches rather than silently hiding the row when the discard itself fails', async () => {
    sendOutboxEntry.mockRejectedValueOnce(new ApiError(
      'This is the first message PortOS has ever sent to this conversation',
      'FIRST_CONTACT_CONFIRMATION_REQUIRED',
    ));
    discardOutboxEntry.mockRejectedValueOnce(new ApiError('Beeper request failed', 'NETWORK_ERROR'));
    listOutboxEntries.mockResolvedValue({ entries: [ENTRY] });
    const { result } = renderHook(() => useBeeperOutbox(CONVERSATION_ID));

    await act(async () => { await result.current.submit('hello there'); });
    await act(async () => { await result.current.cancelConfirmation(); });

    expect(result.current.confirmation).toBeNull();
    expect(toastError).toHaveBeenCalled();
    // The row is not fabricated as removed — it stays, reflecting the server.
    await waitFor(() => expect(result.current.entries).toHaveLength(1));
  });

  it('never re-sends after a transport failure — it reports it and refetches the failed row', async () => {
    sendOutboxEntry.mockRejectedValue(new ApiError('Beeper request failed', 'NETWORK_ERROR'));
    listOutboxEntries.mockResolvedValue({ entries: [{ ...ENTRY, state: 'failed', errorCode: 'NETWORK_ERROR' }] });
    const { result } = renderHook(() => useBeeperOutbox(CONVERSATION_ID));

    await act(async () => { await result.current.submit('hello there'); });

    expect(sendOutboxEntry).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalled();
    await waitFor(() => expect(result.current.entries[0].state).toBe('failed'));
    expect(sendOutboxEntry).toHaveBeenCalledTimes(1);
  });

  it('refetches when a message.upserted invalidation lands on a send awaiting confirmation', async () => {
    const { result } = renderHook(() => useBeeperOutbox(CONVERSATION_ID));
    await act(async () => { await result.current.submit('hello there'); });
    const before = listOutboxEntries.mock.calls.length;

    listOutboxEntries.mockResolvedValue({ entries: [{ ...ENTRY, state: 'sent', messageId: 'msg-final-1' }] });
    await act(async () => {
      for (const handler of invalidateHandlers) handler?.({ kind: 'message.upserted', chatID: 'example-chat-1' });
    });

    expect(listOutboxEntries.mock.calls.length).toBeGreaterThan(before);
    await waitFor(() => expect(result.current.entries[0].state).toBe('sent'));
  });

  // PR #60 blocker 1: `assertBreakerClosed()` runs before the row is claimed,
  // so a 429 `OUTBOX_BREAKER_OPEN` leaves the row `approved` by design (#36)
  // — the same shape as the first-contact refusal, but with no `confirmation`
  // to hang a Cancel off. The row must stay `approved` and visible (never
  // fabricated as failed) so `retry()`/`dismiss()` have something to act on.
  it('leaves a breaker-refused row `approved` rather than `failed`, ready to retry or dismiss', async () => {
    sendOutboxEntry.mockRejectedValueOnce(new ApiError(
      'Beeper sending is blocked by the runaway breaker',
      'OUTBOX_BREAKER_OPEN',
    ));
    listOutboxEntries.mockResolvedValue({ entries: [ENTRY] });
    const { result } = renderHook(() => useBeeperOutbox(CONVERSATION_ID));

    await act(async () => { await result.current.submit('hello there'); });

    expect(toastError).toHaveBeenCalled();
    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    expect(result.current.entries[0].state).toBe('approved');
    expect(result.current.confirmation).toBeNull();
  });

  // `retry()` is the one exception to "nothing here ever retries in place":
  // legal only because a still-`approved` row never reached `sendMessage`, so
  // re-dispatching it is exactly as safe as sending it the first time. It
  // must NOT compose a new row — that would manufacture a second phantom on
  // every click while the breaker stays tripped, the exact failure the
  // reviewer flagged.
  it('retries a stalled approved row in place, without composing a new one', async () => {
    sendOutboxEntry.mockRejectedValueOnce(new ApiError(
      'Beeper sending is blocked by the runaway breaker',
      'OUTBOX_BREAKER_OPEN',
    ));
    listOutboxEntries.mockResolvedValue({ entries: [ENTRY] });
    const { result } = renderHook(() => useBeeperOutbox(CONVERSATION_ID));
    await act(async () => { await result.current.submit('hello there'); });
    await waitFor(() => expect(result.current.entries[0].state).toBe('approved'));

    sendOutboxEntry.mockResolvedValueOnce({ ...ENTRY, state: 'awaiting-confirmation' });
    await act(async () => { await result.current.retry(result.current.entries[0]); });

    expect(createOutboxEntry).toHaveBeenCalledTimes(1);
    expect(sendOutboxEntry).toHaveBeenCalledTimes(2);
    expect(sendOutboxEntry).toHaveBeenLastCalledWith('outbox-1', { confirmFirstContact: false }, { silent: true });
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0].state).toBe('awaiting-confirmation');
  });

  // `dismiss()` is the general form of Cancel: giving up on a stalled
  // `approved` row that is not part of any pending first-contact question.
  it('dismisses a stalled approved row on request, discarding it server-side', async () => {
    sendOutboxEntry.mockRejectedValueOnce(new ApiError(
      'Beeper sending is blocked by the runaway breaker',
      'OUTBOX_BREAKER_OPEN',
    ));
    listOutboxEntries.mockResolvedValue({ entries: [ENTRY] });
    const { result } = renderHook(() => useBeeperOutbox(CONVERSATION_ID));
    await act(async () => { await result.current.submit('hello there'); });
    await waitFor(() => expect(result.current.entries[0].state).toBe('approved'));

    await act(async () => { await result.current.dismiss(result.current.entries[0]); });

    expect(discardOutboxEntry).toHaveBeenCalledWith('outbox-1', { silent: true });
    expect(result.current.entries).toHaveLength(0);
  });

  // `onSent` exists for exactly one purpose: clearing the composer. A send
  // whose text did NOT come from the composer must not fire it, or a message
  // typed while a failed row sat above it is thrown away unsent — the
  // composer clears through `setDraft('')`, which also drops the persisted
  // draft.
  it('only clears the draft for the composer\'s own send, not a failed row\'s retry', async () => {
    const onSent = vi.fn();
    const { result } = renderHook(() => useBeeperOutbox(CONVERSATION_ID, { onSent }));

    await act(async () => { await result.current.submit('older text', { clearsDraft: false }); });
    expect(sendOutboxEntry).toHaveBeenCalledTimes(1);
    expect(onSent).not.toHaveBeenCalled();

    await act(async () => { await result.current.submit('freshly typed'); });
    expect(onSent).toHaveBeenCalledTimes(1);
  });

  // The same rule has to survive the first-contact question: the origin rides
  // on the confirmation, so answering "Send anyway" for a failed row's retry
  // still leaves the composer alone.
  it('carries the no-clear origin through a first-contact confirmation', async () => {
    sendOutboxEntry.mockRejectedValueOnce(new ApiError(
      'This is the first message PortOS has ever sent to this conversation',
      'FIRST_CONTACT_CONFIRMATION_REQUIRED',
    ));
    const onSent = vi.fn();
    const { result } = renderHook(() => useBeeperOutbox(CONVERSATION_ID, { onSent }));

    await act(async () => { await result.current.submit('older text', { clearsDraft: false }); });
    await act(async () => { await result.current.confirmAndSend(); });

    expect(sendOutboxEntry).toHaveBeenLastCalledWith('outbox-1', { confirmFirstContact: true }, { silent: true });
    expect(onSent).not.toHaveBeenCalled();
  });
});
