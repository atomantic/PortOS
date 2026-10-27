import WebSocket from 'ws';
import { open, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join, extname } from 'node:path';
import { PATHS } from '../../lib/fileUtils.js';
import { cdpRequest } from '../browserService.js';

const ORIGIN = 'https://composition.invalid';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };
// Sandboxing removes alternate realms, popups, forms and workers. HTTP assets
// are fulfilled below, never continued to the browser's network stack.
const CSP = "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src http: https:; font-src 'self' data:; media-src 'self'; connect-src http: https:; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

function inside(root, path) {
  const rel = relative(root, path);
  return rel && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel);
}

// Media a staged render reads from disk on request instead of holding in
// memory (a song's worth of takes and stills would not fit the 256 MiB cap).
const STREAMABLE = new Set(['.mp4', '.mov', '.webm', '.mp3', '.wav', '.png', '.jpg', '.jpeg', '.webp']);
const STREAMED_MAX_BYTES = 8 * 1024 * 1024 * 1024;
// One fulfilled range never exceeds this; the media loader asks for the rest.
const RANGE_CHUNK_BYTES = 8 * 1024 * 1024;

// Freeze the input before any script runs. Symlinks are refused, including
// symlinked assets, so the virtual origin cannot export another data store.
// `streamMedia` (a job-private staged copy only, e.g. a music-video document
// render with every scene's take) leaves video, audio and images on disk and
// serves them (by byte range when asked) on request; everything else is read
// into memory here.
export async function snapshotAssets(directory, { streamMedia = false } = {}) {
  const root = await realpath(PATHS.data);
  const dir = await realpath(resolve(root, directory));
  if (!inside(root, dir)) throw new Error('directory must be inside data');
  const assets = new Map();
  let bytes = 0;
  let streamed = 0;
  async function walk(path, prefix = '') {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error('Composition assets must not be symlinks');
      if (entry.isDirectory()) await walk(join(path, entry.name), `${name}/`);
      else if (entry.isFile()) {
        const size = (await stat(join(path, entry.name))).size;
        if (streamMedia && STREAMABLE.has(extname(entry.name).toLowerCase())) {
          streamed += size;
          if (streamed > STREAMED_MAX_BYTES || assets.size >= 4096) throw new Error('Composition media exceed 8 GiB or 4096 files');
          assets.set(`/${name}`, { path: join(path, entry.name), size });
          continue;
        }
        if (bytes + size > 256 * 1024 * 1024 || assets.size >= 4096) throw new Error('Composition assets exceed 256 MiB or 4096 files');
        const body = await readFile(join(path, entry.name));
        bytes += body.length;
        if (bytes > 256 * 1024 * 1024 || assets.size >= 4096) throw new Error('Composition assets exceed 256 MiB or 4096 files');
        assets.set(`/${name}`, body);
      } else throw new Error('Composition assets must be regular files');
    }
  }
  await walk(dir);
  if (!assets.has('/index.html')) throw new Error('directory must contain index.html');
  return assets;
}

// Events whose arrival distinguishes a closed, crashed or detached target from
// a live session that simply never answered. Only the method name is retained.
const LIFECYCLE_EVENTS = new Set([
  'Target.detachedFromTarget', 'Target.targetCrashed', 'Target.targetDestroyed', 'Inspector.detached', 'Inspector.targetCrashed',
]);

// Under the 30s per-command timer; see the document-load wait in connectComposition.
const DOCUMENT_LOAD_DEADLINE_MS = 27000;

// One browser-level socket owns a disposable context and its hidden target.
// Disconnect/abort rejects pending commands; disposeOnDetach covers crashes.
// `bytes=a-b` / `bytes=a-` / `bytes=-n` against `size`; null when absent or unsatisfiable.
function parseByteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!match || (!match[1] && !match[2])) return null;
  let start;
  let end;
  if (!match[1]) {
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  if (!(start <= end) || start >= size) return null;
  return { start, end: Math.min(end, start + RANGE_CHUNK_BYTES - 1) };
}

async function readSlice(asset, start, end) {
  if (Buffer.isBuffer(asset)) return asset.subarray(start, end + 1);
  const handle = await open(asset.path, 'r');
  try {
    const out = Buffer.alloc(end - start + 1);
    const { bytesRead } = await handle.read(out, 0, out.length, start);
    return out.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

// Forwards a bounded description of a same-window postMessage, including a
// recording blob stashed on the page. It does not fail the composition.
const PREVIEW_BRIDGE_SCRIPT = `(() => {
  addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object' || event.source !== window) return;
    if (data.blob instanceof Blob) window.__portosLastBlob = data.blob;
    let meta = null;
    if (data.meta && typeof data.meta === 'object') {
      const duration = Number(data.meta.duration);
      meta = { duration: Number.isFinite(duration) ? duration : null };
    }
    const payload = JSON.stringify({
      type: typeof data.type === 'string' ? data.type.slice(0, 80) : '',
      t: typeof data.t === 'number' && Number.isFinite(data.t) ? data.t : null,
      epoch: Number.isSafeInteger(data.epoch) && data.epoch >= 0 ? data.epoch : null,
      sequence: Number.isSafeInteger(data.sequence) && data.sequence >= 0 ? data.sequence : null,
      message: typeof data.message === 'string' ? data.message.slice(0, 300) : '',
      hasBlob: data.blob instanceof Blob,
      meta,
    }).slice(0, 2000);
    try { globalThis.__portosPreview(payload); } catch { /* binding attaches with the document */ }
  });
})();`;

// `initScripts` run in every new document before its own scripts, after the
// sandbox guards (a read-only probe such as the overlay text check).
// `isolation: 'required'` launches the OS-jailed preview browser. Render encodes
// keep the legacy owned browser.
export async function openComposition(directory, {
  signal, validateAssets, streamMedia = false, mediaMode = 'code-images-video', ownedBrowser = false, initScripts = [],
  isolation = 'legacy', contentSecurityPolicy, freezeNetworkConstructors = true, onEvent, previewBridge = false,
  refuseUnknown = 'fail', lockLoopback = false, onOwnerCleanupFailure,
} = {}) {
  const assets = await snapshotAssets(directory, { streamMedia });
  validateAssets?.(assets);
  signal?.throwIfAborted();
  const connectOptions = {
    signal, mediaMode, initScripts, contentSecurityPolicy, freezeNetworkConstructors, onEvent, previewBridge, refuseUnknown, lockLoopback,
  };
  if (ownedBrowser) {
    const { launchCompositionBrowser } = await import('./ownedBrowser.js');
    const owner = await launchCompositionBrowser({ signal, isolation, onCleanupFailure: onOwnerCleanupFailure });
    const closeOwner = async () => {
      try { await owner.close(); } catch (error) { onOwnerCleanupFailure?.(error); throw error; }
    };
    try {
      const page = await connectComposition(assets, {
        ...connectOptions,
        transport: owner.transport,
        lifecycleFacts: owner.lifecycleFacts,
        version: owner.transport
          ? { 'User-Agent': 'HeadlessChrome/' }
          : { webSocketDebuggerUrl: owner.webSocketDebuggerUrl, 'User-Agent': 'HeadlessChrome/' },
      });
      return { ...page, close: async options => {
        try { await page.close(options); } finally { await closeOwner(); }
      } };
    } catch (error) {
      await closeOwner();
      throw error;
    }
  }
  const response = await cdpRequest('/json/version');
  if (!response.ok) throw new Error('Managed browser is unavailable');
  const version = await response.json();
  return connectComposition(assets, { ...connectOptions, version });
}

async function connectComposition(assets, {
  signal, mediaMode, version, initScripts = [], transport, contentSecurityPolicy, freezeNetworkConstructors = true,
  onEvent, previewBridge = false, refuseUnknown = 'fail', lockLoopback = false, lifecycleFacts,
}) {
  const { webSocketDebuggerUrl } = version || {};
  if (!transport && !webSocketDebuggerUrl) throw new Error('Managed browser has no CDP endpoint');
  const ws = transport || new WebSocket(webSocketDebuggerUrl, { handshakeTimeout: 10000 });
  const pending = new Map();
  let nextId = 0;
  let failure;
  let contextId;
  let sessionId;
  let closing = false;
  // Failure-only evidence for a command that never answers (#12294): which
  // setup step was reached, whether the connection and session were still
  // talking, which allowlisted lifecycle events arrived and what the owned
  // child had done. Names and counters only; never params, payloads or paths.
  const startedAt = performance.now();
  const sinceStart = () => Math.round(performance.now() - startedAt);
  let phase = 'connect';
  let lastInboundMs = null;
  let lastSessionInboundMs = null;
  let transportState = 'open';
  const lifecycleEvents = new Set();
  const commandFacts = (sentMs) => {
    const owned = (() => { try { return lifecycleFacts?.() ?? {}; } catch { return { owner: 'unreadable' }; } })();
    const facts = {
      phase, sentMs, timeoutMs: sinceStart(),
      context: contextId ? 'created' : 'none', session: sessionId ? 'attached' : 'none',
      transport: transportState, lastInboundMs, lastSessionInboundMs,
      events: lifecycleEvents.size ? [...lifecycleEvents].join('|') : 'none', pending: pending.size,
      ...owned,
    };
    return Object.entries(facts).map(([key, value]) => `${key}=${value ?? 'unobserved'}`).join(', ');
  };
  const fail = (error) => {
    failure ??= error;
    for (const command of pending.values()) command.reject(failure);
    pending.clear();
  };
  const abort = () => { fail(signal.reason ?? new Error('Render canceled')); ws.terminate(); };
  signal?.addEventListener('abort', abort, { once: true });
  function send(method, params = {}, session = sessionId) {
    if (failure) return Promise.reject(failure);
    return new Promise((resolveCommand, rejectCommand) => {
      const id = ++nextId;
      const sentMs = sinceStart();
      // The prefix is matched by encode.js page recovery; facts follow it.
      const timer = setTimeout(() => fail(new Error(`Browser command timed out: ${method} (${commandFacts(sentMs)})`)), 30000);
      const finish = (fn) => (value) => { clearTimeout(timer); pending.delete(id); fn(value); };
      pending.set(id, { resolve: finish(resolveCommand), reject: finish(rejectCommand) });
      ws.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }), error => {
        if (error) fail(error);
      });
    });
  }
  const policyCsp = contentSecurityPolicy || CSP.replace('img-src http: https:', mediaMode === 'code-only' ? "img-src 'none'" : 'img-src http: https:').replace("media-src 'self'", mediaMode !== 'code-images-video' ? "media-src 'none'" : "media-src 'self'");
  // The page may cancel a paused request (a source swapped or re-requested
  // with CORS mid-load); its interception is then gone, which is not a fault.
  const fulfill = response => send('Fetch.fulfillRequest', response).catch(error => {
    if (!failure && /Invalid InterceptionId/i.test(error.message)) return;
    throw error;
  });
  async function request(params) {
    if (params.resourceType === 'Image' && mediaMode === 'code-only' || params.resourceType === 'Media' && mediaMode !== 'code-images-video') throw new Error('Composition media mode refused this asset');
    const url = new URL(params.request.url);
    const key = decodeURIComponent(url.pathname);
    const asset = url.origin === ORIGIN && !url.username && !url.password && params.request.method === 'GET' && assets.get(key);
    if (!asset) {
      // A foreground headless target may ask for Chrome's implicit favicon.
      // Answer the absent local icon without allowing any network request.
      if (url.origin === ORIGIN && !url.username && !url.password && params.request.method === 'GET' && key === '/favicon.ico') {
        await fulfill({ requestId: params.requestId, responseCode: 204, body: '' });
        return;
      }
      // Do not continue even a failed request. Disconnect destroys the context.
      // A generated preview answers unknown URLs with an empty local response
      // so one stray image does not tear the page down; nothing is fetched.
      if (refuseUnknown === 'empty') {
        await fulfill({ requestId: params.requestId, responseCode: 204, body: '' });
        onEvent?.({ method: 'Portos.refusedRequest', params: { url: String(params.request.url).slice(0, 200) } });
        return;
      }
      throw new Error(`Refused composition request: ${params.request.url}`);
    }
    const size = Buffer.isBuffer(asset) ? asset.length : asset.size;
    const headers = params.request.headers || {};
    const rangeHeader = Object.entries(headers).find(([name]) => name.toLowerCase() === 'range')?.[1];
    // Media elements ask for byte ranges; answer them (206) so a seek never
    // needs the whole file, and a streamed asset is read only as far as asked.
    const range = rangeHeader ? parseByteRange(rangeHeader, size) : null;
    if (rangeHeader && !range && size > 0) {
      await fulfill({ requestId: params.requestId, responseCode: 416,
        responseHeaders: [{ name: 'Content-Range', value: `bytes */${size}` }, { name: 'Content-Security-Policy', value: policyCsp }, { name: 'Access-Control-Allow-Origin', value: '*' }], body: '' });
      return;
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    const body = size === 0 ? Buffer.alloc(0) : await readSlice(asset, start, end);
    await fulfill({
      requestId: params.requestId, responseCode: range ? 206 : 200,
      responseHeaders: [
        { name: 'Content-Type', value: MIME[extname(key).toLowerCase()] ?? 'application/octet-stream' },
        { name: 'Content-Security-Policy', value: policyCsp },
        { name: 'Access-Control-Allow-Origin', value: '*' },
        { name: 'X-DNS-Prefetch-Control', value: 'off' },
        { name: 'Accept-Ranges', value: 'bytes' },
        { name: 'Content-Length', value: String(body.length) },
        ...(range ? [{ name: 'Content-Range', value: `bytes ${start}-${start + body.length - 1}/${size}` }] : []),
      ], body: body.toString('base64'),
    });
  }
  ws.on('message', bytes => {
    try {
      const message = JSON.parse(bytes.toString());
      lastInboundMs = sinceStart();
      if (sessionId && message.sessionId === sessionId) lastSessionInboundMs = lastInboundMs;
      if (LIFECYCLE_EVENTS.has(message.method)) lifecycleEvents.add(message.method);
      if (message.id) {
        const command = pending.get(message.id);
        if (message.error) command?.reject(new Error(message.error.message));
        else command?.resolve(message.result);
      } else if (!closing && message.method === 'Target.detachedFromTarget' && message.params.sessionId === sessionId) {
        fail(new Error('Composition browser target closed'));
      } else if (message.sessionId === sessionId) {
        if (message.method === 'Fetch.requestPaused') request(message.params).catch(fail);
        if (message.method === 'Runtime.bindingCalled' && message.params.name === '__portosPreview') {
          let payload = {};
          try { payload = JSON.parse(String(message.params.payload).slice(0, 2000)); } catch { payload = {}; }
          onEvent?.({ method: 'Portos.preview', params: payload });
        } else if (message.method === 'Runtime.bindingCalled') {
          const payload = String(message.params.payload).slice(0, 300);
          fail(new Error(message.params.name === '__portosFailure'
            ? `Composition drew cross-origin pixels into a WebGL texture, which the browser refused (${payload}). Load images and video with crossOrigin = 'anonymous' before drawing them.`
            : `Refused composition request: ${payload}`));
        }
        if (message.method === 'Runtime.exceptionThrown') {
          const details = message.params.exceptionDetails;
          const text = `Composition script failed: ${details.exception?.description ?? details.text}`;
          if (previewBridge) onEvent?.({ method: 'Portos.pageError', params: { message: text.slice(0, 300) } });
          else fail(new Error(text));
        }
        if (message.method === 'Inspector.targetCrashed') fail(new Error('Composition browser target crashed'));
        if (message.method === 'Page.screencastFrame') onEvent?.(message);
      }
    } catch (error) { fail(error); }
  });
  ws.on('error', error => { transportState = 'error'; fail(error); });
  ws.on('close', () => {
    if (transportState === 'open') transportState = 'closed';
    if (!closing) fail(new Error('Managed browser disconnected'));
  });
  async function close({ verify = false } = {}) {
    closing = true;
    signal?.removeEventListener('abort', abort);
    // On failure the socket detach disposes the context even if commands fail.
    if (contextId && !failure && ws.readyState === WebSocket.OPEN) {
      await send('Target.disposeBrowserContext', { browserContextId: contextId }, null).catch(fail);
    }
    const error = failure;
    fail(new Error('Composition context closed'));
    ws.terminate();
    if (verify && error) throw error;
  }
  async function evaluate(expression, phase = 'evaluation') {
    const started = performance.now();
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }).catch(error => {
      throw new Error(`Composition ${phase} failed after ${Math.round(performance.now() - started)}ms: ${error.message}`);
    });
    if (result.exceptionDetails) throw new Error(`Composition script failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    if (failure) throw failure;
    return result.result.value;
  }
  try {
    await new Promise((resolveOpen, rejectOpen) => {
      if (ws.readyState === WebSocket.OPEN) return resolveOpen();
      ws.once('open', resolveOpen);
      ws.once('error', rejectOpen);
      ws.once('close', () => rejectOpen(failure ?? new Error('Managed browser disconnected')));
    });
    signal?.throwIfAborted();
    phase = 'create-context';
    ({ browserContextId: contextId } = await send('Target.createBrowserContext', {
      disposeOnDetach: true,
      // Defense in depth for browser-originated HTTP requests outside Fetch.
      // Previews do not bypass loopback; the OS jail is the real UDP boundary.
      proxyServer: 'http://127.0.0.1:9', ...(lockLoopback ? {} : { proxyBypassList: '<-loopback>' }),
    }, null));
    // Headless Chrome has no tab UI to hide. Give its compositor a foreground
    // target: hidden targets can stall surface screenshots on Linux. Headed
    // managed browsers retain the hidden, background rendering posture.
    phase = 'create-target';
    const headless = /HeadlessChrome\//.test(version['User-Agent'] || '');
    const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId: contextId, hidden: !headless, background: !headless }, null);
    phase = 'attach';
    ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }, null));
    phase = 'session-setup';
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Runtime.addBinding', { name: '__portosRefused' });
    await send('Runtime.addBinding', { name: '__portosFailure' });
    if (previewBridge) await send('Runtime.addBinding', { name: '__portosPreview' });
    const networkFreeze = freezeNetworkConstructors ? `
      // WebRTC bypasses HTTP interception. A fresh srcdoc realm does not inherit
      // this freeze; the preview OS jail is what denies that realm's UDP.
      for (const key of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'WebTransport']) {
        Object.defineProperty(globalThis, key, { configurable: false, writable: false,
          value: function() { report(key); throw new Error(key + ' is disabled in compositions'); } });
      }
      for (const key of ['Worker', 'SharedWorker', 'WebSocket']) {
        Object.defineProperty(globalThis, key, { configurable: false, writable: false,
          value: function(url) { report(String(url)); throw new Error(key + ' is disabled in compositions'); } });
      }` : '';
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      const report = globalThis.__portosRefused;
      addEventListener('securitypolicyviolation', event => report(event.blockedURI));
      ${networkFreeze}
      // The sandbox's opaque origin makes every document asset cross-origin. A
      // no-cors image or video taints any canvas it is drawn into, and a
      // tainted canvas cannot become a WebGL texture (three.js swallows that
      // SecurityError and draws black, #10594). Default images and media to
      // CORS: the fulfilled responses allow it, so pixels stay readable without
      // granting same-origin authority. An explicit crossorigin is kept.
      const setAttribute = Element.prototype.setAttribute;
      const corsDefault = element => {
        if ((element instanceof HTMLImageElement || element instanceof HTMLMediaElement) && !element.hasAttribute('crossorigin')) {
          setAttribute.call(element, 'crossorigin', 'anonymous');
          return true;
        }
        return false;
      };
      const owner = element => element instanceof HTMLSourceElement ? element.parentElement : element;
      for (const [proto, names] of [[HTMLImageElement.prototype, ['src', 'srcset']], [HTMLMediaElement.prototype, ['src']], [HTMLSourceElement.prototype, ['src', 'srcset']]]) {
        for (const name of names) {
          const descriptor = Object.getOwnPropertyDescriptor(proto, name);
          Object.defineProperty(proto, name, { ...descriptor, set(value) { corsDefault(owner(this)); descriptor.set.call(this, value); } });
        }
      }
      Element.prototype.setAttribute = function(name, value) {
        if (/^(src|srcset)$/i.test(String(name))) corsDefault(owner(this));
        return setAttribute.call(this, name, value);
      };
      // Markup and innerHTML set attributes without the setters above. A
      // changed crossorigin re-runs an image's fetch; media needs load().
      new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) {
          if (node.nodeType !== 1) continue;
          for (const element of [node, ...node.querySelectorAll('img, video, audio')]) {
            if (corsDefault(element) && element instanceof HTMLMediaElement && element.networkState !== HTMLMediaElement.NETWORK_EMPTY) element.load();
          }
        }
      }).observe(document, { childList: true, subtree: true });
      // Anything still tainted fails the job instead of rendering black.
      const failure = globalThis.__portosFailure;
      for (const Context of [globalThis.WebGLRenderingContext, globalThis.WebGL2RenderingContext]) {
        for (const name of ['texImage2D', 'texSubImage2D', 'texImage3D', 'texSubImage3D']) {
          const upload = Context?.prototype[name];
          if (typeof upload !== 'function') continue;
          Context.prototype[name] = function(...args) {
            try { return upload.apply(this, args); } catch (error) {
              if (error?.name === 'SecurityError') failure(String(error.message));
              throw error;
            }
          };
        }
      }
    })();` });
    if (previewBridge) await send('Page.addScriptToEvaluateOnNewDocument', { source: PREVIEW_BRIDGE_SCRIPT });
    for (const source of initScripts) await send('Page.addScriptToEvaluateOnNewDocument', { source });
    await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    phase = 'navigate';
    const navigation = await send('Page.navigate', { url: `${ORIGIN}/index.html` });
    if (navigation.errorText) throw new Error(`Composition navigation failed: ${navigation.errorText}`);
    phase = 'document-load';
    // The page-side deadline sits under the 30s command timer so the two
    // failures separate (#12656): a command timeout means the renderer stopped
    // answering (host starvation or a hung target); this stall means the page
    // answered but its load event never came, which is a lifecycle fault.
    const loadWaitMs = sinceStart();
    const loaded = await evaluate(`new Promise(resolve => {
      if (document.readyState === 'complete') return resolve('loaded');
      addEventListener('load', () => resolve('loaded'), { once: true });
      setTimeout(() => resolve('stalled:' + document.readyState), ${DOCUMENT_LOAD_DEADLINE_MS});
    })`, 'document load');
    if (typeof loaded === 'string' && loaded.startsWith('stalled:')) throw new Error(`Composition document load stalled: ${loaded.slice('stalled:'.length)} after ${DOCUMENT_LOAD_DEADLINE_MS}ms while the page stayed responsive (${commandFacts(loadWaitMs)})`);
    phase = 'font-readiness';
    await evaluate('document.fonts.ready.then(() => true)', 'font readiness');
    phase = 'ready';
    return { evaluate, send, close, check: () => { signal?.throwIfAborted(); if (failure) throw failure; } };
  } catch (error) {
    await close();
    throw error;
  }
}
