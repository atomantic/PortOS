import { createHash } from 'crypto';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { describe, it, expect, afterEach } from 'vitest';
import {
  DOWNLOAD_HEADROOM_BYTES,
  DOWNLOAD_VERDICTS,
  assessDownloadPreflight,
  assertDownloadFits,
  normalizeSha256,
  siblingDownloadMeta,
  streamResumableDownload,
  verifyDownloadHash,
  partialPathFor,
  probeRemoteSize,
  sweepOrphanedPartials,
  ORPHANED_PARTIAL_MAX_AGE_MS,
} from './downloadPreflight.js';

const GiB = 1024 ** 3;

describe('normalizeSha256 / siblingDownloadMeta', () => {
  it('accepts bare, prefixed, and quoted sha256 hex', () => {
    const hex = 'a'.repeat(64);
    expect(normalizeSha256(hex)).toBe(hex);
    expect(normalizeSha256(`sha256:${hex}`)).toBe(hex);
    expect(normalizeSha256(`"${hex}"`)).toBe(hex);
    expect(normalizeSha256('nope')).toBeNull();
    expect(normalizeSha256(null)).toBeNull();
  });

  it('reads size and digest from an LFS sibling', () => {
    expect(siblingDownloadMeta({
      rfilename: 'model.gguf',
      size: 12,
      lfs: { size: 99, sha256: 'B'.repeat(64) },
    })).toEqual({ bytes: 99, sha256: 'b'.repeat(64) });
  });

  it('falls back to the sibling size when LFS is absent', () => {
    expect(siblingDownloadMeta({ rfilename: 'model.gguf', size: 12 })).toEqual({
      bytes: 12,
      sha256: null,
    });
  });
});

describe('assessDownloadPreflight', () => {
  const statfsImpl = async () => ({ bavail: 10, bsize: GiB }); // 10 GiB free

  it('reports ok when free space covers the payload plus headroom', async () => {
    const result = await assessDownloadPreflight({
      destPath: '/models/example.gguf',
      expectedBytes: 2 * GiB,
      statfsImpl,
    });
    expect(result).toMatchObject({
      destPath: '/models/example.gguf',
      expectedBytes: 2 * GiB,
      requiredBytes: 2 * GiB + DOWNLOAD_HEADROOM_BYTES,
      freeBytes: 10 * GiB,
      verdict: DOWNLOAD_VERDICTS.OK,
    });
    expect(assertDownloadFits(result)).toBe(result);
  });

  it('marks tight when the download would leave less than the headroom', async () => {
    const result = await assessDownloadPreflight({
      destPath: '/models/example.gguf',
      expectedBytes: 9.6 * GiB,
      statfsImpl,
    });
    expect(result.verdict).toBe(DOWNLOAD_VERDICTS.TIGHT);
    expect(() => assertDownloadFits(result)).not.toThrow();
  });

  it('refuses with DISK_INSUFFICIENT when free space cannot hold the payload', async () => {
    const result = await assessDownloadPreflight({
      destPath: '/models/example.gguf',
      expectedBytes: 12 * GiB,
      statfsImpl,
    });
    expect(result.verdict).toBe(DOWNLOAD_VERDICTS.INSUFFICIENT);
    expect(result.requiredBytes).toBe(12 * GiB + DOWNLOAD_HEADROOM_BYTES);
    try {
      assertDownloadFits(result);
      throw new Error('expected throw');
    } catch (err) {
      expect(err.code).toBe('DISK_INSUFFICIENT');
      expect(err.status).toBe(507);
      expect(err.context.freeBytes).toBe(10 * GiB);
      expect(err.context.expectedBytes).toBe(12 * GiB);
    }
  });

  it('does not refuse when the advertised size is unknown', async () => {
    const result = await assessDownloadPreflight({
      destPath: '/models/example.gguf',
      expectedBytes: 0,
      statfsImpl: async () => ({ bavail: 1, bsize: 1024 }),
    });
    expect(result.verdict).toBe(DOWNLOAD_VERDICTS.OK);
    expect(result.requiredBytes).toBe(0);
  });

  it('fails open when statfs is unavailable', async () => {
    const result = await assessDownloadPreflight({
      destPath: '/models/example.gguf',
      expectedBytes: 50 * GiB,
      statfsImpl: async () => { throw new Error('statfs unavailable'); },
    });
    expect(result.freeBytes).toBeNull();
    expect(result.verdict).toBe(DOWNLOAD_VERDICTS.OK);
  });

  describe('with a leftover .partial from a prior attempt', () => {
    const MiB = 1024 * 1024;
    let dir;

    afterEach(async () => {
      if (dir) await rm(dir, { recursive: true, force: true });
      dir = null;
    });

    // A resume only needs the REMAINING bytes — refusing on the full payload
    // size would reject a retry the resumable-download path could actually
    // complete, on a disk that is nearly full precisely because most of the
    // payload is already sitting in the .partial. Sizes are MiB-scale (not
    // the real GiB payloads a weight download moves) purely to keep the test
    // fast — the comparison the fix makes is dimensionless.
    it('subtracts the already-downloaded bytes from the space it requires', async () => {
      dir = await mkdtemp(join(tmpdir(), 'portos-dl-preflight-partial-'));
      const destPath = join(dir, 'weights.gguf');
      await writeFile(partialPathFor(destPath), Buffer.alloc(9 * MiB));

      const result = await assessDownloadPreflight({
        destPath,
        expectedBytes: 10 * MiB,
        headroomBytes: 1 * MiB,
        // 3 MiB free: not enough for the full 10 MiB payload + headroom, but
        // comfortably covers the 1 MiB actually still missing (+ headroom).
        statfsImpl: async () => ({ bavail: 3, bsize: MiB }),
      });

      expect(result.verdict).toBe(DOWNLOAD_VERDICTS.OK);
      expect(result.requiredBytes).toBe(2 * MiB);
      // The reported size still reflects the whole file — only the verdict
      // math looks at what's left to fetch.
      expect(result.expectedBytes).toBe(10 * MiB);
    });

    it('still refuses when even the remaining bytes will not fit', async () => {
      dir = await mkdtemp(join(tmpdir(), 'portos-dl-preflight-partial-'));
      const destPath = join(dir, 'weights.gguf');
      await writeFile(partialPathFor(destPath), Buffer.alloc(1 * MiB));

      const result = await assessDownloadPreflight({
        destPath,
        expectedBytes: 10 * MiB,
        headroomBytes: 1 * MiB,
        statfsImpl: async () => ({ bavail: 2, bsize: MiB }),
      });

      expect(result.verdict).toBe(DOWNLOAD_VERDICTS.INSUFFICIENT);
    });
  });
});

describe('probeRemoteSize', () => {
  it('prefers HEAD Content-Length and an LFS etag', async () => {
    const fetchImpl = async (_url, opts) => {
      expect(opts.method).toBe('HEAD');
      return {
        ok: true,
        headers: {
          get: (name) => ({
            'content-length': '12345',
            'x-linked-etag': `"${'c'.repeat(64)}"`,
          }[name] || null),
        },
      };
    };
    await expect(probeRemoteSize('https://example.com/w.gguf', { fetchImpl }))
      .resolves.toEqual({ bytes: 12345, sha256: 'c'.repeat(64) });
  });

  it('falls back to a 0-byte Range GET when HEAD is silent', async () => {
    const fetchImpl = async (_url, opts) => {
      if (opts.method === 'HEAD') return { ok: false, status: 405, headers: { get: () => null } };
      expect(opts.headers.Range).toBe('bytes=0-0');
      return {
        ok: true,
        status: 206,
        headers: { get: (name) => (name === 'content-range' ? 'bytes 0-0/999' : null) },
        body: { cancel: async () => {} },
      };
    };
    await expect(probeRemoteSize('https://example.com/w.gguf', { fetchImpl }))
      .resolves.toEqual({ bytes: 999, sha256: null });
  });
});

describe('streamResumableDownload', () => {
  let dir;

  const makeDir = async () => {
    dir = await mkdtemp(join(tmpdir(), 'portos-dl-preflight-'));
    return join(dir, 'weights.gguf');
  };

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  const webBody = (...chunks) => Readable.toWeb(Readable.from(chunks.map((c) => Buffer.from(c))));

  it('writes the full body and renames the partial into place', async () => {
    const destPath = await makeDir();
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => (name === 'content-length' ? '6' : null) },
      body: webBody('gg', 'ufgg'),
    });
    const ticks = [];
    const result = await streamResumableDownload({
      url: 'https://example.com/w.gguf',
      destPath,
      fetchImpl,
      onBytes: (received, total) => ticks.push({ received, total }),
    });
    expect(result.bytes).toBe(6);
    expect(result.resumed).toBe(false);
    expect(await readFile(destPath, 'utf8')).toBe('ggufgg');
    expect(await readFile(partialPathFor(destPath)).catch(() => null)).toBeNull();
    expect(ticks.at(-1)).toEqual({ received: 6, total: 6 });
  });

  it('keeps the .partial on a transport failure so a retry can resume', async () => {
    const destPath = await makeDir();
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => '99' },
      body: Readable.toWeb(new Readable({
        read() { this.destroy(new Error('connection reset')); },
      })),
    });
    await expect(streamResumableDownload({
      url: 'https://example.com/w.gguf', destPath, fetchImpl,
    })).rejects.toThrow(/connection reset/);
    // The file may be empty if the reset happened before the first chunk, but
    // it must still be there for Range resume — not unlinked.
    const leftover = await readFile(partialPathFor(destPath)).catch(() => null);
    expect(leftover).not.toBeNull();
    expect(await readFile(destPath).catch(() => null)).toBeNull();
  });

  it('discards the partial when the caller reports a user cancel', async () => {
    const destPath = await makeDir();
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => '99' },
      body: Readable.toWeb(new Readable({
        read() { this.destroy(new Error('aborted')); },
      })),
    });
    await expect(streamResumableDownload({
      url: 'https://example.com/w.gguf',
      destPath,
      fetchImpl,
      isCancelled: () => true,
    })).rejects.toThrow(/aborted/);
    expect(await readFile(partialPathFor(destPath)).catch(() => null)).toBeNull();
  });

  it('resumes with Range from the leftover partial and appends', async () => {
    const destPath = await makeDir();
    await writeFile(partialPathFor(destPath), 'gg');
    const fetchImpl = async (_url, opts) => {
      expect(opts.headers.Range).toBe('bytes=2-');
      return {
        ok: true,
        status: 206,
        headers: {
          get: (name) => ({
            'content-length': '4',
            'content-range': 'bytes 2-5/6',
          }[name] || null),
        },
        body: webBody('ufgg'),
      };
    };
    const result = await streamResumableDownload({
      url: 'https://example.com/w.gguf', destPath, fetchImpl,
    });
    expect(result.resumed).toBe(true);
    expect(result.bytes).toBe(6);
    expect(await readFile(destPath, 'utf8')).toBe('ggufgg');
  });

  it('restarts cleanly when the server ignores Range and sends 200', async () => {
    const destPath = await makeDir();
    await writeFile(partialPathFor(destPath), 'XX');
    const fetchImpl = async (_url, opts) => {
      expect(opts.headers.Range).toBe('bytes=2-');
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => (name === 'content-length' ? '4' : null) },
        body: webBody('full'),
      };
    };
    await streamResumableDownload({
      url: 'https://example.com/w.gguf', destPath, fetchImpl,
    });
    expect(await readFile(destPath, 'utf8')).toBe('full');
  });

  // A resume with no validation could splice a NEW object's bytes onto an
  // OLD partial's prefix if the remote file changed between attempts (same
  // length, different content) — a server honoring If-Range instead returns
  // 200 for that case, which the Range-ignored branch already restarts
  // cleanly on. Two attempts here: the first records the ETag; the second
  // (simulating a fresh process, e.g. after a restart) reads it back and
  // sends it as If-Range.
  it('records the first response ETag and sends it as If-Range on a later resume', async () => {
    const destPath = await makeDir();
    let firstCallHeaders;
    await streamResumableDownload({
      url: 'https://example.com/w.gguf',
      destPath,
      finalize: false,
      fetchImpl: async (_url, opts) => {
        firstCallHeaders = opts.headers;
        return {
          ok: true,
          status: 200,
          headers: { get: (name) => ({ 'content-length': '6', etag: '"abc123"' }[name] || null) },
          body: webBody('gg', 'ufgg'),
        };
      },
    });
    expect(firstCallHeaders.Range).toBeUndefined();
    expect(await readFile(`${partialPathFor(destPath)}.etag`, 'utf8').catch(() => null)).toBe('"abc123"');

    // Simulate a transport drop leaving the .partial short, then resume.
    await writeFile(partialPathFor(destPath), 'gg');
    let secondCallHeaders;
    await streamResumableDownload({
      url: 'https://example.com/w.gguf',
      destPath,
      fetchImpl: async (_url, opts) => {
        secondCallHeaders = opts.headers;
        return {
          ok: true,
          status: 206,
          headers: { get: (name) => ({ 'content-length': '4', 'content-range': 'bytes 2-5/6' }[name] || null) },
          body: webBody('ufgg'),
        };
      },
    });
    expect(secondCallHeaders.Range).toBe('bytes=2-');
    expect(secondCallHeaders['If-Range']).toBe('"abc123"');
  });

  // RFC 9110 §13.1.5 excludes WEAK etags (`W/"…"`) from If-Range use — a
  // conforming origin always evaluates a weak If-Range as non-matching and
  // answers 200, so saving/sending one would turn every resume into a full
  // restart instead of the intended change-detection guard.
  it('never records or sends a weak ETag as If-Range', async () => {
    const destPath = await makeDir();
    await streamResumableDownload({
      url: 'https://example.com/w.gguf',
      destPath,
      finalize: false,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: (name) => ({ 'content-length': '6', etag: 'W/"abc123"' }[name] || null) },
        body: webBody('gg', 'ufgg'),
      }),
    });
    expect(await readFile(`${partialPathFor(destPath)}.etag`, 'utf8').catch(() => null)).toBeNull();

    await writeFile(partialPathFor(destPath), 'gg');
    let secondCallHeaders;
    await streamResumableDownload({
      url: 'https://example.com/w.gguf',
      destPath,
      fetchImpl: async (_url, opts) => {
        secondCallHeaders = opts.headers;
        return {
          ok: true,
          status: 206,
          headers: { get: (name) => ({ 'content-length': '4', 'content-range': 'bytes 2-5/6' }[name] || null) },
          body: webBody('ufgg'),
        };
      },
    });
    expect(secondCallHeaders['If-Range']).toBeUndefined();
  });

  // A proxy that normalizes/ignores the exact byte offset can answer 206
  // starting somewhere OTHER than requested — appending that onto our
  // existing prefix at `flags: 'a'` would corrupt the file, so this must be
  // treated the same as a Range-ignored 200: discard and restart clean.
  it('discards and restarts when a 206 resumes from the wrong offset', async () => {
    const destPath = await makeDir();
    await writeFile(partialPathFor(destPath), 'gg');
    let callCount = 0;
    const fetchImpl = async (_url, opts) => {
      callCount += 1;
      if (callCount === 1) {
        expect(opts.headers.Range).toBe('bytes=2-');
        return {
          ok: true,
          status: 206,
          // Resumed from byte 0, not the byte 2 we asked for.
          headers: { get: (name) => ({ 'content-length': '6', 'content-range': 'bytes 0-5/6' }[name] || null) },
          body: webBody('ggufgg'),
        };
      }
      expect(opts.headers.Range).toBeUndefined();
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => (name === 'content-length' ? '6' : null) },
        body: webBody('ggufgg'),
      };
    };
    const result = await streamResumableDownload({ url: 'https://example.com/w.gguf', destPath, fetchImpl });
    expect(callCount).toBe(2);
    expect(result.resumed).toBe(false);
    expect(await readFile(destPath, 'utf8')).toBe('ggufgg');
  });

  // A body that ends cleanly (no stream error) short of the advertised total
  // is a truncation — without a published digest to catch it (the HF LoRA
  // path has none), a short file would otherwise be renamed into place and
  // treated as a complete, selectable model.
  it('refuses a cleanly-closed response that fell short of Content-Length', async () => {
    const destPath = await makeDir();
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => (name === 'content-length' ? '10' : null) },
      body: webBody('short'), // 5 bytes, advertised 10
    });
    await expect(streamResumableDownload({
      url: 'https://example.com/w.gguf', destPath, fetchImpl,
    })).rejects.toMatchObject({ code: 'DOWNLOAD_TRUNCATED' });
    // Kept for a future resume, exactly like a transport-error partial.
    expect(await readFile(partialPathFor(destPath), 'utf8')).toBe('short');
    expect(await readFile(destPath).catch(() => null)).toBeNull();
  });

  // The 416 restart path deletes the partial and recurses with resumeFrom
  // reset to 0 — the recursive call's own "Range ignored" recheck never
  // fires (resumeFrom is already 0 there), so without an explicit recheck
  // here a preflight sized for the SHORTFALL only never gets rerun against
  // the FULL payload the restart is about to fetch.
  it('refuses a 416 restart the disk cannot hold, using the 416 response\'s own total', async () => {
    const destPath = await makeDir();
    await writeFile(partialPathFor(destPath), 'X'.repeat(9));
    const fetchImpl = async (_url, opts) => {
      if (opts.headers.Range) {
        return {
          ok: false,
          status: 416,
          headers: { get: (name) => (name === 'content-range' ? `bytes */${Number.MAX_SAFE_INTEGER}` : null) },
        };
      }
      throw new Error('unreachable: recheck should reject before the clean-restart GET');
    };
    await expect(streamResumableDownload({
      url: 'https://example.com/w.gguf', destPath, fetchImpl,
    })).rejects.toMatchObject({ code: 'DISK_INSUFFICIENT' });
  });

  // The caller's own preflight only reserved space for the bytes still
  // missing (crediting the .partial already on disk) — once the server
  // ignores Range and the FULL payload is about to land instead, refuse
  // rather than write past what the volume can hold.
  it('refuses a Range-ignored restart the disk cannot actually hold', async () => {
    const destPath = await makeDir();
    await writeFile(partialPathFor(destPath), 'XX');
    const fetchImpl = async (_url, opts) => {
      expect(opts.headers.Range).toBe('bytes=2-');
      return {
        ok: true,
        status: 200,
        // No real disk holds this many bytes, so the recheck must reject
        // regardless of the test machine's actual free space.
        headers: { get: (name) => (name === 'content-length' ? String(Number.MAX_SAFE_INTEGER) : null) },
        body: webBody('full'),
      };
    };
    await expect(streamResumableDownload({
      url: 'https://example.com/w.gguf', destPath, fetchImpl,
    })).rejects.toMatchObject({ code: 'DISK_INSUFFICIENT' });
    // Aborted before writing anything — the doomed transfer never started.
    await expect(readFile(destPath, 'utf8')).rejects.toThrow();
  });

  it('deletes a completed download that does not match the published hash', async () => {
    const destPath = await makeDir();
    const payload = Buffer.from('ggufgg');
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => (name === 'content-length' ? String(payload.length) : null) },
      body: webBody(payload),
    });
    await expect(streamResumableDownload({
      url: 'https://example.com/w.gguf',
      destPath,
      fetchImpl,
      expectedSha256: 'a'.repeat(64),
    })).rejects.toMatchObject({ code: 'DOWNLOAD_HASH_MISMATCH' });
    expect(await readFile(destPath).catch(() => null)).toBeNull();
    expect(await readFile(partialPathFor(destPath)).catch(() => null)).toBeNull();
  });

  it('accepts a matching published hash', async () => {
    const destPath = await makeDir();
    const payload = Buffer.from('ggufgg');
    const digest = createHash('sha256').update(payload).digest('hex');
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => (name === 'content-length' ? String(payload.length) : null) },
      body: webBody(payload),
    });
    await streamResumableDownload({
      url: 'https://example.com/w.gguf', destPath, fetchImpl, expectedSha256: digest,
    });
    expect(await readFile(destPath)).toEqual(payload);
  });
});

describe('verifyDownloadHash', () => {
  let dir;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('skips when no digest was published', async () => {
    expect(await verifyDownloadHash('/nope', null)).toEqual({ ok: true, skipped: true });
  });

  it('compares the on-disk digest case-insensitively', async () => {
    dir = await mkdtemp(join(tmpdir(), 'portos-dl-hash-'));
    const path = join(dir, 'f.bin');
    const payload = Buffer.from('abc');
    await writeFile(path, payload);
    const digest = createHash('sha256').update(payload).digest('hex').toUpperCase();
    await expect(verifyDownloadHash(path, digest)).resolves.toMatchObject({ ok: true });
  });
});

describe('sweepOrphanedPartials', () => {
  let dir;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const writeAged = async (name, ageMs, contents = 'x') => {
    const p = join(dir, name);
    await writeFile(p, contents);
    if (ageMs > 0) {
      const when = new Date(Date.now() - ageMs);
      await utimes(p, when, when);
    }
    return p;
  };

  it('all-zero on a missing dir (does not throw)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'portos-partial-sweep-'));
    const res = await sweepOrphanedPartials(join(dir, 'nope'));
    expect(res).toEqual({ deleted: 0, keptYoung: 0, keptProtected: 0 });
  });

  it('removes a .partial older than the cutoff and its .etag sidecar', async () => {
    dir = await mkdtemp(join(tmpdir(), 'portos-partial-sweep-'));
    const age = ORPHANED_PARTIAL_MAX_AGE_MS + 60_000;
    const partial = await writeAged('model.gguf.partial', age);
    const etag = await writeAged('model.gguf.partial.etag', age, '"abc"');
    await writeAged('keep.gguf', age, 'done');
    const res = await sweepOrphanedPartials(dir);
    expect(res.deleted).toBe(1);
    expect(await readFile(partial).catch(() => null)).toBeNull();
    expect(await readFile(etag).catch(() => null)).toBeNull();
    expect(await readFile(join(dir, 'keep.gguf'), 'utf8')).toBe('done');
  });

  it('keeps a recent .partial (in-flight / still-resumable)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'portos-partial-sweep-'));
    const fresh = await writeAged('model.gguf.partial', 0);
    const res = await sweepOrphanedPartials(dir);
    expect(res.deleted).toBe(0);
    expect(res.keptYoung).toBe(1);
    expect(await readFile(fresh).catch(() => null)).not.toBeNull();
  });

  it('never deletes an isProtected dest even when the .partial is old', async () => {
    dir = await mkdtemp(join(tmpdir(), 'portos-partial-sweep-'));
    const age = ORPHANED_PARTIAL_MAX_AGE_MS + 60_000;
    const pinned = await writeAged('live.gguf.partial', age);
    const stray = await writeAged('stale.gguf.partial', age);
    const dest = join(dir, 'live.gguf');
    const res = await sweepOrphanedPartials(dir, {
      isProtected: (path) => path === dest,
    });
    expect(res.deleted).toBe(1);
    expect(res.keptProtected).toBe(1);
    expect(await readFile(pinned).catch(() => null)).not.toBeNull();
    expect(await readFile(stray).catch(() => null)).toBeNull();
  });

  it('walks nested download dirs (ollama/lmstudio-style trees)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'portos-partial-sweep-'));
    const nested = join(dir, 'blobs');
    await mkdir(nested);
    const age = ORPHANED_PARTIAL_MAX_AGE_MS + 60_000;
    const nestedPartial = join(nested, 'sha.partial');
    await writeFile(nestedPartial, 'x');
    const when = new Date(Date.now() - age);
    await utimes(nestedPartial, when, when);
    const res = await sweepOrphanedPartials(dir);
    expect(res.deleted).toBe(1);
    expect(await readFile(nestedPartial).catch(() => null)).toBeNull();
  });
});
