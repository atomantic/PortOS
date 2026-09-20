import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFleetLlmGateway } from './fleetLlmGateway.js';

const key = 'example-api-key-with-32-characters';
const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
const resources = [];
const listen = async (server) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
};
afterEach(async () => {
  for (const close of resources.reverse()) await close();
  resources.length = 0;
});
async function setup(options = {}) {
  const received = [];
  const upstream = http.createServer((req, res) => {
    if (req.url === '/v1/models') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"data":[{"id":"example-model"}]}'); return; }
    received.push({ req, res });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[]}\n\n');
  });
  const target = await listen(upstream);
  resources.push(async () => { upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); });
  const gateway = createFleetLlmGateway({ upstream: target, apiKey: key, ...options });
  const base = await listen(gateway.server);
  resources.push(gateway.close);
  const post = (signal, body = '{}') => fetch(base + '/v1/chat/completions', { method: 'POST', headers, body, signal });
  return { received, gateway, base, post };
}

describe('shared inference HTTP boundary', () => {
  it('serializes independent clients, preserves SSE, rejects overload and cancels active inference', async () => {
    const { post, received, gateway, base } = await setup({ maxQueued: 1 });
    expect((await fetch(base + '/v1/models')).status).toBe(401);
    const firstAbort = new AbortController();
    const first = await post(firstAbort.signal);
    const reader = first.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('data:');
    expect((await fetch(base + '/v1/models', { headers })).status).toBe(200);
    expect(gateway.status().active).toBe(1);
    const second = post();
    await vi.waitFor(() => expect(gateway.status().queued).toBe(1));
    expect(received).toHaveLength(1);
    const overflow = await post();
    expect(overflow.status).toBe(429);
    expect(overflow.headers.get('retry-after')).toBe('10');
    firstAbort.abort();
    const next = await second;
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received[0].res.destroyed).toBe(true);
    received[1].res.end('data: [DONE]\n\n');
    expect(await next.text()).toContain('[DONE]');
    await vi.waitFor(() => expect(gateway.status()).toMatchObject({ active: 0, queued: 0 }));
  });

  it('removes a disconnected queued client without forwarding its prompt', async () => {
    const { post, received, gateway } = await setup();
    const first = await post();
    const abort = new AbortController();
    const pending = post(abort.signal).catch(() => null);
    await vi.waitFor(() => expect(gateway.status().queued).toBe(1));
    abort.abort();
    await pending;
    await vi.waitFor(() => expect(gateway.status().queued).toBe(0));
    received[0].res.end();
    await first.text();
    expect(received).toHaveLength(1);
  });

  it('bounds queue waiting and body size without occupying a generation slot', async () => {
    const { post, received, gateway } = await setup({ waitMs: 100, maxBodyBytes: 32 });
    expect((await post(undefined, 'x'.repeat(33))).status).toBe(413);
    const first = await post();
    expect((await post()).status).toBe(429);
    expect(received).toHaveLength(1);
    received[0].res.end();
    await first.text();
    await vi.waitFor(() => expect(gateway.status().queued).toBe(0));
  });
});

describe('inbound usage accounting', () => {
  // The whole point of the ledger is attribution the queue depth cannot give,
  // so it is asserted at the HTTP boundary — a unit test of the ledger alone
  // cannot prove the gateway closes every entry it opens.
  const ledgerDouble = () => {
    const open = new Map();
    const closed = [];
    return {
      closed,
      openCount: () => open.size,
      beginRequest({ address, path }) {
        const handle = { id: `h${open.size + closed.length}`, address, path };
        open.set(handle.id, handle);
        return handle;
      },
      endRequest(handle, detail) {
        open.delete(handle.id);
        closed.push({ handle, ...detail });
      },
    };
  };

  it('records a completed generation with the model asked for and the tokens the reply reported', async () => {
    const usage = ledgerDouble();
    const { post, received, gateway } = await setup({ usage });
    const pending = post(undefined, JSON.stringify({ model: 'qwen3.8-27b', messages: [] }));
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(usage.openCount()).toBe(1);
    received[0].res.end('data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":34}}\n\ndata: [DONE]\n\n');
    await (await pending).text();

    await vi.waitFor(() => expect(usage.closed).toHaveLength(1));
    expect(usage.closed[0]).toMatchObject({
      status: 200,
      model: 'qwen3.8-27b',
      usage: { promptTokens: 12, completionTokens: 34 },
    });
    expect(usage.closed[0].handle.path).toBe('/v1/chat/completions');
    await vi.waitFor(() => expect(gateway.status().active).toBe(0));
  });

  it('closes the entry for a client that hangs up while still queued', async () => {
    // A queued job never reaches the run path, so without its own close it
    // would count as generating forever on the report.
    const usage = ledgerDouble();
    const { post, received, gateway } = await setup({ usage });
    const first = await post();
    const abort = new AbortController();
    const pending = post(abort.signal).catch(() => null);
    await vi.waitFor(() => expect(gateway.status().queued).toBe(1));
    abort.abort();
    await pending;
    await vi.waitFor(() => expect(usage.closed).toHaveLength(1));
    received[0].res.end();
    await first.text();
    await vi.waitFor(() => expect(usage.openCount()).toBe(0));
  });

  it('does not count a /v1/models poll as a generation', async () => {
    const usage = ledgerDouble();
    const { base } = await setup({ usage });
    expect((await fetch(base + '/v1/models', { headers })).status).toBe(200);
    expect(usage.openCount()).toBe(0);
    expect(usage.closed).toHaveLength(0);
  });
});
