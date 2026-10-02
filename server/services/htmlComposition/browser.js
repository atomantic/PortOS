import WebSocket from 'ws';
import { open, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join, extname } from 'node:path';
import { PATHS } from '../../lib/fileUtils.js';
import { cdpRequest } from '../browserService.js';

const ORIGIN = 'https://composition.invalid';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };
// Sandboxing removes alternate realms, popups, forms and workers. HTTP assets
// are fulfilled below, never continued to the browser's network stack.
const CSP = "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src http: https:; font-src 'self'; media-src 'self'; connect-src http: https:; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

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

export async function openComposition(directory, { signal, validateAssets, streamMedia = false, mediaMode = 'code-images-video' } = {}) {
  const assets = await snapshotAssets(directory, { streamMedia });
  validateAssets?.(assets);
  signal?.throwIfAborted();
  const response = await cdpRequest('/json/version');
  if (!response.ok) throw new Error('Managed browser is unavailable');
  const version = await response.json();
  const { webSocketDebuggerUrl } = version;
  if (!webSocketDebuggerUrl) throw new Error('Managed browser has no CDP endpoint');
  const ws = new WebSocket(webSocketDebuggerUrl, { handshakeTimeout: 10000 });
  const pending = new Map();
  let nextId = 0;
  let failure;
  let contextId;
  let sessionId;
  let closing = false;
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
      const timer = setTimeout(() => fail(new Error(`Browser command timed out: ${method}`)), 30000);
      const finish = (fn) => (value) => { clearTimeout(timer); pending.delete(id); fn(value); };
      pending.set(id, { resolve: finish(resolveCommand), reject: finish(rejectCommand) });
      ws.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }), error => {
        if (error) fail(error);
      });
    });
  }
  const policyCsp = CSP.replace('img-src http: https:', mediaMode === 'code-only' ? "img-src 'none'" : 'img-src http: https:').replace("media-src 'self'", mediaMode !== 'code-images-video' ? "media-src 'none'" : "media-src 'self'");
  async function request(params) {
    if (params.resourceType === 'Image' && mediaMode === 'code-only' || params.resourceType === 'Media' && mediaMode !== 'code-images-video') throw new Error('Composition media mode refused this asset');
    const url = new URL(params.request.url);
    const key = decodeURIComponent(url.pathname);
    const asset = url.origin === ORIGIN && !url.username && !url.password && params.request.method === 'GET' && assets.get(key);
    if (!asset) {
      // A foreground headless target may ask for Chrome's implicit favicon.
      // Answer the absent local icon without allowing any network request.
      if (url.origin === ORIGIN && !url.username && !url.password && params.request.method === 'GET' && key === '/favicon.ico') {
        await send('Fetch.fulfillRequest', { requestId: params.requestId, responseCode: 204, body: '' });
        return;
      }
      // Do not continue even a failed request. Disconnect destroys the context.
      throw new Error(`Refused composition request: ${params.request.url}`);
    }
    const size = Buffer.isBuffer(asset) ? asset.length : asset.size;
    const headers = params.request.headers || {};
    const rangeHeader = Object.entries(headers).find(([name]) => name.toLowerCase() === 'range')?.[1];
    // Media elements ask for byte ranges; answer them (206) so a seek never
    // needs the whole file, and a streamed asset is read only as far as asked.
    const range = rangeHeader ? parseByteRange(rangeHeader, size) : null;
    if (rangeHeader && !range && size > 0) {
      await send('Fetch.fulfillRequest', { requestId: params.requestId, responseCode: 416,
        responseHeaders: [{ name: 'Content-Range', value: `bytes */${size}` }, { name: 'Content-Security-Policy', value: policyCsp }], body: '' });
      return;
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    const body = size === 0 ? Buffer.alloc(0) : await readSlice(asset, start, end);
    await send('Fetch.fulfillRequest', {
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
      if (message.id) {
        const command = pending.get(message.id);
        if (message.error) command?.reject(new Error(message.error.message));
        else command?.resolve(message.result);
      } else if (!closing && message.method === 'Target.detachedFromTarget' && message.params.sessionId === sessionId) {
        fail(new Error('Composition browser target closed'));
      } else if (message.sessionId === sessionId) {
        if (message.method === 'Fetch.requestPaused') request(message.params).catch(fail);
        if (message.method === 'Runtime.bindingCalled') fail(new Error(`Refused composition request: ${message.params.payload}`));
        if (message.method === 'Runtime.exceptionThrown') {
          const details = message.params.exceptionDetails;
          fail(new Error(`Composition script failed: ${details.exception?.description ?? details.text}`));
        }
        if (message.method === 'Inspector.targetCrashed') fail(new Error('Composition browser target crashed'));
      }
    } catch (error) { fail(error); }
  });
  ws.on('error', fail);
  ws.on('close', () => { if (!closing) fail(new Error('Managed browser disconnected')); });
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
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
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
    ({ browserContextId: contextId } = await send('Target.createBrowserContext', {
      disposeOnDetach: true,
      // Defense in depth for browser-originated HTTP requests outside Fetch.
      proxyServer: 'http://127.0.0.1:9', proxyBypassList: '<-loopback>',
    }, null));
    // Headless Chrome has no tab UI to hide. Give its compositor a foreground
    // target: hidden targets can stall surface screenshots on Linux. Headed
    // managed browsers retain the hidden, background rendering posture.
    const headless = /HeadlessChrome\//.test(version['User-Agent'] || '');
    const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId: contextId, hidden: !headless, background: !headless }, null);
    ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }, null));
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Runtime.addBinding', { name: '__portosRefused' });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      const report = globalThis.__portosRefused;
      addEventListener('securitypolicyviolation', event => report(event.blockedURI));
      // WebRTC bypasses HTTP interception. No other realm can restore these:
      // CSP sandbox disallows frames, workers, popups and same-origin access.
      for (const key of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'WebTransport']) {
        Object.defineProperty(globalThis, key, { configurable: false, writable: false,
          value: function() { report(key); throw new Error(key + ' is disabled in compositions'); } });
      }
      for (const key of ['Worker', 'SharedWorker', 'WebSocket']) {
        Object.defineProperty(globalThis, key, { configurable: false, writable: false,
          value: function(url) { report(String(url)); throw new Error(key + ' is disabled in compositions'); } });
      }
    })();` });
    await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    const navigation = await send('Page.navigate', { url: `${ORIGIN}/index.html` });
    if (navigation.errorText) throw new Error(`Composition navigation failed: ${navigation.errorText}`);
    await evaluate(`new Promise(resolve => document.readyState === 'complete' ? resolve() : addEventListener('load', resolve, { once: true }))`);
    await evaluate('document.fonts.ready.then(() => true)');
    return { evaluate, send, close, check: () => { signal?.throwIfAborted(); if (failure) throw failure; } };
  } catch (error) {
    await close();
    throw error;
  }
}
