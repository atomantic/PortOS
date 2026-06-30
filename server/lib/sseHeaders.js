// The canonical Server-Sent-Events response headers, in their own dependency-free
// module so any SSE producer can share them without dragging in a heavier module's
// transitive imports. (sseDownload.js — the other natural home — imports the
// HuggingFace download stack, so importing SSE_HEADERS from there would load all of
// that into every consumer; sseUtils.js and its ~15 pipeline/editorial routes must
// stay light.)

export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  // Disable proxy (nginx) response buffering so frames reach the client as they
  // are written rather than being held until the buffer fills — without this an
  // SSE stream behind a reverse proxy appears to hang.
  'X-Accel-Buffering': 'no',
};
