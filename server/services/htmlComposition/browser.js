import WebSocket from 'ws';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join, extname } from 'node:path';
import { PATHS } from '../../lib/fileUtils.js';
import { cdpRequest } from '../browserService.js';

const ORIGIN = 'https://composition.invalid';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };
// Sandboxing removes alternate realms, popups, forms and workers. HTTP assets
// are fulfilled below, never continued to the browser's network stack.
const CSP = "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src http: https:; font-src 'self'; media-src 'self'; connect-src http: https:; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

function inside(root, path) {
  const rel = relative(root, path);
  return rel && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel);
}

// Freeze the input before any script runs. Symlinks are refused, including
// symlinked assets, so the virtual origin cannot export another data store.
async function snapshotAssets(directory) {
  const root = await realpath(PATHS.data);
  const dir = await realpath(resolve(root, directory));
  if (!inside(root, dir)) throw new Error('directory must be inside data');
  const assets = new Map();
  let bytes = 0;
  async function walk(path, prefix = '') {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error('Composition assets must not be symlinks');
      if (entry.isDirectory()) await walk(join(path, entry.name), `${name}/`);
      else if (entry.isFile()) {
        const size = (await stat(join(path, entry.name))).size;
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
export async function openComposition(directory, { signal } = {}) {
  const assets = await snapshotAssets(directory);
  signal?.throwIfAborted();
  const response = await cdpRequest('/json/version');
  if (!response.ok) throw new Error('Managed browser is unavailable');
  const { webSocketDebuggerUrl } = await response.json();
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
  async function request(params) {
    const url = new URL(params.request.url);
    const key = decodeURIComponent(url.pathname);
    const body = url.origin === ORIGIN && !url.username && !url.password && params.request.method === 'GET' && assets.get(key);
    if (!body) {
      // Do not continue even a failed request. Disconnect destroys the context.
      throw new Error(`Refused composition request: ${params.request.url}`);
    }
    await send('Fetch.fulfillRequest', {
      requestId: params.requestId, responseCode: 200,
      responseHeaders: [
        { name: 'Content-Type', value: MIME[extname(key).toLowerCase()] ?? 'application/octet-stream' },
        { name: 'Content-Security-Policy', value: CSP },
        { name: 'Access-Control-Allow-Origin', value: '*' },
        { name: 'X-DNS-Prefetch-Control', value: 'off' },
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
    const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId: contextId, hidden: true, background: true }, null);
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
