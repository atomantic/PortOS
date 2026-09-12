import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

vi.mock('../services/beeperStatus.js', () => ({
  getBeeperStatus: vi.fn(),
  checkBeeperConnection: vi.fn(),
}));
vi.mock('../services/beeperOAuth.js', () => ({
  startBeeperOAuth: vi.fn(),
  completeBeeperOAuth: vi.fn(),
  connectWithPastedToken: vi.fn(),
  disconnectBeeper: vi.fn(),
}));
vi.mock('../services/beeperSync.js', () => ({ runBeeperSweep: vi.fn() }));
vi.mock('../services/beeperOutbox.js', () => ({
  createOutboxEntry: vi.fn(),
  sendOutboxEntry: vi.fn(),
  discardOutboxEntry: vi.fn(),
  reconcileOutboxEntry: vi.fn(),
  listOutboxEntries: vi.fn(),
  clearOutboxBreaker: vi.fn(),
}));
vi.mock('../services/beeperConversations.js', () => ({
  listConversations: vi.fn(),
  getConversation: vi.fn(),
  listMessages: vi.fn(),
  listNetworks: vi.fn(),
  markConversationSeen: vi.fn(),
  purgeConversation: vi.fn(),
  setConversationArchived: vi.fn(),
  setConversationLowPriority: vi.fn(),
}));
vi.mock('../services/beeperAttachments.js', () => ({
  backfillAttachments: vi.fn(),
  ensureAttachmentBytes: vi.fn(),
  getAttachment: vi.fn(),
  getAttachmentSummary: vi.fn(),
  setAttachmentKeep: vi.fn(),
}));
// The bytes themselves are served by the shared `serveLocalFile` pipeline,
// whose behaviour (sanitize → containment → nosniff → sendFile) is covered by
// its own suite. What this file pins is what the ROUTE hands it: the resolved
// path, and the stored mimeType as an explicit `contentType` — because
// `GET /v1/assets/serve` sends no Content-Type and a hash-named file has no
// extension worth sniffing.
vi.mock('../lib/fileUtils.js', async (importOriginal) => ({
  ...(await importOriginal()),
  serveLocalFile: vi.fn(async (res) => res.json({ served: true })),
}));

import beeperRoutes from './beeper.js';
import { getBeeperStatus, checkBeeperConnection } from '../services/beeperStatus.js';
import {
  completeBeeperOAuth, connectWithPastedToken, disconnectBeeper, startBeeperOAuth,
} from '../services/beeperOAuth.js';
import { runBeeperSweep } from '../services/beeperSync.js';
import {
  clearOutboxBreaker, createOutboxEntry, discardOutboxEntry, listOutboxEntries, sendOutboxEntry, reconcileOutboxEntry,
} from '../services/beeperOutbox.js';
import {
  listConversations,
  getConversation,
  listMessages,
  listNetworks,
  markConversationSeen,
  purgeConversation,
  setConversationArchived,
  setConversationLowPriority,
} from '../services/beeperConversations.js';
import {
  backfillAttachments,
  ensureAttachmentBytes,
  getAttachment,
  getAttachmentSummary,
  setAttachmentKeep,
} from '../services/beeperAttachments.js';
import { serveLocalFile } from '../lib/fileUtils.js';
import { ServerError, errorEvents } from '../lib/errorHandler.js';
import { BeeperApiError } from '../services/beeperClient.js';

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/beeper', beeperRoutes);
  // The OAuth callback answers a BROWSER with a redirect to the Beeper tab, and
  // the test harness follows redirects, so stand in for the SPA route and
  // report where the browser actually landed — the user-visible outcome.
  app.get('/messages/beeper', (req, res) => res.json({ landedOn: req.originalUrl }));
  return app;
};

describe('GET /api/beeper/status', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the status payload as-is', async () => {
    vi.mocked(getBeeperStatus).mockResolvedValue({ tokenConfigured: false, reachable: null, accounts: [] });
    const res = await request(buildApp()).get('/api/beeper/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tokenConfigured: false, reachable: null, accounts: [] });
  });
});

// The wave-one reviewer contract this route exists to prove: every recognized
// BeeperApiError code maps to its own explicit HTTP status, and the mapper
// never lets a status:0 network-failure error reach res.status() raw (which
// would crash Express).
describe('POST /api/beeper/status/check — createServiceErrorMapper contract', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps NETWORK_ERROR (status:0 on the source error) to 503, not a raw 0', async () => {
    vi.mocked(checkBeeperConnection).mockRejectedValue(
      new BeeperApiError('Beeper request failed: connection refused', { status: 0, code: 'NETWORK_ERROR', retryable: false }),
    );
    const res = await request(buildApp()).post('/api/beeper/status/check');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('NETWORK_ERROR');
  });

  it('maps NOT_CONFIGURED to 412', async () => {
    vi.mocked(checkBeeperConnection).mockRejectedValue(
      new BeeperApiError('Beeper access token is not configured', { status: 401, code: 'NOT_CONFIGURED', retryable: false }),
    );
    const res = await request(buildApp()).post('/api/beeper/status/check');
    expect(res.status).toBe(412);
    expect(res.body.code).toBe('NOT_CONFIGURED');
  });

  it('maps MALFORMED_RESPONSE to 502', async () => {
    vi.mocked(checkBeeperConnection).mockRejectedValue(
      new BeeperApiError('Beeper API returned an unexpected /v1/info response shape', { status: 502, code: 'MALFORMED_RESPONSE', retryable: false }),
    );
    const res = await request(buildApp()).post('/api/beeper/status/check');
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('MALFORMED_RESPONSE');
  });

  it('maps ASSET_UNAVAILABLE to 404', async () => {
    vi.mocked(checkBeeperConnection).mockRejectedValue(
      new BeeperApiError('Asset no longer available', { status: 502, code: 'ASSET_UNAVAILABLE', retryable: false }),
    );
    const res = await request(buildApp()).post('/api/beeper/status/check');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ASSET_UNAVAILABLE');
  });

  it('resolves 200 with the connection result on success', async () => {
    vi.mocked(checkBeeperConnection).mockResolvedValue({ reachable: true, info: { app: { name: 'Beeper' } } });
    const res = await request(buildApp()).post('/api/beeper/status/check');
    expect(res.status).toBe(200);
    expect(res.body.reachable).toBe(true);
  });
});

// The manual run-now sweep (#32). The scheduled sweep is the normal path; this
// is the same work on demand, and it inherits the coded-error contract above
// rather than leaking a status:0 through to res.status().
describe('POST /api/beeper/sync', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs one sweep and returns its summary', async () => {
    vi.mocked(runBeeperSweep).mockResolvedValue({ skipped: false, accounts: 2, chats: 3, messages: 7, failedAccounts: 0, durationMs: 42 });
    const res = await request(buildApp()).post('/api/beeper/sync');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ skipped: false, chats: 3, messages: 7 });
    expect(vi.mocked(runBeeperSweep)).toHaveBeenCalledWith({ reason: 'manual' });
  });

  it('reports an already-running sweep as skipped rather than starting a second one', async () => {
    vi.mocked(runBeeperSweep).mockResolvedValue({ skipped: true, reason: 'manual', accounts: 0, chats: 0, messages: 0 });
    const res = await request(buildApp()).post('/api/beeper/sync');
    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe(true);
  });

  it('maps a missing token to 412 through the same mapper, never a raw status', async () => {
    vi.mocked(runBeeperSweep).mockRejectedValue(
      new BeeperApiError('Beeper access token is not configured', { status: 401, code: 'NOT_CONFIGURED', retryable: false }),
    );
    const res = await request(buildApp()).post('/api/beeper/sync');
    expect(res.status).toBe(412);
    expect(res.body.code).toBe('NOT_CONFIGURED');
  });

  it('maps an unreachable Beeper Desktop (status:0) to 503', async () => {
    vi.mocked(runBeeperSweep).mockRejectedValue(
      new BeeperApiError('Beeper request failed: connection refused', { status: 0, code: 'NETWORK_ERROR', retryable: false }),
    );
    const res = await request(buildApp()).post('/api/beeper/sync');
    expect(res.status).toBe(503);
  });

  // A sweep in which every account failed throws SWEEP_FAILED rather than
  // resolving with a quietly non-zero `failedAccounts`, so this route reports
  // the failure instead of answering 200.
  it('maps an all-accounts-failed sweep to 502 rather than a 200 with a non-zero failedAccounts', async () => {
    vi.mocked(runBeeperSweep).mockRejectedValue(
      new BeeperApiError('Beeper sweep failed for all 3 accounts', { status: 502, code: 'SWEEP_FAILED', retryable: true }),
    );
    const res = await request(buildApp()).post('/api/beeper/sync');
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('SWEEP_FAILED');
  });
});

// The connect flow (#31): OAuth start → browser callback → paste alternative →
// disconnect, each asserted at the route boundary with the services mocked.
describe('POST /api/beeper/oauth/start', () => {
  beforeEach(() => vi.clearAllMocks());

  it('builds the redirect URI from the request origin, not a hardcoded localhost', async () => {
    vi.mocked(startBeeperOAuth).mockResolvedValue({ authorizationUrl: 'http://127.0.0.1:23373/oauth/authorize?x=1', redirectUri: 'x', state: 's' });
    const res = await request(buildApp())
      .post('/api/beeper/oauth/start')
      .set('X-Forwarded-Proto', 'https')
      .set('X-Forwarded-Host', 'example.ts.net:5555');

    expect(res.status).toBe(200);
    expect(startBeeperOAuth).toHaveBeenCalledWith({
      redirectUri: 'https://example.ts.net:5555/api/beeper/oauth/callback',
      clientUri: 'https://example.ts.net:5555',
    });
  });

  // Under the Vite dev proxy (`changeOrigin: true`, no `x-forwarded-*`) the
  // request carries the API's own origin on the API port, so the derivation
  // above sent the browser to a host the TLS certificate does not cover. The
  // browser sends its own origin, and a recognized one wins.
  it('uses the browser origin the client sent when the request origin is the proxy target', async () => {
    vi.mocked(startBeeperOAuth).mockResolvedValue({ authorizationUrl: 'http://127.0.0.1:23373/oauth/authorize?x=1', redirectUri: 'x', state: 's' });
    const res = await request(buildApp())
      .post('/api/beeper/oauth/start')
      .set('X-Forwarded-Proto', 'https')
      .set('X-Forwarded-Host', 'localhost:5555')
      .send({ origin: 'http://localhost:5554' });

    expect(res.status).toBe(200);
    expect(startBeeperOAuth).toHaveBeenCalledWith({
      redirectUri: 'http://localhost:5554/api/beeper/oauth/callback',
      clientUri: 'http://localhost:5554',
    });
  });

  it('ignores a browser origin this install does not serve and falls back to the request origin', async () => {
    vi.mocked(startBeeperOAuth).mockResolvedValue({ authorizationUrl: 'http://127.0.0.1:23373/oauth/authorize?x=1', redirectUri: 'x', state: 's' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await request(buildApp())
      .post('/api/beeper/oauth/start')
      .set('X-Forwarded-Proto', 'https')
      .set('X-Forwarded-Host', 'example.ts.net:5555')
      .send({ origin: 'https://example.com' });

    expect(res.status).toBe(200);
    expect(startBeeperOAuth).toHaveBeenCalledWith({
      redirectUri: 'https://example.ts.net:5555/api/beeper/oauth/callback',
      clientUri: 'https://example.ts.net:5555',
    });
    // The warning never carries the value: it is a host off the user's own
    // machine or tailnet, and this line can end up in a shared log.
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('example.com');
    warn.mockRestore();
  });

  it('rejects an unexpected body field rather than letting it through unvalidated', async () => {
    const res = await request(buildApp())
      .post('/api/beeper/oauth/start')
      .send({ origin: 'http://localhost:5554', unexpected: true });

    expect(res.status).toBe(400);
    expect(startBeeperOAuth).not.toHaveBeenCalled();
  });

  it('maps a discovery failure to 502 and marks it non-retryable', async () => {
    vi.mocked(startBeeperOAuth).mockRejectedValue(
      new BeeperApiError('Beeper authorization-server metadata unavailable (404)', { status: 502, code: 'OAUTH_DISCOVERY_FAILED', retryable: false }),
    );
    const res = await request(buildApp()).post('/api/beeper/oauth/start');
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('OAUTH_DISCOVERY_FAILED');
    expect(res.body.context.retryable).toBe(false);
  });
});

describe('GET /api/beeper/oauth/callback', () => {
  beforeEach(() => vi.clearAllMocks());

  it('exchanges the code and redirects back to the Beeper tab', async () => {
    vi.mocked(completeBeeperOAuth).mockResolvedValue({ tokenConfigured: true, tokenSource: 'oauth', reachable: true });
    const res = await request(buildApp()).get('/api/beeper/oauth/callback?code=abc&state=xyz');
    expect(completeBeeperOAuth).toHaveBeenCalledWith({ code: 'abc', state: 'xyz' });
    expect(res.body.landedOn).toBe('/messages/beeper?beeperConnected=1');
  });

  // A browser lands here, so every outcome has to be a redirect the user can
  // read — never the JSON error envelope in the address bar.
  it('redirects with the reason when the exchange fails', async () => {
    vi.mocked(completeBeeperOAuth).mockRejectedValue(
      new BeeperApiError('Beeper token exchange failed (invalid_grant)', { status: 502, code: 'OAUTH_EXCHANGE_FAILED', retryable: false }),
    );
    const res = await request(buildApp()).get('/api/beeper/oauth/callback?code=abc&state=xyz');
    expect(res.body.landedOn).toContain('beeperOauthError=');
    expect(decodeURIComponent(res.body.landedOn)).toContain('invalid_grant');
  });

  it('redirects with the authorization server error when the user declines', async () => {
    const res = await request(buildApp()).get('/api/beeper/oauth/callback?error=access_denied');
    expect(decodeURIComponent(res.body.landedOn)).toContain('access_denied');
    expect(completeBeeperOAuth).not.toHaveBeenCalled();
  });

  it('redirects rather than 400s when code or state is missing', async () => {
    const res = await request(buildApp()).get('/api/beeper/oauth/callback?code=abc');
    expect(decodeURIComponent(res.body.landedOn)).toContain('Missing authorization code or state');
  });
});

describe('POST /api/beeper/token — the paste path', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stores a pasted token and answers with presence, expiry and provenance only', async () => {
    vi.mocked(connectWithPastedToken).mockResolvedValue({
      tokenConfigured: true, tokenExpiresAt: null, tokenSource: 'pasted', reachable: true, lastProbeError: null,
    });
    const res = await request(buildApp()).post('/api/beeper/token').send({ token: 'example-beeper-token' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      tokenConfigured: true, tokenExpiresAt: null, tokenSource: 'pasted', reachable: true, lastProbeError: null,
    });
  });

  // Introspection says the token is not active: a 401 the client can act on,
  // marked non-retryable so nothing re-posts the same dead credential.
  it('maps a rejected token to 401 with retryable:false', async () => {
    vi.mocked(connectWithPastedToken).mockRejectedValue(
      new BeeperApiError('Beeper rejected that access token (introspection reports it is not active)', { status: 401, code: 'TOKEN_REJECTED', retryable: false }),
    );
    const res = await request(buildApp()).post('/api/beeper/token').send({ token: 'example-beeper-token' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TOKEN_REJECTED');
    expect(res.body.context.retryable).toBe(false);
  });

  it('400s on an empty token instead of reaching the service', async () => {
    const res = await request(buildApp()).post('/api/beeper/token').send({ token: '   ' });
    expect(res.status).toBe(400);
    expect(connectWithPastedToken).not.toHaveBeenCalled();
  });

  it('rejects unknown fields, so nothing else can ride this write path', async () => {
    const res = await request(buildApp()).post('/api/beeper/token').send({ token: 'example-beeper-token', expiresAt: '2099-01-01' });
    expect(res.status).toBe(400);
    expect(connectWithPastedToken).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/beeper/token — disconnect', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports the disconnected state', async () => {
    vi.mocked(disconnectBeeper).mockResolvedValue({ deleted: true, tokenConfigured: false, tokenExpiresAt: null, tokenSource: null });
    const res = await request(buildApp()).delete('/api/beeper/token');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deleted: true, tokenConfigured: false });
  });

  it('is idempotent when nothing was stored', async () => {
    vi.mocked(disconnectBeeper).mockResolvedValue({ deleted: false, tokenConfigured: false, tokenExpiresAt: null, tokenSource: null });
    const res = await request(buildApp()).delete('/api/beeper/token');
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(false);
  });
});

// The #31 acceptance criterion, asserted rather than argued: "a grep of logs and
// of any client response for the token value returns nothing". This drives the
// whole connect → paste → status → disconnect surface with a known token value
// and greps every response body, every redirect Location, and everything the
// routes wrote to console.
describe('the token value never reaches a response or a log line', () => {
  const TOKEN = 'example-beeper-token-value-31';

  it('leaks nothing across connect, paste, status, check and disconnect', async () => {
    vi.clearAllMocks();
    const written = [];
    const capture = (...args) => written.push(args.map(String).join(' '));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(capture);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(capture);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(capture);

    // Every mocked service behaves like the real one: it takes the token in and
    // hands back presence/expiry/provenance, never the value.
    vi.mocked(startBeeperOAuth).mockResolvedValue({ authorizationUrl: 'http://127.0.0.1:23373/oauth/authorize?state=s', redirectUri: 'r', state: 's' });
    vi.mocked(completeBeeperOAuth).mockResolvedValue({ tokenConfigured: true, tokenExpiresAt: null, tokenSource: 'oauth', reachable: true });
    vi.mocked(connectWithPastedToken).mockResolvedValue({ tokenConfigured: true, tokenExpiresAt: null, tokenSource: 'pasted', reachable: true });
    vi.mocked(getBeeperStatus).mockResolvedValue({ tokenConfigured: true, tokenExpiresAt: null, tokenSource: 'pasted', reachable: true, accounts: [] });
    vi.mocked(checkBeeperConnection).mockResolvedValue({ reachable: true, info: { app: { name: 'Beeper' } } });
    vi.mocked(disconnectBeeper).mockResolvedValue({ deleted: true, tokenConfigured: false });

    const app = buildApp();
    const responses = [
      await request(app).post('/api/beeper/oauth/start'),
      await request(app).get('/api/beeper/oauth/callback?code=abc&state=s'),
      await request(app).post('/api/beeper/token').send({ token: TOKEN }),
      await request(app).get('/api/beeper/status'),
      await request(app).post('/api/beeper/status/check'),
      await request(app).delete('/api/beeper/token'),
    ];

    logSpy.mockRestore();
    errSpy.mockRestore();
    warnSpy.mockRestore();

    for (const res of responses) {
      // Covers the redirect's landing URL too — the callback app above reports
      // it as `landedOn`, so a token smuggled into a query param would show up.
      expect(JSON.stringify(res.body ?? null)).not.toContain(TOKEN);
      expect(res.text || '').not.toContain(TOKEN);
    }
    expect(written.join('\n')).not.toContain(TOKEN);
    // The service DID receive it — this is a leak test, not a plumbing bug.
    expect(connectWithPastedToken).toHaveBeenCalledWith(TOKEN);
  });
});

// The outbox routes (#36). The service's own gates are covered in
// `services/beeperOutbox.test.js`; this pins the HTTP contract the composer
// codes against — validation, the coded 4xx map, and `retryable: false` on
// every write path so a client can never turn one refusal into two messages.
describe('POST /api/beeper/outbox — step one, create the entry', () => {
  beforeEach(() => vi.clearAllMocks());
  const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';

  it('creates an approved entry and answers 201', async () => {
    vi.mocked(createOutboxEntry).mockResolvedValue({ id: 'outbox-1', state: 'approved' });
    const res = await request(buildApp())
      .post('/api/beeper/outbox')
      .send({ conversationId: CONVERSATION_ID, body: 'hello there' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 'outbox-1', state: 'approved' });
    expect(createOutboxEntry).toHaveBeenCalledWith({ conversationId: CONVERSATION_ID, body: 'hello there' });
  });

  it('400s a malformed body without touching the service', async () => {
    const res = await request(buildApp()).post('/api/beeper/outbox').send({ body: 'no conversation' });
    expect(res.status).toBe(400);
    expect(createOutboxEntry).not.toHaveBeenCalled();
  });
});

describe('POST /api/beeper/outbox/:id/send — step two, the send', () => {
  beforeEach(() => vi.clearAllMocks());
  const ENTRY_ID = '44444444-4444-4444-8444-444444444444';

  it('400s a malformed entry id before it reaches a query', async () => {
    const res = await request(buildApp()).post('/api/beeper/outbox/not-a-uuid/send').send({});
    expect(res.status).toBe(400);
    expect(sendOutboxEntry).not.toHaveBeenCalled();
  });

  it('passes the first-contact confirmation through explicitly', async () => {
    vi.mocked(sendOutboxEntry).mockResolvedValue({ id: 'outbox-1', state: 'awaiting-confirmation' });
    const res = await request(buildApp())
      .post(`/api/beeper/outbox/${ENTRY_ID}/send`)
      .send({ confirmFirstContact: true });
    expect(res.status).toBe(200);
    expect(sendOutboxEntry).toHaveBeenCalledWith(ENTRY_ID, { confirmFirstContact: true });
  });

  it('defaults the confirmation to false when the field is absent', async () => {
    vi.mocked(sendOutboxEntry).mockResolvedValue({ id: 'outbox-1', state: 'awaiting-confirmation' });
    await request(buildApp()).post(`/api/beeper/outbox/${ENTRY_ID}/send`).send({});
    expect(sendOutboxEntry).toHaveBeenCalledWith(ENTRY_ID, { confirmFirstContact: false });
  });

  it('maps FIRST_CONTACT_CONFIRMATION_REQUIRED to a non-retryable 409', async () => {
    vi.mocked(sendOutboxEntry).mockRejectedValue(new BeeperApiError('confirm first contact', {
      status: 409, code: 'FIRST_CONTACT_CONFIRMATION_REQUIRED', retryable: false,
    }));
    const res = await request(buildApp()).post(`/api/beeper/outbox/${ENTRY_ID}/send`).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('FIRST_CONTACT_CONFIRMATION_REQUIRED');
    expect(res.body.context.retryable).toBe(false);
  });

  it('maps the open breaker to 429 and a transport failure to a non-retryable 503', async () => {
    vi.mocked(sendOutboxEntry).mockRejectedValue(new BeeperApiError('breaker open', {
      status: 429, code: 'OUTBOX_BREAKER_OPEN', retryable: false,
    }));
    const blocked = await request(buildApp()).post(`/api/beeper/outbox/${ENTRY_ID}/send`).send({});
    expect(blocked.status).toBe(429);

    // status:0 on the source error — the mapper must never pass it through.
    vi.mocked(sendOutboxEntry).mockRejectedValue(new BeeperApiError('Beeper request failed', {
      status: 0, code: 'NETWORK_ERROR', retryable: false,
    }));
    const failed = await request(buildApp()).post(`/api/beeper/outbox/${ENTRY_ID}/send`).send({});
    expect(failed.status).toBe(503);
    expect(failed.body.context.retryable).toBe(false);
  });
});

// The reviewer's blocker on #53: cancelling the first-contact confirmation
// left the row `approved` and rendered forever — a phantom pending-send
// bubble with no route to remove it. This is the discard "Cancel" now calls.
describe('DELETE /api/beeper/outbox/:id — discard the "Cancel" path', () => {
  beforeEach(() => vi.clearAllMocks());
  const ENTRY_ID = '44444444-4444-4444-8444-444444444444';

  it('400s a malformed entry id before it reaches the service', async () => {
    const res = await request(buildApp()).delete('/api/beeper/outbox/not-a-uuid');
    expect(res.status).toBe(400);
    expect(discardOutboxEntry).not.toHaveBeenCalled();
  });

  it('discards and answers 204 with no content', async () => {
    vi.mocked(discardOutboxEntry).mockResolvedValue(undefined);
    const res = await request(buildApp()).delete(`/api/beeper/outbox/${ENTRY_ID}`);
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(discardOutboxEntry).toHaveBeenCalledWith(ENTRY_ID);
  });

  it('maps an unknown entry to a non-retryable 404', async () => {
    vi.mocked(discardOutboxEntry).mockRejectedValue(new BeeperApiError('Outbox entry not found', {
      status: 404, code: 'OUTBOX_ENTRY_NOT_FOUND', retryable: false,
    }));
    const res = await request(buildApp()).delete(`/api/beeper/outbox/${ENTRY_ID}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('OUTBOX_ENTRY_NOT_FOUND');
    expect(res.body.context.retryable).toBe(false);
  });

  it('maps a row that has already left "approved" to a non-retryable 409', async () => {
    vi.mocked(discardOutboxEntry).mockRejectedValue(new BeeperApiError('already sent', {
      status: 409, code: 'OUTBOX_INVALID_STATE', retryable: false,
    }));
    const res = await request(buildApp()).delete(`/api/beeper/outbox/${ENTRY_ID}`);
    expect(res.status).toBe(409);
    expect(res.body.context.retryable).toBe(false);
  });
});

describe('GET /api/beeper/outbox and the breaker reset', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists one conversation\'s entries', async () => {
    vi.mocked(listOutboxEntries).mockResolvedValue([{ id: 'outbox-1', state: 'failed' }]);
    const res = await request(buildApp())
      .get('/api/beeper/outbox?conversationId=11111111-1111-4111-8111-111111111111');
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
  });

  it('clears the breaker on an explicit human POST', async () => {
    vi.mocked(clearOutboxBreaker).mockReturnValue({ tripped: false, reason: null });
    const res = await request(buildApp()).post('/api/beeper/outbox/breaker/clear');
    expect(res.status).toBe(200);
    expect(res.body.tripped).toBe(false);
    expect(clearOutboxBreaker).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Chat surface (#35)
// ---------------------------------------------------------------------------

const CONV_ID = '11111111-1111-4111-8111-111111111111';

describe('GET /api/beeper/conversations — filters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listConversations).mockResolvedValue({ conversations: [], nextCursor: null });
  });

  it('passes every supported filter through, with query-string booleans parsed as booleans', async () => {
    const res = await request(buildApp())
      .get('/api/beeper/conversations?network=examplenet&unreadOnly=true&archived=false&lowPriority=false&limit=25');
    expect(res.status).toBe(200);
    expect(listConversations).toHaveBeenCalledWith({
      network: 'examplenet', unreadOnly: true, archived: false, lowPriority: false, limit: 25,
    });
  });

  it('omits an absent filter entirely rather than defaulting it to false', async () => {
    await request(buildApp()).get('/api/beeper/conversations');
    expect(listConversations).toHaveBeenCalledWith({});
  });

  it('rejects a non-boolean filter value instead of coercing it', async () => {
    const res = await request(buildApp()).get('/api/beeper/conversations?archived=yes');
    expect(res.status).toBe(400);
    expect(listConversations).not.toHaveBeenCalled();
  });

  it('forwards the pagination cursor untouched', async () => {
    vi.mocked(listConversations).mockResolvedValue({ conversations: [], nextCursor: 'next-page-token' });
    const res = await request(buildApp()).get('/api/beeper/conversations?cursor=abc123');
    expect(listConversations).toHaveBeenCalledWith({ cursor: 'abc123' });
    expect(res.body.nextCursor).toBe('next-page-token');
  });
});

describe('GET /api/beeper/conversations/:id and its messages', () => {
  beforeEach(() => vi.clearAllMocks());

  it('404s an unknown conversation so a stale deep link degrades to not-found', async () => {
    vi.mocked(getConversation).mockResolvedValue(null);
    const res = await request(buildApp()).get(`/api/beeper/conversations/${CONV_ID}`);
    expect(res.status).toBe(404);
    // Standard error envelope: { error, code, timestamp } — same shape
    // errorMiddleware stamps everywhere else (regression for the hand-rolled
    // res.status(404).json(...) this route used to write itself).
    expect(res.body.code).toBe('NOT_FOUND');
    expect(typeof res.body.timestamp).toBe('number');
  });

  it('marks the 404 severity: warning (mediaJobs.js GET /:id pattern) so it still reaches errorEvents but skips the global toast and the server console.error', async () => {
    vi.mocked(getConversation).mockResolvedValue(null);
    const emit = vi.fn();
    const capturedErrors = [];
    const onError = (error) => capturedErrors.push(error);
    errorEvents.on('error', onError);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const app = buildApp();
      app.set('io', { emit });
      const res = await request(app).get(`/api/beeper/conversations/${CONV_ID}`);
      expect(res.status).toBe(404);
      // Still reaches the error broadcast — item 1's envelope/broadcast
      // contract is unchanged, only the presentation drops.
      expect(capturedErrors).toHaveLength(1);
      expect(capturedErrors[0].severity).toBe('warning');
      expect(emit).toHaveBeenCalledWith('error:occurred', expect.objectContaining({
        code: 'NOT_FOUND',
        severity: 'warning',
      }));
      // ...but does not write the server console.error a plain (non-warning)
      // error would — that log line, repeated on every ~350ms refetch of a
      // stale deep link, is exactly what this severity opts out of.
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    } finally {
      errorEvents.off('error', onError);
      consoleErrorSpy.mockRestore();
    }
  });

  it('rejects a non-uuid conversation id before it reaches the store', async () => {
    const res = await request(buildApp()).get('/api/beeper/conversations/not-a-uuid');
    expect(res.status).toBe(400);
    expect(getConversation).not.toHaveBeenCalled();
  });

  it('paginates the thread and answers an empty page with 200, not an error', async () => {
    vi.mocked(listMessages).mockResolvedValue({ messages: [], nextCursor: null });
    const res = await request(buildApp()).get(`/api/beeper/conversations/${CONV_ID}/messages?limit=20&cursor=abc`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ messages: [], nextCursor: null });
    expect(listMessages).toHaveBeenCalledWith(CONV_ID, { limit: 20, cursor: 'abc' });
  });
});

describe('GET /api/beeper/networks', () => {
  it('returns the rail scopes derived from the mirror', async () => {
    vi.mocked(listNetworks).mockResolvedValue([{ network: 'examplenet', unreadCount: 2 }]);
    const res = await request(buildApp()).get('/api/beeper/networks');
    expect(res.status).toBe(200);
    expect(res.body.networks).toEqual([{ network: 'examplenet', unreadCount: 2 }]);
  });
});

// The two rail controls #9 wired. The contract worth pinning is not that they
// succeed but how they FAIL: a Beeper write has no idempotency key, so the
// error a client sees must never advertise retry-safety.
describe('archive / low-priority write paths', () => {
  beforeEach(() => vi.clearAllMocks());

  it('archives through the service and returns the updated conversation', async () => {
    vi.mocked(setConversationArchived).mockResolvedValue({ id: CONV_ID, isArchived: true });
    const res = await request(buildApp())
      .post(`/api/beeper/conversations/${CONV_ID}/archive`)
      .send({ archived: true });
    expect(res.status).toBe(200);
    expect(setConversationArchived).toHaveBeenCalledWith(CONV_ID, true);
    expect(res.body.isArchived).toBe(true);
  });

  it('sets low priority through the service', async () => {
    vi.mocked(setConversationLowPriority).mockResolvedValue({ id: CONV_ID, isLowPriority: true });
    const res = await request(buildApp())
      .post(`/api/beeper/conversations/${CONV_ID}/low-priority`)
      .send({ lowPriority: true });
    expect(res.status).toBe(200);
    expect(setConversationLowPriority).toHaveBeenCalledWith(CONV_ID, true);
  });

  it('rejects a missing/again non-boolean flag before any upstream write', async () => {
    const res = await request(buildApp())
      .post(`/api/beeper/conversations/${CONV_ID}/archive`)
      .send({ archived: 'yes' });
    expect(res.status).toBe(400);
    expect(setConversationArchived).not.toHaveBeenCalled();
  });

  it('maps a NETWORK_ERROR to 503 and reports retryable: false — never a raw status 0, never a retry hint', async () => {
    vi.mocked(setConversationArchived).mockRejectedValue(
      new BeeperApiError('Beeper request failed: connection refused', { status: 0, code: 'NETWORK_ERROR', retryable: false }),
    );
    const res = await request(buildApp())
      .post(`/api/beeper/conversations/${CONV_ID}/archive`)
      .send({ archived: true });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('NETWORK_ERROR');
    expect(res.body.context).toMatchObject({ retryable: false });
  });

  it('clamps an ordinarily-retryable upstream failure to retryable: false on a write path', async () => {
    vi.mocked(setConversationLowPriority).mockRejectedValue(
      new BeeperApiError('Too Many Requests', { status: 429, code: 'RATE_LIMITED', retryable: false }),
    );
    const res = await request(buildApp())
      .post(`/api/beeper/conversations/${CONV_ID}/low-priority`)
      .send({ lowPriority: true });
    expect(res.status).toBe(429);
    expect(res.body.context).toMatchObject({ retryable: false });
  });

  it('calls the upstream write exactly once — the route never retries', async () => {
    vi.mocked(setConversationArchived).mockRejectedValue(
      new BeeperApiError('Bad Gateway', { status: 502, code: 'UPSTREAM_ERROR', retryable: true }),
    );
    await request(buildApp())
      .post(`/api/beeper/conversations/${CONV_ID}/archive`)
      .send({ archived: false });
    expect(setConversationArchived).toHaveBeenCalledTimes(1);
  });
});

// The LOCAL "seen in PortOS" watermark (#83) — the opposite risk profile from
// the archive/low-priority block above: this route never reaches Beeper, so
// what's worth pinning is the id validation and that the service, not the
// route, decides the response shape.
describe('POST /api/beeper/conversations/:id/seen', () => {
  beforeEach(() => vi.clearAllMocks());

  it('marks the conversation seen through the service and returns the updated conversation', async () => {
    vi.mocked(markConversationSeen).mockResolvedValue({ id: CONV_ID, unreadCount: 0 });
    const res = await request(buildApp()).post(`/api/beeper/conversations/${CONV_ID}/seen`);
    expect(res.status).toBe(200);
    expect(markConversationSeen).toHaveBeenCalledWith(CONV_ID);
    expect(res.body).toEqual({ id: CONV_ID, unreadCount: 0 });
  });

  it('rejects a non-uuid conversation id before it reaches the service', async () => {
    const res = await request(buildApp()).post('/api/beeper/conversations/not-a-uuid/seen');
    expect(res.status).toBe(400);
    expect(markConversationSeen).not.toHaveBeenCalled();
  });

  it('404s an unknown conversation', async () => {
    vi.mocked(markConversationSeen).mockRejectedValue(
      new ServerError('Conversation not found', { status: 404, code: 'NOT_FOUND' }),
    );
    const res = await request(buildApp()).post(`/api/beeper/conversations/${CONV_ID}/seen`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});

describe('attachment mirror routes (#37)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('serves the bytes from disk with the STORED mime type, not the file extension', async () => {
    vi.mocked(ensureAttachmentBytes).mockResolvedValue({
      filePath: '/data/beeper/attachments/ab/abc.bin', mimeType: 'image/png', fileName: 'example.png', cached: true,
    });
    const res = await request(buildApp()).get('/api/beeper/attachments/msg-1/0');
    expect(res.status).toBe(200);
    expect(vi.mocked(ensureAttachmentBytes)).toHaveBeenCalledWith('msg-1', 0);
    const [, dir, filename, options] = vi.mocked(serveLocalFile).mock.calls[0];
    expect(dir).toBe('/data/beeper/attachments/ab');
    expect(filename).toBe('abc.bin');
    expect(options.contentType).toBe('image/png');
  });

  // SEC-4: GET is a safe method — no query param may raise the size ceiling or
  // clear a terminal refusal. `force=true` on the query string is simply
  // ignored (not rejected, since GET no longer parses `force` at all), and the
  // call into the service carries no `force` option regardless of what the
  // query string says.
  it('ignores a force=true query string — GET never asks the service to force a fetch', async () => {
    vi.mocked(ensureAttachmentBytes).mockResolvedValue({ filePath: '/x/y.bin', mimeType: '', fileName: '', cached: true });
    await request(buildApp()).get('/api/beeper/attachments/msg-1/0?force=true');
    expect(vi.mocked(ensureAttachmentBytes)).toHaveBeenCalledWith('msg-1', 0);
  });

  it('still answers 413 over-cap even with force=true on the query string — the ceiling is not bypassable from GET', async () => {
    vi.mocked(ensureAttachmentBytes).mockRejectedValue(new ServerError('Attachment is 40000000 bytes, over the 33554432-byte mirror ceiling', {
      status: 413, code: 'ATTACHMENT_TOO_LARGE', context: { bytes: 40000000, maxBytes: 33554432 },
    }));
    const res = await request(buildApp()).get('/api/beeper/attachments/msg-1/0?force=true');
    expect(res.status).toBe(413);
    expect(vi.mocked(ensureAttachmentBytes)).toHaveBeenCalledWith('msg-1', 0);
  });

  it('still answers 404 ASSET_UNAVAILABLE even with force=true on the query string — a safe method cannot clear the terminal refusal', async () => {
    vi.mocked(ensureAttachmentBytes).mockRejectedValue(new ServerError('Beeper can no longer supply this attachment', {
      status: 404, code: 'ASSET_UNAVAILABLE',
    }));
    const res = await request(buildApp()).get('/api/beeper/attachments/msg-1/0?force=true');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ASSET_UNAVAILABLE');
    expect(vi.mocked(ensureAttachmentBytes)).toHaveBeenCalledWith('msg-1', 0);
  });

  it('answers an over-cap attachment with 413 and carries the measured size into the envelope', async () => {
    vi.mocked(ensureAttachmentBytes).mockRejectedValue(new ServerError('Attachment is 40000000 bytes, over the 33554432-byte mirror ceiling', {
      status: 413, code: 'ATTACHMENT_TOO_LARGE', context: { bytes: 40000000, maxBytes: 33554432 },
    }));
    const res = await request(buildApp()).get('/api/beeper/attachments/msg-1/0');
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('ATTACHMENT_TOO_LARGE');
    // The mapper builds a fresh ServerError, so the size the service measured
    // reaches the client only because the mapper rebuilds the context.
    expect(res.body.context).toMatchObject({ bytes: 40000000, maxBytes: 33554432 });
  });

  it('maps a source that can no longer supply the asset to 404 ASSET_UNAVAILABLE, never a 502 retry', async () => {
    vi.mocked(ensureAttachmentBytes).mockRejectedValue(
      new BeeperApiError('Failed to download asset', { status: 502, code: 'ASSET_UNAVAILABLE', retryable: false }),
    );
    const res = await request(buildApp()).get('/api/beeper/attachments/msg-1/0');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ASSET_UNAVAILABLE');
  });

  it('forces the fetch on "fetch anyway" and answers with the refreshed row', async () => {
    vi.mocked(ensureAttachmentBytes).mockResolvedValue({ filePath: '/x/y.png', mimeType: 'image/png', fileName: '', cached: false });
    vi.mocked(getAttachment).mockResolvedValue({ messageId: 'msg-1', idx: 0, stored: true, overCap: true });
    const res = await request(buildApp()).post('/api/beeper/attachments/msg-1/0/fetch');
    expect(res.status).toBe(200);
    expect(vi.mocked(ensureAttachmentBytes)).toHaveBeenCalledWith('msg-1', 0, { force: true });
    expect(res.body).toMatchObject({ stored: true, overCap: true });
  });

  it('toggles the keep lock', async () => {
    vi.mocked(setAttachmentKeep).mockResolvedValue({ messageId: 'msg-1', idx: 0, keep: true });
    const res = await request(buildApp())
      .patch('/api/beeper/attachments/msg-1/0')
      .send({ keep: true });
    expect(res.status).toBe(200);
    expect(vi.mocked(setAttachmentKeep)).toHaveBeenCalledWith('msg-1', 0, true);
  });

  it('rejects an unknown key on the keep body rather than ignoring it', async () => {
    const res = await request(buildApp())
      .patch('/api/beeper/attachments/msg-1/0')
      .send({ keep: true, evict: true });
    expect(res.status).toBe(400);
    expect(vi.mocked(setAttachmentKeep)).not.toHaveBeenCalled();
  });

  it('reports the backfill census without starting anything', async () => {
    vi.mocked(getAttachmentSummary).mockResolvedValue({
      budgetBytes: 5368709120, usedBytes: 1024, pendingCount: 12, pendingBytes: 4096, pendingUnknownCount: 1,
    });
    const res = await request(buildApp()).get('/api/beeper/attachments/summary');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ pendingCount: 12, pendingBytes: 4096, pendingUnknownCount: 1 });
    expect(vi.mocked(backfillAttachments)).not.toHaveBeenCalled();
  });

  it('runs the bulk backfill only on an explicit POST', async () => {
    vi.mocked(backfillAttachments).mockResolvedValue({ fetched: 3, failed: 1, bytes: 900, stoppedForBudget: false, requested: 4 });
    const res = await request(buildApp()).post('/api/beeper/attachments/backfill').send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ fetched: 3, failed: 1 });
  });

  it('purges one conversation mirror and reports the bytes it freed', async () => {
    vi.mocked(purgeConversation).mockResolvedValue({
      purged: true, conversationId: CONV_ID, messagesRemoved: 12, filesRemoved: 3, bytesFreed: 4096,
    });
    const res = await request(buildApp()).delete(`/api/beeper/conversations/${CONV_ID}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ purged: true, filesRemoved: 3, bytesFreed: 4096 });
  });
});


describe('POST /api/beeper/outbox/:id/reconcile', () => {
  beforeEach(() => vi.clearAllMocks());
  const ENTRY_ID = '44444444-4444-4444-8444-444444444444';
  it('validates the row and returns lookup recovery without invoking the send service', async () => {
    expect((await request(buildApp()).post('/api/beeper/outbox/not-a-uuid/reconcile').send({})).status).toBe(400);
    expect(reconcileOutboxEntry).not.toHaveBeenCalled();
    vi.mocked(reconcileOutboxEntry).mockResolvedValue({ id: ENTRY_ID, state: 'sent' });
    const res = await request(buildApp()).post(`/api/beeper/outbox/${ENTRY_ID}/reconcile`).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: ENTRY_ID, state: 'sent' });
    expect(sendOutboxEntry).not.toHaveBeenCalled();
  });
});
