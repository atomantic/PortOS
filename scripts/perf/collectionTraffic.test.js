import { describe, expect, it } from 'vitest';
import { createTrafficAccumulator, endpointFor, inspectCollection, trafficFailures } from './collectionTraffic.js';
import { CARDINALITIES, messageFixture, mediaFixture } from './collectionFixtureData.js';
const start = (t, id = 'one', path = '/api/messages/inbox?secret=never-retain') => t.event('requestWillBeSent', { requestId: id, request: { url: 'http://example.com' + path } });

describe('synthetic CDP traffic accounting', () => {
  it('redacts thread accounts and non-HTTP payload URLs', () => {
    expect(endpointFor('http://example.com/api/messages/thread/00000000-0000-4000-8000-000000000002/synthetic-thread-1')).toBe('/api/messages/thread/:account/:record');
    expect(endpointFor('data:text/plain,payload')).toBe('/non-http');
  });
  it('counts compressed transfer once and decoded data separately without retaining URLs', () => {
    const t = createTrafficAccumulator(); start(t);
    t.event('responseReceived', { requestId: 'one', response: { status: 200, encodedDataLength: 20 } });
    t.event('dataReceived', { requestId: 'one', dataLength: 1000, encodedDataLength: 100 });
    t.event('loadingFinished', { requestId: 'one', encodedDataLength: 120 });
    expect(t.snapshot().cold['/api/messages/inbox']).toMatchObject({ requests: 1, completed: 1, encodedBytes: 120, decodedBytes: 1000 });
    expect(JSON.stringify(t.snapshot())).not.toMatch(/secret|example.com|never-retain/);
    expect(t.pending()).toBe(0);
  });
  it('accounts redirects, partial cancellations, fixture failures, and phase-crossing bytes', () => {
    const t = createTrafficAccumulator(); start(t);
    t.event('requestWillBeSent', { requestId: 'one', redirectResponse: { encodedDataLength: 30 }, request: { url: 'http://example.com/api/messages/inbox' } });
    t.event('responseReceived', { requestId: 'one', response: { status: 503, encodedDataLength: 20 } });
    t.setPhase('idle');
    t.event('dataReceived', { requestId: 'one', dataLength: 80, encodedDataLength: 40 });
    t.event('loadingFailed', { requestId: 'one', canceled: true });
    t.event('loadingFailed', { requestId: 'one', canceled: true });
    expect(t.snapshot().cold['/api/messages/inbox']).toMatchObject({ requests: 2, completed: 1, encodedBytes: 50, unavailable: 1 });
    expect(t.snapshot().idle['/api/messages/inbox']).toMatchObject({ requests: 0, failed: 1, canceled: 1, encodedBytes: 40, decodedBytes: 80 });
  });
  it('counts UTF-8 and base64 socket payloads without retaining frames or double counting HTTP', () => {
    const t = createTrafficAccumulator();
    t.event('webSocketCreated', { requestId: 'socket', url: 'ws://example.com/socket.io/?token=private' });
    t.setPhase('idle');
    t.event('webSocketFrameSent', { requestId: 'socket', response: { opcode: 1, payloadData: 'é' } });
    t.event('webSocketFrameReceived', { requestId: 'socket', response: { opcode: 2, payloadData: 'AAECAw==' } });
    expect(t.snapshot().idle['/socket.io/']).toMatchObject({ socketSentFrames: 1, socketSentBytes: 2, socketReceivedFrames: 1, socketReceivedBytes: 4, encodedBytes: 0 });
    expect(JSON.stringify(t.snapshot())).not.toMatch(/private|AAECAw/);
  });
});

describe('collection regression gates', () => {
  const q = new URLSearchParams('summary=true');
  it('accepts compact pages but rejects full hydration before client slicing', () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({ id: String(i), preview: 'summary' }));
    expect(inspectCollection('/api/messages/inbox', q, { messages, total: 4000 }, 12000, CARDINALITIES).failures).toEqual([]);
    const full = Array.from({ length: 4000 }, (_, i) => messageFixture('synthetic-account', i));
    const result = inspectCollection('/api/messages/inbox', q, { messages: full, total: 4000 }, 1000000, CARDINALITIES);
    expect(result.failures.map(f => f.reason)).toEqual(['page-limit-or-total', 'list-byte-budget', 'eager-detail-fields']);
    expect(JSON.stringify(result)).not.toContain('bodyText');
    expect(inspectCollection('/api/messages/inbox', q, full, 1000000, CARDINALITIES).failures[0].reason).toBe('unpaged-response');
  });
  it('catches hidden media, full prompts, and lost query-wide totals', () => {
    const payload = { items: [{ kind: 'image', data: { ...mediaFixture('image', 1), prompt: 'summary' } }], total: 3240, hiddenTotal: 360 };
    expect(inspectCollection('/api/image-gen/gallery', q, payload, 1000, CARDINALITIES).failures).toEqual([]);
    payload.items[0].data = mediaFixture('image', 1);
    expect(inspectCollection('/api/image-gen/gallery', q, payload, 9000, CARDINALITIES).failures[0].reason).toBe('eager-detail-fields');
    payload.items[0].data = mediaFixture('image', 0);
    expect(inspectCollection('/api/image-gen/gallery', q, payload, 9000, CARDINALITIES).failures[0].reason).toBe('hidden-row');
    payload.total = 3600;
    expect(inspectCollection('/api/image-gen/gallery', q, payload, 9000, CARDINALITIES).failures[0].reason).toBe('page-limit-or-total');
  });
  it('rejects sibling list reads, eager details and full history without rejecting heartbeats', () => {
    const t = createTrafficAccumulator(); t.setPhase('sibling'); start(t);
    t.setPhase('idle'); t.event('webSocketFrameReceived', { requestId: 's', response: { opcode: 1, payloadData: '2' } });
    t.setPhase('cold'); start(t, 'detail', '/api/messages/account/record'); start(t, 'history', '/api/video-gen/history');
    expect(trafficFailures(t.snapshot()).map(f => f.reason)).toEqual(['sibling-inbox-fetch', 'eager-detail-request', 'full-history-fetch']);
  });
});
