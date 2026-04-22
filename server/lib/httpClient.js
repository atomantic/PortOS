/**
 * Fetch-based HTTP client factory — axios.create() replacement.
 * Supports base URL, default headers, timeout, query params, and self-signed TLS.
 */

import https from 'https';

// Wraps https.request as fetch-compatible for self-signed cert support
function insecureFetch(agent) {
  return async (url, { method = 'GET', headers = {}, body, signal } = {}) => {
    const u = new URL(url);
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method,
        headers,
        agent
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            headers: { get: n => res.headers[n.toLowerCase()] ?? null },
            text: () => Promise.resolve(text),
            json: () => Promise.resolve(JSON.parse(text))
          });
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      if (signal) {
        if (signal.aborted) { req.destroy(); reject(new Error('Request aborted')); return; }
        const onAbort = () => req.destroy(new Error('Request aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
        const cleanup = () => signal.removeEventListener('abort', onAbort);
        req.on('close', cleanup);
        req.on('error', cleanup);
      }
      if (body) req.write(body);
      req.end();
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
