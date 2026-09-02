/**
 * Free-disk preflight, hash verification, and resumable streaming for large
 * weight downloads.
 *
 * A multi-gigabyte GGUF/safetensors pull is a decision the user makes with
 * numbers in front of them: before transferring anything we report size,
 * destination, and free disk, and refuse outright when the volume cannot hold
 * it. An interrupted transfer keeps its `.partial` so a retry can Range-resume
 * rather than restart; a completed file is checked against a published hash
 * before it is allowed to become a selectable model.
 *
 * `statfs` is already used for health/resources — this is the same reading,
 * consulted before spending tens of gigabytes.
 */

import { createWriteStream } from 'fs';
import { readFile, readdir, rm, stat, statfs, rename, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { ServerError } from './errorHandler.js';
import { ensureDir, sha256File } from './fileCore.js';

/** Spare room kept on top of the advertised payload so a full disk isn't a photo-finish. */
export const DOWNLOAD_HEADROOM_BYTES = 512 * 1024 * 1024;

export const DOWNLOAD_VERDICTS = Object.freeze({
  OK: 'ok',
  TIGHT: 'tight',
  INSUFFICIENT: 'insufficient',
});

/** After the download, remaining free space below this share of current free is "tight". */
const TIGHT_REMAINING_RATIO = 0.1;

const PARTIAL_SUFFIX = '.partial';

export const partialPathFor = (destPath) => `${destPath}${PARTIAL_SUFFIX}`;

// Sidecar recording the ETag of the object that produced a `.partial`, so a
// later resume can send `If-Range` and detect a same-length replacement
// object instead of silently splicing its bytes onto our stale prefix.
export const etagPathFor = (destPath) => `${partialPathFor(destPath)}.etag`;

/** Age after which a leftover `.partial` is treated as abandoned rather than resumable. */
export const ORPHANED_PARTIAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const destPathForPartial = (partialPath) => (
  String(partialPath).endsWith(PARTIAL_SUFFIX)
    ? partialPath.slice(0, -PARTIAL_SUFFIX.length)
    : partialPath
);

const MAX_SWEEP_DEPTH = 8;

/**
 * Recursively collect `${name}.partial` files under `dir`. A missing or
 * non-directory path returns `null` so the caller can treat it as a no-op.
 */
async function collectPartialFiles(dir, { recursive = true, depth = 0 } = {}) {
  const entries = await readdir(dir, { withFileTypes: true }).catch((err) => {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return null;
    throw err;
  });
  if (!entries) return null;
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!recursive || depth >= MAX_SWEEP_DEPTH) continue;
      const nested = await collectPartialFiles(full, { recursive, depth: depth + 1 });
      if (nested) files.push(...nested);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(PARTIAL_SUFFIX)) files.push(full);
  }
  return files;
}

/**
 * Age-based sweep of leftover `${dest}.partial` files (and their
 * `.partial.etag` sidecars) in one or more download destination directories.
 *
 * A missing directory is a no-op. Recent files (mtime within `maxAgeMs`) and
 * any path `isProtected` returns true for — an in-flight download's dest, or
 * its `.partial` — are never unlinked. An active transfer's mtime keeps
 * advancing as bytes land, but the protected-path check is the belt against a
 * sweep tick racing a live write.
 *
 * @param {string|string[]} dirs
 * @param {{ maxAgeMs?: number, now?: number, isProtected?: (path: string) => boolean, recursive?: boolean }} [opts]
 * @returns {Promise<{ deleted: number, keptYoung: number, keptProtected: number }>}
 */
export async function sweepOrphanedPartials(dirs, {
  maxAgeMs = ORPHANED_PARTIAL_MAX_AGE_MS,
  now = Date.now(),
  isProtected = () => false,
  recursive = true,
} = {}) {
  const dirList = (Array.isArray(dirs) ? dirs : [dirs])
    .filter((d) => typeof d === 'string' && d);
  let deleted = 0;
  let keptYoung = 0;
  let keptProtected = 0;
  for (const dir of dirList) {
    const files = await collectPartialFiles(dir, { recursive }).catch(() => null);
    if (!files) continue;
    for (const partial of files) {
      const destPath = destPathForPartial(partial);
      if (isProtected(destPath) || isProtected(partial)) {
        keptProtected += 1;
        continue;
      }
      const info = await stat(partial).catch(() => null);
      if (!info) continue;
      if (now - info.mtimeMs < maxAgeMs) {
        keptYoung += 1;
        continue;
      }
      const removed = await rm(partial, { force: true }).then(() => true).catch(() => false);
      // Only drop the sidecar after the partial itself is gone — an EACCES
      // (or any other unlink failure) must not strand a `.partial` without
      // the etag a later resume uses for If-Range.
      if (!removed) continue;
      await rm(etagPathFor(destPath), { force: true }).catch(() => {});
      deleted += 1;
    }
  }
  return { deleted, keptYoung, keptProtected };
}

export function normalizeSha256(value) {
  if (typeof value !== 'string') return null;
  const hex = value.trim().toLowerCase().replace(/^sha256:/, '').replace(/['"]/g, '');
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

/** Size + digest a Hugging Face sibling object actually carries (often via LFS). */
export function siblingDownloadMeta(sibling) {
  if (!sibling || typeof sibling !== 'object') return { bytes: 0, sha256: null };
  const bytes = Number(sibling.lfs?.size ?? sibling.size) || 0;
  return { bytes, sha256: normalizeSha256(sibling.lfs?.sha256 || sibling.lfs?.oid) };
}

const parseContentRangeTotal = (header) => {
  const match = String(header || '').match(/\/(\d+)\s*$/);
  return match ? Number(match[1]) : 0;
};

const parseContentRangeStart = (header) => {
  const match = String(header || '').match(/bytes\s+(\d+)-/i);
  return match ? Number(match[1]) : null;
};

async function freeBytesForPath(destPath, statfsImpl) {
  let probe = destPath || '/';
  for (let i = 0; i < 8; i += 1) {
    const stats = await statfsImpl(probe).catch(() => null);
    if (stats && Number.isFinite(stats.bavail) && Number.isFinite(stats.bsize)) {
      return stats.bavail * stats.bsize;
    }
    const parent = dirname(probe);
    if (!parent || parent === probe) break;
    probe = parent;
  }
  return null;
}

/**
 * Given a destination path and an expected byte total, report free bytes,
 * required bytes (payload + headroom), and a verdict.
 *
 * `freeBytes: null` means statfs was unavailable — the verdict is `ok` so a
 * failed reading cannot block a download that would have fit. `expectedBytes`
 * of 0 means the size is unknown: we never refuse (cannot know it will fail)
 * and never mark tight.
 * A leftover `${destPath}.partial` from a prior attempt already occupies its
 * share of disk — resuming only needs the REMAINING bytes, not the full
 * payload again. Refusing on the full size would make a nearly-full disk
 * reject a resume it can actually complete, defeating the resumable-download
 * path in exactly the low-space scenario it exists for.
 *
 * @param {{ destPath?: string, expectedBytes?: number, headroomBytes?: number, statfsImpl?: typeof statfs }} opts
 */
export async function assessDownloadPreflight({
  destPath,
  expectedBytes = 0,
  headroomBytes = DOWNLOAD_HEADROOM_BYTES,
  statfsImpl = statfs,
} = {}) {
  const expected = Math.max(0, Number(expectedBytes) || 0);
  const headroom = Math.max(0, Number(headroomBytes) || 0);
  const partialBytes = destPath
    ? await stat(partialPathFor(destPath)).then((s) => s.size, () => 0)
    : 0;
  const remaining = Math.max(0, expected - partialBytes);
  const requiredBytes = remaining > 0 ? remaining + headroom : 0;
  const freeBytes = await freeBytesForPath(destPath, statfsImpl);

  let verdict = DOWNLOAD_VERDICTS.OK;
  if (freeBytes != null && remaining > 0 && freeBytes < remaining) {
    verdict = DOWNLOAD_VERDICTS.INSUFFICIENT;
  } else if (
    freeBytes != null
    && remaining > 0
    && freeBytes - remaining < Math.max(headroom, freeBytes * TIGHT_REMAINING_RATIO)
  ) {
    verdict = DOWNLOAD_VERDICTS.TIGHT;
  }

  return {
    destPath: destPath || null,
    expectedBytes: expected,
    requiredBytes,
    headroomBytes: headroom,
    freeBytes,
    verdict,
  };
}

export function diskInsufficientError(assessment) {
  const free = assessment.freeBytes == null ? 'unknown' : `${assessment.freeBytes}`;
  return new ServerError(
    `Not enough free disk to download ${assessment.expectedBytes} bytes to ${assessment.destPath} (free: ${free}, need ${assessment.requiredBytes} including headroom)`,
    {
      status: 507,
      code: 'DISK_INSUFFICIENT',
      context: {
        destPath: assessment.destPath,
        expectedBytes: assessment.expectedBytes,
        requiredBytes: assessment.requiredBytes,
        headroomBytes: assessment.headroomBytes,
        freeBytes: assessment.freeBytes,
        verdict: assessment.verdict,
      },
    },
  );
}

/** Throw DISK_INSUFFICIENT when the verdict is insufficient; otherwise return the assessment. */
export function assertDownloadFits(assessment) {
  if (assessment?.verdict === DOWNLOAD_VERDICTS.INSUFFICIENT) {
    throw diskInsufficientError(assessment);
  }
  return assessment;
}

/**
 * HEAD (then a 0-byte Range GET) a URL for Content-Length / LFS sha.
 * Returns `{ bytes: 0, sha256: null }` when the server will not say — never throws
 * for a probe miss, so a CDN that refuses HEAD cannot block the download.
 */
export async function probeRemoteSize(url, { headers = {}, fetchImpl = fetch, signal } = {}) {
  const empty = { bytes: 0, sha256: null };
  // `content-length` on a 206 describes the PARTIAL body (1 byte for our own
  // `bytes=0-0` probe), not the resource — only trust it on a response that
  // isn't itself a range (a HEAD, or a GET the origin answered with the
  // whole body because it ignored our Range). A genuine partial's total
  // comes from `Content-Range` alone; when that carries no total (`bytes
  // 0-0/*`) the size is unknown, which correctly falls through to `empty`.
  const readMeta = (res, { trustContentLength = true } = {}) => {
    if (!res || typeof res.headers?.get !== 'function') return empty;
    const rangeTotal = parseContentRangeTotal(res.headers.get('content-range'));
    const length = trustContentLength ? (Number(res.headers.get('content-length')) || 0) : 0;
    const sha256 = normalizeSha256(
      res.headers.get('x-linked-etag') || res.headers.get('etag') || '',
    );
    return { bytes: rangeTotal || length, sha256 };
  };

  const head = await fetchImpl(url, { method: 'HEAD', headers, redirect: 'follow', signal }).catch(() => null);
  if (head?.ok) {
    const meta = readMeta(head);
    if (meta.bytes > 0 || meta.sha256) return meta;
  }

  const ranged = await fetchImpl(url, {
    method: 'GET',
    headers: { ...headers, Range: 'bytes=0-0' },
    redirect: 'follow',
    signal,
  }).catch(() => null);
  if (ranged?.ok || ranged?.status === 206) {
    // Drain a 1-byte body so the socket can close; ignore failure.
    await ranged.body?.cancel?.().catch(() => {});
    return readMeta(ranged, { trustContentLength: ranged.status !== 206 });
  }
  return empty;
}

export async function verifyDownloadHash(filePath, expectedSha256) {
  const want = normalizeSha256(expectedSha256);
  if (!want) return { ok: true, skipped: true };
  const actual = (await sha256File(filePath)).toLowerCase();
  if (actual !== want) return { ok: false, expected: want, actual };
  return { ok: true, expected: want, actual };
}

const hashMismatchError = (destPath, check) => new ServerError(
  `Download failed SHA-256 verification for ${destPath} (expected ${check.expected.slice(0, 12)}…, got ${check.actual.slice(0, 12)}…) — the file was deleted`,
  {
    status: 502,
    code: 'DOWNLOAD_HASH_MISMATCH',
    context: { destPath, expected: check.expected, actual: check.actual },
  },
);

/**
 * Stream `url` into `${destPath}.partial`, Range-resuming when a leftover
 * partial exists. Transport/stall failures keep the partial; a user cancel
 * discards it. Optionally verifies a published sha256 and renames into place.
 *
 * @returns {Promise<{ bytes: number, tmpPath: string, resumed: boolean }>}
 */
export async function streamResumableDownload({
  url,
  destPath,
  headers = {},
  fetchImpl = fetch,
  onBytes = () => {},
  signal,
  onIdleStall,
  idleStallTimeoutMs = 0,
  isCancelled = () => false,
  expectedSha256 = null,
  finalize = true,
  onHttpError = null,
} = {}) {
  const tmpPath = partialPathFor(destPath);
  const etagPath = etagPathFor(destPath);
  await ensureDir(dirname(destPath));

  const existing = await stat(tmpPath).catch(() => null);
  let resumeFrom = existing?.isFile() ? existing.size : 0;

  // Force an uncompressed transport. A proxy/mirror that gzips the response
  // still reports Content-Length for the ENCODED size while the bytes we
  // actually count and write are decoded — the truncation check below (and
  // Range math on a resume) would otherwise compare/offset in the wrong
  // units. Weight files are already-compressed binary blobs, so this costs
  // nothing on an origin that would have sent them uncompressed anyway.
  const reqHeaders = { 'Accept-Encoding': 'identity', ...headers };
  if (resumeFrom > 0) {
    reqHeaders.Range = `bytes=${resumeFrom}-`;
    // Makes the resume conditional on the remote object being UNCHANGED
    // since the attempt that produced this partial: an origin honoring
    // If-Range returns 200 (not 206) for a moved object, which the
    // Range-ignored branch below already treats as "discard and restart" —
    // without it, a same-length replacement silently splices its bytes onto
    // our old prefix. No saved etag (server never sent one, or this is the
    // first resume of a partial from before this guard existed) just means
    // no conditional — same as today.
    const savedEtag = await readFile(etagPath, 'utf8').catch(() => null);
    if (savedEtag) reqHeaders['If-Range'] = savedEtag;
  }

  let idleTimer = null;
  const clearIdleTimer = () => {
    if (!idleTimer) return;
    clearTimeout(idleTimer);
    idleTimer = null;
  };
  const resetIdleTimer = () => {
    if (!idleStallTimeoutMs || !onIdleStall) return;
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      try {
        onIdleStall();
      } catch (err) {
        console.error(`❌ Download stall watchdog failed: ${err.message}`);
      }
    }, idleStallTimeoutMs);
    idleTimer.unref?.();
  };

  // Evict a partial this attempt can no longer trust (the resume point moved
  // or the object changed) and recheck capacity against whatever real total
  // the triggering response reports — the original preflight only reserved
  // the bytes THIS discarded partial was short by, not the full payload a
  // clean restart now needs.
  const evictPartialForRestart = async (expectedBytes) => {
    await rm(tmpPath, { force: true }).catch(() => {});
    await rm(etagPath, { force: true }).catch(() => {});
    resumeFrom = 0;
    delete reqHeaders.Range;
    delete reqHeaders['If-Range'];
    if (expectedBytes > 0) {
      assertDownloadFits(await assessDownloadPreflight({ destPath, expectedBytes }));
    }
  };

  // For a response this attempt can't use AT ALL (416, or a 206 that resumed
  // from the wrong offset) — drop its body and recurse into a fresh request.
  const discardAndRefetch = async (res) => {
    await res.body?.cancel?.().catch(() => {});
    await evictPartialForRestart(parseContentRangeTotal(res.headers?.get?.('content-range')));
    return streamResumableDownload({
      url, destPath, headers, fetchImpl, onBytes, signal, onIdleStall,
      idleStallTimeoutMs, isCancelled, expectedSha256, finalize, onHttpError,
    });
  };

  resetIdleTimer();
  try {
    const res = await fetchImpl(url, { headers: reqHeaders, redirect: 'follow', signal });
    if (!res.ok && res.status !== 206) {
      // Partial is past what the server has (or the object changed) — 416
      // conventionally reports the real size as `Content-Range: bytes
      // */<total>`, which discardAndRefetch uses for its capacity recheck.
      if (res.status === 416 && resumeFrom > 0) return discardAndRefetch(res);
      if (onHttpError) onHttpError(res);
      return rejectDownloadStatus(res);
    }
    if (!res.body) {
      throw new ServerError('Download returned no body', { status: 502, code: 'DOWNLOAD_FAILED' });
    }

    // Server ignored Range (or If-Range caught the object changing under us)
    // and sent the whole file in THIS response — no need to re-fetch, just
    // stop treating it as a resume and consume the body already in hand.
    if (resumeFrom > 0 && res.status === 200) {
      await evictPartialForRestart(Number(res.headers?.get?.('content-length')) || 0);
    }

    // A 206 that resumed from somewhere OTHER than we asked (a proxy that
    // normalizes/ignores the exact offset) would otherwise get appended onto
    // our existing prefix at the wrong point, corrupting the file — this
    // response's body starts at the wrong offset, so it can't be reused.
    if (resumeFrom > 0 && res.status === 206) {
      const rangeStart = parseContentRangeStart(res.headers?.get?.('content-range'));
      if (rangeStart != null && rangeStart !== resumeFrom) return discardAndRefetch(res);
    }

    const rangeTotal = parseContentRangeTotal(res.headers?.get?.('content-range'));
    const contentLength = Number(res.headers?.get?.('content-length')) || 0;
    const total = rangeTotal || (resumeFrom > 0 ? resumeFrom + contentLength : contentLength);
    let received = resumeFrom;
    const flags = resumeFrom > 0 ? 'a' : 'w';

    // Starting a fresh write (first attempt, or just discarded above) —
    // record this response's ETag so a LATER resume of it can send
    // If-Range. Best-effort: no ETag, or a write failure, just means the
    // next resume attempt has nothing to validate against (today's behavior).
    // A WEAK etag (`W/"…"`) is explicitly excluded from If-Range use by RFC
    // 9110 §13.1.5 — a conforming origin always treats it as non-matching
    // and answers 200, so saving/sending one would silently turn every
    // resume of this object into a full restart.
    if (flags === 'w') {
      const rawEtag = res.headers?.get?.('etag') || null;
      const etag = rawEtag && !/^\s*W\//i.test(rawEtag) ? rawEtag : null;
      if (etag) await writeFile(etagPath, etag).catch(() => {});
      else await rm(etagPath, { force: true }).catch(() => {});
    }

    const counter = new Transform({
      transform(chunk, _enc, cb) {
        received += chunk.length;
        resetIdleTimer();
        onBytes(received, total);
        cb(null, chunk);
      },
    });

    await pipeline(Readable.fromWeb(res.body), counter, createWriteStream(tmpPath, { flags })).catch(async (err) => {
      if (isCancelled()) {
        await rm(tmpPath, { force: true }).catch(() => {});
        await rm(etagPath, { force: true }).catch(() => {});
      }
      throw err;
    });

    // A body that ends cleanly (no stream error) short of the advertised
    // total is a truncation, not a success — without a published digest to
    // catch it (the HF LoRA path has none), a short file would otherwise be
    // renamed into place and treated as a complete, selectable model. Keep
    // the partial (and its etag) so the next attempt can still resume it.
    if (total > 0 && received !== total) {
      throw new ServerError(
        `Download ended early: got ${received} of ${total} expected bytes for ${destPath}`,
        { status: 502, code: 'DOWNLOAD_TRUNCATED', context: { destPath, received, total } },
      );
    }

    const check = await verifyDownloadHash(tmpPath, expectedSha256);
    if (!check.ok) {
      await rm(tmpPath, { force: true }).catch(() => {});
      await rm(etagPath, { force: true }).catch(() => {});
      throw hashMismatchError(destPath, check);
    }

    if (finalize) {
      await rename(tmpPath, destPath);
      await rm(etagPath, { force: true }).catch(() => {});
    }
    return { bytes: received || total, tmpPath, resumed: resumeFrom > 0 };
  } finally {
    clearIdleTimer();
  }
}

function rejectDownloadStatus(res) {
  if (res.status === 401 || res.status === 403) {
    throw new ServerError(
      `Download rejected (${res.status})`,
      { status: res.status, code: 'DOWNLOAD_AUTH' },
    );
  }
  throw new ServerError(
    `Download failed: ${res.status} ${res.statusText || ''}`.trim(),
    { status: 502, code: 'DOWNLOAD_FAILED' },
  );
}
