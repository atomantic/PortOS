import { killWithEscalation } from '../../lib/killWithEscalation.js';

// These owned browsers render on explicit seek(t), not wall/display time.
// Chromium's display scheduler must not pace a song-length offline capture.
// Background flags match Playwright's standard Chromium launch posture.
// --mute-audio: compositions embed audio, and an unmuted test browser plays it
// through the developer's real speakers.
export function _testChromeCaptureArgs(profile) {
  return [
    '--headless=new', '--mute-audio', '--no-sandbox', '--no-first-run', '--disable-background-networking',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', '--disable-frame-rate-limit',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ];
}

// Chrome writes its CDP address to stderr. Keep only a bounded tail and report
// known failure categories: raw stderr can contain the user's profile path.
export function _waitForTestChrome(proc, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    let timer;
    const diagnostic = () => {
      const categories = [
        ['sandbox', /sandbox/i],
        ['profile in use', /profile.*(?:in use|lock)|ProcessSingleton/i],
        ['permission denied', /permission denied|EACCES/i],
        ['missing file or library', /not found|ENOENT|shared librar/i],
        ['disk full', /no space left|ENOSPC/i],
        ['crashpad', /crashpad/i],
      ].filter(([, pattern]) => pattern.test(stderr)).map(([name]) => name);
      return categories.length ? `; stderr: ${categories.join(', ')}` : stderr ? '; Chrome emitted stderr' : '; no stderr';
    };
    const cleanup = () => {
      clearTimeout(timer);
      proc.removeListener('error', onError);
      proc.removeListener('exit', onExit);
      proc.stderr.removeListener('data', onData);
    };
    const finish = (value, error) => {
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const onData = bytes => {
      stderr = (stderr + bytes.toString()).slice(-8192);
      // Wait for the terminating newline: a stream chunk can end mid-URL.
      const match = stderr.match(/(?:^|\n)DevTools listening on (ws:\/\/[^\r\n]+)\r?\n/);
      if (match) finish(match[1]);
    };
    const onError = error => {
      const code = /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : 'spawn error';
      finish(null, new Error(`Test Chrome failed to spawn (${code}${diagnostic()})`));
    };
    const onExit = (code, signal) => finish(null, new Error(
      `Test Chrome exited before startup (code ${Number.isInteger(code) ? code : 'none'}, signal ${/^[A-Z0-9]{1,32}$/.test(signal) ? signal : 'none'}${diagnostic()})`,
    ));
    proc.once('error', onError);
    proc.once('exit', onExit);
    proc.stderr.on('data', onData);
    timer = setTimeout(() => finish(null, new Error(`Test Chrome did not start within ${timeoutMs}ms${diagnostic()}`)), timeoutMs);
    if (proc.exitCode !== null || proc.signalCode !== null) onExit(proc.exitCode, proc.signalCode);
  });
}

async function withinDeadline(action, timeoutMs, stage) {
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Test Chrome ${stage} exceeded ${timeoutMs}ms deadline`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function terminateOwnedChrome(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  let escalation;
  let onExit;
  // Subscribe before kill. Wait for exit, not stdio close: Chrome descendants
  // can retain stderr after the owned process has terminated.
  const exited = new Promise(resolve => {
    onExit = resolve;
    proc.once('exit', onExit);
  });
  try {
    await withinDeadline(() => {
      escalation = killWithEscalation(proc, {
        label: 'HTML composition test Chrome',
        stillRunning: () => proc.exitCode === null && proc.signalCode === null,
        delayMs: 3000,
      });
      return exited;
    }, 10000, 'child termination');
  } finally {
    clearTimeout(escalation);
    proc.removeListener('exit', onExit);
  }
}

// Test-only lifecycle boundary. Disconnect failure must not strand the owned
// child, and neither failure may prevent removal of temporary test data.
export async function _cleanupTestBrowser({ browser, proc, cleanup }) {
  const errors = [];
  try {
    await withinDeadline(() => browser?.close(), 5000, 'browser disconnect').catch(error => errors.push(error));
    await terminateOwnedChrome(proc).catch(error => errors.push(error));
  } finally {
    proc?.stderr?.destroy();
    await cleanup();
  }
  if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join('; '));
}

// Wrap the REAL encoder only in browser tests. Never print paths, page source,
// process stderr or job IDs: a bounded numeric snapshot suffices to separate
// steady capture from a stuck seek, screenshot, pipe write or encoder drain.
export function _withTestCaptureDiagnostics(encode, { logIntervalMs = 15000, stallMs = 30000, getTestSignal } = {}) {
  return async (page, contract, outputPath, options = {}) => {
    const started = Date.now();
    let phase = 'setup';
    let phaseStarted = started;
    let lastProgress = started;
    let lastLog = started;
    let frame = 0;
    const frames = Math.round(contract.durationSec * contract.fps);
    const timings = { setup: 0, seek: 0, capture: 0, encode: 0 };
    const controller = new AbortController();
    const signal = AbortSignal.any([options.signal, getTestSignal?.(), controller.signal].filter(Boolean));
    const enter = next => {
      const now = Date.now();
      timings[phase] += now - phaseStarted;
      phase = next;
      phaseStarted = now;
      lastProgress = now;
    };
    const snapshot = () => {
      const now = Date.now();
      const totals = { ...timings, [phase]: timings[phase] + now - phaseStarted };
      return `phase=${phase} frames=${frame}/${frames} elapsedMs=${now - started} idleMs=${now - lastProgress} `
        + Object.entries(totals).map(([name, ms]) => `${name}Ms=${ms}`).join(' ');
    };
    const timer = setInterval(() => {
      const now = Date.now();
      if (now - lastProgress >= stallMs) {
        const error = new Error(`Test Chrome capture stalled; ${snapshot()}`);
        console.error(`❌ ${error.message}`);
        // The encoder's existing abort/close boundary terminates only its own
        // ffmpeg child. Existing CDP deadlines settle pending browser commands.
        controller.abort(error);
        clearInterval(timer);
      } else if (now - lastLog >= logIntervalMs) {
        console.log(`🎞️ Test Chrome capture progress; ${snapshot()}`);
        lastLog = now;
      }
    }, Math.min(1000, logIntervalMs, stallMs));
    timer.unref?.();
    const roundTrip = async (next, action) => {
      signal.throwIfAborted();
      enter(next);
      const result = await action();
      // A late response after the test deadline must never start another
      // capture or launch an encoder with an already-aborted signal.
      signal.throwIfAborted();
      enter('encode');
      return result;
    };
    const tracedPage = {
      ...page,
      check() { signal.throwIfAborted(); page.check(); },
      evaluate(...args) {
        return roundTrip(String(args[0]).startsWith('globalThis.portosComposition.seek(') ? 'seek' : 'setup', () => page.evaluate(...args));
      },
      send(...args) {
        return roundTrip(args[0] === 'Page.captureScreenshot' ? 'capture' : 'setup', () => page.send(...args));
      },
    };
    try {
      const result = await encode(tracedPage, contract, outputPath, {
        ...options,
        signal,
        onProgress(fraction, detail) {
          frame = detail?.frame ?? Math.round(fraction * frames);
          lastProgress = Date.now();
          options.onProgress?.(fraction, detail);
        },
      });
      signal.throwIfAborted();
      console.log(`🎞️ Test Chrome capture complete; ${snapshot()}`);
      return result;
    } catch (error) {
      console.error(`❌ Test Chrome capture failed; ${snapshot()}`);
      throw error;
    } finally {
      clearInterval(timer);
    }
  };
}
