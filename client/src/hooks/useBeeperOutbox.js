import { useCallback, useEffect, useRef, useState } from 'react';
import toast from '../components/ui/Toast';
import {
  createOutboxEntry, discardOutboxEntry, listOutboxEntries, sendOutboxEntry,
} from '../services/apiBeeper';
import useBeeperRealtime from './useBeeperRealtime';
import useMounted from './useMounted';

/**
 * The Beeper composer's send lifecycle (#36, decided on #8).
 *
 * Two server steps, deliberately: `POST /api/beeper/outbox` writes the durable
 * row from the typed body, then `POST /api/beeper/outbox/:id/send` performs the
 * send. This hook drives both from one `submit(body)` so the composer stays a
 * text box with a button, while the row exists on disk before anything is sent.
 *
 * Three rules it exists to keep:
 *
 *  - **A send that touched the wire never retries in place.** Beeper has no
 *    idempotency key on send, so retrying an attempt that reached
 *    `sendMessage` is a second real message. A `failed` row stays failed and
 *    visible in `entries`; sending again means composing again, via
 *    `submit()`, which creates a NEW row. `retry()` is the narrow exception:
 *    it only ever re-dispatches a row still `approved` — refused before the
 *    server could claim it (`OUTBOX_BREAKER_OPEN` is the practical case) —
 *    where nothing has touched the wire yet, so re-sending the same row is
 *    exactly as safe as sending it the first time.
 *  - **First contact confirms inline.** The server refuses the first outbound
 *    message to a conversation with `FIRST_CONTACT_CONFIRMATION_REQUIRED`;
 *    that answer is surfaced as `confirmation`, NOT as an error toast, so the
 *    composer can render an `InlineConfirmRow` (never `window.confirm`, which
 *    client conventions forbid). `confirmAndSend()` re-sends the SAME row with
 *    the flag — it does not create a second one.
 *  - **Confirmation is the server's business.** A sent row sits in
 *    `awaiting-confirmation` until the socket or the 30s fallback resolves it;
 *    this hook just refetches when an invalidation says the mirror moved.
 *
 * @param {string|null} conversationId the open conversation (a route param).
 * @param {object} [options]
 * @param {() => void} [options.onSent] called after a send that CAME FROM the
 *   composer is accepted, so the composer can clear its draft buffer. A send
 *   whose text came from somewhere else — a failed row's Retry, which passes
 *   `submit(body, { clearsDraft: false })`, or `retry()` re-dispatching an
 *   existing row — never fires it: the draft may hold a newer message the
 *   user has typed since, and clearing it would discard text that was never
 *   sent.
 */
export default function useBeeperOutbox(conversationId, { onSent } = {}) {
  const [entries, setEntries] = useState([]);
  const [sending, setSending] = useState(false);
  // `null` = no confirmation pending. When set it carries the entry the user is
  // being asked about, so confirming re-sends that row rather than a new one.
  const [confirmation, setConfirmation] = useState(null);
  const [error, setError] = useState(null);
  const mountedRef = useMounted();
  const onSentRef = useRef(onSent);
  onSentRef.current = onSent;

  const refresh = useCallback(async () => {
    if (!conversationId) {
      setEntries([]);
      return;
    }
    const result = await listOutboxEntries(conversationId, { silent: true }).catch(() => null);
    if (!mountedRef.current) return;
    // A failed GET leaves the list alone rather than blanking it — absent is
    // not the same as empty, and an emptied list would hide a failed send.
    if (Array.isArray(result?.entries)) setEntries(result.entries);
  }, [conversationId]);

  useEffect(() => {
    setConfirmation(null);
    setError(null);
    refresh();
  }, [refresh]);

  // A send confirms server-side (socket `message.upserted`, or the 30s GET
  // fallback), and the server re-broadcasts an id-only invalidation when it
  // lands. That is the cue to refetch the outbox — no polling, no timers here.
  const awaitingRef = useRef(false);
  awaitingRef.current = entries.some((entry) => entry.state === 'awaiting-confirmation' || entry.state === 'sending');
  useBeeperRealtime({
    onInvalidate: (frame) => {
      if (frame?.kind !== 'message.upserted' || !awaitingRef.current) return;
      refresh();
    },
  });

  /**
   * Send one existing row. Shared by the first attempt and the confirmation.
   * `clearsDraft` says whether this send's text is the composer's current
   * draft — the only case where finishing it should clear the composer.
   */
  const dispatch = useCallback(async (entry, confirmFirstContact, clearsDraft = false) => {
    setSending(true);
    const [sent, err] = await sendOutboxEntry(entry.id, { confirmFirstContact }, { silent: true })
      .then((value) => [value, null])
      .catch((sendError) => [null, sendError]);
    if (!mountedRef.current) return false;
    setSending(false);

    if (err?.code === 'FIRST_CONTACT_CONFIRMATION_REQUIRED') {
      // Not an error state: a question. The composer renders it inline.
      // `clearsDraft` rides along so answering "Send anyway" keeps whatever
      // this attempt's origin decided, rather than defaulting back to the
      // composer's.
      setConfirmation({ entry, message: err.message, clearsDraft });
      return false;
    }
    setConfirmation(null);
    if (err) {
      setError(err.message || 'Could not send the message');
      toast.error(err.message || 'Could not send the message');
      await refresh();
      return false;
    }
    setError(null);
    setEntries((prev) => [sent, ...prev.filter((row) => row.id !== sent.id)]);
    if (clearsDraft) onSentRef.current?.();
    return true;
  }, [refresh]);

  // `sending` is React state, so it only reflects a send that has already
  // re-rendered. Two `submit()` calls inside ONE render — a double-fired Send
  // button, an Enter keydown racing the click — both read it as false, both
  // create a durable row, and both dispatch a real message. Beeper has no
  // idempotency key, so that second message is unrecallable. This ref latches
  // synchronously, before the first await, and is the actual guard; `sending`
  // stays as the RENDER signal it already is.
  const submittingRef = useRef(false);

  /**
   * Step one + step two, from the composer's Send action.
   *
   * `clearsDraft` defaults to true because the composer is the ordinary
   * caller. The one caller that passes false is a `failed` row's Retry, which
   * composes a new entry from that ROW's text — clearing the composer there
   * would throw away a message typed since the failure.
   */
  const submit = useCallback(async (body, { clearsDraft = true } = {}) => {
    const text = typeof body === 'string' ? body.trim() : '';
    if (!conversationId || !text || sending || submittingRef.current) return false;
    submittingRef.current = true;
    try {
      setError(null);
      const [entry, err] = await createOutboxEntry(conversationId, text, { silent: true })
        .then((value) => [value, null])
        .catch((createError) => [null, createError]);
      if (!mountedRef.current) return false;
      if (err) {
        setError(err.message || 'Could not queue the message');
        toast.error(err.message || 'Could not queue the message');
        return false;
      }
      setEntries((prev) => [entry, ...prev]);
      // Awaited into a local rather than returned bare: `return dispatch(...)`
      // would run the `finally` and drop the latch before the send resolved.
      const dispatched = await dispatch(entry, false, clearsDraft);
      return dispatched;
    } finally {
      // `finally`, not a catch: nothing is swallowed, but the latch must not
      // survive a throw or the composer is wedged shut for the session.
      submittingRef.current = false;
    }
  }, [conversationId, dispatch, sending]);

  /** The inline confirmation's "Send" — the same row, now explicitly confirmed. */
  const confirmAndSend = useCallback(async () => {
    if (!confirmation?.entry) return false;
    return dispatch(confirmation.entry, true, confirmation.clearsDraft === true);
  }, [confirmation, dispatch]);

  /**
   * Discard a row the human has given up on. Legal only while the row is
   * still `approved` — the server enforces that, and this mirrors it exactly
   * — because that is the only state meaning nothing has POSTed to Beeper
   * for it yet. Leaving an unwanted `approved` row behind was the original
   * design, but the composer had no way to render or dismiss it distinctly
   * from "sending": it fell into `OutboxRow`'s default branch and rendered
   * as a permanent "Sending…" bubble, including across a reload, because
   * `GET /outbox` returns every approved row (#53's Cancel fix; #60 blocker
   * 1 closed the other way in — a refused send, e.g. `OUTBOX_BREAKER_OPEN`
   * — into the same phantom). A discard failure (e.g. a network hiccup)
   * refetches instead of silently dropping the row from just the client's
   * view — the truth is the server's.
   */
  const discardEntry = useCallback(async (entry) => {
    if (!entry) return;
    const [, err] = await discardOutboxEntry(entry.id, { silent: true })
      .then(() => [true, null])
      .catch((discardError) => [null, discardError]);
    if (!mountedRef.current) return;
    if (err) {
      toast.error(err.message || 'Could not discard the message');
      await refresh();
      return;
    }
    setEntries((prev) => prev.filter((row) => row.id !== entry.id));
  }, [refresh]);

  /** The inline confirmation's "Cancel" — see `discardEntry`. */
  const cancelConfirmation = useCallback(async () => {
    const entry = confirmation?.entry;
    setConfirmation(null);
    if (!entry) return;
    await discardEntry(entry);
  }, [confirmation, discardEntry]);

  /**
   * Retry a row that never reached Beeper — a stalled `approved` entry
   * refused before the server could claim it (`OUTBOX_BREAKER_OPEN` is the
   * practical case, #60 blocker 1). Re-dispatches the SAME row rather than
   * composing a new one: nothing has touched the wire for it, so this is as
   * safe as sending it the first time, and it means a stuck breaker does not
   * manufacture a fresh phantom on every click the way retrying via `submit`
   * would. It never clears the composer: the row's text is not the draft.
   */
  const retry = useCallback((entry) => dispatch(entry, false, false), [dispatch]);

  /** Give up on a stalled `approved` row outright — see `discardEntry`. */
  const dismiss = useCallback((entry) => discardEntry(entry), [discardEntry]);

  return {
    entries,
    sending,
    error,
    confirmation,
    submit,
    confirmAndSend,
    cancelConfirmation,
    retry,
    dismiss,
    refresh,
  };
}
