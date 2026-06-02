/**
 * Test HTTP request helper
 * fetch-based replacement for supertest — creates a real HTTP server on a
 * random port, makes a single request, then shuts the server down.
 */

import { createServer } from 'http';

function startServer(app) {
  return new Promise((resolve, reject) => {
    const server = createServer(app);
    server.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
}

class RequestBuilder {
  constructor(app, method, path) {
    this._app = app;
    this._method = method;
    this._path = path;
    this._body = undefined;
    this._headers = {};
  }

  send(body) {
    this._body = body;
    return this;
  }

  set(header, value) {
    this._headers[header.toLowerCase()] = value;
    return this;
  }

  then(resolve, reject) {
    return this._execute().then(resolve, reject);
  }

  catch(fn) {
    return this._execute().catch(fn);
  }

  async _execute() {
    const server = await startServer(this._app);
    const { port } = server.address();

    const headers = { ...this._headers };
    let body;
    if (this._body !== undefined) {
      if (typeof this._body === 'object' && this._body !== null) {
        body = JSON.stringify(this._body);
        headers['content-type'] ??= 'application/json';
      } else {
        body = String(this._body);
      }
    }

    let response;
    try {
      const res = await fetch(`http://127.0.0.1:${port}${this._path}`, {
        method: this._method,
        headers,
        body
      });

      const text = await res.text();
      const ct = res.headers.get('content-type') || '';
      let parsedBody = text;
      if (text && ct.includes('application/json')) {
        parsedBody = JSON.parse(text);
      }

      response = {
        status: res.status,
        body: parsedBody,
        text,
        headers: Object.fromEntries(res.headers.entries())
      };
    } finally {
      await closeServer(server);
    }

    return response;
  }
}

export function request(app) {
  return {
    get: (path) => new RequestBuilder(app, 'GET', path),
    post: (path) => new RequestBuilder(app, 'POST', path),
    put: (path) => new RequestBuilder(app, 'PUT', path),
    delete: (path) => new RequestBuilder(app, 'DELETE', path),
    patch: (path) => new RequestBuilder(app, 'PATCH', path),
  };
}

/**
 * Mock a fetch `Response` whose body is read via `.text()` — the read path used
 * by `readResponseJson` and every fetch-based client. Use this for the common
 * case of a JSON body: pass the value, it's serialized into `text()`.
 *
 *   fetchWithTimeout.mockResolvedValue(mockJsonResponse({ value: [] }));
 *
 * @param {*} body - serialized into the response body via JSON.stringify
 * @param {{ ok?: boolean, status?: number }} [opts]
 */
export function mockJsonResponse(body, { ok = true, status = 200 } = {}) {
  const text = JSON.stringify(body);
  return { ok, status, text: async () => text };
}

/**
 * Mock a fetch `Response` with a raw-string body read via `.text()` — for
 * non-JSON / HTML / blank bodies (the masquerade cases) and error text.
 *
 *   fetchWithTimeout.mockResolvedValue(mockTextResponse('<html>502</html>'));
 *   fetchWithTimeout.mockResolvedValue(mockTextResponse('boom', { ok: false, status: 500 }));
 *
 * @param {string} [body] - returned verbatim by `text()`
 * @param {{ ok?: boolean, status?: number }} [opts]
 */
export function mockTextResponse(body = '', { ok = true, status = 200 } = {}) {
  return { ok, status, text: async () => body };
}
