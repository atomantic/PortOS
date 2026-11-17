/**
 * The dispatcher a STREAMING provider run fetches through.
 *
 * undici arms its own `headersTimeout`/`bodyTimeout` (300000ms) on every request,
 * a hidden third bound that fires first: a quiet provider finalized as
 * `network-error` instead of the stall timeout, and `provider.timeout` above
 * 300000 was capped. `executeApiRun` arms its own bounds, so the transport ones
 * are disabled (`0` = no timer); `connectTimeout` stays.
 *
 * Node <=25 bundles undici 6/7, which rejects a bare undici-8 Agent
 * (`UND_ERR_INVALID_ARG`), so it gets `Dispatcher1Wrapper`; Node 26+ gets the bare
 * Agent. The wrapper forces HTTP/1.1, which would lose the GOAWAY frames
 * `preHeaderRetry.js` relies on to safely replay against billable providers.
 */

import { Agent, Dispatcher1Wrapper } from 'undici';

export const STREAM_TRANSPORT_TIMEOUTS = { headersTimeout: 0, bodyTimeout: 0 };

/** Unreadable version reads as "yes": the wrapper works under both contracts. */
export function needsDispatcher1Wrapper(undiciVersion) {
  const major = Number(String(undiciVersion || '').split('.')[0]);
  return !(major >= 8);
}

let cached = null;

/** The shared per-process dispatcher for provider streaming requests. */
export function streamTransportDispatcher() {
  if (!cached) {
    // Spread: undici keeps the options object; don't share the exported reference.
    const agent = new Agent({ ...STREAM_TRANSPORT_TIMEOUTS });
    cached = needsDispatcher1Wrapper(process.versions.undici) ? new Dispatcher1Wrapper(agent) : agent;
  }
  return cached;
}
