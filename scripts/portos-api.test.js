/**
 * portos-api CLI: argv parsing (the part an agent gets wrong silently — a body
 * that never reaches the request, or a path missing its /api prefix) and which
 * credential wins when both the spawn env and the key file are present.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseArgs, resolveCredentials } from './portos-api.js';

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
