/**
 * The Beeper attachment byte mirror (#37, decided on #13).
 *
 * **Lazy.** Ingestion (#32) writes the attachment's METADATA and its durable
 * `mxc_id` reference; the bytes arrive only when a human actually opens the
 * thread that shows them. A mirrored account's attachment history runs to
 * gigabytes, so "fetch everything on ingest" is a transfer nobody asked for —
 * the same reasoning root AGENTS.md applies to unbidden LLM calls, applied to
 * bytes. The bulk backfill exists, but it is a user action behind a consent
 * step that names the count and the size first.
 *
 * **Content-addressed, so deletion is never a one-liner.** Files live at
 * `data/beeper/attachments/<sha256[0..2]>/<sha256>.<ext>`
 * (`lib/beeperAttachmentPaths.js`), which means one photo forwarded into four
 * chats is one file and four rows. Every unlink path here therefore asks
 * "does any OTHER row still point at this path?" first — the shape
 * `chatgptImport.js` uses for its shared import assets.
 *
 * **A 502 is terminal, and it is also a keep.** `GET /v1/assets/serve` answers
 * `502` for media the source network has aged out, which `beeperClient` maps
 * to `ASSET_UNAVAILABLE`. Two consequences, and they pull in opposite
 * directions on purpose: the row is stamped `unavailable_at` so nothing
 * re-requests it on every render (the retry loop #13 called out), and a row
 * already holding bytes is exempted from eviction, because a file Beeper can
 * no longer supply is the last copy in existence.
 *
 * Nothing here ever sends anything through a messaging API.
 */

import { createHash, randomUUID } from 'crypto';
import { createWriteStream } from 'fs';
import { mkdir, link, rename, rm, readdir, stat, unlink } from 'fs/promises';
import { dirname, join } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { query } from '../lib/db.js';
import { ServerError } from '../lib/errorHandler.js';
import { PATHS, pathExists } from '../lib/fileUtils.js';
import {
  BEEPER_ATTACHMENT_MAX_BYTES,
  attachmentExtension,
  attachmentRelativePath,
  isSafeAttachmentRelativePath,
} from '../lib/beeperAttachmentPaths.js';
import { getSettings } from './settings.js';
import { fetchAssetStream, headAsset } from './beeperClient.js';

const BYTES_PER_GB = 1024 * 1024 * 1024;
const DEFAULT_BUDGET_GB = 5;
// Partial downloads land in their own subdirectory rather than beside the
// finished files: the store is enumerated by the orphan backstop and by the
// Data Manager, and a half-written `.partial` sitting in a hash-prefix dir
// would read as a corrupt mirror entry to both.
const TMP_DIR_NAME = '.tmp';
// A partial older than this is from a process that is no longer running: an
// in-flight transfer is abandoned after `STREAM_IDLE_TIMEOUT_MS` without a
// chunk, so nothing legitimate is still writing an hour-old `.partial`.
const TMP_MAX_AGE_MS = 60 * 60 * 1000;
// The stall guard for the BODY. `fetchWithTimeout`'s own budget covers only the
// response headers — it clears its abort timer once `fetch` resolves — so a
// source that answers and then goes silent mid-transfer would otherwise hold a
// half-written file and its socket open indefinitely. This timer is reset on
// every chunk, so it bounds SILENCE rather than the transfer: a slow but
// progressing 32 MiB download is never cut off, and a dead one is.
const STREAM_IDLE_TIMEOUT_MS = 60_000;
// One sweep evicts at most this many files. Each eviction costs a HEAD against
// Beeper Desktop, and a budget cut from 50 GB to 1 GB should not turn into a
// thousand-request burst inside one tick — the next sweep continues.
const MAX_EVICTIONS_PER_SWEEP = 50;

export const attachmentsRoot = () => PATHS.beeperAttachments;
const tmpRoot = () => join(attachmentsRoot(), TMP_DIR_NAME);

const notFound = () => new ServerError('Attachment not found', { status: 404, code: 'NOT_FOUND' });

const toIso = (value) => (value ? new Date(value).toISOString() : null);

/**
 * The client-facing shape of one attachment row.
 *
 * `stored` / `unavailable` / `overCap` are three separate booleans rather than
 * one status string because the surface renders three different things from
 * them and they are not mutually exclusive: an over-cap attachment that a user
 * fetched anyway is `stored: true, overCap: true`, and an unavailable one may
 * still be `stored: true` when the bytes landed before the source aged out.
 */
export function shapeAttachment(row) {
  const byteLength = row.byte_length === null || row.byte_length === undefined ? null : Number(row.byte_length);
  return {
    conversationId: row.conversation_id,
    messageId: row.message_id,
    idx: Number(row.idx) || 0,
    mxcId: row.mxc_id || null,
    mimeType: row.mime_type || '',
    fileName: row.file_name || '',
    byteLength,
    width: row.width === null || row.width === undefined ? null : Number(row.width),
    height: row.height === null || row.height === undefined ? null : Number(row.height),
    stored: Boolean(row.local_path),
    keep: row.keep === true,
    lastViewedAt: toIso(row.last_viewed_at),
    fetchedAt: toIso(row.fetched_at),
    unavailable: Boolean(row.unavailable_at),
    unavailableReason: row.fetch_error || null,
    // A KNOWN size over the ceiling. An unknown size (`null`) is deliberately
    // not over-cap: the HEAD pre-flight is what decides that case, and
    // rendering a placeholder for every attachment whose size the bridge
    // declined to report would hide most of the mirror behind a click.
    overCap: byteLength !== null && byteLength > BEEPER_ATTACHMENT_MAX_BYTES,
    maxBytes: BEEPER_ATTACHMENT_MAX_BYTES,
  };
}

async function loadRow(messageId, idx) {
  const result = await query(
    `SELECT * FROM beeper_attachments WHERE message_id = $1 AND idx = $2`,
    [messageId, Number(idx)],
  );
  return result?.rows?.[0] || null;
}

/** One attachment's current mirror state, or `null` when the id is unknown. */
export async function getAttachment(messageId, idx) {
  const row = await loadRow(messageId, idx);
  return row ? shapeAttachment(row) : null;
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

async function resolveBudgetBytes() {
  const settings = await getSettings().catch(() => null);
  const configured = Number(settings?.beeper?.attachmentBudgetGb);
  const gb = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_BUDGET_GB;
  return Math.round(gb * BYTES_PER_GB);
}

/**
 * Bytes on disk, counted per DISTINCT `local_path`. Counting per ROW would
 * multiply a forwarded photo by the number of chats it landed in and report a
 * mirror several times its real size — the same dedupe that makes deletion
 * need a reference check makes accounting need a DISTINCT.
 */
async function storedBytes() {
  const result = await query(
    `SELECT COALESCE(SUM(byte_length), 0)::bigint AS bytes, COUNT(*)::int AS files
       FROM (
         SELECT DISTINCT ON (local_path) local_path, byte_length
           FROM beeper_attachments
          WHERE local_path IS NOT NULL
       ) unique_files`,
  );
  const row = result?.rows?.[0] || {};
  return { bytes: Number(row.bytes) || 0, files: Number(row.files) || 0 };
}

/**
 * What the bulk-backfill consent modal has to name before it runs, plus the
 * disk picture the settings card renders.
 *
 * `pendingUnknownBytes` is its own count on purpose: an attachment whose
 * `byte_length` the bridge never reported cannot be added to `pendingBytes`,
 * and folding it in as zero would let the modal promise "42 MB" for a transfer
 * that is actually unbounded (root AGENTS.md, absent-vs-empty).
 */
export async function getAttachmentSummary() {
  const [budgetBytes, stored, counts] = await Promise.all([
    resolveBudgetBytes(),
    storedBytes(),
    query(
      `SELECT
         COUNT(*) FILTER (WHERE local_path IS NULL AND unavailable_at IS NULL AND mxc_id IS NOT NULL
                            AND (byte_length IS NULL OR byte_length <= $1))::int AS pending,
         COALESCE(SUM(byte_length) FILTER (WHERE local_path IS NULL AND unavailable_at IS NULL AND mxc_id IS NOT NULL
                            AND byte_length IS NOT NULL AND byte_length <= $1), 0)::bigint AS pending_bytes,
         COUNT(*) FILTER (WHERE local_path IS NULL AND unavailable_at IS NULL AND mxc_id IS NOT NULL
                            AND byte_length IS NULL)::int AS pending_unknown,
         COUNT(*) FILTER (WHERE byte_length > $1)::int AS over_cap,
         COUNT(*) FILTER (WHERE unavailable_at IS NOT NULL)::int AS unavailable,
         COUNT(*) FILTER (WHERE keep = TRUE)::int AS kept,
         COUNT(*)::int AS total
       FROM beeper_attachments`,
      [BEEPER_ATTACHMENT_MAX_BYTES],
    ),
  ]);
  const row = counts?.rows?.[0] || {};
  return {
    budgetBytes,
    usedBytes: stored.bytes,
    storedFiles: stored.files,
    pendingCount: Number(row.pending) || 0,
    pendingBytes: Number(row.pending_bytes) || 0,
    pendingUnknownCount: Number(row.pending_unknown) || 0,
    overCapCount: Number(row.over_cap) || 0,
    unavailableCount: Number(row.unavailable) || 0,
    keptCount: Number(row.kept) || 0,
    totalCount: Number(row.total) || 0,
    maxBytes: BEEPER_ATTACHMENT_MAX_BYTES,
  };
}

// ---------------------------------------------------------------------------
// Acquisition
// ---------------------------------------------------------------------------

const tooLarge = (bytes) => new ServerError(
  `Attachment is ${bytes} bytes, over the ${BEEPER_ATTACHMENT_MAX_BYTES}-byte mirror ceiling`,
  { status: 413, code: 'ATTACHMENT_TOO_LARGE', context: { bytes, maxBytes: BEEPER_ATTACHMENT_MAX_BYTES } },
);

/**
 * Stream one asset to disk, hashing as it goes, and finalize it into its
 * content-addressed home.
 *
 * The shape is `loras.js`'s `downloadToFile`: web stream → byte-counting
 * transform → `.partial` → atomic no-clobber `link()` finalize. The two
 * deltas are both consequences of content addressing — the destination is not
 * known until the last byte is hashed, and an `EEXIST` on the link is a
 * SUCCESS here (another row already mirrored these exact bytes) rather than
 * `loras`' "already installed" conflict.
 *
 * The cap is enforced mid-stream as well as at the HEAD, because a bridge that
 * declines to report `Content-Length` would otherwise get an unbounded write
 * past a ceiling the pre-flight could not see.
 */
async function streamAssetToStore(mxcId, { maxBytes, extension }) {
  // Abort on SILENCE, not on elapsed time — see STREAM_IDLE_TIMEOUT_MS. The
  // controller is handed to the client so the abort tears down the live socket,
  // not just this side's reader. `abort()` cannot throw, which matters because
  // the timer fires outside the request lifecycle.
  const controller = new AbortController();
  let idleTimer = null;
  const clearIdle = () => { if (idleTimer) clearTimeout(idleTimer); idleTimer = null; };
  const armIdle = () => {
    clearIdle();
    idleTimer = setTimeout(() => controller.abort(), STREAM_IDLE_TIMEOUT_MS);
    idleTimer.unref?.();
  };
  armIdle();

  const response = await fetchAssetStream(mxcId, { signal: controller.signal })
    .catch((err) => { clearIdle(); throw err; });
  // A 200 with no body at all: `Readable.fromWeb(null)` would throw a bare
  // TypeError from inside the store, which tells the surface nothing.
  if (!response.body) {
    clearIdle();
    throw new ServerError('Beeper returned no body for this attachment', {
      status: 502, code: 'ATTACHMENT_DOWNLOAD_FAILED',
    });
  }
  await mkdir(tmpRoot(), { recursive: true });
  const tmpPath = join(tmpRoot(), `${randomUUID()}.partial`);

  const hash = createHash('sha256');
  let received = 0;
  let exceeded = false;
  const counter = async function* counter(source) {
    for await (const chunk of source) {
      armIdle();
      received += chunk.length;
      if (received > maxBytes) {
        exceeded = true;
        // Abort the transfer rather than draining a file we have already
        // decided to refuse.
        throw tooLarge(received);
      }
      hash.update(chunk);
      yield chunk;
    }
  };

  const failure = await pipeline(
    Readable.fromWeb(response.body),
    counter,
    createWriteStream(tmpPath),
  ).then(() => null).catch((err) => err);
  clearIdle();

  if (failure) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw exceeded ? failure : new ServerError(
      `Attachment download failed: ${failure.message}`,
      { status: 502, code: 'ATTACHMENT_DOWNLOAD_FAILED' },
    );
  }

  const sha256 = hash.digest('hex');
  const relativePath = attachmentRelativePath(sha256, extension);
  const destPath = join(attachmentsRoot(), relativePath);
  await mkdir(dirname(destPath), { recursive: true });

  // `link` is atomic and fails with EEXIST rather than clobbering — which for
  // a content-addressed store means the bytes are already mirrored under
  // another row and this download was redundant, not a conflict.
  const linkError = await link(tmpPath, destPath).catch((err) => err);
  if (!linkError) {
    await unlink(tmpPath).catch(() => {});
    return { sha256, relativePath, bytes: received };
  }
  if (linkError.code === 'EEXIST') {
    await rm(tmpPath, { force: true }).catch(() => {});
    return { sha256, relativePath, bytes: received, deduped: true };
  }
  // EXDEV or a filesystem without hard links: rename is the portable fallback.
  const renameError = await rename(tmpPath, destPath).catch((err) => err);
  if (renameError) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw new ServerError(`Could not store attachment: ${renameError.message}`, {
      status: 500, code: 'ATTACHMENT_STORE_FAILED',
    });
  }
  return { sha256, relativePath, bytes: received };
}

async function markUnavailable(row, message) {
  await query(
    `UPDATE beeper_attachments
        SET unavailable_at = NOW(), fetch_error = $3, updated_at = NOW()
      WHERE message_id = $1 AND idx = $2`,
    [row.message_id, row.idx, String(message || '').slice(0, 500)],
  );
}

/**
 * Ensure one attachment's bytes are on disk and return where they are.
 *
 * `force` is the "fetch anyway" action from the over-cap placeholder, and it
 * is the ONLY thing that lifts the ceiling or retries a source that previously
 * refused. Every automatic path — a thread render, the backfill, the sweep —
 * runs without it, which is what keeps an aged-out attachment from being
 * re-requested on every paint.
 */
export async function ensureAttachmentBytes(messageId, idx, { force = false } = {}) {
  const row = await loadRow(messageId, idx);
  if (!row) throw notFound();

  if (row.local_path && isSafeAttachmentRelativePath(row.local_path)) {
    const filePath = join(attachmentsRoot(), row.local_path);
    if (await pathExists(filePath)) {
      await query(
        `UPDATE beeper_attachments SET last_viewed_at = NOW() WHERE message_id = $1 AND idx = $2`,
        [row.message_id, row.idx],
      );
      return { filePath, mimeType: row.mime_type || '', fileName: row.file_name || '', cached: true };
    }
    // The row claims bytes the disk no longer has (a Data Manager purge, a
    // restore from a backup that excluded them). Heal the row rather than
    // 404ing, then fall through and re-acquire.
    await query(
      `UPDATE beeper_attachments SET local_path = NULL, fetched_at = NULL, updated_at = NOW()
        WHERE message_id = $1 AND idx = $2`,
      [row.message_id, row.idx],
    );
  }

  if (!row.mxc_id) {
    throw new ServerError('Attachment has no source reference to fetch', {
      status: 404, code: 'ASSET_UNAVAILABLE',
    });
  }
  if (row.unavailable_at && !force) {
    throw new ServerError(row.fetch_error || 'Beeper can no longer supply this attachment', {
      status: 404, code: 'ASSET_UNAVAILABLE',
    });
  }

  const maxBytes = force ? Number.POSITIVE_INFINITY : BEEPER_ATTACHMENT_MAX_BYTES;
  const head = await headAsset(row.mxc_id).catch(async (err) => {
    if (err?.code === 'ASSET_UNAVAILABLE') await markUnavailable(row, err.message);
    throw err;
  });
  if (head.bytes !== null && head.bytes > maxBytes) {
    // Persist the size the HEAD just reported before refusing. Beeper does not
    // always populate `byte_length` on ingest, and an attachment whose size is
    // unknown is deliberately not `overCap` — so without this the surface
    // renders an `<img>`, takes the 413, and falls back to a generic "could not
    // load / Retry" whose retry runs with `force: true`: an unbounded download
    // behind a button that names neither the size nor the ceiling. With the
    // size stored, the next render is the real over-cap placeholder, which
    // states both.
    await query(
      `UPDATE beeper_attachments SET byte_length = $3, updated_at = NOW()
        WHERE message_id = $1 AND idx = $2`,
      [row.message_id, row.idx, head.bytes],
    );
    throw tooLarge(head.bytes);
  }

  const extension = attachmentExtension({ mimeType: row.mime_type, fileName: row.file_name });
  const stored = await streamAssetToStore(row.mxc_id, { maxBytes, extension }).catch(async (err) => {
    if (err?.code === 'ASSET_UNAVAILABLE') await markUnavailable(row, err.message);
    throw err;
  });

  // `sha256` is not persisted (audit cluster 06 decision 3): it was written
  // here but never read back — the content-addressed path is built from the
  // hash `streamAssetToStore` just computed, not from this column. The VALUE
  // stays in `stored.sha256` / `stored.relativePath` for that path; only the
  // column write goes.
  await query(
    `UPDATE beeper_attachments
        SET local_path = $3, byte_length = $4,
            fetched_at = NOW(), last_viewed_at = NOW(),
            unavailable_at = NULL, fetch_error = NULL, updated_at = NOW()
      WHERE message_id = $1 AND idx = $2`,
    [row.message_id, row.idx, stored.relativePath, stored.bytes],
  );
  console.log(`🫧 Beeper attachment mirrored: ${stored.bytes} bytes for message ${row.message_id}#${row.idx}${stored.deduped ? ' (deduped)' : ''}`);
  return {
    filePath: join(attachmentsRoot(), stored.relativePath),
    mimeType: row.mime_type || '',
    fileName: row.file_name || '',
    cached: false,
    // Whether this fetch's bytes were already on disk under another row
    // (`link()`'s EEXIST) — `backfillAttachments` uses it to adjust its
    // running byte total without re-querying the DISTINCT-on-`local_path`
    // total after every attachment.
    deduped: stored.deduped === true,
  };
}

/**
 * The per-attachment `keep` lock — the `useLockToggle` shape (#13): an
 * optimistic PATCH that exempts one attachment from least-recently-viewed
 * eviction forever, for the photo a user does not want the budget to decide
 * about.
 */
export async function setAttachmentKeep(messageId, idx, keep) {
  const result = await query(
    `UPDATE beeper_attachments SET keep = $3, updated_at = NOW()
      WHERE message_id = $1 AND idx = $2
      RETURNING *`,
    [messageId, Number(idx), keep === true],
  );
  const row = result?.rows?.[0];
  if (!row) throw notFound();
  return shapeAttachment(row);
}

// ---------------------------------------------------------------------------
// Bulk backfill (a USER action — the route gates it behind consent)
// ---------------------------------------------------------------------------

/**
 * Mirror the attachments that are still reference-only, oldest first.
 *
 * Sequential by construction. Beeper Desktop is one local process that may
 * itself be pulling each file off the network, and a parallel fan-out of a
 * few thousand requests is how a backfill turns into an outage of the app the
 * user is reading their messages in.
 *
 * Individual failures are COUNTED, not thrown: an aged-out attachment in the
 * middle of a 3,000-file run must not abandon the other 2,999, and each one
 * is stamped `unavailable_at` on the way past so the next run skips it.
 *
 * The running byte total is computed ONCE for the whole pass, then adjusted
 * in memory as bytes land — not re-queried before every attachment.
 * `storedBytes()` is a `DISTINCT ON (local_path)` scan of the full table, and
 * re-running it per attachment turned an N-attachment backfill into N scans of
 * a mirror that can hold tens of thousands of rows. `ensureAttachmentBytes`'s
 * `deduped` flag keeps the in-memory total exact: a fetch that lands on bytes
 * another row already mirrored (`link()`'s EEXIST) adds nothing to disk usage,
 * the same DISTINCT-on-`local_path` accounting `storedBytes()` itself does.
 */
export async function backfillAttachments({ limit = 500 } = {}) {
  const budgetBytes = await resolveBudgetBytes();
  const pending = await query(
    `SELECT message_id, idx FROM beeper_attachments
      WHERE local_path IS NULL AND unavailable_at IS NULL AND mxc_id IS NOT NULL
        AND (byte_length IS NULL OR byte_length <= $1)
      ORDER BY created_at ASC
      LIMIT $2`,
    [BEEPER_ATTACHMENT_MAX_BYTES, Math.max(1, Math.min(Number(limit) || 500, 5000))],
  );

  let used = (await storedBytes()).bytes;

  let fetched = 0;
  let failed = 0;
  let bytes = 0;
  let stoppedForBudget = false;
  for (const row of pending?.rows || []) {
    if (used >= budgetBytes) {
      stoppedForBudget = true;
      break;
    }
    const result = await ensureAttachmentBytes(row.message_id, row.idx)
      .then((value) => ({ value }))
      .catch((err) => ({ err }));
    if (result.err) {
      failed += 1;
      continue;
    }
    fetched += 1;
    const stat_ = await stat(result.value.filePath).catch(() => null);
    const size = stat_?.size || 0;
    bytes += size;
    if (!result.value.deduped) used += size;
  }
  console.log(`🫧 Beeper attachment backfill: ${fetched} mirrored, ${failed} unavailable${stoppedForBudget ? ', stopped at budget' : ''}`);
  return { fetched, failed, bytes, stoppedForBudget, requested: (pending?.rows || []).length };
}

// ---------------------------------------------------------------------------
// Eviction, orphan backstop, purge
// ---------------------------------------------------------------------------

/**
 * Drop one row's claim on its bytes, unlinking the file only when no OTHER row
 * still points at it (content addressing means several usually do).
 * @returns {Promise<{ removed: boolean, bytes: number, failed: boolean }>}
 */
async function releaseRowBytes(row) {
  const relativePath = row.local_path;
  await query(
    `UPDATE beeper_attachments SET local_path = NULL, fetched_at = NULL, updated_at = NOW()
      WHERE message_id = $1 AND idx = $2`,
    [row.message_id, row.idx],
  );
  return unlinkIfUnreferenced(relativePath);
}

/**
 * Unlink one stored file if — and only if — the reference check run RIGHT NOW
 * says nothing points at it. The freshness is the contract: every caller here
 * decided a file was unreferenced at some earlier point, and a dedupe fetch
 * landing on these exact bytes through `link()`'s EEXIST in between would leave
 * the row that just claimed them saying `stored: true` against a deleted file.
 *
 * `removed` is its own field rather than "bytes > 0" because a legitimately
 * empty file reclaims nothing and is still gone. `failed` is its own field
 * because a swallowed unlink error is the worst of the three outcomes: the row
 * has already given up its claim, so the bytes stay on disk with nothing left
 * pointing at them, counting against a budget that has just been told they were
 * reclaimed. ENOENT is not a failure — the file is gone, which is the outcome
 * asked for, and there are no bytes left to under-report.
 * @returns {Promise<{ removed: boolean, bytes: number, failed: boolean }>}
 */
async function unlinkIfUnreferenced(relativePath) {
  const untouched = { removed: false, bytes: 0, failed: false };
  if (!relativePath || !isSafeAttachmentRelativePath(relativePath)) return untouched;
  const others = await query(
    `SELECT 1 FROM beeper_attachments WHERE local_path = $1 LIMIT 1`,
    [relativePath],
  );
  if (others?.rows?.length) return untouched;
  const filePath = join(attachmentsRoot(), relativePath);
  const info = await stat(filePath).catch(() => null);
  const failure = await unlink(filePath).then(() => null).catch((err) => err);
  if (!failure) return { removed: true, bytes: info?.size || 0, failed: false };
  if (failure.code === 'ENOENT') return untouched;
  console.error(`❌ Beeper attachment unlink failed for ${relativePath}: ${failure.message}`);
  return { removed: false, bytes: 0, failed: true };
}

/**
 * Evict least-recently-viewed attachments until the mirror fits its budget.
 *
 * The guard is the part that matters: before evicting, HEAD the source. A
 * `502` means Beeper can no longer supply the file, so the local copy is the
 * only one left — it is KEPT regardless of age and stamped `unavailable_at`,
 * which also takes it out of every subsequent candidate query rather than
 * re-probing it each sweep.
 */
export async function evictToBudget() {
  const budgetBytes = await resolveBudgetBytes();
  let used = (await storedBytes()).bytes;
  if (used <= budgetBytes) return { evicted: 0, reclaimedBytes: 0, keptUnavailable: 0, overBudget: false };

  let evicted = 0;
  let reclaimedBytes = 0;
  let keptUnavailable = 0;
  let failedUnlinks = 0;
  for (let attempt = 0; attempt < MAX_EVICTIONS_PER_SWEEP && used > budgetBytes; attempt += 1) {
    const candidates = await query(
      // `mxc_id IS NOT NULL` is part of the eviction RULE, not an optimisation:
      // eviction is only ever safe because the file can be fetched again, and a
      // row with no source reference is precisely the one that could not be.
      // Filtering in the query (rather than skipping in the loop) also keeps
      // the loop from re-selecting the same unevictable row forever.
      `SELECT message_id, idx, mxc_id, local_path, byte_length
         FROM beeper_attachments
        WHERE local_path IS NOT NULL AND keep = FALSE AND unavailable_at IS NULL
          AND mxc_id IS NOT NULL
        ORDER BY last_viewed_at ASC NULLS FIRST, fetched_at ASC NULLS FIRST
        LIMIT 1`,
    );
    const row = candidates?.rows?.[0];
    if (!row) break;

    const probe = await headAsset(row.mxc_id).then(() => null).catch((err) => err);
    if (probe?.code === 'ASSET_UNAVAILABLE') {
      await markUnavailable(row, probe.message);
      keptUnavailable += 1;
      continue;
    }
    // Any other probe failure (Beeper closed, a transport blip) is not
    // evidence the file is re-fetchable, so this sweep stops rather than
    // evicting on an unanswered question.
    if (probe) break;

    // `freed` is 0 when the unlink failed, so the reclaimed total never counts
    // bytes that are still on disk — and `used` does not drop either, which is
    // what keeps the loop from believing it has made room it has not made.
    const { bytes: freed, failed } = await releaseRowBytes(row);
    evicted += 1;
    if (failed) failedUnlinks += 1;
    reclaimedBytes += freed;
    used -= freed;
  }
  if (evicted > 0 || keptUnavailable > 0) {
    console.log(`🧹 Beeper attachment eviction: ${evicted} evicted, ${reclaimedBytes} bytes reclaimed, ${keptUnavailable} kept (source can no longer supply), ${failedUnlinks} unlink failure(s)`);
  }
  return { evicted, reclaimedBytes, keptUnavailable, failedUnlinks, overBudget: used > budgetBytes };
}

/**
 * Every file in the store, plus whether the listing actually COMPLETED.
 *
 * "The store could not be read" and "the store is empty" are the same value to
 * a `catch(() => [])` — and the row-healing half of the sweep below clears
 * `local_path` for every referenced path it did not see, so one EACCES on the
 * root, or a data volume that came back unmounted, would unlink every mirrored
 * row in the install from its bytes in a single pass. The `complete` flag is
 * the sentinel that keeps the two apart (root AGENTS.md, absent-vs-empty).
 *
 * A PARTIAL listing counts as incomplete for the same reason: a prefix
 * directory that cannot be read hides real files exactly as effectively as an
 * unreadable root does.
 */
async function listStoredFiles() {
  const root = attachmentsRoot();
  const prefixes = await readdir(root, { withFileTypes: true }).catch((err) => err);
  if (!Array.isArray(prefixes)) {
    console.error(`❌ Beeper attachment store could not be listed: ${prefixes.message}`);
    return { files: [], complete: false };
  }
  const files = [];
  let complete = true;
  for (const prefix of prefixes) {
    if (!prefix.isDirectory() || prefix.name === TMP_DIR_NAME) continue;
    const entries = await readdir(join(root, prefix.name)).catch((err) => err);
    if (!Array.isArray(entries)) {
      console.error(`❌ Beeper attachment store prefix ${prefix.name} could not be listed: ${entries.message}`);
      complete = false;
      continue;
    }
    for (const name of entries) files.push(`${prefix.name}/${name}`);
  }
  return { files, complete };
}

/**
 * The orphan backstop, which is deliberately the SAME sweep as the eviction
 * (#13): a file with no row pointing at it is unreachable and would otherwise
 * count against the budget forever, and a row pointing at a file the disk no
 * longer has renders as "mirrored" and then 404s.
 *
 * Both directions get healed here, plus abandoned `.tmp` partials from a
 * process that died mid-download.
 *
 * The row-healing direction is the destructive one, and it runs ONLY on a
 * listing that completed: a store that could not be read is not an empty store,
 * and treating it as one would clear every mirrored row's `local_path` at once.
 * Orphan removal is unaffected — it only ever touches files it actually saw.
 */
export async function sweepAttachmentOrphans() {
  // Create the root before listing it. On an install that has enabled Beeper
  // but never mirrored a byte the directory does not exist yet, and THAT ENOENT
  // really is "empty"; making it once means every later listing failure is a
  // genuine anomaly worth logging and refusing to act on.
  await mkdir(attachmentsRoot(), { recursive: true }).catch(() => {});
  const { files: onDisk, complete: storeListed } = await listStoredFiles();
  const referenced = await query(
    `SELECT DISTINCT local_path FROM beeper_attachments WHERE local_path IS NOT NULL`,
  );
  const referencedSet = new Set((referenced?.rows || []).map((row) => row.local_path));

  const sweepStart = Date.now();
  let orphansRemoved = 0;
  let failedUnlinks = 0;
  for (const relativePath of onDisk) {
    if (referencedSet.has(relativePath)) continue;
    // An age gate, because a file is linked into place a moment BEFORE its row
    // is updated to point at it: a fresh unreferenced file may be a download
    // finishing right now rather than an orphan. Anything older than the asset
    // request budget cannot be.
    const info = await stat(join(attachmentsRoot(), relativePath)).catch(() => null);
    if (!info || sweepStart - info.mtimeMs < TMP_MAX_AGE_MS) continue;
    // `referencedSet` is a SNAPSHOT taken before this loop started, and the
    // mtime gate only rules out a file being written right now — not a dedupe
    // fetch that landed on this exact OLD file through `link()`'s EEXIST while
    // the loop was working through the rest of the store. Re-ask the reference
    // question immediately before the unlink, or the row that just claimed
    // these bytes is left reporting `stored: true` against a deleted file.
    const { removed, failed } = await unlinkIfUnreferenced(relativePath);
    if (removed) orphansRemoved += 1;
    if (failed) failedUnlinks += 1;
  }

  const diskSet = new Set(onDisk);
  let healedRows = 0;
  if (!storeListed) {
    console.error('❌ Beeper attachment sweep: the store did not list completely — no row healed this pass');
  } else {
    const missing = [...referencedSet].filter((relativePath) => !diskSet.has(relativePath));
    if (missing.length > 0) {
      const result = await query(
        `UPDATE beeper_attachments SET local_path = NULL, fetched_at = NULL, updated_at = NOW()
          WHERE local_path = ANY($1::text[])`,
        [missing],
      );
      healedRows = result?.rowCount || 0;
    }
  }

  const now = Date.now();
  const partials = await readdir(tmpRoot()).catch(() => []);
  let partialsRemoved = 0;
  for (const name of partials) {
    const partialPath = join(tmpRoot(), name);
    const info = await stat(partialPath).catch(() => null);
    if (!info || now - info.mtimeMs < TMP_MAX_AGE_MS) continue;
    const failure = await unlink(partialPath).then(() => null).catch((err) => err);
    if (!failure) { partialsRemoved += 1; continue; }
    if (failure.code === 'ENOENT') continue;
    console.error(`❌ Beeper attachment partial unlink failed for ${name}: ${failure.message}`);
    failedUnlinks += 1;
  }

  // The failure count rides in the log line unconditionally: bytes that a
  // failed unlink left on disk are invisible everywhere else — nothing points
  // at them any more, and they still count against the budget.
  if (orphansRemoved || healedRows || partialsRemoved || failedUnlinks) {
    console.log(`🧹 Beeper attachment sweep: ${orphansRemoved} orphan file(s), ${healedRows} stale row(s), ${partialsRemoved} abandoned partial(s), ${failedUnlinks} unlink failure(s)`);
  }
  return { orphansRemoved, healedRows, partialsRemoved, failedUnlinks, storeListed };
}

/** One scheduler tick: budget first, then the orphan backstop. */
export async function sweepBeeperAttachments() {
  const eviction = await evictToBudget();
  const orphans = await sweepAttachmentOrphans();
  // Both halves unlink, so their tallies are summed rather than shadowed by the
  // spread.
  return {
    ...eviction,
    ...orphans,
    failedUnlinks: eviction.failedUnlinks + orphans.failedUnlinks,
  };
}

/**
 * Byte cleanup for a conversation whose mirror is being purged.
 *
 * Called BEFORE the rows go, because the reference check reads them: a file is
 * unlinked only once no row outside this conversation still points at it. The
 * caller deletes the conversation row afterwards and the FK cascade takes the
 * attachment rows with it.
 */
export async function purgeConversationAttachments(conversationId) {
  const owned = await query(
    `SELECT DISTINCT local_path FROM beeper_attachments
      WHERE conversation_id = $1 AND local_path IS NOT NULL`,
    [conversationId],
  );
  const paths = (owned?.rows || []).map((row) => row.local_path);
  if (paths.length === 0) return { removedFiles: 0, freedBytes: 0, failedUnlinks: 0 };

  // Drop this conversation's claims first so the shared-reference check below
  // sees only rows that will SURVIVE the purge.
  await query(
    `UPDATE beeper_attachments SET local_path = NULL, fetched_at = NULL, updated_at = NOW()
      WHERE conversation_id = $1 AND local_path IS NOT NULL`,
    [conversationId],
  );

  let removedFiles = 0;
  let freedBytes = 0;
  let failedUnlinks = 0;
  for (const relativePath of paths) {
    const { removed, bytes, failed } = await unlinkIfUnreferenced(relativePath);
    if (failed) failedUnlinks += 1;
    if (removed) {
      removedFiles += 1;
      freedBytes += bytes;
    }
  }
  // `freedBytes` counts only files actually gone, so the purge confirmation
  // never claims disk it did not reclaim; `failedUnlinks` is how the caller
  // learns the difference is real rather than an accounting slip.
  return { removedFiles, freedBytes, failedUnlinks };
}

/** Mirrored bytes a conversation is holding — what the purge confirmation names. */
export async function getConversationAttachmentBytes(conversationId) {
  const result = await query(
    `SELECT COALESCE(SUM(byte_length), 0)::bigint AS bytes, COUNT(*)::int AS files
       FROM (
         SELECT DISTINCT ON (local_path) local_path, byte_length
           FROM beeper_attachments
          WHERE conversation_id = $1 AND local_path IS NOT NULL
       ) unique_files`,
    [conversationId],
  );
  const row = result?.rows?.[0] || {};
  return { bytes: Number(row.bytes) || 0, files: Number(row.files) || 0 };
}
