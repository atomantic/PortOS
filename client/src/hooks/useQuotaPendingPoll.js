import { useAutoRefetch } from './useAutoRefetch.js';

// A scrape is a 10-20s PTY spawn, so this is a handful of polls, not a busy loop.
export const PENDING_POLL_MS = 4000;

/**
 * Re-read provider quota cards while any of them is still being scraped.
 *
 * `GET /api/usage/providers` never blocks on a 10-20s PTY spawn: a cold cache
 * answers with `pending: true` cards and the reading lands behind the response.
 * Something therefore has to ask again, or the page keeps whatever stood in for
 * the reading — a spinner, or a federated peer's older meters — until the user
 * refreshes by hand.
 *
 * One hook rather than the same six lines on each surface: three pages render
 * the same cards (Usage, Subscriptions, Quota Burn), and the cadence and the
 * "which state keeps polling" rule are exactly the pair that must not drift
 * between them — the card BODY was already extracted for that reason
 * (`components/usage/ProviderQuotaBody.jsx`), and its lifecycle is the half
 * that was left behind.
 *
 * Polling only while something is pending is the point: this is not a
 * background refresh loop, and `useAutoRefetch` pauses on a hidden tab so a
 * backgrounded copy can never re-request a multi-second scrape.
 *
 * @param {Function} reload - re-fetches the cards; called for its side effect.
 * @param {Array<{pending?: boolean}>} cards - the cards currently rendered.
 */
export function useQuotaPendingPoll(reload, cards) {
  const anyPending = Boolean(cards?.some((card) => card?.pending));
  useAutoRefetch(reload, PENDING_POLL_MS, { enabled: anyPending, immediate: false, pollOnly: true });
}

export default useQuotaPendingPoll;
