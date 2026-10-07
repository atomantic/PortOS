/**
 * portos-api CLI: argv parsing (the part an agent gets wrong silently — a body
 * that never reaches the request, or a path missing its /api prefix) and which
 * credential wins when both the spawn env and the key file are present.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { main, parseArgs, resolveCredentials } from './portos-api.js';

describe('parseArgs', () => {
  it('builds a CoS task from the task shorthand', () => {
    const parsed = parseArgs(['task', 'Fix', 'the', 'upload', 'test', '--app', 'portos', '--priority', 'high']);
    expect(parsed).toMatchObject({ method: 'POST', path: '/api/cos/tasks' });
    expect(JSON.parse(parsed.body)).toEqual({ description: 'Fix the upload test', app: 'portos', priority: 'HIGH' });
  });

  it('prefixes /api, and reads inline, @file and stdin bodies', () => {
    expect(parseArgs(['get', 'cos/tasks'])).toEqual({ method: 'GET', path: '/api/cos/tasks', body: null });
    expect(parseArgs(['get', '/data/images/x.png']).path).toBe('/data/images/x.png');
    expect(parseArgs(['post', '/api/x', '{"a":1}']).body).toBe('{"a":1}');
    expect(parseArgs(['post', '/api/x', '@brief.json']).body).toEqual({ file: 'brief.json' });
    expect(parseArgs(['put', '/api/x', '-']).body).toEqual({ stdin: true });
  });

  it('rejects what it cannot send', () => {
    expect(() => parseArgs(['task'])).toThrow(/description/);
    expect(() => parseArgs(['task', 'x', '--priority', 'urgent'])).toThrow(/priority/);
    expect(() => parseArgs(['fetch', '/api/x'])).toThrow(/Unknown command/);
    expect(() => parseArgs(['post'])).toThrow(/needs a path/);
    for (const timeout of ['0', '-1', 'NaN', 'Infinity', '2147484']) {
      expect(() => parseArgs(['get', '/api/x', '--timeout', timeout])).toThrow(/--timeout/);
    }
  });

  it('accepts a seconds deadline for every command without putting it into the task body', () => {
    expect(parseArgs(['get', '/api/x', '--timeout', '3600']).timeoutMs).toBe(3_600_000);
    expect(parseArgs(['whoami', '--timeout', '10']).timeoutMs).toBe(10_000);
    const task = parseArgs(['task', 'Example task', '--timeout', '60']);
    expect(task.timeoutMs).toBe(60_000);
    expect(JSON.parse(task.body)).toEqual({ description: 'Example task' });
  });
});

describe('API request lifecycle', () => {
  let server;
  afterEach(async () => {
    server?.closeAllConnections();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('waits beyond five minutes for headers and body, then enforces and cleans up an explicit deadline', async () => {
    // Advance only the request deadline; a real local HTTP socket exercises the transport.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let received;
    const nextRequest = () => new Promise(resolve => { received = resolve; });
    server = createServer((request, response) => {
      const chunks = [];
      request.on('data', chunk => chunks.push(chunk));
      request.on('end', () => received({ request, response, body: Buffer.concat(chunks).toString('utf8') }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const env = {
      PORTOS_URL: `http://127.0.0.1:${server.address().port}`,
      PORTOS_API_TOKEN: 'synthetic-agent-token',
      PORTOS_AGENT_KEY_FILE: join(tmpdir(), 'portos-missing-key.json'),
    };
    const incoming = nextRequest();
    let complete = false;
    const command = main(['post', '/api/example', '{"example":true}'], env).then(code => { complete = true; return code; });
    const { request, response, body } = await incoming;
    expect(request.headers.authorization).toBe('Bearer synthetic-agent-token');
    expect(request.headers['content-type']).toBe('application/json');
    expect(body).toBe('{"example":true}');
    await vi.advanceTimersByTimeAsync(300_001);
    expect(complete).toBe(false);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{"done":');
    await vi.advanceTimersByTimeAsync(300_001);
    expect(complete).toBe(false);
    response.end('true}');
    await expect(command).resolves.toBe(0);
    expect(log).toHaveBeenCalledWith(JSON.stringify({ done: true }, null, 2));
    expect(vi.getTimerCount()).toBe(0);

    const stalled = nextRequest();
    const timeout = expect(main(['get', '/api/example', '--timeout', '30'], env))
      .rejects.toThrow('Request timed out after 30 seconds; server work may still be running.');
    const pending = await stalled;
    pending.response.writeHead(200);
    pending.response.write('unfinished body');
    await vi.advanceTimersByTimeAsync(30_000);
    await timeout;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports a refusal and missing credentials without presenting it as a transport failure', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    server = createServer((_request, response) => {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end('{"code":"AUTH_REQUIRED"}');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await expect(main(['whoami'], {
      PORTOS_URL: `http://127.0.0.1:${server.address().port}`,
      PORTOS_AGENT_KEY_FILE: join(tmpdir(), 'portos-missing-key.json'),
    })).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith('❌ GET /api/auth/whoami → 401');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('AUTH_REQUIRED'));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('No credential found'));
  });
});

describe('resolveCredentials', () => {
  let dir;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  it('reads the key file, with PORTOS_API_TOKEN and PORTOS_URL taking precedence', async () => {
    dir = await mkdtemp(join(tmpdir(), 'portos-api-cli-'));
    const file = join(dir, 'agent-key.json');
    await writeFile(file, JSON.stringify({ url: 'http://127.0.0.1:5553/', token: 'from-file' }));

    await expect(resolveCredentials({ PORTOS_AGENT_KEY_FILE: file }))
      .resolves.toEqual({ url: 'http://127.0.0.1:5553', token: 'from-file' });
    await expect(resolveCredentials({ PORTOS_AGENT_KEY_FILE: file, PORTOS_API_TOKEN: 'spawned', PORTOS_URL: 'http://127.0.0.1:9' }))
      .resolves.toEqual({ url: 'http://127.0.0.1:9', token: 'spawned' });
  });

  it('falls back to the default URL and no token without a key file', async () => {
    await expect(resolveCredentials({ PORTOS_AGENT_KEY_FILE: join(tmpdir(), 'portos-missing-key.json') }))
      .resolves.toEqual({ url: 'http://127.0.0.1:5555', token: null });
  });
});
