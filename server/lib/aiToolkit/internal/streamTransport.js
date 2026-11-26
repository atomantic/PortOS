// Stream provider responses over HTTP(S) under the run's AbortSignal.

import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createBrotliDecompress, createUnzip } from 'node:zlib';

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const BODYLESS_STATUSES = new Set([204, 205, 304]);
const MAX_REDIRECTS = 20;

function requestOnce(target, { method, headers, signal, body }) {
  // The run owns its stall and absolute deadlines. A fresh HTTP/1.1 socket
  // has no pooled connection timeout or HTTP/2 session to retire mid-request.
  const transport = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(target, {
      method, headers: Object.fromEntries(headers), signal, agent: false,
    }, resolve);
    req.on('error', reject);
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      reject(new Error('HTTP protocol upgrade is unsupported'));
    });
    req.end(body);
  });
}

function providerResponse(res, signal) {
  const status = res.statusCode;
  const headers = Object.entries(res.headersDistinct)
    .flatMap(([name, values]) => values.map(value => [name, value]));
  let body = null;
  // The same run signal covers headers, the socket body and decompression.
  if (BODYLESS_STATUSES.has(status)) {
    res.destroy();
  } else {
    const encoding = res.headers['content-encoding']?.trim().toLowerCase();
    const decoder = encoding === 'br' ? createBrotliDecompress()
      : ['gzip', 'x-gzip', 'deflate'].includes(encoding) ? createUnzip() : null;
    if (decoder) pipeline(res, decoder, { signal }).catch(() => {});
    body = Readable.toWeb(decoder ?? res, { strategy: { highWaterMark: 0 } });
  }
  return new Response(body, { status, statusText: res.statusMessage, headers });
}

export async function requestProviderStream(url, { headers, signal, body }) {
  let target = new URL(url);
  let method = 'POST';
  const requestHeaders = new Headers(headers);
  if (!requestHeaders.has('accept-encoding')) requestHeaders.set('accept-encoding', 'gzip, deflate, br');
  if (body != null) requestHeaders.set('content-length', String(Buffer.byteLength(body)));

  for (let redirects = 0; ; redirects++) {
    if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new TypeError('Unsupported provider URL protocol');
    if (target.username || target.password) throw new TypeError('Provider URL credentials are not supported');
    const res = await requestOnce(target, { method, headers: requestHeaders, signal, body });
    const location = res.headers.location;

    if (!REDIRECTS.has(res.statusCode) || location == null) {
      try {
        return providerResponse(res, signal);
      } catch (error) {
        res.destroy();
        throw error;
      }
    }

    res.destroy();
    if (redirects === MAX_REDIRECTS) throw new Error('Too many provider redirects');
    const next = new URL(location, target);
    if (next.origin !== target.origin) {
      for (const name of ['authorization', 'proxy-authorization', 'cookie', 'host']) requestHeaders.delete(name);
    }
    if (res.statusCode === 303 || ((res.statusCode === 301 || res.statusCode === 302) && method === 'POST')) {
      method = 'GET';
      body = undefined;
      for (const name of ['content-encoding', 'content-language', 'content-location', 'content-length', 'content-type']) {
        requestHeaders.delete(name);
      }
    }
    target = next;
  }
}
