import { execFile, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as httpsServer } from 'node:https';
import { createServer as httpServer } from 'node:http';
import { connect, createServer as tcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';
import { inspect, promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createArtifactHttpTransport } from './artifactHttpTransport.js';
import { partialPathFor, streamResumableDownload } from './downloadPreflight.js';
import { sha256Text } from './fileCore.js';

let root;
let caFile;
let caDir;
let tls;
const stopServers = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'artifact-transport-'));
  const config = join(root, 'openssl.cnf');
  const key = join(root, 'key.pem');
  caFile = join(root, 'certificate.pem');
  caDir = join(root, 'certs');
  await writeFile(config, `[req]
distinguished_name = dn
x509_extensions = extensions
prompt = no
[dn]
CN = artifact.invalid
[extensions]
subjectAltName = DNS:artifact.invalid, DNS:localhost, IP:127.0.0.1, IP:2001:db8::7
basicConstraints = critical,CA:TRUE
`);
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', key, '-out', caFile, '-days', '2', '-config', config,
  ], { stdio: 'ignore' });
  tls = { key: await readFile(key), cert: await readFile(caFile) };
  await mkdir(caDir);
  // Use the layout of an OpenSSL hashed certificate directory.
  await writeFile(join(caDir, 'aabbccdd.0'), tls.cert);
});

afterEach(async () => {
  await Promise.all(stopServers.splice(0).map(stop => stop()));
  await rm(root, { recursive: true, force: true });
});

async function listen(server) {
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  stopServers.push(() => {
    const closed = once(server, 'close');
    server.close();
    for (const socket of sockets) socket.destroy();
    return closed;
  });
  return server.address().port;
}

async function readBytes(socket, length) {
  const bytes = Buffer.alloc(length);
  for (let offset = 0; offset < length;) {
    const chunk = socket.read(Math.min(length - offset, socket.readableLength));
    if (chunk) {
      offset += chunk.copy(bytes, offset);
      continue;
    }
    await once(socket, 'readable');
  }
  return bytes;
}

function relay(socket, port, handshakeReply) {
  const origin = connect(port, '127.0.0.1', () => {
    socket.write(handshakeReply);
    socket.pipe(origin).pipe(socket);
  });
  origin.on('error', () => socket.destroy());
  socket.on('close', () => origin.destroy());
}

async function selectMethod(socket, credentials) {
  const [version, count] = await readBytes(socket, 2);
  const methods = await readBytes(socket, count);
  expect(version).toBe(5);
  expect([...methods]).toEqual(credentials ? [0, 2] : [0]);
  socket.write(Buffer.from([5, credentials ? 2 : 0]));
  if (credentials) {
    const [authVersion, usernameLength] = await readBytes(socket, 2);
    const username = await readBytes(socket, usernameLength);
    const [passwordLength] = await readBytes(socket, 1);
    const password = await readBytes(socket, passwordLength);
    expect(authVersion).toBe(1);
    expect(username.toString()).toBe(credentials.username);
    expect(password.toString()).toBe(credentials.password);
    socket.write(Buffer.from([1, 0]));
  }
}

async function readTarget(socket) {
  const [replyVersion, command, , addressType] = await readBytes(socket, 4);
  if (replyVersion !== 5 || command !== 1) throw new Error('Expected SOCKS5 CONNECT');
  let hostname;
  if (addressType === 3) {
    const [length] = await readBytes(socket, 1);
    hostname = (await readBytes(socket, length)).toString();
  } else if (addressType === 1) {
    hostname = (await readBytes(socket, 4)).join('.');
  } else if (addressType === 4) {
    hostname = (await readBytes(socket, 16)).toString('hex');
  } else {
    throw new Error('Unexpected SOCKS5 address type');
  }
  const port = (await readBytes(socket, 2)).readUInt16BE();
  return { addressType, hostname, port };
}

async function negotiate(socket, originPort, targets) {
  await selectMethod(socket);
  targets.push(await readTarget(socket));
  relay(socket, originPort, Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
}

it('uses proxy-side DNS, promptly cancels a SOCKS5h download and resumes the pinned bytes', async () => {
  const requests = [];
  const originPort = await listen(httpsServer(tls, (req, res) => {
    requests.push([req.headers.range, req.headers['if-range']]);
    if (req.headers.range) {
      res.writeHead(206, { 'Content-Range': 'bytes 3-5/6', 'Content-Length': 3 });
      res.end('def');
    } else {
      res.writeHead(200, { ETag: '"fixture"', 'Content-Length': 6 });
      res.write('abc');
    }
  }));
  const targets = [];
  const proxy = tcpServer(socket => {
    negotiate(socket, originPort, targets).catch(() => socket.destroy());
  });
  const proxyPort = await listen(proxy);
  const fetchImpl = await createArtifactHttpTransport({
    ALL_PROXY: 'socks5h://127.0.0.1:' + proxyPort,
    SSL_CERT_DIR: caDir,
  });
  const controller = new AbortController();
  const url = 'https://artifact.invalid:' + originPort;
  const destPath = join(root, 'checkpoint');
  const expectedSha256 = sha256Text('abcdef');
  const transfer = { url, destPath, fetchImpl, expectedSha256 };
  const socketClosed = once(proxy, 'connection').then(([socket]) => once(socket, 'close'));
  const first = streamResumableDownload({ ...transfer, signal: controller.signal }).catch(error => error);
  try {
    await vi.waitFor(async () => expect(await readFile(partialPathFor(destPath), 'utf8')).toBe('abc'));
  } finally {
    controller.abort();
  }
  expect(await first).toMatchObject({ name: 'AbortError' });
  await socketClosed;

  await streamResumableDownload(transfer);
  expect(await readFile(destPath, 'utf8')).toBe('abcdef');
  expect(requests).toEqual([[undefined, undefined], ['bytes=3-', '"fixture"']]);
  const expectedTarget = { addressType: 3, hostname: 'artifact.invalid', port: originPort };
  expect(targets).toEqual([expectedTarget, expectedTarget]);
});

it('closes a SOCKS5h connection when cancelled before the proxy answers', async () => {
  const proxy = tcpServer(socket => socket.resume());
  const port = await listen(proxy);
  const fetchImpl = await createArtifactHttpTransport({ ALL_PROXY: 'socks5h://127.0.0.1:' + port });
  const controller = new AbortController();
  const socketClosed = once(proxy, 'connection').then(async ([socket]) => {
    await once(socket, 'data'); // The server leaves the SOCKS greeting unanswered.
    const closed = once(socket, 'close');
    controller.abort();
    await closed;
  });
  await expect(fetchImpl('https://artifact.invalid', { signal: controller.signal }))
    .rejects.toMatchObject({ name: 'AbortError' });
  await socketClosed;
});

it('resolves SOCKS5 destinations locally and honours NO_PROXY before opening the proxy', async () => {
  const originPort = await listen(httpsServer(tls, (_req, res) => res.end('fixture')));
  const targets = [];
  const proxyPort = await listen(tcpServer(socket => {
    negotiate(socket, originPort, targets).catch(() => socket.destroy());
  }));
  const fetchImpl = await createArtifactHttpTransport({
    all_proxy: 'socks5://127.0.0.1:' + proxyPort,
    no_proxy: '127.0.0.1:' + originPort,
    CURL_CA_BUNDLE: caFile,
  });
  for (const hostname of ['localhost', '127.0.0.1']) {
    const response = await fetchImpl('https://' + hostname + ':' + originPort, {});
    expect(response.ok).toBe(true);
    await response.body.cancel();
  }
  expect(targets).toHaveLength(1);
  expect(targets[0].port).toBe(originPort);
  expect([1, 4]).toContain(targets[0].addressType);
});

const credentials = { username: 'fixture@é', password: 'secret:/🔒' };
const proxyUserInfo = [credentials.username, credentials.password].map(encodeURIComponent).join(':');

it.each([
  ['socks5', '127.0.0.1', 1, '127.0.0.1', [4, ...Buffer.alloc(16)]],
  ['socks5h', '[2001:db8::7]', 4, '20010db8000000000000000000000007', [3, 4, ...Buffer.from('bind')]],
])('authenticates over %s and reads the full proxy reply before TLS', async (protocol, host, addressType, hostname, bound) => {
  const originPort = await listen(httpsServer(tls, (_req, res) => res.end('fixture')));
  const targets = [];
  const proxyPort = await listen(tcpServer(async socket => {
    try {
      await selectMethod(socket, credentials);
      targets.push(await readTarget(socket));
      socket.write(Buffer.from([5, 0, 0]));
      relay(socket, originPort, Buffer.from([...bound, 0, 0]));
    } catch {
      socket.destroy();
    }
  }));
  const transport = await createArtifactHttpTransport({
    ALL_PROXY: protocol + '://' + proxyUserInfo + '@127.0.0.1:' + proxyPort,
    SSL_CERT_FILE: caFile,
  });
  const response = await transport('https://' + host + ':' + originPort, {});
  expect(response.ok).toBe(true);
  await response.body.cancel();
  expect(targets).toEqual([{ addressType, hostname, port: originPort }]);
});

it.each([
  ['an unsupported address type', [5, 0, 0, 2, 0, 0], false],
  ['a nonzero reserved byte', [5, 0, 1, 1, 127, 0, 0, 1, 0, 0], false],
  ['a truncated bound address', [5, 0, 0, 4, 1], true],
])('rejects %s without leaking the proxy credentials', async (_description, bytes, truncated) => {
  const targets = [];
  const proxy = tcpServer(async socket => {
    try {
      await selectMethod(socket, credentials);
      targets.push(await readTarget(socket));
      socket.resume();
      if (truncated) socket.end(Buffer.from(bytes));
      else socket.write(Buffer.from(bytes));
    } catch {
      socket.destroy();
    }
  });
  const proxyPort = await listen(proxy);
  const transport = await createArtifactHttpTransport({ ALL_PROXY: 'socks5h://' + proxyUserInfo + '@127.0.0.1:' + proxyPort });
  const socketClosed = once(proxy, 'connection').then(([socket]) => once(socket, 'close'));
  const error = await transport('https://artifact.invalid', {}).catch(error => error);
  expect(error).toEqual(new Error('Could not establish the SOCKS5 artifact tunnel.'));
  const details = inspect(error, { showHidden: true, depth: null });
  expect(details).not.toContain(credentials.username);
  expect(details).not.toContain(credentials.password);
  expect(details).not.toContain(proxyUserInfo);
  await socketClosed;
  expect(targets).toEqual([{ addressType: 3, hostname: 'artifact.invalid', port: 443 }]);
});

it('rejects unsupported or malformed proxies before reaching the origin', async () => {
  for (const ALL_PROXY of ['socks4://proxy.example.com:1080', 'http://', 'https://proxy.example.com:0']) {
    await expect(createArtifactHttpTransport({ ALL_PROXY })).rejects.toThrow('Invalid artifact proxy');
  }
});

it('keeps certificate trust scoped and accepts the directory or either explicit CA-file setting', async () => {
  const port = await listen(httpsServer(tls, (_req, res) => res.end('fixture')));
  const url = 'https://127.0.0.1:' + port;
  const defaultTransport = await createArtifactHttpTransport({});
  await expect(defaultTransport(url)).rejects.toThrow();
  for (const env of [{ SSL_CERT_DIR: caDir }, { CURL_CA_BUNDLE: caFile }, { SSL_CERT_FILE: caFile }]) {
    const transport = await createArtifactHttpTransport(env);
    const response = await transport(url, {});
    expect(response.ok).toBe(true);
    await response.body.cancel();
  }
  await expect(defaultTransport(url)).rejects.toThrow();
});

it('keeps Node default roots when extending trust with a CA directory', async () => {
  const port = await listen(httpsServer(tls, (_req, res) => res.end('fixture')));
  // This directory cannot validate the fixture. Its root comes from the
  // child process's normal startup trust store.
  await writeFile(join(caDir, 'aabbccdd.0'), rootCertificates[0]);
  const moduleUrl = new URL('./artifactHttpTransport.js', import.meta.url).href;
  const source = `
    import { createArtifactHttpTransport } from ${JSON.stringify(moduleUrl)};
    const [url, directory] = process.argv.slice(1);
    const transport = await createArtifactHttpTransport({ SSL_CERT_DIR: directory });
    const response = await transport(url, {});
    if (!response.ok) process.exitCode = 1;
    await response.body.cancel();
  `;
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source, 'https://127.0.0.1:' + port, caDir], {
    env: { ...process.env, NODE_EXTRA_CA_CERTS: caFile },
  });
});

it('continues to use an HTTP CONNECT proxy for HTTPS artifacts', async () => {
  const originPort = await listen(httpsServer(tls, (_req, res) => res.end('fixture')));
  const connects = [];
  const proxy = httpServer();
  proxy.on('connect', (request, socket) => {
    connects.push(request.url);
    relay(socket, originPort, 'HTTP/1.1 200 Connection Established\r\n\r\n');
  });
  const proxyPort = await listen(proxy);
  const transport = await createArtifactHttpTransport({
    HTTPS_PROXY: 'http://127.0.0.1:' + proxyPort,
    ALL_PROXY: 'socks4://proxy.example.com:1080',
    SSL_CERT_FILE: caFile,
  });
  const response = await transport('https://artifact.invalid:' + originPort, {});
  expect(response.ok).toBe(true);
  await response.body.cancel();
  expect(connects).toEqual(['artifact.invalid:' + originPort]);
});
