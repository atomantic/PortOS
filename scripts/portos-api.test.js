/**
 * portos-api CLI: argv parsing (the part an agent gets wrong silently — a body
 * that never reaches the request, or a path missing its /api prefix) and which
 * credential wins when both the spawn env and the key file are present.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, request as httpRequest } from 'node:http';
import { EventEmitter } from 'node:events';

vi.mock('node:http', async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, request: vi.fn(original.request) };
});
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createTlsServer } from 'node:https';
import { PORTS } from '../server/lib/ports.js';
import { DISPOSABLE_ROOT_MARKER } from '../server/lib/dataRoot.js';
import { main, parseArgs, resolveCredentials } from './portos-api.js';


// Synthetic TLS material; used only by isolated loopback fixtures.
const TLS_KEY = '-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgsmTM3L/sbDmQbdMy\nhB0Cr2yvl2GrcWmbQM+zu8RjsFyhRANCAASSt8pu/qVh51sOU9YpdzAkKufDGjbq\n4HHPRUwKYqQlDM2fVIKOqO+NqjyOlCiBX21gzbnYU057iXRVJZgEH8jH\n-----END PRIVATE KEY-----\n';
const TLS_CERT = '-----BEGIN CERTIFICATE-----\nMIIBfTCCASKgAwIBAgIURm+4Ws6hBxzNDDslU4mibL+EV3QwCgYIKoZIzj0EAwIw\nJDEiMCAGA1UEAwwZc3ludGhldGljLXBvcnRvcy1hcGkudGVzdDAeFw0yNjEwMTcw\nMTU3NDlaFw0zNjEwMTQwMTU3NDlaMCQxIjAgBgNVBAMMGXN5bnRoZXRpYy1wb3J0\nb3MtYXBpLnRlc3QwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAASSt8pu/qVh51sO\nU9YpdzAkKufDGjbq4HHPRUwKYqQlDM2fVIKOqO+NqjyOlCiBX21gzbnYU057iXRV\nJZgEH8jHozIwMDAdBgNVHQ4EFgQUk3SePqT2M4mcfL9y9Y8MhK226oswDwYDVR0T\nAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNJADBGAiEAsh5/nlEF2WXrJGDsdm2NrD81\nj5omkDkpxyJHHgjH8+wCIQD2U6RF+9aXsztQ/o27GH+/DZluuBgdNiQOVwK8nM0F\nfA==\n-----END CERTIFICATE-----\n';

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

  it('delivers a JSON body on DELETE', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    let seen;
    server = createServer((request, response) => {
      const chunks = [];
      request.on('data', chunk => chunks.push(chunk));
      request.on('end', () => { seen = { method: request.method, body: Buffer.concat(chunks).toString('utf8') }; response.writeHead(204); response.end(); });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await expect(main(['delete', '/api/example', '{"key":"value"}'], {
      PORTOS_URL: `http://127.0.0.1:${server.address().port}`,
      PORTOS_AGENT_KEY_FILE: join(tmpdir(), 'portos-missing-key.json'),
    })).resolves.toBe(0);
    expect(seen).toEqual({ method: 'DELETE', body: '{"key":"value"}' });
  });

  it('sends the per-run secret only to external admission and rejects malformed secrets locally', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const seen = [];
    server = createServer((request, response) => {
      seen.push({ path: request.url, secret: request.headers['x-portos-admission-session'] });
      response.end('{}');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const env = { PORTOS_URL: `http://127.0.0.1:${server.address().port}`,
      PORTOS_AGENT_KEY_FILE: join(tmpdir(), 'portos-missing-key.json'), PORTOS_ADMISSION_SESSION: 'a'.repeat(64) };
    await main(['post', '/cos/merge-admission/external', '{}'], env);
    await main(['whoami'], env);
    expect(seen).toEqual([{ path: '/api/cos/merge-admission/external', secret: env.PORTOS_ADMISSION_SESSION },
      { path: '/api/auth/whoami', secret: undefined }]);
    await expect(main(['post', '/cos/merge-admission/external', '{}'], { ...env, PORTOS_ADMISSION_SESSION: 'caller-id' }))
      .rejects.toThrow('PORTOS_ADMISSION_SESSION must be');
    expect(seen).toHaveLength(2);
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
  afterEach(async () => {
    vi.unstubAllEnvs();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

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
    dir = await mkdtemp(join(tmpdir(), 'portos-api-no-cert-'));
    await writeFile(join(dir, DISPOSABLE_ROOT_MARKER), 'test fixture');
    vi.stubEnv('PORTOS_DATA_ROOT', dir);
    await expect(resolveCredentials({ PORTOS_AGENT_KEY_FILE: join(dir, 'missing-key.json') }))
      .resolves.toEqual({ url: `http://127.0.0.1:${PORTS.API}`, token: null });
  });
});


describe('local install URL selection', () => {
  let root;
  const servers = [];
  const listen = async (server) => {
    servers.push(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return server.address().port;
  };
  const setup = async (tls = false) => {
    root = await mkdtemp(join(tmpdir(), 'portos-api-config-'));
    await writeFile(join(root, DISPOSABLE_ROOT_MARKER), 'test fixture');
    vi.stubEnv('PORTOS_DATA_ROOT', root);
    await mkdir(join(root, 'data/certs'), { recursive: true });
    if (tls) {
      await writeFile(join(root, 'data/certs/cert.pem'), TLS_CERT);
      await writeFile(join(root, 'data/certs/key.pem'), TLS_KEY);
    }
    return { PORTOS_AGENT_KEY_FILE: join(root, 'missing-key.json'), PORTOS_API_TOKEN: 'synthetic-token' };
  };
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      if (server.listening) await new Promise(resolve => server.close(resolve));
    }
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('reaches the configured TLS mirror and preserves credentials', async () => {
    const env = await setup(true);
    const seen = [];
    const port = await listen(createServer((req, res) => {
      seen.push({ path: req.url, auth: req.headers.authorization });
      res.end('{"authenticated":true}');
    }));
    await writeFile(join(root, '.env'), `PORTOS_HTTP_PORT=${port}\n`);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(main(['whoami'], env)).resolves.toBe(0);
    expect(seen).toEqual([{ path: '/api/auth/whoami', auth: 'Bearer synthetic-token' }]);
    await expect(resolveCredentials({ ...env, PORTOS_HTTP_PORT: '12345' }))
      .resolves.toMatchObject({ url: 'http://127.0.0.1:12345' });
    await expect(resolveCredentials({ ...env, PORTOS_HTTP_PORT: 'invalid' }))
      .resolves.toMatchObject({ url: `http://127.0.0.1:${port}` });
  });

  it('uses the shared defaults and treats unusable certificate files like the server', async () => {
    const env = await setup(true);
    await expect(resolveCredentials(env)).resolves.toMatchObject({ url: `http://127.0.0.1:${PORTS.API_LOCAL}` });
    await writeFile(join(root, 'data/certs/key.pem'), 'incomplete key');
    await expect(resolveCredentials({ ...env, PORT: String(PORTS.COS) })).resolves.toMatchObject({ url: `http://127.0.0.1:${PORTS.API}` });
  });

  it('keeps explicit and key-file URLs ahead of TLS-derived defaults without rewriting their audience', async () => {
    const env = await setup(true);
    await writeFile(env.PORTOS_AGENT_KEY_FILE, JSON.stringify({ url: 'https://peer.example.test:9443/', token: 'from-file' }));
    await expect(resolveCredentials(env)).resolves.toEqual({ url: 'https://peer.example.test:9443', token: 'synthetic-token' });
    await expect(resolveCredentials({ ...env, PORTOS_URL: 'https://explicit.example.test/' }))
      .resolves.toEqual({ url: 'https://explicit.example.test', token: 'synthetic-token' });
  });

  it('explains a local TLS-port reset without retrying or sending credentials to the mirror', async () => {
    const env = await setup(true);
    const tlsPort = await listen(createTlsServer({ key: TLS_KEY, cert: TLS_CERT }));
    const mirrorRequests = vi.fn();
    const mirrorPort = await listen(createServer((_req, res) => { mirrorRequests(); res.end('{}'); }));
    const config = { ...env, PORTOS_HTTP_PORT: String(mirrorPort), PORTOS_URL: `http://127.0.0.1:${PORTS.API}` };
    const resetRequest = () => {
      const request = new EventEmitter();
      request.end = () => queueMicrotask(() => request.emit('error', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })));
      return request;
    };
    vi.mocked(httpRequest).mockImplementationOnce(resetRequest);
    await expect(main(['whoami'], config)).rejects.toThrow(`PORTOS_URL=http://127.0.0.1:${mirrorPort}`);
    vi.mocked(httpRequest).mockImplementationOnce(resetRequest);
    await expect(main(['whoami'], { ...config, PORTOS_URL: `http://external.example.test:${PORTS.API}` }))
      .rejects.toMatchObject({ code: 'ECONNRESET', message: 'socket hang up' });
    expect(mirrorRequests).not.toHaveBeenCalled();
    await expect(main(['whoami'], { ...config, PORTOS_URL: `http://127.0.0.1:${tlsPort}` })).rejects.toMatchObject({ code: 'ECONNRESET', message: 'socket hang up' });
  });
});


describe('FableLoom export CLI handoff', () => {
  it('passes exact ordered export options and rejects implicit or incompatible consent', () => {
    const parsed = parseArgs(['fableloom-export', 'preflight', 'loom/id', '--episodes', 'two,one', '--player', 'true', '--characters', 'true', '--voice', 'true', '--allow-draft', 'true', '--profile', 'web-720p']);
    expect(parsed.path).toBe('/api/fableloom/loom%2Fid/export/preflight');
    expect(JSON.parse(parsed.body)).toEqual({ episodeIds: ['two', 'one'], includePlayer: true, includeCharacters: true, includeVoice: true, allowDraft: true, mediaProfile: 'web-720p' });
    expect(() => parseArgs(['fableloom-export', 'start', 'loom', '--voice', 'true'])).toThrow(/characters/);
    expect(() => parseArgs(['fableloom-export', 'start', 'loom', '--allow-draft', 'yes'])).toThrow(/true or false/);
  });

  it('downloads protected ZIP bytes without printing the credential and refuses overwrite', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'portos-export-cli-'));
    const output = join(dir, 'story.zip');
    const bytes = Buffer.from([80, 75, 3, 4, 0, 255, 128]);
    const received = [];
    const server = createServer((request, response) => {
      received.push({ path: request.url, authorization: request.headers.authorization });
      response.writeHead(200, { 'Content-Type': 'application/zip' }); response.end(bytes);
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const env = { PORTOS_URL: `http://127.0.0.1:${server.address().port}`, PORTOS_API_TOKEN: 'synthetic-export-token', PORTOS_AGENT_KEY_FILE: join(dir, 'absent') };
    try {
      expect(await main(['fableloom-export', 'download', 'loom', 'job', '--output', output], env)).toBe(0);
      expect(await readFile(output)).toEqual(bytes);
      expect(received[0]).toEqual({ path: '/api/fableloom/loom/export/job/download', authorization: 'Bearer synthetic-export-token' });
      expect(JSON.stringify(log.mock.calls)).not.toContain('synthetic-export-token');
      await expect(main(['fableloom-export', 'download', 'loom', 'job', '--output', output], env)).rejects.toMatchObject({ code: 'EEXIST' });
    } finally {
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      log.mockRestore(); await rm(dir, { recursive: true, force: true });
    }
  });
});
