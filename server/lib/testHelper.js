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
