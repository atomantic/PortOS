/**
 * Tests for the SSRF-guarded public-URL fetch helpers. The DNS resolver and the
 * underlying fetchWithTimeout are mocked so the guard + redirect-revalidation
 * logic is exercised without a network.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'node:http';
import { Agent } from 'undici';

const lookupMock = vi.fn();
vi.mock('dns/promises', () => ({
  default: { lookup: (...a) => lookupMock(...a) },
  lookup: (...a) => lookupMock(...a),
}));

const fetchMock = vi.fn();
vi.mock('./fetchWithTimeout.js', () => ({
  fetchWithTimeout: (...a) => fetchMock(...a),
}));

const {
  isPublicHttpUrlSafe, assertPublicHttpUrl, fetchPublicText, fetchPublicBinary, buildPinnedLookup,
} = await import('./safeUrlFetch.js');

const res = ({ ok = true, status = 200, headers = {}, text = '', body = new ArrayBuffer(0) } = {}) => ({
  ok,
  status,
  headers: new Map(Object.entries(headers)), // Headers-like: supports .get()
  text: async () => text,
  arrayBuffer: async () => body,
});

beforeEach(() => {
  lookupMock.mockReset();
  fetchMock.mockReset();
  lookupMock.mockResolvedValue({ address: '93.184.216.34' }); // public
});

describe('isPublicHttpUrlSafe', () => {
  it('accepts a public https URL', async () => {
    expect(await isPublicHttpUrlSafe('https://www.pinterest.com/x.rss')).toBe(true);
  });
  it('rejects non-http(s) schemes', async () => {
    expect(await isPublicHttpUrlSafe('file:///etc/passwd')).toBe(false);
    expect(await isPublicHttpUrlSafe('ftp://host/x')).toBe(false);
  });
  it('rejects loopback / metadata host literals without resolving', async () => {
    expect(await isPublicHttpUrlSafe('http://127.0.0.1/x')).toBe(false);
    expect(await isPublicHttpUrlSafe('http://169.254.169.254/latest/meta-data')).toBe(false);
    expect(lookupMock).not.toHaveBeenCalled();
  });
  it('rejects a hostname that RESOLVES to a blocked address', async () => {
    lookupMock.mockResolvedValue({ address: '127.0.0.1' });
    expect(await isPublicHttpUrlSafe('https://evil.example.com/x')).toBe(false);
  });
});

describe('assertPublicHttpUrl', () => {
  it('throws a 400 UNSAFE_URL for a blocked target', async () => {
    await expect(assertPublicHttpUrl('http://localhost/x')).rejects.toMatchObject({ status: 400, code: 'UNSAFE_URL' });
  });
  it('resolves for a safe target', async () => {
    await expect(assertPublicHttpUrl('https://example.com/x')).resolves.toBeUndefined();
  });
});

describe('fetchPublicText', () => {
  it('returns the body on a 2xx', async () => {
    fetchMock.mockResolvedValue(res({ text: '<rss/>' }));
    expect(await fetchPublicText('https://example.com/feed.rss')).toBe('<rss/>');
  });
  it('returns null on a non-ok status', async () => {
    fetchMock.mockResolvedValue(res({ ok: false, status: 404 }));
    expect(await fetchPublicText('https://example.com/feed.rss')).toBeNull();
  });
  it('follows a redirect only after revalidating the target', async () => {
    fetchMock
      .mockResolvedValueOnce(res({ status: 301, headers: { location: 'https://cdn.example.com/feed.rss' } }))
      .mockResolvedValueOnce(res({ text: 'ok' }));
    expect(await fetchPublicText('https://example.com/feed.rss')).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('drops a redirect to a blocked host (fails closed)', async () => {
    fetchMock.mockResolvedValueOnce(res({ status: 302, headers: { location: 'http://169.254.169.254/x' } }));
    expect(await fetchPublicText('https://example.com/feed.rss')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('connect-time IP pinning (DNS-rebinding TOCTOU, #1859)', () => {
  it('pins the vetted address, ignoring the hostname undici would re-resolve', () => {
    const lookup = buildPinnedLookup('93.184.216.34', 4);
    // undici asks with { all: true } → array of { address, family } entries.
    let all;
    lookup('evil.example.com', { all: true }, (_e, addrs) => { all = addrs; });
    expect(all).toEqual([{ address: '93.184.216.34', family: 4 }]);
    // net.lookup single-address shape (no `all`).
    let single;
    lookup('evil.example.com', {}, (_e, addr, fam) => { single = [addr, fam]; });
    expect(single).toEqual(['93.184.216.34', 4]);
  });

  it('derives the family from the address when undici omits it', () => {
    const lookup = buildPinnedLookup('2606:2800:220:1:248:1893:25c8:1946');
    let single;
    lookup('h', {}, (_e, addr, fam) => { single = [addr, fam]; });
    expect(single).toEqual(['2606:2800:220:1:248:1893:25c8:1946', 6]);
  });

  it('hands the fetch a dispatcher pinned to the validation-time address', async () => {
    // Validation resolves the host to a PUBLIC ip; the connection is pinned to
    // that exact address so a connect-time rebind to a private ip is impossible.
    lookupMock.mockResolvedValue({ address: '93.184.216.34', family: 4 });
    fetchMock.mockResolvedValue(res({ text: 'ok' }));
    await fetchPublicText('https://rebind.example.com/x');
    expect(fetchMock.mock.calls[0][1].dispatcher).toBeDefined();
  });

  it('fails closed when the validation lookup fails (no unpinned connect-time re-resolve)', async () => {
    lookupMock.mockRejectedValue(new Error('ENOTFOUND'));
    // A hostname we can't vet must not fall through to an unpinned fetch — the
    // first hop throws like any other unsafe URL and never reaches the network.
    await expect(fetchPublicText('https://unresolvable.example.com/x'))
      .rejects.toMatchObject({ status: 400, code: 'UNSAFE_URL' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await isPublicHttpUrlSafe('https://unresolvable.example.com/x')).toBe(false);
  });

  // End-to-end proof the mechanism actually defeats rebinding: a hostname that
  // never resolves in real DNS still reaches the server, so undici MUST have
  // used our pinned address rather than re-resolving at connect time.
  it('undici connects to the pinned address for a non-resolving hostname', async () => {
    const server = http.createServer((req, res2) => res2.end(`host:${req.headers.host}`));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const dispatcher = new Agent({ connect: { lookup: buildPinnedLookup('127.0.0.1', 4) } });
    const out = await fetch(`http://rebind.invalid:${port}/`, { dispatcher });
    expect(await out.text()).toBe(`host:rebind.invalid:${port}`); // Host preserved, IP pinned
    await dispatcher.close();
    await new Promise((r) => server.close(r));
  });
});

// Streaming response double — getReader() yields the given Uint8Array chunks.
const streamRes = (chunks, { headers = {}, ok = true, status = 200 } = {}) => {
  let i = 0;
  const cancel = vi.fn(async () => {});
  return {
    ok,
    status,
    headers: new Map(Object.entries(headers)),
    arrayBuffer: async () => new ArrayBuffer(0),
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }),
        cancel,
        releaseLock: () => {},
      }),
      _cancel: cancel,
    },
  };
};

describe('fetchPublicBinary', () => {
  it('returns the buffer + content-type from a non-streaming response (fallback)', async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    fetchMock.mockResolvedValue(res({ body: bytes, headers: { 'content-type': 'image/jpeg' } }));
    const out = await fetchPublicBinary('https://i.pinimg.com/736x/x.jpg');
    expect(out.contentType).toBe('image/jpeg');
    expect(out.buffer).toBeInstanceOf(Buffer);
    expect(out.buffer.length).toBe(3);
  });
  it('rejects a body over the declared Content-Length cap', async () => {
    fetchMock.mockResolvedValue(res({ headers: { 'content-length': String(99 * 1024 * 1024) } }));
    expect(await fetchPublicBinary('https://i.pinimg.com/x.jpg', { maxBytes: 1024 })).toBeNull();
  });
  it('streams a chunked body and concatenates within the cap', async () => {
    const r = streamRes([new Uint8Array([1, 2]), new Uint8Array([3, 4])], { headers: { 'content-type': 'image/png' } });
    fetchMock.mockResolvedValue(r);
    const out = await fetchPublicBinary('https://i.pinimg.com/x.png', { maxBytes: 1024 });
    expect(out.buffer.length).toBe(4);
    expect(out.contentType).toBe('image/png');
  });
  it('aborts a no-Content-Length body that exceeds the cap (bounds peak memory)', async () => {
    const r = streamRes([new Uint8Array(600), new Uint8Array(600)]); // 1200 > cap, no content-length
    fetchMock.mockResolvedValue(r);
    expect(await fetchPublicBinary('https://evil.example.com/x', { maxBytes: 1024 })).toBeNull();
    expect(r.body._cancel).toHaveBeenCalled(); // stream was cancelled rather than fully read
  });
});
