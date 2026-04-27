// Shared helpers for the per-job SSE streams used by imageGen/local.js and
// videoGen/local.js. Both providers attach a list of `res` clients to a
// per-jobId record and broadcast diffuser progress as SSE frames; this module
// keeps the wire format and the response headers in one place.

// Filters Python child noise (HF/torch/bitsandbytes/xformers warnings, deprecation
// notices, etc.) that would otherwise drown the user's view of real progress.
export const PYTHON_NOISE_RE = /xformers|xFormers|triton|Triton|bitsandbytes|Please reinstall|Memory-efficient|Set XFORMERS|FutureWarning|UserWarning|DeprecationWarning|torch\.distributed|Unable to import.*torchao|Skipping import of cpp|NOTE: Redirects/i;

// Late-connecting EventSource clients sometimes re-attach during the brief
// window between `complete` and the route teardown. Hold the SSE list open
// for this many ms after the underlying job finishes so a client that
// connected just after the terminal broadcast still gets it (replayed from
// `job.lastPayload`) instead of hanging until timeout.
export const SSE_CLEANUP_DELAY_MS = 5000;

export const broadcastSse = (job, payload) => {
  // Cache the most recent payload on the job so attachSseClient can replay
  // it to a client that connects after this fired. Without this, a client
  // that races with `complete` would hang waiting for a frame that already
  // shipped.
  job.lastPayload = payload;
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const c of job.clients) c.write(msg);
};

export const attachSseClient = (jobs, jobId, res) => {
  const job = jobs.get(jobId);
  if (!job) return false;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  job.clients.push(res);
  // Replay the last broadcasted frame so a client that connected after a
  // `complete`/`error` (within the SSE_CLEANUP_DELAY_MS grace window) sees
  // the terminal state instead of an empty stream.
  if (job.lastPayload) {
    res.write(`data: ${JSON.stringify(job.lastPayload)}\n\n`);
  }
  res.req.on('close', () => {
    job.clients = job.clients.filter((c) => c !== res);
  });
  return true;
};

// Drains any late-connecting EventSource clients then removes the job
// from the per-provider job map. Both providers do this on child exit.
export const closeJobAfterDelay = (jobs, jobId, delay = SSE_CLEANUP_DELAY_MS) => {
  setTimeout(() => {
    const job = jobs.get(jobId);
    if (job) for (const c of job.clients) c.end();
    jobs.delete(jobId);
  }, delay);
};
