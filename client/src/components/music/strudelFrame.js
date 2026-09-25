/**
 * The sandboxed players behind the Music Designer's "Code" engine (CodePanel).
 *
 * The LLM writes the track as Strudel or Tone.js code, and that code is
 * arbitrary JavaScript. It never runs in the PortOS origin. The panel mounts
 * `buildStrudelFrameDoc()` or `buildToneFrameDoc()` as the `srcdoc` of an
 * `<iframe sandbox="allow-scripts">` (no `allow-same-origin`), so the frame has
 * an opaque origin: no PortOS cookies, storage, or DOM. Both documents' CSP
 * adds `connect-src 'none'`, so code in the frame can't call the PortOS API
 * (which sends no CORS restrictions) or anything else over fetch, XHR,
 * WebSocket, or beacon. The only script either may load is its own pinned
 * bundle, checked against its SRI hash. Strudel is AGPL-3.0, so it is fetched
 * at runtime from the CDN rather than vendored into this repository; Tone.js
 * is MIT but is fetched the same way for one consistent, auditable path.
 *
 * Protocol (postMessage; every message carries `source: CODE_FRAME_SOURCE`,
 * shared by both frame documents):
 *   panel → frame  { type: 'play', code } · { type: 'stop' }
 *                  { type: 'record', code, seconds }
 *   frame → panel  { type: 'ready' }
 *                  { type: 'state', state: 'playing' | 'stopped' | 'recording' | 'blocked' }
 *                  { type: 'error', message }
 *                  { type: 'progress', seconds }       while recording
 *                  { type: 'recorded', wav, durationSec }  wav: a transferred ArrayBuffer
 *
 * Recording taps the frame's audio graph. Before either bundle loads, the
 * frame wraps `AudioNode.prototype.connect` so every connection into an
 * AudioContext's destination is mirrored into a capture node. That node
 * collects real-time PCM, and the frame encodes it as a 16-bit stereo WAV.
 * The tap works for any Web Audio library, which is what lets the same
 * bootstrap serve both Strudel and Tone.js without change.
 */

export const STRUDEL_VERSION = '1.3.0';
export const STRUDEL_BUNDLE_URL = `https://cdn.jsdelivr.net/npm/@strudel/web@${STRUDEL_VERSION}/dist/index.js`;
// sha384 of STRUDEL_BUNDLE_URL. Bump it together with STRUDEL_VERSION.
export const STRUDEL_BUNDLE_INTEGRITY = 'sha384-Be7toEZy01lox8utUZEOBM2nCd1jVX8R9A3YwfZ7j5kBTv/MKy+LlCbTWqE97W8x';

export const TONE_VERSION = '15.5.42';
export const TONE_BUNDLE_URL = `https://cdn.jsdelivr.net/npm/tone@${TONE_VERSION}/build/Tone.js`;
// sha384 of TONE_BUNDLE_URL. Bump it together with TONE_VERSION.
export const TONE_BUNDLE_INTEGRITY = 'sha384-rpNzF3PRX6H+JanjHDJjUnsohhGj57xP3C6y5EZqp7BC7RBHSzYPW7NHGl0hPrul';

export const CODE_FRAME_SOURCE = 'portos-code-frame';

// Both frame documents share this policy shape. Scripts may run (and `eval`,
// which Strudel's transpiler needs and Tone.js code is run through; `data:`
// covers Strudel's bundled AudioWorklet modules), but nothing may reach the
// network except the one pinned bundle for that language.
const buildFrameCsp = (bundleUrl) => [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' data: ${bundleUrl}`,
  "style-src 'unsafe-inline'",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

const FRAME_CSP = buildFrameCsp(STRUDEL_BUNDLE_URL);
const TONE_FRAME_CSP = buildFrameCsp(TONE_BUNDLE_URL);

// Runs inside the frame BEFORE the bundle, so the destination tap is in place
// before Strudel builds its audio graph. Kept as plain ES2020 source text.
const FRAME_BOOTSTRAP = `
(() => {
  'use strict';
  const SOURCE = ${JSON.stringify(CODE_FRAME_SOURCE)};
  const post = (msg, transfer) => parent.postMessage({ source: SOURCE, ...msg }, '*', transfer || []);
  const origConnect = AudioNode.prototype.connect;
  const taps = new WeakMap();
  let capture = null;

  const tapFor = (ctx) => {
    let tap = taps.get(ctx);
    if (tap) return tap;
    tap = ctx.createGain();
    const proc = ctx.createScriptProcessor(4096, 2, 2);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    origConnect.call(tap, proc);
    origConnect.call(proc, mute);
    origConnect.call(mute, ctx.destination);
    proc.onaudioprocess = (event) => {
      if (!capture || capture.ctx !== ctx) return;
      const input = event.inputBuffer;
      const n = Math.min(input.length, capture.limit - capture.frames);
      if (n <= 0) return;
      capture.left.push(input.getChannelData(0).slice(0, n));
      capture.right.push(input.getChannelData(input.numberOfChannels > 1 ? 1 : 0).slice(0, n));
      capture.frames += n;
    };
    taps.set(ctx, tap);
    return tap;
  };

  AudioNode.prototype.connect = function connect(destination, ...rest) {
    const result = origConnect.call(this, destination, ...rest);
    if (destination instanceof AudioDestinationNode) origConnect.call(this, tapFor(destination.context), rest[0] || 0);
    return result;
  };

  window.__portosCapture = {
    post,
    start(ctx, seconds) {
      tapFor(ctx);
      capture = { ctx, left: [], right: [], frames: 0, limit: Math.round(seconds * ctx.sampleRate) };
      return capture;
    },
    cancel() { capture = null; },
    finish() {
      const done = capture;
      capture = null;
      return done;
    },
  };
})();
`;

// Runs after the bundle: boots Strudel and answers the panel's messages.
const FRAME_CONTROLLER = `
(() => {
  'use strict';
  const { post, start, cancel, finish } = window.__portosCapture;
  const statusEl = document.getElementById('status');
  const unlockEl = document.getElementById('unlock');
  const show = (text) => { statusEl.textContent = text; };
  const messageOf = (err) => String((err && err.message) || err || 'Unknown error').slice(0, 600);
  let failed = false;
  const fail = (err) => {
    failed = true;
    const message = messageOf(err);
    show('Error: ' + message);
    post({ type: 'error', message });
  };
  const setState = (state) => { post({ type: 'state', state }); };

  window.addEventListener('error', (event) => fail(event.error || event.message));
  window.addEventListener('unhandledrejection', (event) => fail(event.reason));
  // Strudel reports scheduler and sound errors through its logger, not by throwing.
  document.addEventListener('strudel.log', (event) => {
    const detail = event.detail || {};
    if (detail.type === 'error' || /\\berror\\b/i.test(String(detail.message || ''))) fail(detail.message);
  });

  const lib = window.strudel;
  if (!lib || typeof lib.initStrudel !== 'function') {
    fail('Could not load the Strudel engine from cdn.jsdelivr.net. Check the network connection and reload.');
    return;
  }

  let recording = null;
  const ready = lib.initStrudel({
    onEvalError: fail,
    onToggle: (started) => { if (!recording) setState(started ? 'playing' : 'stopped'); },
  });

  // Browsers only start audio after a gesture INSIDE this frame (the parent's
  // click doesn't count everywhere). When the context stays suspended, ask for
  // one click here and replay the pending action.
  let pending = null;
  const audioRunning = async () => {
    const ctx = lib.getAudioContext();
    if (ctx.state !== 'running') {
      await Promise.race([ctx.resume().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 800))]);
    }
    return ctx.state === 'running';
  };
  const whenAudible = async (action) => {
    await ready;
    if (await audioRunning()) return action();
    pending = action;
    unlockEl.hidden = false;
    show('Click here to allow audio');
    setState('blocked');
    return undefined;
  };
  unlockEl.addEventListener('click', () => {
    lib.getAudioContext().resume().then(() => {
      unlockEl.hidden = true;
      const action = pending;
      pending = null;
      if (action) action();
    }, fail);
  });

  const evaluate = async (code) => {
    failed = false;
    await lib.evaluate(code, true);
    return !failed;
  };

  const stopRecording = () => {
    if (!recording) return;
    clearInterval(recording.timer);
    recording = null;
    cancel();
  };

  const play = (code) => whenAudible(async () => {
    stopRecording();
    show('Playing');
    if (!(await evaluate(code))) { lib.hush(); setState('stopped'); }
  });

  const stop = () => {
    pending = null;
    unlockEl.hidden = true;
    stopRecording();
    lib.hush();
    show('Stopped');
    setState('stopped');
  };

  const encodeWav = (take) => {
    const frames = take.frames;
    const buffer = new ArrayBuffer(44 + frames * 4);
    const view = new DataView(buffer);
    const text = (offset, value) => { for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i)); };
    const rate = take.ctx.sampleRate;
    text(0, 'RIFF'); view.setUint32(4, 36 + frames * 4, true); text(8, 'WAVE');
    text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 4, true); view.setUint16(32, 4, true); view.setUint16(34, 16, true);
    text(36, 'data'); view.setUint32(40, frames * 4, true);
    let offset = 44;
    let peak = 0;
    for (let c = 0; c < take.left.length; c += 1) {
      const left = take.left[c];
      const right = take.right[c];
      for (let i = 0; i < left.length; i += 1) {
        const l = Math.max(-1, Math.min(1, left[i]));
        const r = Math.max(-1, Math.min(1, right[i]));
        peak = Math.max(peak, Math.abs(l), Math.abs(r));
        view.setInt16(offset, l < 0 ? l * 0x8000 : l * 0x7fff, true);
        view.setInt16(offset + 2, r < 0 ? r * 0x8000 : r * 0x7fff, true);
        offset += 4;
      }
    }
    return { buffer, peak };
  };

  const record = (code, seconds) => whenAudible(async () => {
    stopRecording();
    lib.hush();
    const ctx = lib.getAudioContext();
    const take = start(ctx, seconds);
    const startedAt = Date.now();
    recording = { timer: 0 };
    setState('recording');
    show('Recording');
    if (!(await evaluate(code))) { stopRecording(); lib.hush(); setState('stopped'); return; }
    if (!recording) return;
    recording.timer = setInterval(() => {
      post({ type: 'progress', seconds: take.frames / ctx.sampleRate });
      const stalled = Date.now() - startedAt > (seconds + 15) * 1000;
      if (take.frames < take.limit && !stalled) return;
      clearInterval(recording.timer);
      recording = null;
      lib.hush();
      const done = finish();
      if (stalled || !done || done.frames === 0) { fail('The recording stalled before it finished. Try again.'); setState('stopped'); return; }
      const { buffer, peak } = encodeWav(done);
      if (peak < 0.0005) { fail('The code played only silence, so there is nothing to save.'); setState('stopped'); return; }
      show('Recorded');
      post({ type: 'recorded', wav: buffer, durationSec: done.frames / ctx.sampleRate }, [buffer]);
      setState('stopped');
    }, 250);
  });

  window.addEventListener('message', (event) => {
    if (event.source !== parent) return;
    const msg = event.data || {};
    if (msg.type === 'stop') { stop(); return; }
    const code = typeof msg.code === 'string' ? msg.code : '';
    if (!code.trim()) { fail('There is no code to run.'); return; }
    if (msg.type === 'play') play(code).catch(fail);
    else if (msg.type === 'record') record(code, Math.max(1, Math.min(600, Number(msg.seconds) || 30))).catch(fail);
  });

  ready.then(() => { show('Ready'); post({ type: 'ready' }); }, fail);
})();
`;

/** The complete `srcdoc` for the sandboxed Strudel player frame. */
export function buildStrudelFrameDoc() {
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">
<style>
  html, body { margin: 0; height: 100%; background: transparent; color: #9ca3af; font: 12px/1.4 ui-sans-serif, system-ui, sans-serif; }
  body { display: flex; align-items: center; gap: 8px; padding: 0 8px; overflow: hidden; }
  #status { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #unlock { font: inherit; padding: 4px 10px; border-radius: 6px; border: 1px solid #6b7280; background: #1f2937; color: #fff; cursor: pointer; }
</style></head>
<body>
<button id="unlock" type="button" hidden>Enable audio</button>
<span id="status">Loading Strudel ${STRUDEL_VERSION}…</span>
<script>${FRAME_BOOTSTRAP}</script>
<script src="${STRUDEL_BUNDLE_URL}" integrity="${STRUDEL_BUNDLE_INTEGRITY}" crossorigin="anonymous"></script>
<script>${FRAME_CONTROLLER}</script>
</body></html>`;
}

// Runs after the Tone.js bundle: boots the LLM's code and answers the panel's
// messages the same way FRAME_CONTROLLER does for Strudel. Tone has no
// built-in "reset everything" call, so each run re-evaluates against a fresh
// `Tone.Transport` state and disposes every node the PREVIOUS run created —
// tracked by wrapping constructor access on `Tone` in a Proxy, never by
// recreating the AudioContext (that would orphan the one `Tone.Transport`
// singleton the LLM's code is told to use).
const TONE_FRAME_CONTROLLER = `
(() => {
  'use strict';
  const { post, start, cancel, finish } = window.__portosCapture;
  const statusEl = document.getElementById('status');
  const unlockEl = document.getElementById('unlock');
  const show = (text) => { statusEl.textContent = text; };
  const messageOf = (err) => String((err && err.message) || err || 'Unknown error').slice(0, 600);
  const fail = (err) => {
    const message = messageOf(err);
    show('Error: ' + message);
    post({ type: 'error', message });
  };
  const setState = (state) => { post({ type: 'state', state }); };

  window.addEventListener('error', (event) => fail(event.error || event.message));
  window.addEventListener('unhandledrejection', (event) => fail(event.reason));

  const Tone = window.Tone;
  if (!Tone || typeof Tone.getTransport !== 'function') {
    fail('Could not load the Tone.js engine from cdn.jsdelivr.net. Check the network connection and reload.');
    return;
  }

  // Every instance the sandboxed code constructs through this proxy is
  // tracked so the NEXT run can dispose it; property access that is not a
  // "new"-able class (functions, Transport, getContext, ...) passes through.
  const created = new Set();
  const ctorProxies = new WeakMap();
  const trackedTone = new Proxy(Tone, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== 'function' || typeof value.prototype?.dispose !== 'function') return value;
      let proxy = ctorProxies.get(value);
      if (!proxy) {
        proxy = new Proxy(value, {
          construct(ctor, args, newTarget) {
            const instance = Reflect.construct(ctor, args, newTarget);
            created.add(instance);
            return instance;
          },
        });
        ctorProxies.set(value, proxy);
      }
      return proxy;
    },
  });

  const disposePrevious = () => {
    for (const instance of created) { try { instance.dispose(); } catch (err) { /* already disposed */ } }
    created.clear();
  };

  const resetTransport = () => {
    const transport = Tone.getTransport();
    transport.stop(0);
    transport.cancel(0);
    transport.position = 0;
  };

  // Browsers only start audio after a gesture INSIDE this frame (the parent's
  // click doesn't count everywhere). When the context stays suspended, ask for
  // one click here and replay the pending action.
  let pending = null;
  const audioRunning = async () => {
    const ctx = Tone.getContext().rawContext;
    if (ctx.state !== 'running') {
      await Promise.race([Tone.start().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 800))]);
    }
    return Tone.getContext().rawContext.state === 'running';
  };
  const whenAudible = async (action) => {
    if (await audioRunning()) return action();
    pending = action;
    unlockEl.hidden = false;
    show('Click here to allow audio');
    setState('blocked');
    return undefined;
  };
  unlockEl.addEventListener('click', () => {
    Tone.start().then(() => {
      unlockEl.hidden = true;
      const action = pending;
      pending = null;
      if (action) action();
    }, fail);
  });

  let recording = null;
  const stopRecording = () => {
    if (!recording) return;
    clearInterval(recording.timer);
    recording = null;
    cancel();
  };

  const evaluate = (code) => {
    disposePrevious();
    resetTransport();
    try {
      // eslint-disable-next-line no-new-func -- runs the LLM's code against the Tone global only.
      new Function('Tone', code)(trackedTone);
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  };

  const play = (code) => whenAudible(async () => {
    stopRecording();
    show('Playing');
    if (!evaluate(code)) { resetTransport(); setState('stopped'); return; }
    setState('playing');
  });

  const stop = () => {
    pending = null;
    unlockEl.hidden = true;
    stopRecording();
    resetTransport();
    show('Stopped');
    setState('stopped');
  };

  const encodeWav = (take) => {
    const frames = take.frames;
    const buffer = new ArrayBuffer(44 + frames * 4);
    const view = new DataView(buffer);
    const text = (offset, value) => { for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i)); };
    const rate = take.ctx.sampleRate;
    text(0, 'RIFF'); view.setUint32(4, 36 + frames * 4, true); text(8, 'WAVE');
    text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 4, true); view.setUint16(32, 4, true); view.setUint16(34, 16, true);
    text(36, 'data'); view.setUint32(40, frames * 4, true);
    let offset = 44;
    let peak = 0;
    for (let c = 0; c < take.left.length; c += 1) {
      const left = take.left[c];
      const right = take.right[c];
      for (let i = 0; i < left.length; i += 1) {
        const l = Math.max(-1, Math.min(1, left[i]));
        const r = Math.max(-1, Math.min(1, right[i]));
        peak = Math.max(peak, Math.abs(l), Math.abs(r));
        view.setInt16(offset, l < 0 ? l * 0x8000 : l * 0x7fff, true);
        view.setInt16(offset + 2, r < 0 ? r * 0x8000 : r * 0x7fff, true);
        offset += 4;
      }
    }
    return { buffer, peak };
  };

  const record = (code, seconds) => whenAudible(async () => {
    stopRecording();
    resetTransport();
    const ctx = Tone.getContext().rawContext;
    const take = start(ctx, seconds);
    const startedAt = Date.now();
    recording = { timer: 0 };
    setState('recording');
    show('Recording');
    if (!evaluate(code)) { stopRecording(); resetTransport(); setState('stopped'); return; }
    if (!recording) return;
    recording.timer = setInterval(() => {
      post({ type: 'progress', seconds: take.frames / ctx.sampleRate });
      const stalled = Date.now() - startedAt > (seconds + 15) * 1000;
      if (take.frames < take.limit && !stalled) return;
      clearInterval(recording.timer);
      recording = null;
      resetTransport();
      const done = finish();
      if (stalled || !done || done.frames === 0) { fail('The recording stalled before it finished. Try again.'); setState('stopped'); return; }
      const { buffer, peak } = encodeWav(done);
      if (peak < 0.0005) { fail('The code played only silence, so there is nothing to save.'); setState('stopped'); return; }
      show('Recorded');
      post({ type: 'recorded', wav: buffer, durationSec: done.frames / ctx.sampleRate }, [buffer]);
      setState('stopped');
    }, 250);
  });

  window.addEventListener('message', (event) => {
    if (event.source !== parent) return;
    const msg = event.data || {};
    if (msg.type === 'stop') { stop(); return; }
    const code = typeof msg.code === 'string' ? msg.code : '';
    if (!code.trim()) { fail('There is no code to run.'); return; }
    if (msg.type === 'play') play(code).catch(fail);
    else if (msg.type === 'record') record(code, Math.max(1, Math.min(600, Number(msg.seconds) || 30))).catch(fail);
  });

  show('Ready');
  post({ type: 'ready' });
})();
`;

/** The complete `srcdoc` for the sandboxed Tone.js player frame. */
export function buildToneFrameDoc() {
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${TONE_FRAME_CSP}">
<style>
  html, body { margin: 0; height: 100%; background: transparent; color: #9ca3af; font: 12px/1.4 ui-sans-serif, system-ui, sans-serif; }
  body { display: flex; align-items: center; gap: 8px; padding: 0 8px; overflow: hidden; }
  #status { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #unlock { font: inherit; padding: 4px 10px; border-radius: 6px; border: 1px solid #6b7280; background: #1f2937; color: #fff; cursor: pointer; }
</style></head>
<body>
<button id="unlock" type="button" hidden>Enable audio</button>
<span id="status">Loading Tone.js ${TONE_VERSION}…</span>
<script>${FRAME_BOOTSTRAP}</script>
<script src="${TONE_BUNDLE_URL}" integrity="${TONE_BUNDLE_INTEGRITY}" crossorigin="anonymous"></script>
<script>${TONE_FRAME_CONTROLLER}</script>
</body></html>`;
}
