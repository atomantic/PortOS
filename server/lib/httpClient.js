/**
 * Fetch-based HTTP client factory — axios.create() replacement.
 * Supports base URL, default headers, timeout, query params, and self-signed TLS.
 */

import https from 'https';

// Wraps https.request as fetch-compatible for self-signed cert support
export function insecureFetch(agent) {
  return async (url, { method = 'GET', headers = {}, body, signal, maxBytes } = {}) => {
    const u = new URL(url);
    return new Promise((resolve, reject) => {
      // Declare cleanup before req so it can be called from res.on('end'),
      // res.on('error'), and req.on('error') — keep-alive sockets may not
      // fire req 'close' promptly, so we cannot rely on that alone.
      let cleanup = () => {};

      const req = https.request({
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method,
        headers,
        agent
      }, (res) => {
        // Streaming size cap. Without this, peer-sync asset pulls over HTTPS
        // buffer the WHOLE response before the post-resolve content-length
        // check fires — so an oversized or missing-header asset can exhaust
        // memory before the cap kicks in. Two layers:
        //   1. Early reject when the server-declared Content-Length already
        //      exceeds the cap — no body bytes read.
        //   2. Per-chunk accumulator that destroys the request if the actual
        //      bytes-on-the-wire exceed the cap (server lied or omitted
        //      header).
        // Callers without a cap (everything except asset pull today) skip
        // both layers — maxBytes only gates when provided.
        if (typeof maxBytes === 'number' && maxBytes > 0) {
          const declared = Number(res.headers['content-length']);
          if (Number.isFinite(declared) && declared > maxBytes) {
            cleanup();
            req.destroy();
            reject(new Error(`Response declared Content-Length ${declared} exceeds maxBytes ${maxBytes}`));
            return;
          }
        }
        const chunks = [];
        let bytesSoFar = 0;
        let capTripped = false;
        res.on('data', c => {
          // Once the cap is tripped we both destroy the request AND stop
          // accumulating; the socket teardown isn't instantaneous and
          // additional 'data' events can fire before 'close' / 'end'.
          // Push-and-reject-on-every-chunk would otherwise (a) keep
          // growing `chunks` past the cap and (b) call reject() multiple
          // times (Promise resolves once; the dropped rejections are
          // harmless but the unbounded buffering isn't).
          if (capTripped) return;
          if (typeof maxBytes === 'number' && maxBytes > 0) {
            bytesSoFar += c.length;
            if (bytesSoFar > maxBytes) {
              capTripped = true;
              cleanup();
              req.destroy();
              reject(new Error(`Response body exceeded maxBytes ${maxBytes} (got ${bytesSoFar})`));
              return;
            }
          }
          chunks.push(c);
        });
        res.on('end', () => {
          if (capTripped) return;
          cleanup();
          // Concat as a raw Buffer so the response can be projected to text
          // (UTF-8 decode), JSON (parse), or arrayBuffer (binary). Pre-
          // decoding to a UTF-8 string up-front would corrupt binary
          // responses — the peer-sync asset-pull worker uses this shim to
          // download images / videos over HTTPS, and `Buffer.toString('utf-8')`
          // silently replaces invalid byte sequences with U+FFFD.
          const buffer = Buffer.concat(chunks);
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            headers: {
              get: n => res.headers[n.toLowerCase()] ?? null,
              // has() mirrors Fetch's Headers API so consumers (peerSync's
              // asset-pull cap check) can distinguish "header missing" from
              // "header is '0'" without branching on transport. Without this
              // the asset-pull `res.headers.has('content-length')` throws
              // TypeError on every HTTPS pull.
              has: n => Object.prototype.hasOwnProperty.call(res.headers, n.toLowerCase()),
            },
            text: () => Promise.resolve(buffer.toString('utf-8')),
            json: () => Promise.resolve(JSON.parse(buffer.toString('utf-8'))),
            // ArrayBuffer view matching Fetch's Response so call sites can
            // `Buffer.from(await res.arrayBuffer())` without branching on
            // transport.
            arrayBuffer: () => Promise.resolve(
              buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
            ),
          });
        });
        res.on('error', (err) => { if (capTripped) return; cleanup(); reject(err); });
      });
      req.on('error', (err) => { cleanup(); reject(err); });
      if (body) req.write(body);
      req.end();

      // Register abort handler after req exists to avoid TDZ; also handle already-aborted case
      if (signal) {
        if (signal.aborted) { req.destroy(new Error('Request aborted')); return; }
        const onAbort = () => req.destroy(new Error('Request aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
        cleanup = () => signal.removeEventListener('abort', onAbort);
      }
    });
  };
}

export function createHttpClient({ baseURL = '', headers: defaultHeaders = {}, timeout = 30000, allowSelfSigned = false } = {}) {
  const fetchFn = allowSelfSigned
    ? insecureFetch(new https.Agent({ rejectUnauthorized: false }))
    : fetch;

  const request = async (method, path, { params, data, headers: extraHeaders } = {}) => {
    let url = baseURL + path;
    if (params) {
      const qs = new URLSearchParams(
        Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])
      );
      if (qs.toString()) url += '?' + qs;
    }

    const options = {
      method,
      headers: { ...defaultHeaders, ...extraHeaders },
      signal: AbortSignal.timeout(timeout)
    };

    if (data !== undefined) {
      options.body = JSON.stringify(data);
      if (!options.headers['Content-Type'] && !options.headers['content-type']) {
        options.headers['Content-Type'] = 'application/json';
      }
    }

    const res = await fetchFn(url, options);
    const ct = res.headers.get('content-type') || '';
    const responseData = ct.includes('application/json') ? await res.json() : await res.text();

    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      err.response = { data: responseData, status: res.status };
      throw err;
    }

    return { data: responseData, status: res.status };
  };

  return {
    get: (path, opts) => request('GET', path, opts),
    post: (path, data, opts) => request('POST', path, { ...opts, data }),
    put: (path, data, opts) => request('PUT', path, { ...opts, data }),
    delete: (path, opts) => request('DELETE', path, opts)
  };
}
