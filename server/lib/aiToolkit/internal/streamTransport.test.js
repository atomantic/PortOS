import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestProviderStream } from './streamTransport.js';

describe('provider stream transport', () => {
  const servers = [];

  async function listen(handler) {
    const server = http.createServer(handler);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    servers.push(server);
    return `http://127.0.0.1:${server.address().port}`;
  }

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => {
      server.closeAllConnections();
      return new Promise(resolve => server.close(resolve));
    }));
  });

  it('streams the first chunk before completion and aborts the response socket on demand', async () => {
    const disconnected = Promise.withResolvers();
    const url = await listen((_req, res) => {
      res.on('close', disconnected.resolve);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: first\n\n');
    });
    const controller = new AbortController();
    const response = await requestProviderStream(url, { body: '{}', signal: controller.signal });
    const reader = response.body.getReader();
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: first\n\n');
    controller.abort();
    await expect(reader.read()).rejects.toMatchObject({ code: 'ECONNRESET' });
    await disconnected.promise;
  });

  it('lets the run cancel before headers without imposing another deadline', async () => {
    const accepted = Promise.withResolvers();
    const url = await listen(() => accepted.resolve());
    const controller = new AbortController();
    const pending = requestProviderStream(url, { body: '{}', signal: controller.signal });
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await accepted.promise;
    controller.abort();
    await rejection;
  });

  it('decodes a compressed error while preserving status and headers', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(429, { 'Retry-After': '5', 'Content-Encoding': 'gzip' });
      res.end(gzipSync('quota exhausted'));
    });
    const response = await requestProviderStream(url, { body: '{}' });
    expect(response).toMatchObject({ status: 429, ok: false });
    expect(response.headers.get('retry-after')).toBe('5');
    await expect(response.text()).resolves.toBe('quota exhausted');
  });

  it('follows a same-origin 307 with the JSON body and a cross-origin 303 without credentials', async () => {
    const received = vi.fn();
    const finish = await listen((req, res) => {
      received(req.method, req.headers.authorization, req.headers['content-length']);
      res.end('done');
    });
    const start = await listen(async (req, res) => {
      if (req.url === '/start') {
        res.writeHead(307, { Location: '/second' }).end();
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      received(req.method, req.headers.authorization, body);
      res.writeHead(303, { Location: finish }).end();
    });
    const response = await requestProviderStream(`${start}/start`, {
      headers: { Authorization: 'Bearer example', 'Content-Type': 'application/json' },
      body: '{"model":"example"}',
    });
    await expect(response.text()).resolves.toBe('done');
    expect(received.mock.calls).toEqual([
      ['POST', 'Bearer example', '{"model":"example"}'],
      ['GET', undefined, undefined],
    ]);
  });
});
