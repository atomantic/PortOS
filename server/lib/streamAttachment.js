/**
 * `streamAttachment(res,stream,{filename,contentType,failure,label})`.
 *
 * pipe a readable to a response as a file download, for `routes/imageTo3d.js` (GLB, full-mesh, USDZ) and `routes/backup.js` (snapshot tarball).
 *
 * Sets the attachment headers plus `X-Content-Type-Options:nosniff` and owns the shared teardown: a pre-stream failure drops the download headers and returns `failure` via `sendErrorResponse`, a mid-stream failure destroys the socket (the envelope no-ops once headers are sent), and a client disconnect calls `stream.abort?.()` so an upstream child process is torn down.
 */

import { sendErrorResponse } from './errorHandler.js';
import { onClientDisconnect } from './sseDownload.js';

// A tar/child-backed stream exposes abort() to kill its process; a plain file read has none, and without destroy() its fd stays open for every abandoned download.
function teardown(stream) {
  if (typeof stream.abort === 'function') stream.abort();
  else stream.destroy();
}

/**
 * Pipe a readable to an Express response as a file attachment. The error handling is why this is shared: the 'error' event fires OUTSIDE the asyncHandler promise chain, so a throw there would crash the process and must go through sendErrorResponse (shared envelope + headers-sent guard);
 * pre-stream failures (the common case: the file vanished after the readiness check) get the JSON envelope, mid-stream failures tear the socket down (sendErrorResponse no-ops once headers are sent).
 *
 * @param {import('express').Response} res
 * @param {import('stream').Readable} stream - piped to res; may expose an
 *   `abort()` used to tear down an upstream child process on disconnect.
 * @param {object} opts
 * @param {string} opts.filename - offered to the browser as the download name.
 * @param {string} opts.contentType
 * @param {import('./errorHandler.js').ServerError} opts.failure - the error
 *   returned when the stream fails before any bytes are written.
 * @param {string} opts.label - short subject for the warning log.
 * @param {'attachment'|'inline'} [opts.disposition] - defaults to `attachment`.
 *   Pass `inline` for a format whose whole point is that the OS handler opens it
 *   in place rather than landing in Downloads (USDZ / AR Quick Look): Safari will
 *   not engage Quick Look on an `attachment` response.
 */
export function streamAttachment(res, stream, {
  filename, contentType, failure, label, disposition = 'attachment',
}) {
  stream.on('error', (err) => {
    if (res.destroyed || res.writableEnded) return; // Cancellation can emit an error during teardown.
    console.warn(`⚠️ ${label} stream error: ${err.code || err.message}`);
    if (res.headersSent) {
      res.destroy(err);
      return;
    }
    // Drop the download headers so the JSON error body isn't offered to the
    // browser as an attachment named like a real file.
    res.removeHeader('Content-Type');
    res.removeHeader('Content-Disposition');
    sendErrorResponse(res, failure);
  });

  // The route awaited settings/stat first, so the client may already be gone: 'close' fired before the listener below was installed and nothing would tear the stream down.
  if (res.destroyed || res.writableEnded) {
    teardown(stream);
    return;
  }

  res.set('Content-Type', contentType);
  // Quote the filename at the boundary rather than trusting callers to have slugged it (a quote or newline in a record-derived name would break out of the header).
  const safeName = String(filename).replace(/[^\w.-]+/g, '_') || 'download';
  res.set('Content-Disposition', `${disposition}; filename="${safeName}"`);
  // Attachments are never meant to be sniffed into an executable type.
  res.set('X-Content-Type-Options', 'nosniff');

  onClientDisconnect(null, res, () => teardown(stream));
  stream.pipe(res);
}
