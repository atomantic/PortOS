// Shared SSE driver for HF-repo pre-download endpoints. Image gen and video
// gen both expose `GET /…/models/:id/download` (and video also a separate
// `/text-encoder/download`); without this helper each route open-codes the
// same `writeHead → send → cache-check → in-flight check → spawn → cleanup`
// flow. A single in-flight Map keyed by repo also dedupes across routes:
// FLUX-family repos referenced by both image and video gen would otherwise
// spawn two concurrent children.

import { inspectModelCache } from './hfCache.js';
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

export async function startHfDownloadStream({ req, res, repo, repos, alreadyDownloadedMessage, force = false }) {
  // Caller passes either `repo` (single string, legacy callers) OR `repos`
  // (ordered array, used when a model has auxiliary repos that must be
  // present alongside the main weights — e.g. HiDream's separate Llama-3.1
  // text encoder). Multi-repo runs are sequential and short-circuit on any
  // single-repo error.
  const targets = Array.isArray(repos)
    ? repos.filter((r) => typeof r === 'string' && r.length > 0)
    : (typeof repo === 'string' && repo.length > 0 ? [repo] : []);
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
  req.on('close', () => {
    aborted = true;
    if (currentHandle) currentHandle.kill();
    safeEnd();
  });

  let downloadedAny = false;
  let totalSize = 0;
  for (let i = 0; i < targets.length; i += 1) {
    const r = targets[i];
    if (aborted) return;
    const existing = await inspectModelCache(r);
    if (aborted) return;
    // `force` is set by a repair-initiated re-download: repairModelCache()
    // deleted the corrupt file(s), but for a multi-shard repo the remaining
    // shards still make inspectModelCache() report `cached` — so skipping here
    // would leave the just-deleted shard missing and never re-fetched. Forcing
    // re-runs the HF fetch, which is a cheap no-op for files already present
    // (etag match) and pulls only what's gone.
    if (existing.cached && !force) {
      totalSize += existing.sizeBytes || 0;
      send({ type: 'log', message: `${r} already cached (${existing.sizeBytes} bytes).`, repo: r, sizeBytes: existing.sizeBytes });
      continue;
    }
    if (inFlight.has(r)) {
      send({ type: 'error', message: `Another download for ${r} is already running.`, kind: 'already_running', repo: r });
      return safeEnd();
    }
    const handle = downloadHfRepo({ repo: r, onEvent: (ev) => send({ ...ev, repo: r }) });
    currentHandle = handle;
    inFlight.set(r, handle);
    try {
      await handle.promise;
      downloadedAny = true;
    } finally {
      inFlight.delete(r);
      currentHandle = null;
    }
  }

  if (!aborted) {
    let message;
    if (targets.length === 1) {
      // Preserve legacy single-repo `complete` message semantics: if it was
      // already cached on entry, surface the caller's `alreadyDownloadedMessage`
      // (or the default already-downloaded line).
      message = !downloadedAny
        ? (alreadyDownloadedMessage || `${targets[0]} already downloaded.`)
        : `${targets[0]} downloaded.`;
    } else {
      message = downloadedAny
        ? `Downloaded ${targets.length} repos: ${targets.join(', ')}`
        : `All ${targets.length} repos already cached: ${targets.join(', ')}`;
    }
    send({ type: 'complete', message, repos: targets, sizeBytes: totalSize });
  }
  safeEnd();
}
