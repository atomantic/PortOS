import { describe, it, expect, afterEach } from 'vitest';
import net from 'net';
import { isMachineOnline, isPortReachable } from './connectivity.js';

// Spin up a real loopback TCP server so the "connects" path is exercised
// without hitting the public internet; a closed loopback port gives a fast,
// deterministic "refused" for the failure path.
function listenOnEphemeralPort() {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => socket.end());
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function findClosedPort() {
  // Bind then immediately release so nothing is listening on the returned port.
  const { server, port } = await listenOnEphemeralPort();
  await new Promise((r) => server.close(r));
  return port;
}

describe('isMachineOnline', () => {
  const servers = [];
  afterEach(async () => {
    while (servers.length) {
      const s = servers.pop();
      await new Promise((r) => s.close(r));
    }
  });

  it('resolves true when a probe host connects', async () => {
    const { server, port } = await listenOnEphemeralPort();
    servers.push(server);
    const online = await isMachineOnline({ hosts: [{ host: '127.0.0.1', port }], timeoutMs: 1000 });
    expect(online).toBe(true);
  });

  it('resolves false when every probe host fails', async () => {
    const closed = await findClosedPort();
    const online = await isMachineOnline({ hosts: [{ host: '127.0.0.1', port: closed }], timeoutMs: 1000 });
    expect(online).toBe(false);
  });

  it('resolves true if ANY host connects even when another fails', async () => {
    const { server, port } = await listenOnEphemeralPort();
    servers.push(server);
    const closed = await findClosedPort();
    const online = await isMachineOnline({
      hosts: [{ host: '127.0.0.1', port: closed }, { host: '127.0.0.1', port }],
      timeoutMs: 1000,
    });
    expect(online).toBe(true);
  });

  it('resolves false (never rejects) for an empty host list', async () => {
    await expect(isMachineOnline({ hosts: [] })).resolves.toBe(false);
  });

  it('resolves false within the timeout for an unreachable (non-routable) host', async () => {
    // 192.0.2.1 is TEST-NET-1 (RFC 5737) — guaranteed non-routable, so the
    // connect never completes and must resolve false via the timeout path.
    const start = Date.now();
    const online = await isMachineOnline({ hosts: [{ host: '192.0.2.1', port: 443 }], timeoutMs: 300 });
    expect(online).toBe(false);
    expect(Date.now() - start).toBeLessThan(3000);
  });
});

describe('isPortReachable', () => {
  it('resolves true only while something is actually listening on the port', async () => {
    const { server, port } = await listenOnEphemeralPort();
    await expect(isPortReachable({ port })).resolves.toBe(true);
    await new Promise((resolve) => server.close(resolve));
    await expect(isPortReachable({ port })).resolves.toBe(false);
  });

  it('never rejects, and refuses an out-of-range port without dialing', async () => {
    await expect(isPortReachable({ port: 0 })).resolves.toBe(false);
    await expect(isPortReachable({ port: 70_000 })).resolves.toBe(false);
    await expect(isPortReachable()).resolves.toBe(false);
  });
});
