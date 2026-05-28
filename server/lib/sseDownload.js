// Shared SSE driver for HF-repo pre-download endpoints. Image gen and video
// gen both expose `GET /…/models/:id/download` (and video also a separate
// `/text-encoder/download`); without this helper each route open-codes the
// same `writeHead → send → cache-check → in-flight check → spawn → cleanup`
// flow. A single in-flight Map keyed by repo also dedupes across routes:
// FLUX-family repos referenced by both image and video gen would otherwise
// spawn two concurrent children.

import { inspectModelCache } from './hfCache.js';
import { downloadHfRepo } from './hfDownload.js';

const inFlight = new Map(); // repo -> { promise, kill }

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
};

export async function startHfDownloadStream({ req, res, repo, alreadyDownloadedMessage }) {
  res.writeHead(200, SSE_HEADERS);
  const send = (event) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const safeEnd = () => { if (!res.writableEnded) res.end(); };

  // Disconnect bookkeeping wired BEFORE the cache-inspection await. The
  // inspection can take double-digit ms on a cold cache; without this the
  // client closing mid-await would land after spawn with no kill path.
  let handle = null;
  let aborted = false;
  req.on('close', () => {
    aborted = true;
    if (handle) handle.kill();
    safeEnd();
  });

  const existing = await inspectModelCache(repo);
  if (aborted) return;
  if (existing.cached) {
    send({ type: 'complete', message: alreadyDownloadedMessage || `${repo} already downloaded.`, repo, sizeBytes: existing.sizeBytes });
    return safeEnd();
  }
  if (inFlight.has(repo)) {
    send({ type: 'error', message: `Another download for ${repo} is already running.`, kind: 'already_running' });
    return safeEnd();
  }

  handle = downloadHfRepo({ repo, onEvent: send });
  inFlight.set(repo, handle);
  handle.promise.finally(() => {
    inFlight.delete(repo);
    safeEnd();
  });
}
