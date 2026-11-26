// Make a single HTTP(S) request with a caller-vetted DNS lookup and a streamed Response.

import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createBrotliDecompress, createUnzip } from 'node:zlib';

const BODYLESS_STATUSES = new Set([204, 205, 304]);

export async function pinnedHttpRequest(url, { headers, lookup }, timeoutMs) {
  const target = new URL(url);
  // http.request would turn URL credentials into a Basic header. Fetch rejected
  // such URLs, so keep that refusal even on a vetted host.
  if (target.username || target.password) throw new TypeError('URL credentials are not supported');

  const secure = target.protocol === 'https:';
  if (!secure && target.protocol !== 'http:') throw new TypeError('Unsupported URL protocol');
  const hostname = target.hostname.replace(/^\[|\]$/g, '');
  const signal = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? AbortSignal.timeout(Math.ceil(timeoutMs))
    : undefined;
  const requestHeaders = new Headers(headers);
  if (!requestHeaders.has('accept-encoding')) requestHeaders.set('accept-encoding', 'gzip, deflate, br');

  const transport = secure ? https : http;
  const res = await new Promise((resolve, reject) => {
    // A one-shot agent prevents another request's socket or the global proxy
    // configuration from bypassing lookup. The URL still supplies Host and SNI.
    const req = transport.request(target, {
      agent: false,
      lookup,
      signal,
      headers: Object.fromEntries(requestHeaders),
      ...(secure ? { servername: isIP(hostname) ? '' : hostname } : {}),
    }, resolve);
    req.on('error', reject);
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      reject(new Error('HTTP protocol upgrade is unsupported'));
    });
    req.end();
  });
  try {
    const status = res.statusCode;
    const responseHeaders = Object.entries(res.headersDistinct)
      .flatMap(([name, values]) => values.map(value => [name, value]));
    let body = null;
    if (BODYLESS_STATUSES.has(status)) {
      res.destroy();
    } else {
      const encoding = res.headers['content-encoding']?.trim().toLowerCase();
      const decoder = encoding === 'br' ? createBrotliDecompress()
        : ['gzip', 'x-gzip', 'deflate'].includes(encoding) ? createUnzip() : null;
      if (decoder) pipeline(res, decoder, { signal }).catch(() => {});
      body = Readable.toWeb(decoder ?? res, { strategy: { highWaterMark: 0 } });
    }
    return new Response(body, { status, statusText: res.statusMessage, headers: responseHeaders });
  } catch (error) {
    res.destroy();
    throw error;
  }
}
