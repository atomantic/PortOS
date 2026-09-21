/**
 * The dispatcher a STREAMING provider run fetches through.
 *
 * undici — the HTTP client behind Node's built-in `fetch` — arms its OWN
 * no-progress ceilings on every request: `headersTimeout` and `bodyTimeout`,
 * both 300000ms by default. A streaming API run therefore carried a THIRD
 * bound nobody declared, exactly equal to `DEFAULT_API_RUN_TIMEOUT_MS`, and
 * armed one layer below the two in `runTimeouts.js` — the transport sees a byte
 * before the read loop does, so undici's timer re-arms fractionally earlier and
 * fires fractionally first. It won every race:
 *
 *   - A provider that opened the stream and went quiet finalized as
 *     `network-error` ("Check network connectivity and provider endpoint URL")
 *     instead of the stall TIMEOUT it is, so `metadata.timeoutBound` — the
 *     field that tells a quiet provider (bench candidate) from a slow but
 *     productive one — was never stamped, and the run escalated as a
 *     connectivity fault. An NVIDIA NIM `nemotron` persistent-mind run died
 *     that way at 419.9s with `terminated: UND_ERR_INFO: HTTP/2: "stream
 *     timeout after 300000"`.
 *   - `provider.timeout` above 300000 was silently capped: an install that
 *     deliberately widened the stall bound for a slow reasoning model still
 *     lost the stream at undici's five minutes.
 *
 * `executeApiRun` arms both of its own bounds around this fetch and aborts the
 * controller the request carries, so the transport ceilings are pure
 * duplication — disabled here (`0` = no timer, in undici's h1 parser and its h2
 * stream alike) and the run's declared bounds are authoritative again.
 * `connectTimeout` is untouched: it bounds the pre-request dial, which no run
 * timer covers.
 *
 * ## Why the dispatcher is sometimes wrapped
 *
 * Node's built-in `fetch` drives a dispatcher with whichever request-handler
 * contract the undici version BUNDLED IN THAT NODE speaks, and we hand it an
 * Agent from the undici in `node_modules`:
 *
 *   - Node 26+ bundles undici 8, the same contract — hand it the bare Agent.
 *   - Node 22/24/25 bundle undici 6/7, whose handler shape undici 8 dropped; a
 *     bare undici-8 Agent is rejected there with `UND_ERR_INVALID_ARG`
 *     ("invalid onRequestStart method") and the request never leaves.
 *     `Dispatcher1Wrapper` is undici's adapter for exactly that.
 *
 * The wrapper is not free, which is why it is not simply used everywhere: it
 * forces `allowH2: false` ("Legacy (v1) consumers do not support HTTP/2"), and
 * forcing HTTP/1.1 would cost the run its `GOAWAY` frames — the one transport
 * failure `preHeaderRetry.js` may replay against a billable provider, because
 * only HTTP/2 §6.8 guarantees the request was never processed. NVIDIA NIM
 * recycles idle pooled connections on its own schedule, so that replay is load
 * bearing.
 *
 * Splitting on the bundled major keeps the wire protocol exactly as each
 * runtime already chose it: Node ≤25's built-in fetch offers only `http/1.1`
 * over ALPN and gets HTTP/1.1 through the wrapper; Node 26's offers `h2` and
 * gets HTTP/2 through the bare Agent. Only the timeouts change.
 */

import { Agent, Dispatcher1Wrapper } from 'undici';

// Both of undici's per-request no-progress ceilings, disabled. `0` is undici's
// documented "no timer" (`if (delay)` guards the h1 parser's timer, and the h2
// stream arms none when both are falsy) — not "expire immediately".
export const STREAM_TRANSPORT_TIMEOUTS = { headersTimeout: 0, bodyTimeout: 0 };

/**
 * Does this runtime's built-in fetch speak undici's pre-8 handler contract?
 * An unreadable version reads as "yes": the wrapper is accepted by BOTH
 * contracts, so an unknown runtime degrades to HTTP/1.1 rather than to a
 * dispatcher the runtime refuses.
 */
export function needsDispatcher1Wrapper(undiciVersion) {
  const major = Number(String(undiciVersion || '').split('.')[0]);
  return !(major >= 8);
}

let cached = null;

/**
 * The shared dispatcher for provider streaming requests. One Agent for the
 * process, so connection pooling and keep-alive behave as they did under the
 * runtime's global dispatcher.
 */
export function streamTransportDispatcher() {
  if (!cached) {
    // Spread: undici keeps the options object, and the exported constant is
    // read by the tests — never hand the same reference to both.
    const agent = new Agent({ ...STREAM_TRANSPORT_TIMEOUTS });
    cached = needsDispatcher1Wrapper(process.versions.undici) ? new Dispatcher1Wrapper(agent) : agent;
  }
  return cached;
}
