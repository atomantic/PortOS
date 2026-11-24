import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import { io as connect } from 'socket.io-client';
import { createCosRunner } from './index.js';
import { runnerRequestRefusal } from './requestGuard.js';

const headers = (extra = {}) => ({ host: 'localhost:5558', ...extra });

describe('runner native-client boundary', () => {
  it.each([
    [{}, null],
    [{ host: '127.0.0.1:5558' }, null],
    [{ host: '[::1]:5558' }, null],
    [{ host: '127.0.0.2:5558' }, null],
    [{ host: '127.999.1.1:5558' }, 'HOST_NOT_ALLOWED'],
    [{ host: '::1' }, null],
    [{ 'sec-fetch-mode': 'cors' }, null],
    [{ origin: 'https://attacker.example' }, 'BROWSER_REQUEST_REJECTED'],
    [{ origin: 'http://localhost:5555' }, 'BROWSER_REQUEST_REJECTED'],
    [{ origin: 'null' }, 'BROWSER_REQUEST_REJECTED'],
    [{ 'sec-fetch-site': 'same-origin' }, 'BROWSER_REQUEST_REJECTED'],
    [{ host: 'rebind.attacker.example:5558' }, 'HOST_NOT_ALLOWED'],
    [{ host: 'localhost.attacker.example' }, 'HOST_NOT_ALLOWED'],
    [{ host: 'attacker.example@localhost:5558' }, 'HOST_NOT_ALLOWED'],
    [{ host: 'localhost:5558/path' }, 'HOST_NOT_ALLOWED'],
    [{ host: '[::1]evil' }, 'HOST_NOT_ALLOWED'],
    [{ host: undefined }, 'HOST_NOT_ALLOWED'],
  ])('classifies %j', (extra, expected) => {
    expect(runnerRequestRefusal({ headers: headers(extra) }, { host: undefined })).toBe(expected);
  });

  it('allows only the explicitly configured hostname, never a wildcard bind', () => {
    expect(runnerRequestRefusal({ headers: headers({ host: 'runner.example:5558' }) }, { host: 'runner.example' })).toBeNull();
    for (const host of ['0.0.0.0', '::', '[::]', '*']) {
      expect(runnerRequestRefusal({ headers: headers({ host }) }, { host })).toBe('HOST_NOT_ALLOWED');
      expect(runnerRequestRefusal({ headers: headers({ host: 'attacker.example' }) }, { host })).toBe('HOST_NOT_ALLOWED');
    }
  });
});

// Real runner transports from createCosRunner with no real agents spawned:
// verifies the actual Express middleware ordering and Socket.IO engine guard.
describe('runner HTTP and Socket.IO admission', () => {
  let runner;
  const clients = [];

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    if (runner) {
      await new Promise(resolve => runner.io.close(resolve));
      runner.server.closeAllConnections?.();
      runner = null;
    }
    vi.restoreAllMocks();
  });

  const fixture = async () => {
    runner = createCosRunner({
      port: 0,
      host: '127.0.0.1',
      orphanCleanupDelayMs: -1,
      existsSync: () => true,
      ensureDir: async () => {},
      adoptNpmGlobalBinDir: vi.fn(async () => {}),
    });
    const { port } = await runner.start(0, '127.0.0.1');
    return { runner, url: `http://127.0.0.1:${port}` };
  };

  const httpRequest = (url, extra, path = '/terminate-all', method = 'POST', rawBody = '') => new Promise((resolve, reject) => {
    const req = request(`${url}${path}`, { method, headers: extra }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end(rawBody);
  });

  it('refuses no-preflight POSTs and rebind Hosts before routes or JSON parsing', async () => {
    const { url } = await fixture();
    for (const extra of [{ Origin: 'https://attacker.example' }, { 'Sec-Fetch-Site': 'same-origin' }, { Host: 'attacker.example:5558' }]) {
      // Malformed JSON still gets 403 from runnerRequestGuard, proving it runs ahead of express.json().
      const response = await httpRequest(url, { 'Content-Type': 'application/json', ...extra }, '/terminate-all', 'POST', '{bad json');
      expect(response.status).toBe(403);
      expect(JSON.parse(response.body).code).toMatch(/REJECTED|NOT_ALLOWED/);
    }
    const native = await fetch(`${url}/terminate-all`, { method: 'POST' });
    expect(native.status).toBe(200);
    expect(await native.json()).toEqual({ success: true, killed: 0 });
  });

  it.each(['polling', 'websocket'])('rejects browser and rebind %s handshakes; preserves native TUI relay', async transport => {
    const { runner: instance, url } = await fixture();
    const hostileHeaders = [{ Origin: 'https://attacker.example' }, { Origin: 'http://localhost:5555' }, { 'Sec-Fetch-Site': 'same-origin' }];
    // The polling client's XMLHttpRequest implementation strips Host overrides.
    // Use raw HTTP for that handshake so the hostile header reaches the server.
    if (transport === 'polling') {
      expect((await httpRequest(url, { Host: 'attacker.example:5558' }, '/socket.io/?EIO=4&transport=polling', 'GET')).status).toBe(403);
    } else hostileHeaders.push({ Host: 'attacker.example:5558' });
    for (const extraHeaders of hostileHeaders) {
      const client = connect(url, { transports: [transport], extraHeaders, reconnection: false, timeout: 2000 });
      clients.push(client);
      const result = await new Promise(resolve => {
        client.once('connect', () => resolve('connected'));
        client.once('connect_error', () => resolve('refused'));
      });
      expect(result, JSON.stringify(extraHeaders)).toBe('refused');
    }

    const write = vi.fn();
    instance.activeAgents.set('synthetic-agent', {
      kind: 'tui',
      sessionId: 'synthetic-session',
      promptSubmitted: null,
      process: { write },
    });

    const serverSocketReady = new Promise(resolve => instance.io.once('connection', resolve));
    const client = connect(url, { transports: [transport], reconnection: false, timeout: 2000 });
    clients.push(client);
    await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
    const serverSocket = await serverSocketReady;

    const relayed = new Promise(resolve => {
      serverSocket.once('tui:input', () => queueMicrotask(resolve));
    });
    client.emit('tui:input', { sessionId: 'synthetic-session', data: 'synthetic-input' });
    await relayed;
    expect(write).toHaveBeenCalledWith('synthetic-input');

    // An already-issued sid does not bypass the HTTP guard on later packets.
    const response = await httpRequest(url, { Origin: 'https://attacker.example' }, `/socket.io/?EIO=4&transport=polling&sid=${client.io.engine.id}`);
    expect(response.status).toBe(403);
  });
});
