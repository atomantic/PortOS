import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

// This is the inference API, independent of federation record/status transport.
// Bodies live only for their HTTP request; interrupted streams are never replayed.
export function createFleetLlmGateway({ upstream, apiKey, maxQueued = 16, maxBodyBytes = 2 * 1024 ** 2, waitMs = 120000, runMs = 600000 }) {
  const pending = [];
  let active = null;
  let closing = false;
  let discovery = null;
  // Coalesce discovery independently: a long generation must not make clients
  // mark a healthy provider offline just because /models waits for its slot.
  const models = () => {
    if (!discovery) discovery = fetch(upstream + '/v1/models', {
      headers: { Authorization: 'Bearer ' + apiKey }, redirect: 'error', signal: AbortSignal.timeout(5000),
    }).then(async (response) => ({ status: response.status, body: await response.text() }))
      .finally(() => { discovery = null; });
    return discovery;
  };
  const reply = (res, status, message) => {
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) return res.destroy();
    res.writeHead(status, { 'Content-Type': 'application/json', ...(status === 429 ? { 'Retry-After': '10' } : {}) });
    res.end(JSON.stringify({ error: { message, type: 'fleet_host_error' } }));
  };
  const authenticated = (header) => {
    const expected = Buffer.from(`Bearer ${apiKey}`);
    const supplied = Buffer.from(String(header || ''));
    return apiKey?.length >= 24 && expected.length === supplied.length && timingSafeEqual(expected, supplied);
  };
  const pump = () => {
    if (active || closing || !pending[0]?.ready) return;
    const job = pending.shift();
    if (!job) return;
    active = job;
    clearTimeout(job.waitTimer);
    job.runTimer = setTimeout(() => job.controller.abort(), runMs);
    execute(job).catch(() => reply(job.res, 502, 'Model connection failed or exceeded its time limit.'))
      .finally(() => {
        clearTimeout(job.runTimer);
        active = null;
        pump();
      });
  };
  const execute = async (job) => {
    const response = await fetch(`${upstream}${job.path}`, {
      method: job.req.method,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: job.body,
      signal: job.controller.signal,
      redirect: 'error',
    });
    job.res.writeHead(response.status, {
      'Content-Type': response.headers.get('content-type') || 'application/json',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    });
    if (response.body) await pipeline(Readable.fromWeb(response.body), job.res, { signal: job.controller.signal });
    else job.res.end();
  };
  const handle = async (req, res) => {
    if (!authenticated(req.headers.authorization)) return reply(res, 401, 'A valid model host API key is required.');
    const path = req.url;
    if (req.method === 'GET' && path === '/v1/models' && !closing) {
      const result = await models().catch(() => null);
      if (!result) return reply(res, 502, 'Model discovery is unavailable.');
      if (res.destroyed) return;
      res.writeHead(result.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(result.body);
    }
    if (!((req.method === 'GET' && path === '/v1/models') || (req.method === 'POST' && path === '/v1/chat/completions'))) {
      return reply(res, 404, 'Use /v1/models or /v1/chat/completions.');
    }
    if (closing || pending.length >= maxQueued) return reply(res, 429, 'Model host queue is full. Retry later.');
    const job = { req, res, path, controller: new AbortController() };
    // Reserve before reading the body, so concurrent uploads cannot bypass the cap.
    pending.push(job);
    const remove = () => {
      const index = pending.indexOf(job);
      if (index >= 0) pending.splice(index, 1);
      clearTimeout(job.waitTimer);
      job.controller.abort();
      pump();
    };
    res.on('close', remove);
    job.waitTimer = setTimeout(() => { reply(res, 429, 'Model host queue wait expired. Retry later.'); remove(); }, waitMs);
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > maxBodyBytes) { reply(res, 413, 'Request exceeds the model host body limit.'); remove(); return; }
      chunks.push(chunk);
    }
    if (job.controller.signal.aborted) return;
    job.body = req.method === 'POST' ? Buffer.concat(chunks) : undefined;
    job.ready = true;
    // Uploads are bounded and preserve arrival order; pump only complete bodies.
    pump();
  };
  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => { reply(res, 400, 'Request could not be read.'); res.destroy(); });
  });
  server.requestTimeout = waitMs;
  return {
    server,
    status: () => ({ active: active ? 1 : 0, queued: pending.length, maxActive: 1, maxQueued }),
    close: async () => {
      closing = true;
      for (const job of [...pending, ...(active ? [active] : [])]) {
        clearTimeout(job.waitTimer);
        job.controller.abort();
        reply(job.res, 503, 'Model host is stopping.');
      }
      pending.length = 0;
      server.closeAllConnections();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    },
  };
}
