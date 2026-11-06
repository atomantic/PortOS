import { createHash, createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { PassThrough, Readable } from 'node:stream';
import express from 'express';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { request } from '../lib/testHelper.js';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';
import { canonicalStringify } from '../lib/objects.js';
import { buildNativeUsageReport, nativeUsageParticipantKey } from '../lib/nativeUsageContract.js';
import { resolveEffectiveCategories } from '../lib/instanceSyncCategories.js';

const fixture = vi.hoisted(() => ({ registry: null, enabled: false, capture: vi.fn(), streamRequest: vi.fn() }));
const { makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'native-usage-peer-' });
vi.mock('../lib/fileUtils.js', async original => makeProxy(await original()));
vi.mock('../lib/peerHttpClient.js', async original => ({ ...await original(), peerStreamRequest: fixture.streamRequest }));
vi.mock('./instanceIdentity.js', () => ({
  loadData: async () => structuredClone(fixture.registry), UNKNOWN_INSTANCE_ID: 'unknown',
  getInstanceId: async () => fixture.registry.self.instanceId,
}));
vi.mock('./instances.js', () => ({
  getPeers: async () => structuredClone(fixture.registry.peers), resolveEffectiveCategories, wakePeerProbe: vi.fn(),
}));
vi.mock('./nativeUsageReport.js', () => ({ captureDashboardNativeUsageReport: fixture.capture }));
vi.mock('./auth.js', () => ({
  isAuthEnabled: async () => fixture.enabled, verifyPassword: async () => true,
  verifyRequestSession: async req => req.headers.authorization === 'Bearer fixture-operator',
}));
vi.mock('./settings.js', () => ({ getSettings: async () => ({}), settingsEvents: new EventEmitter() }));
// The actual usage router is exercised, without loading unrelated accounting workflows.
vi.mock('./usage.js', () => ({}));
vi.mock('./claudeCodeUsage.js', () => ({ getClaudeCodeUsage: vi.fn() }));
vi.mock('./claudeCodeTranscriptUsage.js', () => ({ refreshLocalTranscriptUsage: vi.fn() }));
vi.mock('./providerUsage.js', () => ({ getProviderQuotas: vi.fn() }));
vi.mock('./providers.js', () => ({ getAllProviders: vi.fn() }));
vi.mock('./subscriptionCosts.js', () => ({ saveSubscriptionCosts: vi.fn(), getSubscriptionSavings: vi.fn() }));
vi.mock('./subscriptions.js', () => ({ getSubscriptionOverview: vi.fn(), savePlanTiers: vi.fn(), setSubscriptionEnabled: vi.fn() }));
vi.mock('./peerUsage.js', () => ({ getFleetUsage: vi.fn(), getFleetClaudeCodeModels: vi.fn(), getFleetRollingCost: vi.fn() }));
vi.mock('./usageFleetBilling.js', () => ({ getApiBilledInstanceIds: vi.fn(), setInstanceUsesSubscriptions: vi.fn() }));
vi.mock('./usageCutoverBarrier.js', () => ({ acquireUsageCutover: vi.fn(), activateUsageCutover: vi.fn(), getUsageCutoverStatus: vi.fn(),
  releaseUsageCutover: vi.fn(), rollbackUsageCutover: vi.fn(), verifyUsageCutover: vi.fn() }));
vi.mock('./usageBackfill.js', () => ({ getHistoricalUsageBackfillStatus: vi.fn(), startHistoricalUsageBackfill: vi.fn(),
  startCodexUsagePreview: vi.fn(), cancelCodexUsagePreview: vi.fn() }));

const { derivePeerAuthToken } = await import('../lib/peerHttpClient.js');
const { peerStreamRequest: actualPeerStreamRequest } = await vi.importActual('../lib/peerHttpClient.js');
const { authGate } = await import('./authGate.js');
const { errorMiddleware } = await import('../lib/errorHandler.js');
const { default: routes } = await import('../routes/usage.js');
const { readNativeUsagePeerReport, revalidateNativeUsagePeerReport, NATIVE_USAGE_PEER_MAX_BYTES } = await import('./nativeUsagePeer.js');
const LOCAL = 'fixture-local-instance';
const PEER = 'fixture-peer-instance';
const SECRET = 'fixture-pair-secret-not-a-real-credential';
const CHALLENGE = 'a'.repeat(64);
const NOW = Date.parse('2026-11-06T12:00:00.000Z');
const hash = value => createHash('sha256').update(canonicalStringify(value)).digest('hex');
const rehash = value => {
  value.evidenceHash = hash(value.providers);
  const { contentHash: _old, ...body } = value;
  value.contentHash = hash(body);
  return value;
};
const missingSource = { status: 'unavailable', summary: null, coverage: {
  files: 0, records: 0, measuredRecords: 0, missingUsageRecords: 0, missingIdentityRecords: 0, duplicateRecords: 0, conflictingRecords: 0,
  invalidLines: 0, undatedRecords: 0, unreadableFiles: 0, skippedLinks: 0, missingSource: true, capped: false, stoppedEarly: false,
  oversizedLines: 0, streamingSupersededRecords: 0, unfinalizedRecords: 0, fieldInconsistentRecords: 0, runtimeVersions: [], steps: null,
  cacheOverlap: null, costTickRecords: null, firstObservedAt: null, lastObservedAt: null,
} };
const report = (instanceId, capturedAt = new Date(NOW).toISOString()) => buildNativeUsageReport({
  instanceId, capturedAt, transcripts: { agy: missingSource, claude: missingSource, grok: missingSource },
  scanLimits: { bytes: 1, lineBytes: 1, entries: 1, records: 1, milliseconds: 1, depth: 1 },
  codexEvidence: { usage: { summary: { lifetimeTokens: 20 }, dailyUsageBuckets: [{ startDate: '2026-11-06', tokens: 20 }] },
    accountBefore: { status: 'read', account: { authMethod: 'chatgpt', planType: 'pro' } },
    accountAfter: { status: 'read', account: { authMethod: 'chatgpt', planType: 'pro' } } },
});
const sign = payload => ({ ...payload, signature: createHmac('sha256', SECRET)
  .update(`portos-native-usage-report:v1:${canonicalStringify(payload)}`).digest('hex') });
const payloadFor = url => ({ protocolVersion: 1, sourceParticipantKey: nativeUsageParticipantKey(PEER),
  audienceParticipantKey: nativeUsageParticipantKey(LOCAL), challenge: new URL(url).searchParams.get('challenge'), report: report(PEER) });
const streamed = (body, status = 200, headers = {}) => ({ status, headers, stream: Readable.from([Buffer.from(body)]) });
const json = body => streamed(JSON.stringify(body));
const headers = (instanceId = PEER, secret = SECRET) => ({ 'X-PortOS-Instance-Id': instanceId,
  'X-PortOS-Peer-Auth': derivePeerAuthToken(secret, instanceId) });
const callRoute = (extraHeaders = headers(), query = `challenge=${CHALLENGE}`) => {
  const app = express();
  app.use(authGate); app.use('/api/usage', routes); app.use(errorMiddleware);
  const call = request(app).get(`/api/usage/native-report/v1?${query}`);
  for (const [name, value] of Object.entries(extraHeaders)) call.set(name, value);
  return call;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
  fixture.enabled = false;
  fixture.registry = { self: { instanceId: LOCAL }, peers: [{ id: 'fixture-peer-record', instanceId: PEER,
    enabled: true, directions: ['outbound'], syncSecret: SECRET, syncEnabled: false,
    address: '192.0.2.5', port: 5555, auth: { password: 'fixture-broad-password' } }] };
  fixture.capture.mockImplementation(async () => report(LOCAL));
  fixture.streamRequest.mockImplementation(async url => json(sign(payloadFor(url))));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
afterAll(cleanup);

describe('native usage paired HTTP boundary', () => {
  it('serves only local, hashed evidence under the same usage policy with the password on or off', async () => {
    for (const enabled of [false, true]) {
      fixture.enabled = enabled;
      const result = await callRoute();
      expect(result.status).toBe(200);
      expect(result.headers['cache-control']).toBe('no-store');
      const { signature, ...payload } = result.body;
      expect(signature).toBe(sign(payload).signature);
      expect(payload).toMatchObject({ protocolVersion: 1, challenge: CHALLENGE,
        sourceParticipantKey: nativeUsageParticipantKey(LOCAL), audienceParticipantKey: nativeUsageParticipantKey(PEER),
        report: { participantKey: nativeUsageParticipantKey(LOCAL), contractVersion: 4 } });
      for (const privateValue of [LOCAL, PEER, SECRET, 'fixture-broad-password', '192.0.2.5']) {
        expect(JSON.stringify(result.body)).not.toContain(privateValue);
      }
    }
    expect(fixture.streamRequest).not.toHaveBeenCalled();
    expect(fixture.capture).toHaveBeenCalledTimes(2);
  });

  it('refuses anonymous, spoofed and password/session-only callers before capture on a password-free install', async () => {
    for (const supplied of [{}, { 'X-PortOS-Instance-Id': PEER }, headers('unknown-peer'), headers(PEER, 'different-secret'),
      { Authorization: `Basic ${Buffer.from(':fixture-password').toString('base64')}` }, { Authorization: 'Bearer fixture-operator' }]) {
      expect((await callRoute(supplied)).status).toBe(403);
    }
    expect(fixture.capture).not.toHaveBeenCalled();
  });

  it('refuses disabled, unpaired, inbound-only, unknown and category-disabled peers, including explicit inbound usage', async () => {
    const original = fixture.registry.peers[0];
    for (const change of [{ enabled: false }, { syncSecret: undefined }, { directions: ['inbound'], syncCategories: { usage: true } },
      { instanceId: 'another-peer' }, { syncCategories: { usage: false } }]) {
      fixture.registry.peers = [{ ...original, ...change }];
      expect((await callRoute()).status).toBe(403);
    }
    expect(fixture.capture).not.toHaveBeenCalled();
  });

  it('rejects caller-controlled source/scan options and malformed challenges without reading sources', async () => {
    for (const query of ['', 'challenge=short', `challenge=${CHALLENGE}&challenge=${CHALLENGE}`,
      `challenge=${CHALLENGE}&home=private`, `challenge=${CHALLENGE}&scope=fleet`]) {
      expect((await callRoute(headers(), query)).status).toBe(400);
    }
    expect(fixture.capture).not.toHaveBeenCalled();
  });

  it('refuses an ambiguous peer registry in either direction and fails closed on a malformed registry', async () => {
    fixture.registry.peers.push({ ...fixture.registry.peers[0], id: 'duplicate-peer-record' });
    expect((await callRoute()).status).toBe(403);
    await expect(readNativeUsagePeerReport(PEER)).rejects.toMatchObject({ code: 'NATIVE_USAGE_PEER_FORBIDDEN' });
    fixture.registry.peers = {};
    expect((await callRoute()).status).toBe(403);
    expect(fixture.capture).not.toHaveBeenCalled();
    expect(fixture.streamRequest).not.toHaveBeenCalled();
  });

  it('refuses an oversized local envelope rather than silently dropping evidence', async () => {
    const oversized = report(LOCAL);
    oversized.providers.find(provider => provider.family === 'codex').totals.dailyBuckets =
      Array.from({ length: 450000 }, () => ({ startDate: '2026-11-06', tokens: 20 }));
    fixture.capture.mockResolvedValueOnce(rehash(oversized));
    const result = await callRoute();
    expect(result.status).toBe(413);
    expect(result.body.code).toBe('NATIVE_USAGE_PEER_REPORT_TOO_LARGE');
    expect(JSON.stringify(result.body)).not.toContain('dailyBuckets');
  });

  it('rechecks sharing and the exact pair after capture and sanitizes capture errors', async () => {
    for (const change of [peer => { peer.enabled = false; }, peer => { peer.syncSecret = 'replacement-fixture-secret-1234567890'; },
      peer => { peer.syncCategories = { usage: false }; }, peer => { peer.address = '192.0.2.6'; }]) {
      const original = structuredClone(fixture.registry);
      fixture.capture.mockImplementationOnce(async () => { change(fixture.registry.peers[0]); return report(LOCAL); });
      expect((await callRoute()).status).toBeGreaterThanOrEqual(400);
      fixture.registry = original;
    }
    fixture.capture.mockRejectedValueOnce(new Error('private native path and credential'));
    const result = await callRoute();
    expect(result.status).toBe(503);
    expect(JSON.stringify(result.body)).not.toContain('private native');
  });
});

describe('native usage peer consumer', () => {
  it('accepts a fresh authenticated report without Basic or raw-secret fallback', async () => {
    expect(await readNativeUsagePeerReport(PEER)).toEqual(report(PEER));
    const [url, options, peer] = fixture.streamRequest.mock.calls[0];
    expect(new URL(url).pathname).toBe('/api/usage/native-report/v1');
    expect(options).toMatchObject({ headers: headers(LOCAL) });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(peer).toMatchObject({ auth: undefined, peerAuthAccepted: true });
    expect(options.headers).not.toHaveProperty('Authorization');
    expect(options.headers).not.toHaveProperty('X-PortOS-Peer-Sync-Token');
  });

  it('refuses forged/replayed/source-mismatched envelopes and invalid report hashes even with a valid MAC', async () => {
    const alterations = [
      value => { value.challenge = CHALLENGE; }, value => { value.sourceParticipantKey = 'b'.repeat(32); },
      value => { value.audienceParticipantKey = 'b'.repeat(32); }, value => { value.protocolVersion = 2; },
      value => { value.report.participantKey = 'b'.repeat(32); rehash(value.report); },
      value => { value.report.evidenceHash = 'b'.repeat(64); }, value => { value.report.contentHash = 'b'.repeat(64); },
      value => { value.report.contractVersion = 3; rehash(value.report); },
      value => { value.report.providers[0].prompt = 'private prompt'; rehash(value.report); },
    ];
    for (const alter of alterations) {
      fixture.streamRequest.mockImplementationOnce(async url => { const payload = payloadFor(url); alter(payload); return json(sign(payload)); });
      await expect(readNativeUsagePeerReport(PEER)).rejects.toMatchObject({ code: 'NATIVE_USAGE_PEER_UNVERIFIED' });
    }
    fixture.streamRequest.mockImplementationOnce(async url => json({ ...sign(payloadFor(url)), signature: '0'.repeat(64) }));
    await expect(readNativeUsagePeerReport(PEER)).rejects.toMatchObject({ code: 'NATIVE_USAGE_PEER_UNVERIFIED' });
  });

  it('enforces the capture-time bounds and rejects impossible dates', async () => {
    for (const capturedAt of [new Date(NOW - 300001).toISOString(), new Date(NOW + 30001).toISOString(), '2026-02-30T00:00:00.000Z']) {
      fixture.streamRequest.mockImplementationOnce(async url => { const payload = payloadFor(url); payload.report.capturedAt = capturedAt;
        rehash(payload.report); return json(sign(payload)); });
      await expect(readNativeUsagePeerReport(PEER)).rejects.toMatchObject({ code: 'NATIVE_USAGE_PEER_STALE' });
    }
    for (const offset of [-300000, 30000]) {
      fixture.streamRequest.mockImplementationOnce(async url => { const payload = payloadFor(url); payload.report = report(PEER, new Date(NOW + offset).toISOString()); return json(sign(payload)); });
      expect((await readNativeUsagePeerReport(PEER)).capturedAt).toBe(new Date(NOW + offset).toISOString());
    }
  });

  it('discards a valid result if the pair, local identity, destination or category changed during the request', async () => {
    const original = structuredClone(fixture.registry);
    for (const change of [value => { value.peers[0].syncSecret += '-rotated'; }, value => { value.peers[0].address = '192.0.2.6'; },
      value => { value.self.instanceId = 'replacement-local'; }, value => { value.peers[0].syncCategories = { usage: false }; },
      value => { value.peers = []; }]) {
      fixture.streamRequest.mockImplementationOnce(async url => { const result = json(sign(payloadFor(url))); change(fixture.registry); return result; });
      await expect(readNativeUsagePeerReport(PEER)).rejects.toMatchObject({ code: expect.stringMatching(/^NATIVE_USAGE_PEER_(UNVERIFIED|FORBIDDEN)$/) });
      fixture.registry = structuredClone(original);
    }
  });

  it('bounds chunked bodies and refuses errors/older peers without returning a cached success', async () => {
    await readNativeUsagePeerReport(PEER);
    const oversized = streamed(' '.repeat(NATIVE_USAGE_PEER_MAX_BYTES + 1));
    fixture.streamRequest.mockResolvedValueOnce(oversized);
    await expect(readNativeUsagePeerReport(PEER)).rejects.toMatchObject({ code: 'NATIVE_USAGE_PEER_REPORT_TOO_LARGE' });
    expect(oversized.stream.destroyed).toBe(true);
    for (const [status, code] of [[404, 'NATIVE_USAGE_PEER_UNAVAILABLE'], [413, 'NATIVE_USAGE_PEER_REPORT_TOO_LARGE'],
      [401, 'NATIVE_USAGE_PEER_FORBIDDEN'], [403, 'NATIVE_USAGE_PEER_FORBIDDEN'], [302, 'NATIVE_USAGE_PEER_UNAVAILABLE']]) {
      const response = streamed('private response body', status);
      fixture.streamRequest.mockResolvedValueOnce(response);
      await expect(readNativeUsagePeerReport(PEER)).rejects.toMatchObject({ code,
        message: 'Native usage peer report unavailable or unverified. Existing usage records are unchanged.' });
      expect(response.stream.destroyed).toBe(true);
    }
    fixture.streamRequest.mockRejectedValueOnce(new Error('private network error'));
    await expect(readNativeUsagePeerReport(PEER)).rejects.toMatchObject({ code: 'NATIVE_USAGE_PEER_UNAVAILABLE' });
  });

  it('revalidates earlier reports at collector completion and refuses detached or stale evidence', async () => {
    const accepted = await readNativeUsagePeerReport(PEER);
    await expect(revalidateNativeUsagePeerReport(accepted)).resolves.toBeUndefined();
    await expect(revalidateNativeUsagePeerReport(structuredClone(accepted))).rejects.toMatchObject({ code: 'NATIVE_USAGE_PEER_UNVERIFIED' });
    fixture.registry.peers[0].syncCategories = { usage: false };
    await expect(revalidateNativeUsagePeerReport(accepted)).rejects.toMatchObject({ code: 'NATIVE_USAGE_PEER_FORBIDDEN' });
    fixture.registry.peers[0].syncCategories = { usage: true };
    vi.setSystemTime(NOW + 300001);
    await expect(revalidateNativeUsagePeerReport(accepted)).rejects.toMatchObject({ code: 'NATIVE_USAGE_PEER_STALE' });
  });

  it('aborts a continuously streaming body at the whole-request deadline', async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), milliseconds);
      return controller.signal;
    });
    let stream;
    fixture.streamRequest.mockImplementationOnce(async (_url, { signal }) => {
      stream = new PassThrough();
      const interval = setInterval(() => stream.write(Buffer.from(' ')), 1000);
      signal.addEventListener('abort', () => { clearInterval(interval); stream.destroy(new Error('aborted')); });
      return { status: 200, headers: {}, stream };
    });
    const pending = expect(readNativeUsagePeerReport(PEER)).rejects.toMatchObject({ code: 'NATIVE_USAGE_PEER_UNAVAILABLE' });
    await vi.advanceTimersByTimeAsync(0);
    expect(stream.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    await pending;
    expect(stream.destroyed).toBe(true);
  });

  it('applies idle and byte limits to HTTPS streams before the peer finishes its response', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    fixture.registry.peers[0].host = 'fixture-peer.invalid';
    // Exercise the real peerStreamRequest HTTPS branch and Node→Web conversion.
    // Only the network socket is doubled; a buffered shim would never settle.
    let incoming;
    const requestSpy = vi.spyOn(https, 'request').mockImplementation((_options, callback) => {
      const req = new EventEmitter();
      req.end = () => callback(incoming);
      return req;
    });
    for (const [mode, code] of [['idle', 'NATIVE_USAGE_PEER_UNAVAILABLE'], ['bytes', 'NATIVE_USAGE_PEER_REPORT_TOO_LARGE'],
      ['declared-bytes', 'NATIVE_USAGE_PEER_REPORT_TOO_LARGE']]) {
      incoming = new PassThrough();
      incoming.statusCode = 200;
      incoming.headers = mode === 'declared-bytes' ? { 'content-length': String(NATIVE_USAGE_PEER_MAX_BYTES + 1) } : {};
      incoming.write(Buffer.from(mode === 'bytes' ? ' '.repeat(NATIVE_USAGE_PEER_MAX_BYTES + 1) : '{}'));
      fixture.streamRequest.mockImplementationOnce(actualPeerStreamRequest);
      const pending = expect(readNativeUsagePeerReport(PEER)).rejects.toMatchObject({ code });
      await vi.advanceTimersByTimeAsync(0);
      if (mode === 'idle') {
        await vi.advanceTimersByTimeAsync(4999);
        expect(incoming.destroyed).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
      }
      await pending;
      expect(incoming.destroyed).toBe(true);
      expect(incoming.readableEnded).toBe(false);
    }
    expect(requestSpy).toHaveBeenCalledTimes(3);
    expect(requestSpy.mock.calls[0][0]).toMatchObject({ hostname: 'fixture-peer.invalid', method: 'GET', headers: headers(LOCAL) });
  });
});
