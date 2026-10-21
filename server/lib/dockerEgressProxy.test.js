import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { request } from 'node:http';
import { DOCKER_EGRESS_PROXY_READY, DOCKER_EGRESS_PROXY_SOURCE, decideEgressConnect, isNonPublicAddress } from './dockerEgressProxy.js';

describe('egress proxy decisions', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.17.0.1', '192.168.1.5', '100.100.1.1', '169.254.169.254', '0.0.0.0', '224.0.0.1',
    '::1', 'fd7a:115c:a1e0::1', 'fe80::1', '::ffff:192.168.1.5',
  ])('treats %s as non-public', (address) => expect(isNonPublicAddress(address)).toBe(true));

  it.each(['104.16.1.34', '2606:4700::6810:122'])('treats %s as public', (address) => expect(isNonPublicAddress(address)).toBe(false));

  it('allows only allowlisted host names on allowed ports', () => {
    const policy = { allow: ['registry.npmjs.org'], ports: [443] };
    expect(decideEgressConnect('registry.npmjs.org:443', policy)).toEqual({ host: 'registry.npmjs.org', port: 443 });
    expect(decideEgressConnect('Registry.NPMJS.org.:443', policy)).toEqual({ host: 'registry.npmjs.org', port: 443 });
    expect(decideEgressConnect('registry.npmjs.org:22', policy).refused).toMatch(/port/);
    expect(decideEgressConnect('evil.example.com:443', policy).refused).toMatch(/allowlist/);
    expect(decideEgressConnect('104.16.1.34:443', policy).refused).toMatch(/IP-literal/);
    expect(decideEgressConnect('[::1]:443', policy).refused).toMatch(/malformed/);
  });
});

// The same program the proxy container runs, on the host, against loopback.
describe('egress proxy program', () => {
  let proxy;
  let port;
  let target;
  beforeAll(async () => {
    target = createServer((socket) => socket.end('reached')).listen(0, '127.0.0.1');
    await new Promise((resolve) => { target.once('listening', resolve); });
    proxy = spawn(process.execPath, ['-e', DOCKER_EGRESS_PROXY_SOURCE], {
      env: { PORTOS_EGRESS_ALLOW: 'localhost', PORTOS_EGRESS_PORTS: String(target.address().port), PORTOS_EGRESS_PORT: '0', PORTOS_EGRESS_LISTEN: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((resolve, reject) => {
      proxy.on('error', reject);
      proxy.stdout.on('data', (chunk) => {
        const ready = new RegExp(`${DOCKER_EGRESS_PROXY_READY} on (\\d+)`).exec(String(chunk));
        if (ready) { port = Number(ready[1]); resolve(); }
      });
    });
  });
  afterAll(() => { proxy?.kill('SIGKILL'); target?.close(); });

  const tunnel = (authority) => new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
    let data = '';
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });

  it('refuses an allowlisted name that resolves to a non-public address', async () => {
    expect(await tunnel(`localhost:${target.address().port}`)).toMatch(/^HTTP\/1\.1 403[\s\S]*non-public address/);
  });

  it('refuses a name outside the allowlist and a disallowed port', async () => {
    expect(await tunnel(`example.com:${target.address().port}`)).toMatch(/403[\s\S]*not on the egress allowlist/);
    expect(await tunnel('localhost:443')).toMatch(/403[\s\S]*port 443 is not allowed/);
  });

  it('refuses plain-HTTP proxying', async () => {
    const status = await new Promise((resolve, reject) => {
      request({ host: '127.0.0.1', port, path: 'http://localhost/', method: 'GET' }, (res) => { res.resume(); resolve(res.statusCode); })
        .on('error', reject).end();
    });
    expect(status).toBe(403);
  });
});
