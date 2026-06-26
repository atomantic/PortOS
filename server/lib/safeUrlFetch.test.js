/**
 * Tests for the SSRF-guarded public-URL fetch helpers. The DNS resolver and the
 * underlying fetchWithTimeout are mocked so the guard + redirect-revalidation
 * logic is exercised without a network.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  isPublicHttpUrlSafe, assertPublicHttpUrl, fetchPublicText, fetchPublicBinary,
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

describe('fetchPublicBinary', () => {
  it('returns the buffer + content-type within the cap', async () => {
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
});
