// Shared SSE driver for HF-repo pre-download endpoints. Image gen and video
// gen both expose `GET /…/models/:id/download` (and video also a separate
// `/text-encoder/download`); without this helper each route open-codes the
// same `writeHead → send → cache-check → in-flight check → spawn → cleanup`
// flow. A single in-flight Map keyed by repo also dedupes across routes:
// FLUX-family repos referenced by both image and video gen would otherwise
// spawn two concurrent children.

import { findCachedRepoFile, inspectModelCache } from './hfCache.js';
import { downloadHfRepo } from './hfDownload.js';
import { SSE_HEADERS } from './sseHeaders.js';

const inFlight = new Map(); // repo -> { promise, kill }

/**
 * Open an SSE response and return write-safe helpers. Canonical replacement
 * for the per-route `writeHead → send → safeEnd` boilerplate: `send` JSON-
 * encodes one event per frame and both helpers no-op after the response ends.
 *
 * @param {import('http').ServerResponse} res - Express/HTTP response
 * @returns {{ send: (event: object) => void, safeEnd: () => void }}
 */
export function openSseStream(res) {
  res.writeHead(200, SSE_HEADERS);
  const send = (event) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const safeEnd = () => { if (!res.writableEnded) res.end(); };
  return { send, safeEnd };
}

/**
 * Run `onDisconnect` when the CLIENT goes away mid-stream.
 *
 * Use this instead of `req.on('close', …)`. On a POST whose JSON body
 * `express.json()` has already consumed, the request is complete before the
 * handler runs (`req.complete === true`), so Node emits `'close'` on the very
 * next tick — a handler that attaches the listener before its first `await`
 * reads that as an instant client disconnect and cancels work that never
 * started. `POST /api/music/models` did exactly that: the download aborted
 * before its first frame, the stream closed empty, and the UI reported the
 * install as a success. GET routes are unaffected (nothing to consume), which
 * is why every other SSE endpoint here looked fine.
 *
 * The response is the right thing to watch: `res` `'close'` fires only when the
 * response actually closes, and `writableEnded` separates our own `safeEnd()`
 * from a genuine disconnect.
 *
 * @param {import('http').IncomingMessage} _req - unused; kept so call sites read as (req, res)
 * @param {import('http').ServerResponse} res
 * @param {() => void} onDisconnect
 */
export function onClientDisconnect(_req, res, onDisconnect) {
  res.on('close', () => {
    if (res.writableEnded) return; // we ended it — normal completion
    onDisconnect();
  });
}

export async function startHfDownloadStream({ req, res, repo, repos, fallbacks, cachedFile = null, alreadyDownloadedMessage, force = false, pythonPath = null }) {
  // Three input shapes, two semantics:
  //  - `repo` (single string) / `repos` (ordered array) — ALL must succeed. Used
  //    when a model has auxiliary repos that must be present alongside the main
  //    weights (e.g. HiDream's separate Llama-3.1 text encoder). Sequential;
  //    short-circuits on any single-repo error.
  //  - `fallbacks` (ordered array of `{ repo, only? }`) — FIRST SUCCESS wins, and
  //    a failure advances to the next entry. Used when the same file lives in
  //    several repos with different access (Ingredients: gated first-party repo,
  //    then an un-gated mirror), so a user with no HF token still succeeds.
  //
  // `only` (array of exact repo-relative filenames, per entry) forwards to the
  // helper's single-file mode — MANDATORY for aggregate repos where a snapshot is
  // catastrophic (the ~708 GB DeepBeepMeep/LTX-2 mirror).
  //
  // `ignore` (array of fnmatch globs, per entry) is the inverse: still snapshot
  // the repo, but drop paths the runtime never loads — extra checkpoint formats
  // or a bundled sibling model. Ignored when `only` is set for the same entry.
  //
  // `cachedFile` is the "is it already here?" predicate for a single-file pull:
  // `inspectModelCache` reports the whole repo cached as soon as ANY weight is
  // resident, which for an aggregate mirror is true after the first unrelated
  // file — so the generic already-cached short-circuit would skip a weight the
  // user doesn't have. Callers pass an async `() => boolean` that checks the one
  // file instead.
  const normalizeOnly = (v) => (Array.isArray(v) ? v.filter((f) => typeof f === 'string' && f.length > 0) : []);
  const normalizeRevision = (v) => (typeof v === 'string' && v.length > 0 ? v : null);
  const normalizeTarget = (target) => {
    if (typeof target === 'string' && target.length > 0) return { repo: target, only: [], ignore: [], revision: null };
    if (!target || typeof target.repo !== 'string' || target.repo.length === 0) return null;
    return {
      repo: target.repo,
      only: normalizeOnly(target.only),
      ignore: normalizeOnly(target.ignore),
      revision: normalizeRevision(target.revision),
    };
  };
  const firstSuccessWins = Array.isArray(fallbacks);
  const targets = (firstSuccessWins ? fallbacks : (Array.isArray(repos) ? repos : [repo]))
    .map(normalizeTarget)
    .filter(Boolean);
  const { send, safeEnd } = openSseStream(res);

  if (targets.length === 0) {
    send({ type: 'error', message: 'No repo specified for download.' });
    return safeEnd();
  }

  // Disconnect bookkeeping wired BEFORE the cache-inspection await. The
  // inspection can take double-digit ms on a cold cache; without this the
  // client closing mid-await would land after spawn with no kill path.
  let currentHandle = null;
  let aborted = false;
  onClientDisconnect(req, res, () => {
    aborted = true;
    // Only a live handle means a download was mid-flight, so this keeps the
    // cancel line out of the log when the client simply navigated away between
    // repos.
    if (currentHandle) {
      console.log(`🛑 HuggingFace download cancelled (client disconnect)`);
      currentHandle.kill();
    }
    safeEnd();
  });

  let downloadedAny = false;
  let totalSize = 0;
  // Only meaningful in first-success-wins mode: which repo actually delivered,
  // and the per-attempt failures to report if none did.
  let succeededRepo = null;
  const attemptErrors = [];
  for (let i = 0; i < targets.length; i += 1) {
    const { repo: r, only: onlyFiles, ignore: ignorePatterns, revision } = targets[i];
    const isLastTarget = i === targets.length - 1;
    if (aborted) return;
    // For a single-file pull the repo-wide cache verdict is both the wrong
    // question AND too expensive to ask: `inspectModelCache` recursively stats
    // every weight in the snapshot, and an aggregate mirror reports `cached` off
    // any unrelated resident file — so it would skip the file the user actually
    // asked for after walking hundreds of GB to get there. Skip the walk entirely
    // and defer to the caller's per-file predicate.
    const singleFile = onlyFiles.length > 0;
    const existing = singleFile
      ? { cached: false, sizeBytes: 0 }
      : await inspectModelCache(r, { revision });
    if (aborted) return;
    const alreadyHave = singleFile
      ? (typeof cachedFile === 'function'
        ? await cachedFile({ repo: r, only: onlyFiles, revision })
        : (await Promise.all(onlyFiles.map((file) => findCachedRepoFile(r, file, { revision })))).every(Boolean))
      : existing.cached;
    if (aborted) return;
    // `force` is set by a repair-initiated re-download: repairModelCache()
    // deleted the corrupt file(s), but for a multi-shard repo the remaining
    // shards still make inspectModelCache() report `cached` — so skipping here
    // would leave the just-deleted shard missing and never re-fetched. Forcing
    // re-runs the HF fetch, which is a cheap no-op for files already present
    // (etag match) and pulls only what's gone.
    if (alreadyHave && !force) {
      // A single-file pull has no repo-wide total to report (we deliberately
      // never computed one) — and claiming the aggregate mirror's resident bytes
      // would be a wildly wrong number on the badge anyway. Report 0 and let the
      // badge fall back to the registry's size estimate.
      if (singleFile) {
        console.log(`📦 HuggingFace weight already cached: ${onlyFiles.join(', ')} (${r})`);
        send({ type: 'log', message: `${onlyFiles.join(', ')} already cached.`, repo: r, sizeBytes: 0 });
      } else {
        totalSize += existing.sizeBytes || 0;
        console.log(`📦 HuggingFace repo already cached: ${r} (${existing.sizeBytes} bytes)`);
        send({ type: 'log', message: `${r} already cached (${existing.sizeBytes} bytes).`, repo: r, sizeBytes: existing.sizeBytes });
      }
      // In first-success-wins mode the file being present is the whole goal —
      // don't fall through and try the mirror for something we already have.
      if (firstSuccessWins) { succeededRepo = r; break; }
      continue;
    }
    // Dedupe key includes the filenames: an aggregate repo hosts many unrelated
    // weights, so two single-file pulls of DIFFERENT files from the same repo are
    // not duplicates and must not block each other.
    const revisionKey = revision ? `@${revision}` : '';
    const flightKey = singleFile ? `${r}${revisionKey}::${onlyFiles.join(',')}` : `${r}${revisionKey}`;
    if (inFlight.has(flightKey)) {
      console.log(`⏭️  HuggingFace download already running for ${flightKey} — refusing duplicate`);
      send({ type: 'error', message: `Another download for ${r} is already running.`, kind: 'already_running', repo: r });
      return safeEnd();
    }
    // Server-side visibility for a pull that used to surface only on the SSE
    // stream (the browser) — a headless/PM2 log had no record the multi-GB
    // fetch ever ran. Log the start, each file as it streams, and the outcome.
    console.log(`⬇️  Downloading HuggingFace repo: ${r}${singleFile ? ` (${onlyFiles.length} file(s) only)` : ''}${force ? ' (forced re-fetch)' : ''}`);
    const handle = downloadHfRepo({
      repo: r,
      revision,
      only: singleFile ? onlyFiles : null,
      ignore: ignorePatterns,
      pythonPath,
      onEvent: (ev) => {
        // File-start frames only. Byte ticks arrive several times a second on
        // a large single-file pull and would drown the PM2 log.
        if (ev.type === 'progress' && ev.file && ev.downloaded == null && ev.stage !== 'verify') {
          console.log(`⬇️  ${r}: ${ev.file} (${ev.step}/${ev.total})`);
        }
        // A failure that we're about to retry against the next candidate isn't a
        // user-facing error — downgrade it to a log so the UI doesn't flash a red
        // "gated repo" banner for something the mirror then delivers fine.
        if (firstSuccessWins && ev.type === 'error') {
          send({
            type: 'log',
            message: `${r}: ${ev.message}${isLastTarget ? '' : ' — trying the next source.'}`,
            repo: r,
          });
          return;
        }
        send({ ...ev, repo: r });
      },
    });
    currentHandle = handle;
    inFlight.set(flightKey, handle);
    let result;
    try {
      result = await handle.promise;
      if (result?.ok) {
        console.log(`✅ HuggingFace download complete: ${r} (${result.sizeBytes || 0} bytes)`);
      } else if (result?.errorKind !== 'cancelled') {
        console.error(`❌ HuggingFace download failed: ${r} — ${result?.errorMessage || 'unknown error'}`);
      }
    } finally {
      inFlight.delete(flightKey);
      currentHandle = null;
    }
    if (!firstSuccessWins) {
      // ALL must succeed here — unlike the fallback-chain branch below, there
      // is no next candidate to fall through to. Silently treating a failed
      // repo as done (the prior bug) let the loop reach `complete` even
      // though one of the required repos never downloaded.
      if (!result?.ok) {
        if (result?.errorKind === 'cancelled') return safeEnd();
        send({
          type: 'error',
          kind: result?.errorKind || 'download_failed',
          message: `${r}: ${result?.errorMessage || 'unknown error'}`,
          repo: r,
        });
        return safeEnd();
      }
      downloadedAny = true;
      totalSize += result.sizeBytes || 0;
      continue;
    }
    if (result?.ok) {
      downloadedAny = true;
      succeededRepo = r;
      totalSize += result.sizeBytes || 0;
      break;
    }
    // A user cancel must not silently roll onto the next candidate.
    if (result?.errorKind === 'cancelled') return safeEnd();
    attemptErrors.push(`${r}: ${result?.errorMessage || 'unknown error'}`);
  }

  if (!aborted) {
    if (firstSuccessWins) {
      if (!succeededRepo) {
        send({
          type: 'error',
          kind: 'all_sources_failed',
          message: `Every source failed — ${attemptErrors.join('; ')}`,
        });
        return safeEnd();
      }
      send({
        type: 'complete',
        message: downloadedAny
          ? `${succeededRepo} downloaded.`
          : (alreadyDownloadedMessage || `${succeededRepo} already downloaded.`),
        repos: [succeededRepo],
        sizeBytes: totalSize,
      });
      return safeEnd();
    }
    const names = targets.map((t) => t.repo);
    let message;
    if (names.length === 1) {
      // Preserve legacy single-repo `complete` message semantics: if it was
      // already cached on entry, surface the caller's `alreadyDownloadedMessage`
      // (or the default already-downloaded line).
      message = !downloadedAny
        ? (alreadyDownloadedMessage || `${names[0]} already downloaded.`)
        : `${names[0]} downloaded.`;
    } else {
      message = downloadedAny
        ? `Downloaded ${names.length} repos: ${names.join(', ')}`
        : `All ${names.length} repos already cached: ${names.join(', ')}`;
    }
    send({ type: 'complete', message, repos: names, sizeBytes: totalSize });
  }
  safeEnd();
}
