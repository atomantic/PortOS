import { describe, it, expect } from 'vitest';
import {
  createFleetHostUsageLedger,
  createUsageSniffer,
  findReportedUsage,
  normalizeClientAddress,
  usageDayKey,
} from './fleetHostUsage.js';

// The parser earns focused tests: it reads two materially different wire
// shapes that a route-level test cannot cheaply produce, and a wrong answer is
// silent — a report that undercounts looks exactly like a quiet host.
describe('findReportedUsage', () => {
  it('reads the usage block of a non-streamed completion', () => {
    const body = JSON.stringify({
      id: 'chatcmpl-1',
      choices: [{ message: { content: 'hello' } }],
      usage: { prompt_tokens: 120, completion_tokens: 34, total_tokens: 154 },
    });
    expect(findReportedUsage(body)).toEqual({ promptTokens: 120, completionTokens: 34 });
  });

  it('takes the final populated frame of a stream whose earlier frames carry usage: null', () => {
    // vLLM with `stream_options.include_usage` emits a null `usage` on every
    // content frame and the real one only at the end. A forward scan stops on
    // the first null and reports nothing.
    const stream = [
      'data: {"choices":[{"delta":{"content":"he"}}],"usage":null}',
      'data: {"choices":[{"delta":{"content":"llo"}}],"usage":null}',
      'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7}}',
      'data: [DONE]',
      '',
    ].join('\n\n');
    expect(findReportedUsage(stream)).toEqual({ promptTokens: 11, completionTokens: 7 });
  });

  it('reports nothing when the stream never carried counts', () => {
    const stream = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
    expect(findReportedUsage(stream)).toBeNull();
  });

  it('skips a usage value that is not an object rather than throwing', () => {
    expect(findReportedUsage('{"usage":null}')).toBeNull();
    expect(findReportedUsage('{"usage":"n/a"}')).toBeNull();
  });

  it('is not confused by a brace inside a string value', () => {
    const body = '{"choices":[{"message":{"content":"}{ \\" not json"}}],"usage":{"prompt_tokens":3,"completion_tokens":4}}';
    expect(findReportedUsage(body)).toEqual({ promptTokens: 3, completionTokens: 4 });
  });
});

describe('createUsageSniffer', () => {
  it('finds the counts after a generation longer than its tail buffer', () => {
    const sniffer = createUsageSniffer({ maxBytes: 512 });
    for (let i = 0; i < 200; i += 1) {
      sniffer.push(Buffer.from(`data: {"choices":[{"delta":{"content":"chunk ${i}"}}],"usage":null}\n\n`));
    }
    sniffer.push(Buffer.from('data: {"usage":{"prompt_tokens":9,"completion_tokens":400}}\n\n'));
    expect(sniffer.result()).toEqual({ promptTokens: 9, completionTokens: 400 });
  });

  it('decodes once at the end, so a multi-byte character split across chunks stays intact', () => {
    const sniffer = createUsageSniffer();
    const text = Buffer.from('data: {"content":"é","usage":{"prompt_tokens":1,"completion_tokens":2}}');
    sniffer.push(text.subarray(0, 25));
    sniffer.push(text.subarray(25));
    expect(sniffer.result()).toEqual({ promptTokens: 1, completionTokens: 2 });
  });

  it('answers null before anything has streamed', () => {
    expect(createUsageSniffer().result()).toBeNull();
  });
});

describe('normalizeClientAddress', () => {
  it('folds an IPv4-mapped IPv6 address onto the same key as its plain form', () => {
    // A dual-stack listener reports one machine two ways; two rows for one peer
    // would split its totals in half.
    expect(normalizeClientAddress('::ffff:192.0.2.10')).toBe('192.0.2.10');
    expect(normalizeClientAddress('192.0.2.10')).toBe('192.0.2.10');
  });

  it('returns null for a missing address rather than an empty key', () => {
    expect(normalizeClientAddress(undefined)).toBeNull();
    expect(normalizeClientAddress('   ')).toBeNull();
  });
});

describe('createFleetHostUsageLedger', () => {
  const at = (iso) => new Date(iso).getTime();

  it('attributes requests and observed tokens per client', () => {
    const ledger = createFleetHostUsageLedger({ now: () => at('2026-09-20T10:00:00Z') });
    const a = ledger.beginRequest({ address: '192.0.2.10', path: '/v1/chat/completions' });
    const b = ledger.beginRequest({ address: '192.0.2.11', path: '/v1/chat/completions' });
    expect(ledger.snapshot().activeRequests).toBe(2);

    ledger.endRequest(a, { status: 200, usage: { promptTokens: 100, completionTokens: 50 }, model: 'qwen3.8-27b' });
    ledger.endRequest(b, { status: 500, usage: null });

    const snapshot = ledger.snapshot();
    expect(snapshot.activeRequests).toBe(0);
    const first = snapshot.clients.find((c) => c.key === '192.0.2.10');
    expect(first).toMatchObject({ requests: 1, errors: 0, promptTokens: 100, completionTokens: 50, tokenReports: 1, models: ['qwen3.8-27b'] });
    const second = snapshot.clients.find((c) => c.key === '192.0.2.11');
    expect(second).toMatchObject({ requests: 1, errors: 1, tokenReports: 0, promptTokens: 0, completionTokens: 0 });
    expect(snapshot.totals).toMatchObject({ requests: 2, errors: 1, tokenReports: 1, completionTokens: 50 });
  });

  it('counts a request whose response reported nothing without inventing a token total', () => {
    // The regression: treating "no counts reported" as zero makes a busy
    // streaming client read as free, which is worse than reading as unknown.
    const ledger = createFleetHostUsageLedger({ now: () => at('2026-09-20T10:00:00Z') });
    const handle = ledger.beginRequest({ address: '192.0.2.10' });
    ledger.endRequest(handle, { status: 200, usage: null });
    const [client] = ledger.snapshot().clients;
    expect(client.requests).toBe(1);
    expect(client.tokenReports).toBe(0);
  });

  it('buckets by local day and drops buckets past the retention window', () => {
    let clock = at('2026-08-01T12:00:00Z');
    const ledger = createFleetHostUsageLedger({ now: () => clock, retentionDays: 7 });
    ledger.endRequest(ledger.beginRequest({ address: '192.0.2.10' }), { status: 200, usage: { promptTokens: 5, completionTokens: 5 } });
    expect(Object.keys(ledger.snapshot().clients[0].days)).toEqual([usageDayKey(clock)]);

    const old = usageDayKey(clock);
    clock = at('2026-08-20T12:00:00Z');
    ledger.endRequest(ledger.beginRequest({ address: '192.0.2.10' }), { status: 200, usage: null });
    const days = Object.keys(ledger.snapshot().clients[0].days);
    expect(days).not.toContain(old);
    expect(days).toEqual([usageDayKey(clock)]);
  });

  it('never evicts a client with a request in flight when the map is full', () => {
    // Eviction under load would decrement a row that no longer exists and
    // resurrect the client with a phantom count.
    let clock = at('2026-09-20T10:00:00Z');
    const ledger = createFleetHostUsageLedger({ now: () => clock, maxClients: 2 });
    const busy = ledger.beginRequest({ address: '192.0.2.10' });
    clock += 1000;
    ledger.endRequest(ledger.beginRequest({ address: '192.0.2.11' }), { status: 200, usage: null });
    clock += 1000;
    ledger.endRequest(ledger.beginRequest({ address: '192.0.2.12' }), { status: 200, usage: null });

    const keys = ledger.snapshot().clients.map((c) => c.key);
    expect(keys).toContain('192.0.2.10');
    expect(keys).not.toContain('192.0.2.11');

    ledger.endRequest(busy, { status: 200, usage: { promptTokens: 1, completionTokens: 1 } });
    expect(ledger.snapshot().activeRequests).toBe(0);
  });

  it('round-trips through persistence without restoring a phantom in-flight request', () => {
    const clock = at('2026-09-20T10:00:00Z');
    const ledger = createFleetHostUsageLedger({ now: () => clock });
    ledger.endRequest(ledger.beginRequest({ address: '192.0.2.10' }), { status: 200, usage: { promptTokens: 7, completionTokens: 8 }, model: 'qwen3.8-27b' });
    // A connection cannot outlive the process that served it.
    ledger.beginRequest({ address: '192.0.2.10' });
    expect(ledger.snapshot().activeRequests).toBe(1);

    const restored = createFleetHostUsageLedger({ now: () => clock });
    expect(restored.hydrate(JSON.parse(JSON.stringify(ledger.toJSON())))).toBe(true);
    const snapshot = restored.snapshot();
    expect(snapshot.activeRequests).toBe(0);
    expect(snapshot.clients[0]).toMatchObject({ key: '192.0.2.10', requests: 1, promptTokens: 7, completionTokens: 8 });
  });

  it('refuses a payload from an unknown future version rather than half-reading it', () => {
    const ledger = createFleetHostUsageLedger();
    expect(ledger.hydrate({ version: 2, clients: [{ key: '192.0.2.10', requests: 9 }] })).toBe(false);
    expect(ledger.snapshot().clients).toEqual([]);
  });
});
