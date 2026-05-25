import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm, writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock peerFetch for network isolation.
vi.mock('../../lib/peerHttpClient.js', async () => ({
  peerFetch: vi.fn(),
  peerSocketOptions: {},
}));

// Mock instances.js so backfillMissingSidecars can be tested without live peers.
vi.mock('../instances.js', async () => ({
  UNKNOWN_INSTANCE_ID: 'unknown',
  getInstanceId: vi.fn().mockResolvedValue('test-instance'),
  getPeers: vi.fn(),
}));

// Mock peerUrl so base URL generation is deterministic in tests.
vi.mock('../../lib/peerUrl.js', async () => ({
  peerBaseUrl: vi.fn((peer) => `http://${peer.instanceId}.test:5555`),
}));

import { PATHS } from '../../lib/fileUtils.js';
import { peerFetch } from '../../lib/peerHttpClient.js';
import { getPeers } from '../instances.js';
import { pullSidecarForImage, backfillMissingSidecars } from './sidecarSync.js';

let tmp;
let originalImagesPath;

beforeEach(async () => {
  originalImagesPath = PATHS.images;
  tmp = join(tmpdir(), `portos-sidecar-test-${Date.now()}-${Math.random()}`);
  await mkdir(join(tmp, 'images'), { recursive: true });
  PATHS.images = join(tmp, 'images');
  vi.mocked(peerFetch).mockReset();
  vi.mocked(getPeers).mockReset();
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
  PATHS.images = originalImagesPath;
});

const fakePeer = { instanceId: 'peer-x', name: 'Peer X' };
const fakeBase = 'http://peer-x.test:5555';

describe('pullSidecarForImage', () => {
  it('fetches and writes sidecar when peer returns ok', async () => {
    const sidecarBody = JSON.stringify({ prompt: 'a cat', model: 'flux' });
    const buf = Buffer.from(sidecarBody);
    vi.mocked(peerFetch).mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-length': String(buf.byteLength) }),
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    });

    const result = await pullSidecarForImage(fakePeer, fakeBase, 'test.png');
    expect(result).toBe(true);

    const sidecarPath = join(PATHS.images, 'test.metadata.json');
    expect(existsSync(sidecarPath)).toBe(true);
    const written = JSON.parse(await readFile(sidecarPath, 'utf8'));
    expect(written.prompt).toBe('a cat');
  });

  it('returns false and writes nothing when peer returns !ok (404)', async () => {
    vi.mocked(peerFetch).mockResolvedValue({ ok: false, status: 404 });

    const result = await pullSidecarForImage(fakePeer, fakeBase, 'missing.png');
    expect(result).toBe(false);
    expect(existsSync(join(PATHS.images, 'missing.metadata.json'))).toBe(false);
  });

  it('returns false and does not throw when peerFetch rejects', async () => {
    vi.mocked(peerFetch).mockRejectedValue(new Error('network error'));

    const result = await pullSidecarForImage(fakePeer, fakeBase, 'error.png');
    expect(result).toBe(false);
    expect(existsSync(join(PATHS.images, 'error.metadata.json'))).toBe(false);
  });

  it('returns false when peer returns an empty body', async () => {
    vi.mocked(peerFetch).mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-length': '0' }),
      arrayBuffer: async () => new ArrayBuffer(0),
    });

    const result = await pullSidecarForImage(fakePeer, fakeBase, 'empty.png');
    expect(result).toBe(false);
  });

  it('constructs the correct URL including encoded sidecar name + abort signal', async () => {
    vi.mocked(peerFetch).mockResolvedValue({ ok: false, status: 404 });
    await pullSidecarForImage(fakePeer, fakeBase, 'my image.png');
    expect(peerFetch).toHaveBeenCalledWith(
      `${fakeBase}/data/images/${encodeURIComponent('my image.metadata.json')}`,
      expect.objectContaining({ maxBytes: expect.any(Number), signal: expect.any(AbortSignal) })
    );
  });

  it('returns false and writes nothing when the body is not valid JSON (HTML error page guard)', async () => {
    const htmlBody = Buffer.from('<!DOCTYPE html><html><body>500 oops</body></html>');
    vi.mocked(peerFetch).mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-length': String(htmlBody.byteLength) }),
      arrayBuffer: async () => htmlBody.buffer.slice(htmlBody.byteOffset, htmlBody.byteOffset + htmlBody.byteLength),
    });
    const result = await pullSidecarForImage(fakePeer, fakeBase, 'htmlpage.png');
    expect(result).toBe(false);
    expect(existsSync(join(PATHS.images, 'htmlpage.metadata.json'))).toBe(false);
  });

  it('returns false and writes nothing when the JSON body is not an object (scalar/array)', async () => {
    // Valid JSON but a non-object — writing it would corrupt the gallery reader
    // (getOrComputeImageSha256 spreads `sidecar || {}`; a string spreads to char keys).
    for (const body of ['"oops"', '[1,2,3]', '42', 'true', 'null']) {
      vi.mocked(peerFetch).mockReset();
      const buf = Buffer.from(body);
      vi.mocked(peerFetch).mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-length': String(buf.byteLength) }),
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      });
      const result = await pullSidecarForImage(fakePeer, fakeBase, 'scalar.png');
      expect(result).toBe(false);
    }
    expect(existsSync(join(PATHS.images, 'scalar.metadata.json'))).toBe(false);
  });

  // Build a fetch-style Response whose body streams `chunks` via getReader(),
  // and whose arrayBuffer() throws (so the test proves the streaming path is used).
  const streamingRes = (contentLength, ...chunks) => {
    let i = 0;
    return {
      ok: true,
      headers: new Headers({ 'content-length': String(contentLength) }),
      body: {
        getReader: () => ({
          read: async () => (i < chunks.length
            ? { done: false, value: chunks[i++] }
            : { done: true, value: undefined }),
          cancel: async () => {},
        }),
      },
      arrayBuffer: async () => { throw new Error('should stream via getReader, not arrayBuffer'); },
    };
  };

  it('streams the body via getReader (native-fetch path) and writes a valid sidecar', async () => {
    const body = Buffer.from(JSON.stringify({ prompt: 'streamed' }));
    vi.mocked(peerFetch).mockResolvedValue(streamingRes(body.byteLength, new Uint8Array(body)));
    const result = await pullSidecarForImage(fakePeer, fakeBase, 'streamed.png');
    expect(result).toBe(true);
    const written = JSON.parse(await readFile(join(PATHS.images, 'streamed.metadata.json'), 'utf8'));
    expect(written.prompt).toBe('streamed');
  });

  it('aborts the stream and writes nothing when the body exceeds the cap despite a small Content-Length (lying peer)', async () => {
    // Content-Length LIES (100 bytes, passes the cap check) but the streamed
    // body is 300KB (> 256KB cap). The streaming reader must abort, not buffer.
    const oversized = new Uint8Array(300 * 1024);
    vi.mocked(peerFetch).mockResolvedValue(streamingRes(100, oversized));
    const result = await pullSidecarForImage(fakePeer, fakeBase, 'liar.png');
    expect(result).toBe(false);
    expect(existsSync(join(PATHS.images, 'liar.metadata.json'))).toBe(false);
  });

  it('returns false and writes nothing when the peer sidecar is cache-only (sha256 block, no prompt)', async () => {
    // A cache-only sidecar has no prompt to recover and could clobber a
    // prompt-bearing local one — must not be written.
    const cacheOnly = Buffer.from(JSON.stringify({ sha256: { value: 'a'.repeat(64), mtimeMs: 1, size: 2 } }));
    vi.mocked(peerFetch).mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-length': String(cacheOnly.byteLength) }),
      arrayBuffer: async () => cacheOnly.buffer.slice(cacheOnly.byteOffset, cacheOnly.byteOffset + cacheOnly.byteLength),
    });
    const result = await pullSidecarForImage(fakePeer, fakeBase, 'cacheonly.png');
    expect(result).toBe(false);
    expect(existsSync(join(PATHS.images, 'cacheonly.metadata.json'))).toBe(false);
  });

  it('rejects path-traversal filenames before any fetch or FS op', async () => {
    vi.mocked(peerFetch).mockResolvedValue({ ok: true, arrayBuffer: async () => Buffer.from('{}').buffer });
    const result = await pullSidecarForImage(fakePeer, fakeBase, '../../etc/passwd.png');
    expect(result).toBe(false);
    // Never even hit the network for a traversal name.
    expect(peerFetch).not.toHaveBeenCalled();
  });

  it('rejects an over-cap content-length before buffering', async () => {
    vi.mocked(peerFetch).mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-length': String(10 * 1024 * 1024) }), // 10MB >> 256KB cap
      arrayBuffer: async () => { throw new Error('should not buffer an over-cap body'); },
    });
    const result = await pullSidecarForImage(fakePeer, fakeBase, 'huge.png');
    expect(result).toBe(false);
    expect(existsSync(join(PATHS.images, 'huge.metadata.json'))).toBe(false);
  });

  it('refuses when the content-length header is missing (cannot bound the body)', async () => {
    vi.mocked(peerFetch).mockResolvedValue({
      ok: true,
      headers: new Headers({}),
      arrayBuffer: async () => Buffer.from('{}').buffer,
    });
    const result = await pullSidecarForImage(fakePeer, fakeBase, 'noheader.png');
    expect(result).toBe(false);
  });
});

describe('backfillMissingSidecars', () => {
  it('attempts only images without sidecars and skips already-present ones', async () => {
    // Create two images: one with a real gen-params sidecar already, one bare.
    await writeFile(join(PATHS.images, 'with-sidecar.png'), Buffer.from('img1'));
    await writeFile(
      join(PATHS.images, 'with-sidecar.metadata.json'),
      Buffer.from(JSON.stringify({ prompt: 'already has a prompt' })),
    );
    await writeFile(join(PATHS.images, 'bare.png'), Buffer.from('img2'));

    const sidecarBuf = Buffer.from(JSON.stringify({ prompt: 'recovered' }));
    vi.mocked(getPeers).mockResolvedValue([
      { instanceId: 'peer-a', name: 'Peer A', status: 'online' },
    ]);
    vi.mocked(peerFetch).mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-length': String(sidecarBuf.byteLength) }),
      arrayBuffer: async () => sidecarBuf.buffer.slice(
        sidecarBuf.byteOffset, sidecarBuf.byteOffset + sidecarBuf.byteLength
      ),
    });

    const result = await backfillMissingSidecars({
      filenames: ['with-sidecar.png', 'bare.png'],
    });

    // Only the bare image was attempted.
    expect(result.attempted).toBe(1);
    expect(result.recovered).toBe(1);
    // The sidecar that was already present was NOT re-fetched.
    expect(peerFetch).toHaveBeenCalledTimes(1);
    // The recovered sidecar is now on disk.
    expect(existsSync(join(PATHS.images, 'bare.metadata.json'))).toBe(true);
  });

  it('returns { attempted: 0, recovered: 0 } when all sidecars already have gen-params', async () => {
    await writeFile(join(PATHS.images, 'all.png'), Buffer.from('img'));
    await writeFile(
      join(PATHS.images, 'all.metadata.json'),
      Buffer.from(JSON.stringify({ prompt: 'p', model: 'flux' })),
    );
    vi.mocked(getPeers).mockResolvedValue([
      { instanceId: 'peer-a', name: 'Peer A', status: 'online' },
    ]);

    const result = await backfillMissingSidecars({ filenames: ['all.png'] });
    expect(result.attempted).toBe(0);
    expect(result.recovered).toBe(0);
    expect(peerFetch).not.toHaveBeenCalled();
  });

  it('treats a cache-only sidecar (just sha256, no prompt) as missing and attempts a pull', async () => {
    // getOrComputeImageSha256 writes this exact shape for every image it hashes
    // during sync — it has NO prompt, so "Pull missing prompts" must still try.
    await writeFile(join(PATHS.images, 'cacheonly.png'), Buffer.from('img'));
    await writeFile(
      join(PATHS.images, 'cacheonly.metadata.json'),
      Buffer.from(JSON.stringify({ sha256: { value: 'a'.repeat(64), mtimeMs: 1, size: 3 } })),
    );
    const recoveredBuf = Buffer.from(JSON.stringify({ prompt: 'recovered prompt' }));
    vi.mocked(getPeers).mockResolvedValue([
      { instanceId: 'peer-a', name: 'Peer A', status: 'online' },
    ]);
    vi.mocked(peerFetch).mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-length': String(recoveredBuf.byteLength) }),
      arrayBuffer: async () => recoveredBuf.buffer.slice(
        recoveredBuf.byteOffset, recoveredBuf.byteOffset + recoveredBuf.byteLength,
      ),
    });

    const result = await backfillMissingSidecars({ filenames: ['cacheonly.png'] });
    expect(result.attempted).toBe(1);
    expect(result.recovered).toBe(1);
    expect(peerFetch).toHaveBeenCalledTimes(1);
    // The cache-only sidecar was overwritten with the real prompt metadata.
    const written = JSON.parse(await readFile(join(PATHS.images, 'cacheonly.metadata.json'), 'utf8'));
    expect(written.prompt).toBe('recovered prompt');
  });

  it('returns { attempted: 1, recovered: 0 } when no peer has the sidecar', async () => {
    await writeFile(join(PATHS.images, 'bare2.png'), Buffer.from('img'));
    vi.mocked(getPeers).mockResolvedValue([
      { instanceId: 'peer-a', name: 'Peer A', status: 'online' },
    ]);
    vi.mocked(peerFetch).mockResolvedValue({ ok: false, status: 404 });

    const result = await backfillMissingSidecars({ filenames: ['bare2.png'] });
    expect(result.attempted).toBe(1);
    expect(result.recovered).toBe(0);
  });

  it('skips offline peers', async () => {
    await writeFile(join(PATHS.images, 'bare3.png'), Buffer.from('img'));
    vi.mocked(getPeers).mockResolvedValue([
      { instanceId: 'peer-offline', name: 'Offline', status: 'offline' },
    ]);

    const result = await backfillMissingSidecars({ filenames: ['bare3.png'] });
    expect(result.attempted).toBe(1);
    expect(result.recovered).toBe(0);
    expect(peerFetch).not.toHaveBeenCalled();
  });

  it('skips peers the user turned off (enabled:false or syncEnabled:false)', async () => {
    await writeFile(join(PATHS.images, 'bare-off.png'), Buffer.from('img'));
    vi.mocked(getPeers).mockResolvedValue([
      { instanceId: 'peer-disabled', name: 'Disabled', status: 'online', enabled: false },
      { instanceId: 'peer-nosync', name: 'NoSync', status: 'online', syncEnabled: false },
    ]);

    const result = await backfillMissingSidecars({ filenames: ['bare-off.png'] });
    expect(result.attempted).toBe(1);
    expect(result.recovered).toBe(0);
    // Neither opted-out peer is contacted.
    expect(peerFetch).not.toHaveBeenCalled();
  });

  it('skips filenames whose image bytes are not on disk (no orphan sidecar, no fetch)', async () => {
    // Image file intentionally NOT written — only a stale filename is passed.
    vi.mocked(getPeers).mockResolvedValue([
      { instanceId: 'peer-a', name: 'Peer A', status: 'online' },
    ]);
    const result = await backfillMissingSidecars({ filenames: ['ghost.png'] });
    expect(result.attempted).toBe(0);
    expect(result.recovered).toBe(0);
    expect(peerFetch).not.toHaveBeenCalled();
    // No orphan sidecar was written for the absent image.
    expect(existsSync(join(PATHS.images, 'ghost.metadata.json'))).toBe(false);
  });

  it('handles non-array filenames gracefully (returns zeros)', async () => {
    vi.mocked(getPeers).mockResolvedValue([]);
    const result = await backfillMissingSidecars({ filenames: null });
    expect(result.attempted).toBe(0);
    expect(result.recovered).toBe(0);
  });

  it('skips path-traversal filenames (never attempts them)', async () => {
    vi.mocked(getPeers).mockResolvedValue([
      { instanceId: 'peer-a', name: 'Peer A', status: 'online' },
    ]);
    const result = await backfillMissingSidecars({
      filenames: ['../../etc/passwd.png', 'sub/dir/asset.png'],
    });
    expect(result.attempted).toBe(0);
    expect(result.recovered).toBe(0);
    expect(peerFetch).not.toHaveBeenCalled();
  });
});
