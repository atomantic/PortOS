import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getSettings } from './settings.js';
import { resolveBeeperToken } from './beeperCredentials.js';
import {
  BeeperApiError,
  DEFAULT_BASE_URL,
  resolveBeeperBaseUrl,
  resolveBeeperConfig,
  mapBeeperResponseError,
  paginateBeeperCursor,
  listChatsPage,
  listChats,
  listMessages,
  searchChatsPage,
  searchMessagesPage,
  getInfo,
  probeBeeperInfo,
  assertValidInfoResponse,
  getAccounts,
  getBridges,
  joinAccountsWithBridges,
  getJoinedAccounts,
  sendMessage,
  editMessage,
  deleteMessage,
  downloadAsset,
  fetchAssetStream,
  updateChat,
} from './beeperClient.js';

// resolveBeeperConfig only touches settings.js (base URL) and the vault-backed
// credential store (token) when EITHER baseUrl or token is omitted; every other
// test in this file passes both explicitly and never exercises these mocks, so
// they're safe to hoist for the whole file. `beeperCredentials` is mocked
// rather than exercised because its own suite covers the vault contract and it
// would otherwise reach for Postgres from here.
vi.mock('./settings.js', () => ({ getSettings: vi.fn() }));
vi.mock('./beeperCredentials.js', () => ({ resolveBeeperToken: vi.fn() }));

// A fixture-shaped fake Response, matching what readResponseJson consumes
// (only `.text()` is read; `.ok`/`.status` drive the beeperRequest branch).
function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

// A response whose body is NOT valid JSON — readResponseJson's fallback turns
// this into `{ message: text }`, which is the exact shape the malformed-
// response tests below must NOT let getAccounts/getBridges/paginateBeeperCursor
// coerce into an empty (but "successful") roster.
function nonJsonResponse(status, text) {
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

describe('beeperClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  // Config resolution
  // -------------------------------------------------------------------------

  describe('resolveBeeperConfig', () => {
    it('defaults the base URL and reports no token when neither is configured', async () => {
      vi.mocked(getSettings).mockResolvedValue({});
      vi.mocked(resolveBeeperToken).mockResolvedValue(null);
      const config = await resolveBeeperConfig();
      expect(config).toEqual({ baseUrl: DEFAULT_BASE_URL, token: null });
    });

    it('reads the base URL from settings and the token from the vault-backed store (#31)', async () => {
      vi.mocked(getSettings).mockResolvedValue({ beeper: { baseUrl: 'http://127.0.0.1:23373/' } });
      vi.mocked(resolveBeeperToken).mockResolvedValue({ token: 'vaulted-token', tokenSource: 'oauth' });
      const config = await resolveBeeperConfig();
      expect(config).toEqual({ baseUrl: 'http://127.0.0.1:23373', token: 'vaulted-token' });
    });

    // The vault read throwing means "the credential cannot be read", which is
    // NOT "no credential is configured" — collapsing the two would silently
    // make an authenticated call anonymous.
    it('propagates an unreadable credential store instead of resolving token:null', async () => {
      vi.mocked(getSettings).mockResolvedValue({});
      vi.mocked(resolveBeeperToken).mockRejectedValue(new Error('Malformed vault ciphertext'));
      await expect(resolveBeeperConfig()).rejects.toThrow(/vault ciphertext/);
    });

    it('an explicit baseUrl + token bypasses settings entirely', async () => {
      const config = await resolveBeeperConfig({ baseUrl: 'http://127.0.0.1:9999/', token: 'abc123' });
      expect(config).toEqual({ baseUrl: 'http://127.0.0.1:9999', token: 'abc123' });
    });

    it('an explicit token of null is honored as "deliberately unauthenticated", not "unset"', async () => {
      vi.mocked(resolveBeeperToken).mockClear();
      const config = await resolveBeeperConfig({ baseUrl: DEFAULT_BASE_URL, token: null });
      expect(config.token).toBeNull();
      expect(resolveBeeperToken).not.toHaveBeenCalled();
    });

    // The liveness probe must never trigger a credential read: /v1/info is the
    // one endpoint that answers unauthenticated, and a probe that decrypts the
    // vault on every status poll would be both slower and a wider blast radius.
    it('an explicit token (with no baseUrl) still skips the credential store', async () => {
      vi.mocked(resolveBeeperToken).mockClear();
      vi.mocked(getSettings).mockResolvedValue({ beeper: { baseUrl: DEFAULT_BASE_URL } });
      const config = await resolveBeeperConfig({ token: null });
      expect(config).toEqual({ baseUrl: DEFAULT_BASE_URL, token: null });
      expect(resolveBeeperToken).not.toHaveBeenCalled();
    });

    // SEC-2: `getSettings()` reads `settings.json` off disk with no schema
    // re-validation on read, so `normalizeBaseUrl` re-applies the SAME
    // loopback-only gate `beeperSettingsSchema` enforces on the PUT route —
    // otherwise a hand-edited settings.json is a second path to the exact
    // value the schema exists to block.
    it('falls back to the loopback default for a non-loopback settings baseUrl with no opt-in', async () => {
      vi.mocked(getSettings).mockResolvedValue({ beeper: { baseUrl: 'https://example.com:23373' } });
      vi.mocked(resolveBeeperToken).mockResolvedValue({ token: 'vaulted-token', tokenSource: 'oauth' });
      const config = await resolveBeeperConfig();
      expect(config).toEqual({ baseUrl: DEFAULT_BASE_URL, token: 'vaulted-token' });
    });

    it('honors a non-loopback settings baseUrl once allowNonLoopbackBaseUrl is set', async () => {
      vi.mocked(getSettings).mockResolvedValue({
        beeper: { baseUrl: 'https://example.com:23373', allowNonLoopbackBaseUrl: true },
      });
      vi.mocked(resolveBeeperToken).mockResolvedValue({ token: 'vaulted-token', tokenSource: 'oauth' });
      const config = await resolveBeeperConfig();
      expect(config).toEqual({ baseUrl: 'https://example.com:23373', token: 'vaulted-token' });
    });

    // The "both explicit" bypass trusts its caller rather than re-deriving the
    // opt-in here — it exists for values a caller ALREADY resolved through
    // `resolveBeeperBaseUrl()` (which is where the gate lives), not for a raw
    // unvalidated string. `beeperStatus.js` is the worked example: it calls
    // `resolveBeeperBaseUrl()` first and passes the result in here, rather
    // than reading `settings.beeper.baseUrl` straight into this bypass.
    it('does not re-derive the opt-in for the "both explicit" bypass — it trusts an already-resolved baseUrl', async () => {
      const config = await resolveBeeperConfig({ baseUrl: 'https://example.com:23373', token: 'abc123' });
      expect(config).toEqual({ baseUrl: 'https://example.com:23373', token: 'abc123' });
    });
  });

  describe('resolveBeeperBaseUrl', () => {
    it('falls back to the loopback default for a non-loopback settings baseUrl with no opt-in', async () => {
      vi.mocked(getSettings).mockResolvedValue({ beeper: { baseUrl: 'http://example.com:23373' } });
      await expect(resolveBeeperBaseUrl()).resolves.toBe(DEFAULT_BASE_URL);
    });

    it('honors a non-loopback settings baseUrl once allowNonLoopbackBaseUrl is set', async () => {
      vi.mocked(getSettings).mockResolvedValue({
        beeper: { baseUrl: 'http://example.com:23373', allowNonLoopbackBaseUrl: true },
      });
      await expect(resolveBeeperBaseUrl()).resolves.toBe('http://example.com:23373');
    });
  });

  // -------------------------------------------------------------------------
  // 502-is-terminal mapping
  // -------------------------------------------------------------------------

  describe('mapBeeperResponseError', () => {
    it('maps a 502 from an asset endpoint to the terminal ASSET_UNAVAILABLE', () => {
      const err = mapBeeperResponseError(502, { message: 'Failed to download asset: Transfer failed for mxc://abc', code: 'BRIDGE_ERROR' }, { isAssetEndpoint: true });
      expect(err).toBeInstanceOf(BeeperApiError);
      expect(err.code).toBe('ASSET_UNAVAILABLE');
      expect(err.retryable).toBe(false);
    });

    it('maps a 502 from a non-asset endpoint to the ordinarily-retryable UPSTREAM_ERROR', () => {
      const err = mapBeeperResponseError(502, { message: 'bridge unavailable' }, { isAssetEndpoint: false });
      expect(err.code).toBe('UPSTREAM_ERROR');
      expect(err.retryable).toBe(true);
    });

    it('maps 401 to a non-retryable UNAUTHORIZED', () => {
      const err = mapBeeperResponseError(401, { message: 'Unauthorized: Invalid or missing token', code: 'unauthorized' });
      expect(err.code).toBe('UNAUTHORIZED');
      expect(err.retryable).toBe(false);
    });

    // Live-verified: POST /v1/assets/download answers HTTP 200 for an
    // unresolvable mxc:// reference, with an `{ error }` body and no `srcURL`
    // — never a 502. beeperRequest treats any `response.ok` body as success,
    // so downloadAsset itself must reject a 200 body shaped like a failure.
    it('downloadAsset end-to-end surfaces ASSET_UNAVAILABLE on a live 200-with-error body', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
        jsonResponse(200, { error: 'Failed to download asset: Transfer failed for mxc://gone' }),
      ));
      await expect(downloadAsset('mxc://gone', { baseUrl: DEFAULT_BASE_URL, token: 't' }))
        .rejects.toMatchObject({ code: 'ASSET_UNAVAILABLE', retryable: false });
    });

    it('downloadAsset also rejects a 200 body with neither an error nor a srcURL', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, {})));
      await expect(downloadAsset('mxc://odd', { baseUrl: DEFAULT_BASE_URL, token: 't' }))
        .rejects.toMatchObject({ code: 'ASSET_UNAVAILABLE', retryable: false });
    });

    it('downloadAsset resolves with the body when srcURL is a non-empty string', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
        jsonResponse(200, { srcURL: 'file:///tmp/example.png' }),
      ));
      await expect(downloadAsset('mxc://ok', { baseUrl: DEFAULT_BASE_URL, token: 't' }))
        .resolves.toEqual({ srcURL: 'file:///tmp/example.png' });
    });

    // The mapper's asset-502 branch above still applies to GET/HEAD
    // /v1/assets/serve — the byte-streaming half of the asset surface — which
    // really does answer 502 for a missing/expired asset (live-verified).
    // downloadAsset (POST /v1/assets/download) is the one caller that never
    // reaches this branch, per the two tests above.
  });

  // -------------------------------------------------------------------------
  // Cursor pagination / exhaustion
  // -------------------------------------------------------------------------

  describe('paginateBeeperCursor', () => {
    it('walks every page until hasMore is false', async () => {
      const pages = [
        { items: ['a', 'b'], hasMore: true, oldestCursor: 'c1', newestCursor: null },
        { items: ['c'], hasMore: true, oldestCursor: 'c2', newestCursor: null },
        { items: ['d'], hasMore: false, oldestCursor: null, newestCursor: null },
      ];
      const fetchPage = vi.fn(async ({ cursor }) => {
        if (!cursor) return pages[0];
        if (cursor === 'c1') return pages[1];
        if (cursor === 'c2') return pages[2];
        throw new Error(`unexpected cursor ${cursor}`);
      });

      const collected = [];
      for await (const item of paginateBeeperCursor(fetchPage)) collected.push(item);

      expect(collected).toEqual(['a', 'b', 'c', 'd']);
      expect(fetchPage).toHaveBeenCalledTimes(3);
    });

    it('stops (does not loop forever) when hasMore is true but the walked cursor is null', async () => {
      const fetchPage = vi.fn(async () => ({ items: ['only'], hasMore: true, oldestCursor: null, newestCursor: null }));
      const collected = [];
      for await (const item of paginateBeeperCursor(fetchPage)) collected.push(item);
      expect(collected).toEqual(['only']);
      expect(fetchPage).toHaveBeenCalledTimes(1);
    });

    it('stops (does not loop forever) when a server echoes back the same cursor it was just called with', async () => {
      // hasMore stays true and oldestCursor never advances past 'stuck' — a
      // naive loop would walk in place forever.
      const fetchPage = vi.fn(async () => ({ items: ['x'], hasMore: true, oldestCursor: 'stuck', newestCursor: null }));
      const collected = [];
      for await (const item of paginateBeeperCursor(fetchPage)) collected.push(item);
      expect(collected).toEqual(['x', 'x']);
      expect(fetchPage).toHaveBeenCalledTimes(2);
    });

    it('yields nothing and makes one call for a single empty page', async () => {
      const fetchPage = vi.fn(async () => ({ items: [], hasMore: false }));
      const collected = [];
      for await (const item of paginateBeeperCursor(fetchPage)) collected.push(item);
      expect(collected).toEqual([]);
      expect(fetchPage).toHaveBeenCalledTimes(1);
    });

    it('throws MALFORMED_RESPONSE instead of silently treating a missing items array as exhausted', async () => {
      const fetchPage = vi.fn(async () => ({ hasMore: false }));
      const collected = [];
      await expect((async () => {
        for await (const item of paginateBeeperCursor(fetchPage)) collected.push(item);
      })()).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE', retryable: false });
      expect(collected).toEqual([]);
    });

    it('throws MALFORMED_RESPONSE when a later page (not the first) has a non-array items', async () => {
      const fetchPage = vi.fn(async ({ cursor }) => (!cursor
        ? { items: ['a'], hasMore: true, oldestCursor: 'c1' }
        : { items: 'not-an-array', hasMore: true, oldestCursor: 'c2' }));
      const collected = [];
      await expect((async () => {
        for await (const item of paginateBeeperCursor(fetchPage)) collected.push(item);
      })()).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE', retryable: false });
      expect(collected).toEqual(['a']);
    });

    it('walks newestCursor when direction is "after"', async () => {
      const fetchPage = vi.fn(async ({ cursor }) => (!cursor
        ? { items: [1], hasMore: true, oldestCursor: null, newestCursor: 'n1' }
        : { items: [2], hasMore: false }));
      const collected = [];
      for await (const item of paginateBeeperCursor(fetchPage, { direction: 'after' })) collected.push(item);
      expect(collected).toEqual([1, 2]);
      expect(fetchPage).toHaveBeenNthCalledWith(2, { cursor: 'n1', direction: 'after' });
    });

    it('listChats/listMessages iterators drive listChatsPage/listMessagesPage across real HTTP pages', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(jsonResponse(200, { items: [{ id: 'chat1' }], hasMore: true, oldestCursor: 'cur1' }))
        .mockResolvedValueOnce(jsonResponse(200, { items: [{ id: 'chat2' }], hasMore: false }));
      vi.stubGlobal('fetch', fetchMock);

      const chats = [];
      for await (const chat of listChats({ baseUrl: DEFAULT_BASE_URL, token: 't' })) chats.push(chat);
      expect(chats.map((c) => c.id)).toEqual(['chat1', 'chat2']);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][0]).toContain('cursor=cur1');
    });
  });

  // -------------------------------------------------------------------------
  // probeBeeperInfo body-shape check (#30 — a wave-one reviewer requirement:
  // a 200 with an unexpected body must not be reported as a healthy probe)
  // -------------------------------------------------------------------------

  describe('probeBeeperInfo / assertValidInfoResponse', () => {
    it('reports reachable:true for a well-shaped /v1/info body', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
        jsonResponse(200, { app: { name: 'Beeper', version: '4.3.73' }, server: { status: 'running' } }),
      ));
      const result = await probeBeeperInfo({ baseUrl: DEFAULT_BASE_URL });
      expect(result).toEqual({
        reachable: true, info: expect.objectContaining({ app: expect.any(Object) }), error: null, timedOut: false, latencyMs: expect.any(Number),
      });
    });

    it('reports reachable:false — not true — for a 200 whose body is not the documented /v1/info shape', async () => {
      // A misconfigured settings.beeper.baseUrl (#30 makes it user-editable)
      // could point at some other local HTTP service that happens to answer
      // 200 with an unrelated JSON body. The transport succeeded but this is
      // not Beeper, so it must never read as a healthy probe.
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { ok: true })));
      const result = await probeBeeperInfo({ baseUrl: DEFAULT_BASE_URL });
      expect(result.reachable).toBe(false);
      expect(result.info).toBeNull();
      expect(result.error).toMatch(/unexpected \/v1\/info response shape/);
    });

    it('reports reachable:false for a 200 with a blank/non-JSON body', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(nonJsonResponse(200, '')));
      const result = await probeBeeperInfo({ baseUrl: DEFAULT_BASE_URL });
      expect(result.reachable).toBe(false);
      expect(result.error).toMatch(/unexpected \/v1\/info response shape/);
    });

    it('assertValidInfoResponse throws a typed MALFORMED_RESPONSE BeeperApiError directly', () => {
      expect(() => assertValidInfoResponse({ app: { name: '' }, server: { status: 'running' } }))
        .toThrow(expect.objectContaining({ code: 'MALFORMED_RESPONSE', status: 502 }));
      expect(() => assertValidInfoResponse(null)).toThrow(BeeperApiError);
      expect(() => assertValidInfoResponse({ app: { name: 'Beeper' }, server: { status: 'running' } })).not.toThrow();
    });

    // Fork issue #61, decision 7: `timedOut` is what `beeperStatus.js` reads to
    // tell "briefly slow" from "genuinely closed" — a fast refusal (nothing
    // listening) must never be mistaken for a timeout, or a closed Beeper
    // Desktop could ride a stale recent-success window into a false "slow".
    it('reports timedOut:false for a fast connection refusal, distinct from an abort', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })));
      const result = await probeBeeperInfo({ baseUrl: DEFAULT_BASE_URL });
      expect(result.reachable).toBe(false);
      expect(result.timedOut).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Timeout behaviour with injected time (no real sleeps)
  // -------------------------------------------------------------------------

  describe('timeout behavior (fake timers)', () => {
    function bodyThatRejectsOnAbort(status, signal) {
      return {
        ok: status >= 200 && status < 300,
        status,
        text: () => new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new DOMException('aborted while reading body', 'AbortError'));
          }, { once: true });
        }),
      };
    }

    function tricklingJsonResponse(status, signal) {
      let chunksSent = 0;
      const stream = new ReadableStream({
        start(controller) {
          const trickleId = setInterval(() => {
            chunksSent++;
            controller.enqueue(new TextEncoder().encode(' '));
          }, 5);
          signal.addEventListener('abort', () => {
            clearInterval(trickleId);
            controller.error(signal.reason || new DOMException('aborted', 'AbortError'));
          }, { once: true });
        },
      });
      return { response: new Response(stream, { status }), chunksSent: () => chunksSent };
    }

    // Fork issue #61, decision 7: 1s proved too tight for a briefly-busy Beeper
    // Desktop, so the cap moved to 3s.
    it('probeBeeperInfo caps at 3s and resolves reachable:false/timedOut:true without throwing, and without a real sleep', async () => {
      vi.useFakeTimers();
      try {
        vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, opts) =>
          new Promise((_resolve, reject) => {
            opts.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          })));

        const probePromise = probeBeeperInfo({ baseUrl: DEFAULT_BASE_URL });
        // Advance virtual time only — a real 3s sleep here would fail CI timing
        // budgets and defeats the point of injected time.
        await vi.advanceTimersByTimeAsync(3000);
        const result = await probePromise;

        expect(result.reachable).toBe(false);
        expect(result.error).toBeTruthy();
        // The abort IS the timeout — this is the signal `beeperStatus.js` reads
        // to decide `slow` vs `unreachable` (fork issue #61, decision 7), so a
        // regression here is silent everywhere downstream.
        expect(result.timedOut).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('a read call (allowRetry) retries a replayable connection error using injected delay, not a real sleep', async () => {
      vi.useFakeTimers();
      try {
        const fetchMock = vi.fn()
          .mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }))
          .mockResolvedValueOnce(jsonResponse(200, { items: [], hasMore: false }));
        vi.stubGlobal('fetch', fetchMock);

        const promise = listChatsPage({ baseUrl: DEFAULT_BASE_URL, token: 't' });
        // Let the first attempt's rejection settle, then advance past the
        // retry delay entirely in virtual time.
        await vi.advanceTimersByTimeAsync(400);
        const result = await promise;

        expect(result).toEqual({ items: [], hasMore: false });
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('a total deadline cancels retry backoff before another read attempt starts', async () => {
      vi.useFakeTimers();
      try {
        const fetchMock = vi.fn().mockRejectedValue(
          Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }),
        );
        vi.stubGlobal('fetch', fetchMock);

        const request = listChatsPage({
          baseUrl: DEFAULT_BASE_URL, token: 't', timeoutMs: 25,
        });
        const rejection = expect(request).rejects.toMatchObject({
          code: 'NETWORK_ERROR',
          context: { details: { timedOut: true } },
        });
        await vi.advanceTimersByTimeAsync(25);

        await rejection;
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it.each([200, 500])('bounds a stalled JSON body after immediate HTTP %s headers', async (status) => {
      vi.useFakeTimers();
      try {
        let requestSignal;
        const fetchMock = vi.fn().mockImplementation((_url, opts) => {
          requestSignal = opts.signal;
          return Promise.resolve(bodyThatRejectsOnAbort(status, requestSignal));
        });
        vi.stubGlobal('fetch', fetchMock);

        const request = getInfo({ baseUrl: DEFAULT_BASE_URL, timeoutMs: 25 });
        const rejection = expect(request).rejects.toMatchObject({
          code: 'NETWORK_ERROR',
          context: { details: { timedOut: true } },
        });
        await vi.advanceTimersByTimeAsync(25);

        await rejection;
        expect(requestSignal.aborted).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps one total deadline when a JSON body keeps trickling data', async () => {
      vi.useFakeTimers();
      try {
        let requestSignal;
        let chunksSent;
        vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, opts) => {
          requestSignal = opts.signal;
          const trickle = tricklingJsonResponse(200, requestSignal);
          chunksSent = trickle.chunksSent;
          return Promise.resolve(trickle.response);
        }));

        const request = getInfo({ baseUrl: DEFAULT_BASE_URL, timeoutMs: 30 });
        const rejection = expect(request).rejects.toMatchObject({
          code: 'NETWORK_ERROR',
          context: { details: { timedOut: true } },
        });
        await vi.advanceTimersByTimeAsync(30);

        await rejection;
        expect(chunksSent()).toBeGreaterThan(1);
        expect(requestSignal.aborted).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('clears the total deadline after a successful JSON read', async () => {
      vi.useFakeTimers();
      try {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, {
          app: { name: 'Beeper' }, server: { status: 'running' },
        })));

        await expect(getInfo({ baseUrl: DEFAULT_BASE_URL, timeoutMs: 50 })).resolves.toMatchObject({
          app: { name: 'Beeper' },
        });
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('aborts a stalled send body after one POST without retrying it', async () => {
      vi.useFakeTimers();
      try {
        let requestSignal;
        const fetchMock = vi.fn().mockImplementation((_url, opts) => {
          requestSignal = opts.signal;
          return Promise.resolve(bodyThatRejectsOnAbort(200, requestSignal));
        });
        vi.stubGlobal('fetch', fetchMock);

        const request = sendMessage('chat1', { text: 'hi' }, {
          baseUrl: DEFAULT_BASE_URL, token: 't', timeoutMs: 25,
        });
        const rejection = expect(request).rejects.toMatchObject({ code: 'NETWORK_ERROR', retryable: false });
        await vi.advanceTimersByTimeAsync(25);

        await rejection;
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][1].method).toBe('POST');
      } finally {
        vi.useRealTimers();
      }
    });

    it('getInfo does not retry (unauthenticated probe, no allowRetry) — a connection error surfaces immediately', async () => {
      const fetchMock = vi.fn().mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(getInfo({ baseUrl: DEFAULT_BASE_URL })).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Send-safe retries
  // -------------------------------------------------------------------------

  describe('send-safe retries', () => {
    it('refuses redirects for message bodies and attachment requests', async () => {
      const fetchMock = vi.fn().mockRejectedValue(new TypeError('unexpected redirect'));
      vi.stubGlobal('fetch', fetchMock);

      await expect(sendMessage('chat1', { text: 'Example private message' }, { baseUrl: DEFAULT_BASE_URL, token: 'example-token' }))
        .rejects.toMatchObject({ code: 'NETWORK_ERROR', retryable: false });
      await expect(fetchAssetStream('mxc://example.com/asset', { baseUrl: DEFAULT_BASE_URL, token: 'example-token' }))
        .rejects.toMatchObject({ code: 'NETWORK_ERROR', retryable: false });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      for (const [, options] of fetchMock.mock.calls) expect(options.redirect).toBe('error');
    });

    it('sendMessage does NOT retry a replayable connection error — a retry would duplicate a real message', async () => {
      const fetchMock = vi.fn().mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(sendMessage('chat1', { text: 'hi' }, { baseUrl: DEFAULT_BASE_URL, token: 't' }))
        .rejects.toMatchObject({ code: 'NETWORK_ERROR', retryable: false });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('sendMessage rejects with retryable: false on a 429 too — a write\'s thrown error must never advertise retry-safety, regardless of status', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(429, { message: 'Too Many Requests' }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(sendMessage('chat1', { text: 'hi' }, { baseUrl: DEFAULT_BASE_URL, token: 't' }))
        .rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: false });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('editMessage rejects with retryable: false on a 502 — same write send-safety posture as sendMessage', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(502, { message: 'Bad Gateway' }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(editMessage('chat1', 'msg1', 'edited text', { baseUrl: DEFAULT_BASE_URL, token: 't' }))
        .rejects.toMatchObject({ code: 'UPSTREAM_ERROR', retryable: false });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('updateChat does NOT retry a replayable connection error — it is a write, like every other chat-state PATCH', async () => {
      const fetchMock = vi.fn().mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(updateChat('chat1', { isArchived: true }, { baseUrl: DEFAULT_BASE_URL, token: 't' }))
        .rejects.toMatchObject({ code: 'NETWORK_ERROR', retryable: false });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('updateChat sends ONLY the two allowlisted flags — a PATCH body spread could clear the chat draft as a side effect', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { id: 'chat1', isArchived: true }));
      vi.stubGlobal('fetch', fetchMock);

      await updateChat(
        'chat1',
        { isArchived: true, isLowPriority: false, draft: { text: 'nope' }, isPinned: true },
        { baseUrl: DEFAULT_BASE_URL, token: 't' },
      );

      const [, init] = fetchMock.mock.calls[0];
      expect(JSON.parse(init.body)).toEqual({ isArchived: true, isLowPriority: false });
    });

    it('a read call (allowRetry) still surfaces retryable: true on a 500 — the write clamp above must not leak into reads', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(500, { message: 'Internal Server Error' }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(listChatsPage({ baseUrl: DEFAULT_BASE_URL, token: 't' }))
        .rejects.toMatchObject({ code: 'INTERNAL_ERROR', retryable: true });
    });

    it('deleteMessage requires an explicit boolean forEveryone and never calls fetch without one', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      await expect(deleteMessage('chat1', 'msg1', undefined, { baseUrl: DEFAULT_BASE_URL, token: 't' }))
        .rejects.toMatchObject({ code: 'FOR_EVERYONE_REQUIRED' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('deleteMessage passes forEveryone=false explicitly in the query string', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204, text: async () => '' });
      vi.stubGlobal('fetch', fetchMock);

      await deleteMessage('chat1', 'msg1', false, { baseUrl: DEFAULT_BASE_URL, token: 't' });
      expect(fetchMock.mock.calls[0][0]).toContain('forEveryone=false');
    });
  });

  // -------------------------------------------------------------------------
  // Accounts / bridges join on a fixture where the `network` join is zero rows
  // -------------------------------------------------------------------------

  describe('joinAccountsWithBridges', () => {
    // Deliberately fake identifiers per repo privacy rules — no real handles,
    // phone numbers, hostnames, or message bodies. `user` is shaped like the
    // live `Account.user` (a `User`, per `GET /v1/spec`) — carrying its own
    // `phoneNumber`/`email`/`fullName` — so a test against this fixture would
    // actually catch a leak of those fields, not just of the flat `id` the
    // old `{ id: 'user-1' }` fixture had no way to catch.
    const accounts = [
      {
        accountID: 'discordgo',
        network: 'Discord', // display name
        status: 'connected',
        loginID: '+15550000001', // must never survive into the joined output
        user: {
          id: 'user-1',
          username: 'example-user-1',
          isSelf: true,
          phoneNumber: '+15550000001', // deliberately SURVIVES — fork issue #10 needs it
          email: 'alice@example.com', // deliberately SURVIVES
          fullName: 'Alice Example', // deliberately SURVIVES
        },
      },
      {
        accountID: 'local-whatsapp_ba_example',
        network: 'WhatsApp', // display name
        status: 'connection_required',
        loginID: '+15550000002',
        user: {
          id: 'user-2',
          username: 'example-user-2',
          isSelf: true,
          phoneNumber: '+15550000002',
          email: 'bob@example.com',
          fullName: 'Bob Example',
        },
      },
      {
        accountID: 'orphan-account',
        network: 'Mystery Network',
        status: 'connected',
        // no matching bridge below — must be tolerated, not dropped
      },
    ];

    const bridgesResponse = {
      items: [
        {
          id: 'bridge-discord',
          network: 'discord', // lowercase slug — differs from account.network 'Discord'
          status: 'connected',
          statusText: 'Connected',
          supportsMultipleAccounts: false,
          activeAccountCount: 3, // must never survive — documented to over-report
          accounts: [{ accountID: 'discordgo', loginID: '+15550000001', user: { id: 'user-1', phoneNumber: '+15550000001' } }],
        },
        {
          id: 'bridge-whatsapp',
          network: 'whatsapp', // lowercase slug — differs from account.network 'WhatsApp'
          status: 'connection_required',
          statusText: null,
          activeAccountCount: 1,
          accounts: [{ accountID: 'local-whatsapp_ba_example', loginID: '+15550000002', user: { id: 'user-2', phoneNumber: '+15550000002' } }],
        },
      ],
    };

    it('joins on accountID even though every account.network differs from its bridge.network (the network join is zero rows)', () => {
      // Prove the trap: naive equality on network would match nothing.
      const naiveMatches = accounts.filter((a) => bridgesResponse.items.some((b) => b.network === a.network));
      expect(naiveMatches).toHaveLength(0);

      const joined = joinAccountsWithBridges(accounts, bridgesResponse);
      const discord = joined.find((a) => a.accountID === 'discordgo');
      const whatsapp = joined.find((a) => a.accountID === 'local-whatsapp_ba_example');

      expect(discord.bridgeId).toBe('bridge-discord');
      expect(discord.statusText).toBe('Connected');
      expect(whatsapp.bridgeId).toBe('bridge-whatsapp');
      expect(whatsapp.statusText).toBeNull();
    });

    it('tolerates an account with no matching bridge', () => {
      const joined = joinAccountsWithBridges(accounts, bridgesResponse);
      const orphan = joined.find((a) => a.accountID === 'orphan-account');
      expect(orphan).toMatchObject({ bridgeId: null, bridgeStatus: null, statusText: null });
    });

    it('never surfaces loginID in the joined output', () => {
      const joined = joinAccountsWithBridges(accounts, bridgesResponse);
      for (const account of joined) expect(account).not.toHaveProperty('loginID');
    });

    it('strips ONLY loginID — nested user.phoneNumber/email/fullName deliberately survive the join (fork issue #10 needs user.phoneNumber for Tribe identity)', () => {
      const joined = joinAccountsWithBridges(accounts, bridgesResponse);
      const discord = joined.find((a) => a.accountID === 'discordgo');
      expect(discord).not.toHaveProperty('loginID');
      expect(discord.user).toMatchObject({
        phoneNumber: '+15550000001',
        email: 'alice@example.com',
        fullName: 'Alice Example',
      });
    });

    it('getAccounts / getBridges strip loginID and activeAccountCount at the client boundary too, before any join — but deliberately leave nested user PII (phoneNumber/email/fullName) intact', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(jsonResponse(200, accounts))
        .mockResolvedValueOnce(jsonResponse(200, bridgesResponse));
      vi.stubGlobal('fetch', fetchMock);

      const [gotAccounts, gotBridges] = await Promise.all([
        getAccounts({ baseUrl: DEFAULT_BASE_URL, token: 't' }),
        getBridges({ baseUrl: DEFAULT_BASE_URL, token: 't' }),
      ]);

      for (const account of gotAccounts) expect(account).not.toHaveProperty('loginID');
      expect(gotAccounts.find((a) => a.accountID === 'discordgo').user).toMatchObject({ phoneNumber: '+15550000001' });

      for (const bridge of gotBridges.items) {
        expect(bridge).not.toHaveProperty('activeAccountCount');
        for (const account of bridge.accounts) expect(account).not.toHaveProperty('loginID');
      }
      expect(gotBridges.items[0].accounts[0].user).toMatchObject({ phoneNumber: '+15550000001' });
    });

    it('getJoinedAccounts wires getAccounts + getBridges through the fetch layer end-to-end', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(jsonResponse(200, accounts))
        .mockResolvedValueOnce(jsonResponse(200, bridgesResponse));
      vi.stubGlobal('fetch', fetchMock);

      const joined = await getJoinedAccounts({ baseUrl: DEFAULT_BASE_URL, token: 't' });
      expect(joined.find((a) => a.accountID === 'discordgo').bridgeId).toBe('bridge-discord');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // Malformed response shapes — must throw a typed MALFORMED_RESPONSE error,
  // never silently coerce to an empty roster (AGENTS.md "sentinel + validate":
  // absent/failed/invalid must never collapse into "legitimately empty").
  // -------------------------------------------------------------------------

  describe('getAccounts / getBridges malformed response', () => {
    it('getAccounts throws MALFORMED_RESPONSE (not an empty roster) on a 200 with a non-JSON body', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(nonJsonResponse(200, 'not json at all')));
      await expect(getAccounts({ baseUrl: DEFAULT_BASE_URL, token: 't' }))
        .rejects.toMatchObject({ code: 'MALFORMED_RESPONSE', retryable: false });
    });

    it('getAccounts throws MALFORMED_RESPONSE on a 200 object body where an array is expected', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { accounts: [] })));
      await expect(getAccounts({ baseUrl: DEFAULT_BASE_URL, token: 't' }))
        .rejects.toMatchObject({ code: 'MALFORMED_RESPONSE', retryable: false });
    });

    it('getAccounts throws MALFORMED_RESPONSE on a blank 200 body (readResponseJson\'s emptyValue {})', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(nonJsonResponse(200, '')));
      await expect(getAccounts({ baseUrl: DEFAULT_BASE_URL, token: 't' }))
        .rejects.toMatchObject({ code: 'MALFORMED_RESPONSE', retryable: false });
    });

    it('getBridges throws MALFORMED_RESPONSE (not an empty roster) on a 200 with a non-JSON body', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(nonJsonResponse(200, 'not json at all')));
      await expect(getBridges({ baseUrl: DEFAULT_BASE_URL, token: 't' }))
        .rejects.toMatchObject({ code: 'MALFORMED_RESPONSE', retryable: false });
    });

    it('getBridges throws MALFORMED_RESPONSE on a 200 body whose items is not an array', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { items: 'not-an-array' })));
      await expect(getBridges({ baseUrl: DEFAULT_BASE_URL, token: 't' }))
        .rejects.toMatchObject({ code: 'MALFORMED_RESPONSE', retryable: false });
    });

    it('a genuinely empty roster (200 with []/{ items: [] }) is NOT malformed — still resolves empty', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(jsonResponse(200, []))
        .mockResolvedValueOnce(jsonResponse(200, { items: [] }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(getAccounts({ baseUrl: DEFAULT_BASE_URL, token: 't' })).resolves.toEqual([]);
      await expect(getBridges({ baseUrl: DEFAULT_BASE_URL, token: 't' })).resolves.toEqual({ items: [] });
    });
  });

  // -------------------------------------------------------------------------
  // Search endpoint limit clamping (limit max 20 on /v1/messages/search)
  // -------------------------------------------------------------------------

  describe('searchMessagesPage limit clamping', () => {
    it('clamps an over-cap limit to 20 rather than passing it through unbounded', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { items: [], hasMore: false, chats: {} }));
      vi.stubGlobal('fetch', fetchMock);

      await searchMessagesPage({ query: 'hello', limit: 500, baseUrl: DEFAULT_BASE_URL, token: 't' });
      expect(fetchMock.mock.calls[0][0]).toContain('limit=20');
    });

    it('defaults limit to 20 when omitted', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { items: [], hasMore: false }));
      vi.stubGlobal('fetch', fetchMock);

      await searchMessagesPage({ query: 'hello', baseUrl: DEFAULT_BASE_URL, token: 't' });
      expect(fetchMock.mock.calls[0][0]).toContain('limit=20');
    });
  });

  // -------------------------------------------------------------------------
  // Array query params (accountIDs, chatIDs, mediaTypes) must serialize as
  // repeated keys, not one comma-joined value the server reads as a single id.
  // -------------------------------------------------------------------------

  describe('array query param serialization', () => {
    it('searchMessagesPage serializes an array filter (accountIDs) as repeated keys, not comma-joined', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { items: [], hasMore: false }));
      vi.stubGlobal('fetch', fetchMock);

      await searchMessagesPage({ query: 'hello', accountIDs: ['acct-a', 'acct-b'], baseUrl: DEFAULT_BASE_URL, token: 't' });
      const url = fetchMock.mock.calls[0][0];
      const params = new URL(url).searchParams;
      expect(params.getAll('accountIDs')).toEqual(['acct-a', 'acct-b']);
      expect(url).not.toContain('acct-a%2Cacct-b');
    });

    it('searchChatsPage serializes an array filter (chatIDs) as repeated keys, not comma-joined', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { items: [], hasMore: false }));
      vi.stubGlobal('fetch', fetchMock);

      await searchChatsPage({ chatIDs: ['chat-a', 'chat-b'], baseUrl: DEFAULT_BASE_URL, token: 't' });
      const url = fetchMock.mock.calls[0][0];
      const params = new URL(url).searchParams;
      expect(params.getAll('chatIDs')).toEqual(['chat-a', 'chat-b']);
      expect(url).not.toContain('chat-a%2Cchat-b');
    });

    // #32: the ingestion sweep pages ONE account at a time so every chat row is
    // attributable to the account whose cursor bounds it. `GET /v1/chats` takes
    // no `limit`, so `accountIDs` is its only filter and has to survive into the
    // query string as repeated keys.
    it('listChatsPage sends accountIDs as repeated keys alongside cursor and direction', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { items: [], hasMore: false }));
      vi.stubGlobal('fetch', fetchMock);

      await listChatsPage({
        accountIDs: ['acct-a', 'acct-b'], cursor: 'cur1', direction: 'after', baseUrl: DEFAULT_BASE_URL, token: 't',
      });
      const url = fetchMock.mock.calls[0][0];
      const params = new URL(url).searchParams;
      expect(params.getAll('accountIDs')).toEqual(['acct-a', 'acct-b']);
      expect(params.get('cursor')).toBe('cur1');
      expect(params.get('direction')).toBe('after');
      expect(url).not.toContain('acct-a%2Cacct-b');
      expect(url).not.toContain('limit=');
    });

    it('listChatsPage omits accountIDs entirely when unset — an empty filter must not read as "match nothing"', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { items: [], hasMore: false }));
      vi.stubGlobal('fetch', fetchMock);

      await listChatsPage({ baseUrl: DEFAULT_BASE_URL, token: 't' });
      const url = fetchMock.mock.calls[0][0];
      expect(url).not.toContain('accountIDs');
      expect(new URL(url).searchParams.get('direction')).toBe('before');
    });

    it('the listChats iterator carries accountIDs onto every page it walks', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(jsonResponse(200, { items: [{ id: 'chat1' }], hasMore: true, oldestCursor: 'cur1' }))
        .mockResolvedValueOnce(jsonResponse(200, { items: [{ id: 'chat2' }], hasMore: false }));
      vi.stubGlobal('fetch', fetchMock);

      const chats = [];
      for await (const chat of listChats({ accountIDs: ['acct-a'], baseUrl: DEFAULT_BASE_URL, token: 't' })) chats.push(chat);
      expect(chats.map((c) => c.id)).toEqual(['chat1', 'chat2']);
      for (const call of fetchMock.mock.calls) {
        expect(new URL(call[0]).searchParams.getAll('accountIDs')).toEqual(['acct-a']);
      }
    });

    it('a scalar filter still serializes as a single key (no regression from the array path)', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { items: [], hasMore: false }));
      vi.stubGlobal('fetch', fetchMock);

      await searchMessagesPage({ query: 'hello', chatType: 'group', baseUrl: DEFAULT_BASE_URL, token: 't' });
      const params = new URL(fetchMock.mock.calls[0][0]).searchParams;
      expect(params.getAll('chatType')).toEqual(['group']);
    });
  });

  // -------------------------------------------------------------------------
  // Auth requirement
  // -------------------------------------------------------------------------

  describe('auth requirement', () => {
    it('an authenticated call with no token configured fails fast with NOT_CONFIGURED, without calling fetch', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      await expect(getAccounts({ baseUrl: DEFAULT_BASE_URL, token: null }))
        .rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('getInfo requires no token (the one unauthenticated endpoint) and sends no Authorization header', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { app: { name: 'Beeper' } }));
      vi.stubGlobal('fetch', fetchMock);

      await getInfo({ baseUrl: DEFAULT_BASE_URL });
      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.headers.Authorization).toBeUndefined();
    });

    it('an authenticated call sends the configured token as an Authorization: Bearer header', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, []));
      vi.stubGlobal('fetch', fetchMock);

      await getAccounts({ baseUrl: DEFAULT_BASE_URL, token: 'secret-token' });
      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.headers.Authorization).toBe('Bearer secret-token');
    });
  });
});
