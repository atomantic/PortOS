import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTrafficAccumulator } from './collectionTraffic.js';
import {
  createEndpointRedactor, installLiveTransport, liveFindings, parseLiveAuditArgs,
  preflightLiveTransport, resolveLiveOrigin,
} from './liveTraffic.js';
import { exitCodeFor, runLiveAudit } from './liveBrowserAudit.mjs';
import { requestApi } from '../portos-api.js';

const ORIGIN = 'http://127.0.0.1:5553';
const TOKEN = 'tok-example-0123456789abcdef';
const CATALOG = {
  mounts: ['/api/image-gen', '/api/messages'],
  routes: [
    { method: 'GET', path: '/api/image-gen/gallery' },
    { method: 'GET', path: '/api/image-gen/:filename/variants' },
    { method: 'GET', path: '/api/messages/inbox' },
    { method: 'GET', path: '/api/messages/:accountId/:messageId' },
  ],
};

describe('live audit redaction', () => {
  it('reduces live URLs to source route patterns with no identifiers, queries, hosts or credentials', () => {
    const redact = createEndpointRedactor({ origin: ORIGIN, pages: ['/media/history'], catalog: CATALOG });
    const traffic = createTrafficAccumulator({ label: redact });
    const urls = [
      `${ORIGIN}/api/image-gen/gallery?limit=60&search=alice%40example.com`,
      `${ORIGIN}/api/image-gen/portrait-of-alice.png/variants`,
      `${ORIGIN}/api/messages/alice@example.com/msg-4711`,
      `${ORIGIN}/api/messages/inbox?token=${TOKEN}`,
      `${ORIGIN}/api/image-gen/private-project/unknown/route`,
      `${ORIGIN}/api/unmounted-secret/alice`,
      `${ORIGIN}/data/images/alice-at-home.png`,
      `${ORIGIN}/media/history?q=alice`,
      `${ORIGIN}/brain/people/alice-example`,
      'http://127.0.0.1:5560/api/messages/inbox',
      'https://tracker.example.net/collect?u=alice',
    ];
    urls.forEach((url, i) => {
      traffic.event('requestWillBeSent', { requestId: 'r' + i, request: { url, method: 'GET' } });
      traffic.event('loadingFinished', { requestId: 'r' + i, encodedDataLength: 10 });
    });
    traffic.event('webSocketCreated', { requestId: 's', url: `ws://127.0.0.1:5553/socket.io/?EIO=4&sid=${TOKEN}` });
    const phases = traffic.snapshot();
    expect(Object.keys(phases.cold)).toEqual([':foreign-origin', '/:page', '/api/:unmatched', '/api/image-gen/:filename/variants',
      '/api/image-gen/:unmatched', '/api/image-gen/gallery', '/api/messages/:accountId/:messageId', '/api/messages/inbox',
      '/data/:asset', '/media/history']);
    expect(phases.cold[':foreign-origin'].requests).toBe(2);
    expect(JSON.stringify(phases)).not.toMatch(/alice|msg-4711|private-project|unmounted|tok-example|127\.0\.0\.1|5553|5560|example\.(com|net)/);
  });

  it('counts sequential repeats and concurrent duplicates without keeping the URL', () => {
    const traffic = createTrafficAccumulator({ label: createEndpointRedactor({ origin: ORIGIN, catalog: CATALOG }) });
    const send = id => traffic.event('requestWillBeSent', { requestId: id, request: { url: `${ORIGIN}/api/messages/inbox?cursor=alice`, method: 'GET' } });
    send('a'); send('b');
    traffic.event('loadingFinished', { requestId: 'a', encodedDataLength: 1 });
    traffic.event('loadingFinished', { requestId: 'b', encodedDataLength: 1 });
    send('c');
    expect(traffic.snapshot().cold['/api/messages/inbox']).toMatchObject({ requests: 3, duplicates: 2, overlapping: 1 });
    expect(traffic.pendingByEndpoint()).toEqual({ '/api/messages/inbox': 1 });
  });

  it('reports blocked requests once, sibling collection refetches and in-flight work as findings', () => {
    const row = (overrides) => ({ requests: 0, failed: 0, canceled: 0, overlapping: 0, httpErrors: 0, ...overrides });
    const findings = liveFindings({
      phases: {
        cold: { '/api/image-gen/gallery': row({ requests: 1 }), ':foreign-origin': row({ requests: 1, failed: 1 }) },
        sibling: { '/api/image-gen/gallery': row({ requests: 1, httpErrors: 1 }) },
      },
      blocked: [{ phase: 'cold', reason: 'foreign-origin', endpoint: ':foreign-origin', count: 1 }],
      inFlight: { '/api/settings': 1 },
      collectionEndpoint: '/api/image-gen/gallery',
    });
    expect(findings.map(f => `${f.phase} ${f.reason}`)).toEqual(['sibling http-error', 'sibling sibling-collection-refetch',
      'cold blocked-foreign-origin', 'end in-flight-at-end']);
  });
});

describe('live audit transport', () => {
  const servers = [];
  const listen = handler => new Promise(resolve => {
    const seen = [];
    const server = createServer((req, res) => { seen.push({ path: req.url, authorization: req.headers.authorization }); handler(req, res); });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve({ origin: `http://127.0.0.1:${server.address().port}`, seen }));
  });
  afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve)))); });

  it('accepts only an exact plain-HTTP loopback origin', () => {
    expect(resolveLiveOrigin('http://127.0.0.1:5553/')).toBe(ORIGIN);
    expect(resolveLiveOrigin('http://[::1]:5553')).toBe('http://[::1]:5553');
    const reasons = ['https://127.0.0.1:5555', 'http://portos.example.ts.net:5555', 'http://192.0.2.10:5555',
      'http://user:pw@127.0.0.1:5553', 'http://127.0.0.1:5553/api', 'not a url'].map(raw => {
      try { resolveLiveOrigin(raw); return 'accepted'; } catch (error) { return error.reason; }
    });
    expect(reasons).toEqual(['non-loopback-origin', 'non-loopback-origin', 'non-loopback-origin', 'invalid-origin', 'invalid-origin', 'invalid-origin']);
  });

  it('presents the bearer only to the exact origin and never follows a redirect elsewhere', async () => {
    const decoy = await listen((req, res) => res.end('{}'));
    const auth = await listen((req, res) => res.end(JSON.stringify({ required: true, authenticated: req.headers.authorization === `Bearer ${TOKEN}` })));
    const redirecting = await listen((req, res) => { res.writeHead(302, { location: decoy.origin + '/api/auth/whoami' }); res.end(); });
    const open = await listen((req, res) => res.end(JSON.stringify({ required: false, authenticated: true })));

    await expect(preflightLiveTransport({ origin: auth.origin, token: TOKEN, request: requestApi })).resolves.toEqual({ ok: true, mode: 'delegated-session' });
    await expect(preflightLiveTransport({ origin: auth.origin, token: 'revoked', request: requestApi })).resolves.toEqual({ ok: false, reason: 'credential-rejected' });
    await expect(preflightLiveTransport({ origin: auth.origin, token: null, request: requestApi })).resolves.toEqual({ ok: false, reason: 'credential-missing' });
    await expect(preflightLiveTransport({ origin: redirecting.origin, token: TOKEN, request: requestApi })).resolves.toEqual({ ok: false, reason: 'whoami-unreadable' });
    await expect(preflightLiveTransport({ origin: open.origin, token: TOKEN, request: requestApi })).resolves.toEqual({ ok: true, mode: 'password-free' });
    expect(auth.seen.map(r => r.path)).toEqual(['/api/auth/whoami', '/api/auth/whoami', '/api/auth/whoami']);
    expect(decoy.seen).toEqual([]);
    const [authServer] = servers.splice(1, 1);
    await new Promise(resolve => authServer.close(resolve));
    await expect(preflightLiveTransport({ origin: auth.origin, token: TOKEN, request: requestApi })).resolves.toEqual({ ok: false, reason: 'origin-unreachable' });
  });

  it('guards every request and WebSocket before the session cookie enters the browser context', async () => {
    const calls = [];
    let routeHandler, socketMatcher;
    const context = {
      route: async (_match, handler) => { calls.push('route'); routeHandler = handler; },
      routeWebSocket: async (match) => { calls.push('routeWebSocket'); socketMatcher = match; },
      addCookies: async cookies => calls.push(['addCookies', cookies]),
    };
    const blocked = [];
    await installLiveTransport(context, { origin: ORIGIN, token: TOKEN, onBlocked: (reason, url) => blocked.push([reason, url]) });
    expect(calls).toEqual(['route', 'routeWebSocket', ['addCookies', [{ name: 'portos_auth_5553', value: TOKEN, url: ORIGIN, httpOnly: true, sameSite: 'Strict' }]]]);

    const decide = async (url, method = 'GET') => {
      let outcome;
      await routeHandler({ request: () => ({ url: () => url, method: () => method }),
        continue: async () => { outcome = 'continue'; }, abort: async () => { outcome = 'abort'; } });
      return outcome;
    };
    expect(await decide(`${ORIGIN}/api/messages/inbox`)).toBe('continue');
    expect(await decide(`${ORIGIN}/socket.io/?EIO=4&transport=polling`, 'POST')).toBe('continue');
    expect(await decide(`${ORIGIN}/api/messages/sync`, 'POST')).toBe('abort');
    expect(await decide('http://127.0.0.1:5560/api/auth/whoami')).toBe('abort');
    expect(await decide('http://localhost:5553/api/auth/whoami')).toBe('abort');
    expect(await decide('https://cdn.example.net/x.js')).toBe('abort');
    expect(blocked.map(([reason]) => reason)).toEqual(['mutation', 'foreign-origin', 'foreign-origin', 'foreign-origin']);
    expect(socketMatcher(new URL('ws://127.0.0.1:5553/socket.io/'))).toBe(false);
    expect(socketMatcher(new URL('ws://127.0.0.1:5560/socket.io/'))).toBe(true);
  });

  it('stays UNVERIFIED with a next step, without launching a browser, when no authorized transport exists', async () => {
    const chromium = { launch: vi.fn() };
    const args = parseLiveAuditArgs([]);
    const env = { PORTOS_URL: 'http://192.0.2.10:5555', PORTOS_AGENT_KEY_FILE: '/nonexistent/agent-key.json', PORTOS_API_TOKEN: TOKEN };
    const request = vi.fn();
    const remote = await runLiveAudit({ args, env, chromium, request });
    expect(request).not.toHaveBeenCalled();
    expect(remote).toMatchObject({ live: true, synthetic: false, status: 'unverified', unverified: { reason: 'non-loopback-origin' } });

    const auth = await listen((req, res) => res.end(JSON.stringify({ required: true, authenticated: false })));
    const missing = await runLiveAudit({ args, env: { PORTOS_URL: auth.origin, PORTOS_AGENT_KEY_FILE: '/nonexistent/agent-key.json' }, chromium });
    expect(missing.unverified).toMatchObject({ reason: 'credential-missing', nextStep: expect.stringContaining('Agent API key') });
    expect(chromium.launch).not.toHaveBeenCalled();
    expect(exitCodeFor(missing)).toBe(2);
    expect(JSON.stringify([remote, missing])).not.toMatch(/tok-example|192\.0\.2\.10|127\.0\.0\.1/);
  });

  it('parses a bounded live window and requires a collection marker', () => {
    expect(parseLiveAuditArgs(['out.json', '--route=/messages/inbox', '--sibling=/messages/contacts', '--idle-ms=90000']))
      .toEqual({ output: 'out.json', route: '/messages/inbox', sibling: '/messages/contacts', collectionEndpoint: '/api/messages/inbox', idleMs: 90000 });
    for (const bad of [['--idle-ms=5000'], ['--route=/brain/people'], ['--route=//evil.example'], ['--route=/Media'], ['--sibling=/media/history']]) {
      expect(() => parseLiveAuditArgs(bad)).toThrow();
    }
  });
});
