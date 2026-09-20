import { describe, it, expect, afterAll } from 'vitest';
import { createServer } from 'node:http';
import { Agent, Dispatcher1Wrapper } from 'undici';

import { STREAM_TRANSPORT_TIMEOUTS, needsDispatcher1Wrapper, streamTransportDispatcher } from './streamTransport.js';

// Longer than the control dispatcher's body ceiling below (undici rounds a
// short body timeout up to its ~500ms fast-timer tick, so the gap is wide
// enough that the control fails deterministically), short enough to keep the
// suite quick.
const QUIET_MS = 1500;
const CONTROL_BODY_TIMEOUT_MS = 100;

// A provider that opens the stream, sends one frame, then goes quiet before
// finishing: the exact shape that made undici's transport ceiling — not the
// run's own stall bound — end an NVIDIA NIM streaming run.
const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write('data: first\n\n');
  const quiet = setTimeout(() => res.end('data: [DONE]\n\n'), QUIET_MS);
  res.on('close', () => clearTimeout(quiet));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

// The dispatcher is a process-wide keep-alive pool; close it so its idle
// sockets can't hold the runner open past this file.
afterAll(async () => {
  await streamTransportDispatcher().close();
  server.close();
});

// Same wrapping rule as the module under test, so the control differs from it
// in the timeouts ALONE — including on a runtime whose built-in fetch refuses
// an unwrapped undici-8 dispatcher.
const controlDispatcher = () => {
  const agent = new Agent({ headersTimeout: 0, bodyTimeout: CONTROL_BODY_TIMEOUT_MS });
  return needsDispatcher1Wrapper(process.versions.undici) ? new Dispatcher1Wrapper(agent) : agent;
};

const readAll = (dispatcher) => fetch(url, { dispatcher }).then((res) => res.text());

describe('streaming transport dispatcher', () => {
  it('lets a stream go quiet past a ceiling that would otherwise cut it', async () => {
    const control = controlDispatcher();
    // The ceiling is real and this plumbing reaches it: with a body timeout
    // configured, the quiet window kills the request.
    await expect(readAll(control)).rejects.toThrow();
    await control.close();

    // With `0` (undici's "no timer", not "expire immediately") the same quiet
    // window is survived, leaving `executeApiRun`'s stall and absolute bounds
    // as the only ceilings on the run — so a provider that goes silent is
    // classified as the stall TIMEOUT it is (with `timeoutBound` stamped for
    // the bench decision) instead of a `network-error`, and a `provider.timeout`
    // raised past undici's default 300s is no longer silently capped.
    await expect(readAll(streamTransportDispatcher())).resolves.toContain('[DONE]');
  });

  it('wraps the dispatcher only for runtimes bundling undici < 8', () => {
    // Node 22/24/25 bundle undici 6/7, whose handler contract undici 8 dropped:
    // a bare undici-8 Agent is rejected there (`UND_ERR_INVALID_ARG`).
    expect(needsDispatcher1Wrapper('6.22.0')).toBe(true);
    expect(needsDispatcher1Wrapper('7.24.4')).toBe(true);
    // Node 26+ bundles undici 8 and its built-in fetch negotiates HTTP/2. The
    // wrapper forces `allowH2: false`, which would cost the run the GOAWAY
    // frames `preHeaderRetry.js` replays against a billable provider.
    expect(needsDispatcher1Wrapper('8.0.2')).toBe(false);
    // Unreadable version → the wrapper, which BOTH contracts accept.
    expect(needsDispatcher1Wrapper(undefined)).toBe(true);
  });

  it('disables both of undici\'s per-request no-progress ceilings', () => {
    expect(STREAM_TRANSPORT_TIMEOUTS).toEqual({ headersTimeout: 0, bodyTimeout: 0 });
  });
});
