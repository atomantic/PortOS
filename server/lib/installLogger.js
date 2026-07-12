// Server-console visibility for install / environment-setup SSE flows. The
// runtime installers that spawn `setup-image-video.sh` (music + video gen) and
// the FLUX.2 venv bootstrap stream multi-GB pip/git progress to the browser via
// the SSE `send()` channel ONLY — a headless / PM2 log had no record the install
// ever ran. This is the install-side analogue of
// `sseDownload.js#startHfDownloadStream` (which closed the same gap for HF model
// downloads): a single chokepoint that logs a START line, coarse throttled
// heartbeats + stage milestones, and the OUTCOME (success / fail / cancel) —
// NOT every raw pip/bash line (that would flood the console from a hot loop).
//
// Usage: create one logger per install request, call `start()` at spawn, feed
// every SSE event through `onEvent(ev)` (it auto-detects terminal `complete` /
// `error` events and logs the outcome), and call `cancel()` on client
// disconnect. `success()` / `failure()` are terminal reconcilers for install
// flows that resolve without emitting a terminal SSE event.

// How long a hot log/progress stream may run before the console emits a single
// "still installing" heartbeat. Keeps a multi-minute pip download visible in
// the server log without echoing every line.
const HEARTBEAT_MS = 15000;

export function createInstallLogger({ installer, target } = {}) {
  const name = installer || 'install';
  const suffix = target ? ` (${target})` : '';
  const startedAt = Date.now();
  let started = false;
  let finished = false;
  let lastHeartbeat = 0;
  let lineCount = 0;

  const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;

  // These methods run inside child-process stdout/stderr and promise callbacks
  // that live OUTSIDE the Express request lifecycle — an uncaught throw there
  // crashes the Node process (no `next(err)` to bubble to). Wrap every hook body.
  const safe = (fn) => {
    try { fn(); }
    catch (err) { console.error(`❌ Install logger error (${name}): ${err.message}`); }
  };

  const finish = (ok, message) => {
    if (finished) return;
    finished = true;
    if (ok) {
      console.log(`✅ Install complete: ${name}${suffix} in ${elapsed()}${message ? ` — ${message}` : ''}`);
    } else {
      console.error(`❌ Install failed: ${name}${suffix} after ${elapsed()}${message ? ` — ${message}` : ''}`);
    }
  };

  const start = () => safe(() => {
    if (started) return;
    started = true;
    lastHeartbeat = Date.now();
    console.log(`🔧 Install starting: ${name}${target ? ` → ${target}` : ''}`);
  });

  const onEvent = (ev) => safe(() => {
    if (!started || finished || !ev || typeof ev !== 'object') return;
    if (ev.type === 'complete') { finish(true, ev.message); return; }
    if (ev.type === 'error') { finish(false, ev.message); return; }
    if (ev.type === 'stage' && ev.stage) {
      console.log(`🔧 ${name}: ${ev.stage}${ev.message ? ` — ${ev.message}` : ''} (${elapsed()})`);
      return;
    }
    // Raw log/progress lines: count them but surface only a throttled heartbeat
    // so a hot pip/bash stream doesn't flood the server console.
    lineCount += 1;
    const now = Date.now();
    if (now - lastHeartbeat >= HEARTBEAT_MS) {
      lastHeartbeat = now;
      console.log(`⏳ ${name} installing…${suffix} (${lineCount} lines, ${elapsed()})`);
    }
  });

  const success = (message) => safe(() => finish(true, message));
  const failure = (message) => safe(() => finish(false, message));
  const cancel = () => safe(() => {
    if (finished) return;
    finished = true;
    console.log(`🛑 Install cancelled: ${name}${suffix} after ${elapsed()}`);
  });

  return { start, onEvent, success, failure, cancel };
}
