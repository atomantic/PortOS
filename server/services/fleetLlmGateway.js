import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';

import { createUsageSniffer } from '../lib/fleetHostUsage.js';
import { createStallDetector, readVllmProgress } from './fleetLlmStallWatch.js';

const STALL_MESSAGE = 'Model runtime is not generating. The host is restarting it.';

/**
 * The generation a job asked for, read from the request body it already holds.
 *
 * Attribution only — the model id is the one field of an inbound body this host
 * records, so the report can say WHICH model a peer spent the GPU on. Nothing
 * else is read, and a body that does not parse simply has no model.
 */
function requestedModel(body) {
  if (!body || body.length === 0) return null;
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    return typeof parsed?.model === 'string' && parsed.model !== '' ? parsed.model : null;
  } catch {
    return null;
  }
}

// This is the inference API, independent of federation record/status transport.
// Bodies live only for their HTTP request; interrupted streams are never replayed.
//
// `usage` is the inbound ledger (`lib/fleetHostUsage.js`), optional so the
// gateway can be constructed without one. Every ADMITTED generation opens
// exactly one ledger entry and closes it once — including the ones that fail,
// time out, or are cancelled by a client hanging up, because "a peer started 40
// requests and abandoned 39" is precisely the pattern an operator wondering
// where their GPU went needs to see. Discovery calls (`GET /v1/models`) are NOT
// recorded as generations: every connected client polls that on a timer, and
// counting them would bury the real traffic.
//
// Stall watchdog: while a job is admitted, the private runtime's own progress
// counters are polled every `stallPollMs` (nothing is called while idle). A
// running request whose token totals do not move for `stalledAfterMs` marks the
// engine `stalled`: the active job is aborted, waiting jobs and new arrivals get
// an immediate 503, and `restartRuntime` (optional) runs at most once per
// `restartCooldownMs`. `readProgress` and `now` are injectable for tests;
// `stallPollMs: 0` disables the timer, leaving `pollStall()` to be driven by hand.
export function createFleetLlmGateway({
  upstream, apiKey, usage = null, onRecorded = () => {}, onChanged = () => {}, maxQueued = 16, maxBodyBytes = 2 * 1024 ** 2, waitMs = 120000, runMs = 600000,
  stallPollMs = 15000, stalledAfterMs = 120000, restartCooldownMs = 600000, now = Date.now, readProgress = null, restartRuntime = null,
}) {
  const pending = [];
  let active = null;
  let closing = false;
  let discovery = null;
  const detector = createStallDetector({ stalledAfterMs, now });
  const stalled = () => detector.stalledSince() !== null;
  let watchTimer = null;
  let polling = false;
  let lastRestartAt = null;
  let restarting = false;
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
  // Closed exactly once per admitted job, from whichever path finishes it
  // first — a normal completion, a 502, or a client that hung up mid-stream.
  const settle = (job, status) => {
    if (!job.ledger || job.settled) return;
    job.settled = true;
    usage.endRequest(job.ledger, {
      status: status ?? job.status ?? null,
      usage: job.sniffer?.result() || null,
      model: job.model,
    });
    onRecorded();
  };
  const pump = () => {
    if (active || closing || stalled() || !pending[0]?.ready) return;
    const job = pending.shift();
    if (!job) return;
    active = job;
    onChanged();
    armWatch();
    clearTimeout(job.waitTimer);
    job.runTimer = setTimeout(() => job.controller.abort(), runMs);
    execute(job).catch(() => reply(job.res, 502, 'Model connection failed or exceeded its time limit.'))
      .finally(() => {
        clearTimeout(job.runTimer);
        settle(job, job.status ?? 502);
        active = null;
        onChanged();
        pump();
      });
  };
  const armWatch = () => {
    if (watchTimer || stallPollMs <= 0 || closing) return;
    watchTimer = setInterval(() => { void pollStall(); }, stallPollMs);
    watchTimer.unref?.();
  };
  const disarmWatch = () => { clearInterval(watchTimer); watchTimer = null; };
  const cooldownElapsed = () => lastRestartAt === null || now() - lastRestartAt >= restartCooldownMs;
  const requestRestart = () => {
    lastRestartAt = now();
    restarting = true;
    Promise.resolve().then(restartRuntime)
      .then(() => console.log('🔄 Fleet host runtime restart requested'))
      .catch((err) => console.error(`❌ Fleet host runtime restart failed: ${String(err?.message ?? err).split('\n')[0].slice(0, 200)}`))
      .finally(() => { restarting = false; });
  };
  const restartOnce = () => {
    if (!restartRuntime) return;
    if (!cooldownElapsed()) {
      console.log('⏭️ Fleet host runtime stalled again inside the restart cooldown; restarting it once the cooldown passes');
      return;
    }
    requestRestart();
  };
  // A stall only clears when the runtime shows life, and nothing is admitted
  // while stalled, so a stall that began inside the cooldown or whose restart
  // failed would refuse every request until someone restarted it by hand.
  // Retry once the cooldown passes, but only while the runtime still answers
  // /metrics: an unreachable one is mid-restart or cold-loading.
  const retryRestart = () => {
    if (!restartRuntime || restarting || !cooldownElapsed()) return;
    console.log('🔄 Fleet host runtime is still not generating after the restart cooldown; restarting it again');
    requestRestart();
  };
  const enterStall = () => {
    console.error('❌ Fleet host runtime stalled: a request is running but no tokens have moved');
    for (const job of pending.splice(0)) {
      clearTimeout(job.waitTimer);
      job.status = 503;
      reply(job.res, 503, STALL_MESSAGE);
      job.controller.abort();
      settle(job, 503);
    }
    // The active job's own run path closes its ledger entry and answers its client 502.
    active?.controller.abort();
    onChanged();
    restartOnce();
  };
  // One watchdog tick. A sample read while a different job took the slot is
  // discarded, since the counters would be attributed to the wrong request.
  const pollStall = async () => {
    if (polling) return;
    polling = true;
    try {
      if (closing || (!active && !stalled())) { detector.idle(); disarmWatch(); return; }
      const job = active;
      const progress = await (readProgress ? readProgress() : readVllmProgress({ upstream, apiKey })).catch(() => null);
      if (closing || (!stalled() && active !== job)) return;
      const transition = detector.sample(progress, job);
      if (transition === 'stalled') enterStall();
      else if (transition === 'cleared') {
        console.log('✅ Fleet host runtime is generating again');
        onChanged();
        pump();
      } else if (progress && stalled()) retryRestart();
    } catch (err) {
      console.error(`❌ Fleet host stall check failed: ${String(err?.message ?? err).split('\n')[0].slice(0, 200)}`);
    } finally {
      polling = false;
    }
  };
  const execute = async (job) => {
    const response = await fetch(`${upstream}${job.path}`, {
      method: job.req.method,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: job.body,
      signal: job.controller.signal,
      redirect: 'error',
    });
    job.status = response.status;
    job.res.writeHead(response.status, {
      'Content-Type': response.headers.get('content-type') || 'application/json',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    });
    if (!response.body) return job.res.end();
    // A pass-through tap rather than a tee: the client's stream stays the
    // pipeline's only consumer (so backpressure and cancellation behave exactly
    // as before) and the sniffer just watches the bytes go past, holding a
    // bounded tail of them to read the final `usage` frame out of. The tap is a
    // pipeline stage, never `.pipe()`d: `.pipe()` does not forward errors, so the
    // AbortError a client hang-up raises on the body escaped as an uncaught
    // 'error' and crashed the host.
    const stages = [Readable.fromWeb(response.body)];
    if (job.sniffer) stages.push(new Transform({
      transform(chunk, _enc, done) { job.sniffer.push(chunk); done(null, chunk); },
    }));
    await pipeline(...stages, job.res, { signal: job.controller.signal });
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
    if (stalled()) return reply(res, 503, STALL_MESSAGE);
    if (closing || pending.length >= maxQueued) return reply(res, 429, 'Model host queue is full. Retry later.');
    const job = { req, res, path, controller: new AbortController() };
    if (usage) {
      job.ledger = usage.beginRequest({ address: req.socket?.remoteAddress, path });
      job.sniffer = createUsageSniffer();
    }
    // Reserve before reading the body, so concurrent uploads cannot bypass the cap.
    pending.push(job);
    onChanged();
    const remove = () => {
      const index = pending.indexOf(job);
      if (index >= 0) pending.splice(index, 1);
      clearTimeout(job.waitTimer);
      job.controller.abort();
      // A job still QUEUED never reaches `pump`'s finally, so close its ledger
      // entry here. One already running (or already finished) is settled there
      // instead, and `settle`'s own once-guard makes a second call a no-op.
      if (index >= 0) { settle(job, job.status ?? 499); onChanged(); }
      pump();
    };
    res.on('close', remove);
    job.waitTimer = setTimeout(() => { job.status = 429; reply(res, 429, 'Model host queue wait expired. Retry later.'); remove(); }, waitMs);
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > maxBodyBytes) { job.status = 413; reply(res, 413, 'Request exceeds the model host body limit.'); remove(); return; }
      chunks.push(chunk);
    }
    if (job.controller.signal.aborted) return;
    job.body = req.method === 'POST' ? Buffer.concat(chunks) : undefined;
    job.model = requestedModel(job.body);
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
    pollStall,
    status: () => ({
      active: active ? 1 : 0, queued: pending.length, maxActive: 1, maxQueued,
      stalled: stalled(), stalledSince: stalled() ? new Date(detector.stalledSince()).toISOString() : null,
    }),
    close: async () => {
      closing = true;
      disarmWatch();
      for (const job of [...pending, ...(active ? [active] : [])]) {
        clearTimeout(job.waitTimer);
        job.controller.abort();
        reply(job.res, 503, 'Model host is stopping.');
        settle(job, 503);
      }
      pending.length = 0;
      onChanged();
      server.closeAllConnections();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    },
  };
}
