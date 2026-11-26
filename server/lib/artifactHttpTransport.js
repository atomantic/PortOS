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
import { SocksClient } from 'socks';

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
    const socks = { host: unbracket(host), port: Number(url.port || 1080), type: 5, userId, password };
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

async function socksSocket({ url, socks }, target, ca, signal) {
  const host = unbracket(target.hostname);
  if (host.length > 255) throw new Error('Artifact hostname is too long for SOCKS5.');
  const destination = url.protocol === 'socks5:' && !isIP(host) ? (await lookup(host)).address : host;
  const negotiation = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
  negotiation.throwIfAborted();
  const socket = new Socket();
  const abort = addAbortListener(negotiation, () => socket.destroy());
  try {
    socket.connect(socks.port, socks.host);
    await once(socket, 'connect', { signal: negotiation });
    await SocksClient.createConnection({
      command: 'connect',
      proxy: socks,
      destination: { host: destination, port: Number(target.port || 443) },
      existing_socket: socket,
    });
    negotiation.throwIfAborted();
    return connectTls({ socket, host, servername: isIP(host) ? undefined : host, ca });
  } catch {
    socket.destroy();
    negotiation.throwIfAborted();
    // The SOCKS client attaches its options, including credentials, to errors.
    throw new Error('Could not establish the SOCKS5 artifact tunnel.');
  } finally {
    abort[Symbol.dispose]();
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
