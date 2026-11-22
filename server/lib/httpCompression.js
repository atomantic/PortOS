/**
 * `httpCompression` negotiates Brotli, gzip, or deflate for API and static responses while
 * preserving streaming, ranges, existing encodings, and `no-transform`.
 */

import { constants, createBrotliCompress, createDeflate, createGzip } from 'node:zlib';

const MIN_BYTES = 1024;
const COMPRESSORS = {
  br: () => createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }),
  gzip: () => createGzip({ level: 6 }),
  deflate: () => createDeflate({ level: 6 }),
};
const ENCODING_PREFERENCE = { br: 2, gzip: 1, deflate: 0, identity: 0 };
const COMPRESSIBLE_TYPES = new Set([
  'application/json', 'application/javascript', 'application/xml', 'image/svg+xml',
]);

function isCompressible(res) {
  const type = String(res.getHeader('Content-Type') ?? '').split(';', 1)[0].trim().toLowerCase();
  if (type === 'text/event-stream') return false;
  return type.startsWith('text/') || COMPRESSIBLE_TYPES.has(type) || /\+(?:json|xml)$/.test(type);
}

function negotiateEncoding(header) {
  if (!header) return 'identity';
  const accepted = new Map();
  let lowestQuality = 1;
  for (const [index, entry] of header.split(',').entries()) {
    const [token, ...parameters] = entry.trim().toLowerCase().split(';');
    const name = token.trim();
    if (!name) continue;
    const qualityParameter = parameters.find(parameter => /^\s*q\s*=/.test(parameter));
    const quality = qualityParameter === undefined ? 1 : Number(qualityParameter.slice(qualityParameter.indexOf('=') + 1));
    if (quality > 0 && quality <= 1) lowestQuality = Math.min(lowestQuality, quality);
    const validQuality = quality >= 0 && quality <= 1 ? quality : 0;
    if (!accepted.has(name) || validQuality > accepted.get(name).quality) {
      accepted.set(name, { quality: validQuality, index });
    }
  }

  // An omitted identity is the fallback. Explicit tokens override the wildcard, even at q=0.
  const wildcard = accepted.get('*');
  const candidates = Object.entries(ENCODING_PREFERENCE).map(([name, preference]) => {
    const explicit = accepted.get(name);
    const fallback = { quality: name === 'identity' ? lowestQuality : 0, index: Infinity };
    return { name, preference, explicit: explicit ? 1 : 0, ...(explicit ?? wildcard ?? fallback) };
  });
  candidates.sort((a, b) => b.quality - a.quality || b.preference - a.preference ||
    b.explicit - a.explicit || a.index - b.index);
  return candidates[0].quality > 0 ? candidates[0].name : 'identity';
}

function appendEncodingVary(res) {
  const vary = res.getHeader('Vary');
  if (String(vary ?? '').split(',').some(field => /^\s*(?:\*|accept-encoding)\s*$/i.test(field))) return;
  res.appendHeader('Vary', 'Accept-Encoding');
}

function setWriteHeadHeaders(res, headers) {
  if (Array.isArray(headers)) {
    if (headers.length % 2 !== 0) throw new TypeError('Expected name/value pairs in writeHead headers');
    // Node's raw header array replaces earlier values while retaining repeated fields.
    for (let i = 0; i < headers.length; i += 2) res.removeHeader(headers[i]);
    for (let i = 0; i < headers.length; i += 2) res.appendHeader(headers[i], headers[i + 1]);
  } else if (headers) {
    for (const name of Object.keys(headers)) res.setHeader(name, headers[name]);
  }
}

export function httpCompression(req, res, next) {
  const { writeHead, write, end, emit } = res;
  let stream;
  let prepared = false;

  function prepare(status, endBytes) {
    if (prepared || res.headersSent || res.destroyed) return;
    prepared = true;

    const encoding = res.getHeader('Content-Encoding');
    if (req.headers.range || (encoding && String(encoding).toLowerCase() !== 'identity')) return;
    if (/(?:^|,)\s*no-transform\s*(?:,|$)/i.test(res.getHeader('Cache-Control') ?? '')) return;
    if (!isCompressible(res)) return;

    appendEncodingVary(res);
    const length = res.getHeader('Content-Length') ?? endBytes;
    if (Number(length) < MIN_BYTES || req.method === 'HEAD' || status < 200 || status === 204 || status === 304) return;
    const method = negotiateEncoding(req.headers['accept-encoding']);
    if (method === 'identity') return;

    stream = COMPRESSORS[method]();
    res.setHeader('Content-Encoding', method);
    res.removeHeader('Content-Length');
    res.once('close', () => stream.destroy());
    stream.on('error', error => res.destroy(error));
    stream.on('data', chunk => {
      if (!write.call(res, chunk)) stream.pause();
    });
    stream.once('end', () => end.call(res));

    // Socket drain resumes compressed output. Producers that write to res wait
    // for zlib's input buffer to drain, using their normal response listeners.
    res.emit = function (event, ...args) {
      if (event !== 'drain') return emit.call(this, event, ...args);
      stream.resume();
      return true;
    };
    stream.on('drain', () => emit.call(res, 'drain'));
  }

  res.writeHead = function (status, reason, headers) {
    if (typeof reason !== 'string') headers = reason;
    setWriteHeadHeaders(this, headers);
    prepare(status);
    return typeof reason === 'string' ? writeHead.call(this, status, reason) : writeHead.call(this, status);
  };

  res.write = function (chunk, encoding, callback) {
    prepare(this.statusCode);
    if (!stream) return write.call(this, chunk, encoding, callback);
    if (stream.writableEnded) return false;
    return stream.write(chunk, encoding, callback);
  };

  res.end = function (chunk, encoding, callback) {
    if (typeof chunk === 'function') {
      callback = chunk;
      chunk = undefined;
    } else if (typeof encoding === 'function') {
      callback = encoding;
      encoding = undefined;
    }
    if (!prepared && !this.headersSent && !this.destroyed) {
      const endBytes = chunk == null || this.hasHeader('Content-Length') ? 0 : Buffer.byteLength(chunk, encoding);
      prepare(this.statusCode, endBytes);
    }
    if (!stream) return end.call(this, chunk, encoding, callback);
    if (stream.writableEnded) return this;
    if (callback) this.once('finish', callback);
    stream.end(chunk, encoding);
    return this;
  };

  next();
}
