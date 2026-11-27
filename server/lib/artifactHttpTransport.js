// Creates a scoped HTTPS artifact transport with proxy routing and optional CA files or directories.
import { lookup } from 'node:dns/promises';
import { addAbortListener, once } from 'node:events';
import { readFile, readdir, stat } from 'node:fs/promises';
import { Agent, get } from 'node:https';
import { isIP, Socket } from 'node:net';
import { delimiter, join } from 'node:path';
import { Readable } from 'node:stream';
import { connect as connectTls, getCACertificates } from 'node:tls';
import { domainToASCII } from 'node:url';

const HTTP_PROXY_PROTOCOLS = ['http:', 'https:'];
const SOCKS_PROXY_PROTOCOLS = ['socks5:', 'socks5h:'];
const unbracket = (host) => host.replace(/^\[(.*)\]$/, '$1');
const pemCertificates = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

function parseProxy(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(value) || /[\r\n\t]/.test(value) || !url.hostname || url.port === '0'
      || (url.pathname && url.pathname !== '/') || url.search || url.hash
      || ![...HTTP_PROXY_PROTOCOLS, ...SOCKS_PROXY_PROTOCOLS].includes(url.protocol)) {
      throw new TypeError();
    }
    // Reject malformed escapes before either proxy connector consumes them.
    const userId = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    if (HTTP_PROXY_PROTOCOLS.includes(url.protocol)) return { url };
    const host = domainToASCII(url.hostname);
    if (!host || Buffer.byteLength(userId) > 255 || Buffer.byteLength(password) > 255) throw new TypeError();
    const socks = { host: unbracket(host), port: Number(url.port || 1080), userId, password };
    return { url, socks };
  } catch {
    throw new TypeError('Invalid artifact proxy. Configure an HTTP, HTTPS, SOCKS5 or SOCKS5h proxy URL.');
  }
}

async function readTrust(env, signal) {
  const file = env.CURL_CA_BUNDLE || env.SSL_CERT_FILE;
  if (!file && !env.SSL_CERT_DIR) return undefined;
  try {
    const base = file ? [await readFile(file, { signal })] : getCACertificates('default');
    const certificates = new Set();
    for (const directory of (env.SSL_CERT_DIR || '').split(delimiter).filter(Boolean)) {
      for (const name of await readdir(directory)) {
        signal?.throwIfAborted();
        // OpenSSL CA directories may use hash-named symlinks to PEM files.
        if (!/\.(?:pem|crt|cer)$/i.test(name) && !/^[a-f\d]{8}\.\d+$/i.test(name)) continue;
        const path = join(directory, name);
        if (!(await stat(path, { throwIfNoEntry: false }))?.isFile()) continue;
        const content = await readFile(path, { encoding: 'utf8', signal });
        for (const certificate of content.match(pemCertificates) || []) certificates.add(certificate);
      }
    }
    if (env.SSL_CERT_DIR && !certificates.size) throw new Error();
    return [...base, ...certificates];
  } catch {
    signal?.throwIfAborted();
    throw new TypeError('Could not load artifact CA certificates. Check CURL_CA_BUNDLE, SSL_CERT_FILE and SSL_CERT_DIR.');
  }
}

function bypassSocksProxy(url, exclusions) {
  const host = unbracket(url.hostname).toLowerCase();
  return exclusions.split(/[\s,]+/).some((exclusion) => {
    if (exclusion === '*') return true;
    if (!exclusion) return false;
    const port = isIP(unbracket(exclusion)) ? null : exclusion.match(/:(\d+)$/);
    if (port && port[1] !== (url.port || '443')) return false;
    const domain = unbracket(port ? exclusion.slice(0, port.index) : exclusion).toLowerCase().replace(/^\*?\./, '');
    return host === domain || (!isIP(host) && host.endsWith('.' + domain));
  });
}

function socksAddress(host) {
  const family = isIP(host);
  if (family === 4) return Buffer.from([1, ...host.split('.').map(Number)]);
  if (family === 6) {
    // URL canonicalizes any dotted IPv4 tail into 16-bit IPv6 groups.
    const [left, right] = unbracket(new URL(`http://[${host}]`).hostname).split('::');
    const prefix = left ? left.split(':') : [];
    const suffix = right ? right.split(':') : [];
    const address = Buffer.alloc(17);
    address[0] = 4;
    prefix.forEach((group, index) => address.writeUInt16BE(parseInt(group, 16), 1 + index * 2));
    suffix.forEach((group, index) => address.writeUInt16BE(parseInt(group, 16), 17 - (suffix.length - index) * 2));
    return address;
  }
  return Buffer.concat([Buffer.from([3, Buffer.byteLength(host)]), Buffer.from(host)]);
}

async function readSocksBytes(socket, length, signal) {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    signal.throwIfAborted();
    // Drain partial frames so 'readable' waits for new bytes.
    const chunk = socket.read(Math.min(length - offset, socket.readableLength));
    if (chunk) offset += chunk.copy(bytes, offset);
    else await once(socket, 'readable', { signal });
  }
  return bytes;
}

async function negotiateSocks5(socket, credentials, destination, port, signal) {
  const read = (length) => readSocksBytes(socket, length, signal);
  const methods = credentials.userId || credentials.password ? [0, 2] : [0];
  socket.write(Buffer.from([5, methods.length, ...methods]));
  const [version, method] = await read(2);
  if (version !== 5 || !methods.includes(method)) throw new Error('Invalid SOCKS5 method selection.');

  if (method === 2) {
    const userId = Buffer.from(credentials.userId);
    const password = Buffer.from(credentials.password);
    socket.write(Buffer.concat([Buffer.from([1, userId.length]), userId, Buffer.from([password.length]), password]));
    const [authVersion, status] = await read(2);
    if (authVersion !== 1 || status !== 0) throw new Error('SOCKS5 authentication failed.');
  }

  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port);
  socket.write(Buffer.concat([Buffer.from([5, 1, 0]), socksAddress(destination), portBytes]));
  const [replyVersion, status, reserved, type] = await read(4);
  if (replyVersion !== 5 || status !== 0 || reserved !== 0) throw new Error('Invalid SOCKS5 CONNECT reply.');

  // Consume exactly BND.ADDR and BND.PORT before giving the socket to TLS.
  const addressLength = type === 3 ? (await read(1))[0] : { 1: 4, 4: 16 }[type];
  if (!addressLength) throw new Error('Invalid SOCKS5 bound address.');
  await read(addressLength + 2);
}

async function socksSocket({ url, socks }, target, ca, signal) {
  const host = unbracket(target.hostname);
  if (Buffer.byteLength(host) > 255) throw new Error('Artifact hostname is too long for SOCKS5.');
  signal?.throwIfAborted();
  const destination = url.protocol === 'socks5:' && !isIP(host) ? (await lookup(host)).address : host;
  const negotiation = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
  negotiation.throwIfAborted();
  const socket = new Socket();
  const abort = addAbortListener(negotiation, () => socket.destroy());
  const closed = new AbortController();
  const onEnd = () => closed.abort();
  socket.once('end', onEnd);
  socket.once('close', onEnd);
  const handshakeSignal = AbortSignal.any([negotiation, closed.signal]);
  try {
    socket.connect(socks.port, socks.host);
    await once(socket, 'connect', { signal: handshakeSignal });
    await negotiateSocks5(socket, socks, destination, Number(target.port || 443), handshakeSignal);
    negotiation.throwIfAborted();
    return connectTls({ socket, host, servername: isIP(host) ? undefined : host, ca });
  } catch {
    socket.destroy();
    negotiation.throwIfAborted();
    throw new Error('Could not establish the SOCKS5 artifact tunnel.');
  } finally {
    abort[Symbol.dispose]();
    socket.off('end', onEnd);
    socket.off('close', onEnd);
  }
}

export async function createArtifactHttpTransport(env, { signal } = {}) {
  const proxy = parseProxy(env.https_proxy || env.HTTPS_PROXY || env.all_proxy || env.ALL_PROXY);
  const ca = await readTrust(env, signal);
  if (!proxy && !ca) return fetch;

  const noProxy = env.no_proxy || env.NO_PROXY || '';
  const httpProxy = proxy && !proxy.socks;
  const agent = new Agent({
    keepAlive: false,
    proxyEnv: httpProxy ? { HTTPS_PROXY: proxy.url.href, NO_PROXY: noProxy } : undefined,
    ca,
  });
  return (url, options) => new Promise((resolve, reject) => {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.username || target.password) {
      throw new TypeError('Artifact requests require an HTTPS URL without credentials.');
    }
    const route = proxy?.socks && !bypassSocksProxy(target, noProxy)
      ? { createConnection: (_options, callback) => {
        socksSocket(proxy, target, ca, options.signal).then(socket => callback(null, socket), callback);
      } }
      : { agent };
    const request = get(target, { ...route, headers: options.headers, signal: options.signal }, (response) => {
      const { statusCode: status, statusMessage: statusText } = response;
      resolve({
        status, statusText, ok: status >= 200 && status < 300,
        headers: new Headers(response.headers),
        body: Readable.toWeb(response),
      });
    });
    request.on('error', reject);
  });
}
