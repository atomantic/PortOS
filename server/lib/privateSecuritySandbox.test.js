import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { preparePrivateSecuritySpawn, privateSecurityEndpoint } from './privateSecuritySandbox.js';

const localProvider = (port) => ({ id: 'claude-ollama', type: 'cli', command: 'claude', ollamaBacked: true,
  envVars: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` } });

describe('private assessment containment', () => {
  it('rejects remote endpoints and bind-all ambiguity despite local runtime markers', () => {
    expect(privateSecurityEndpoint(localProvider(11434))).toMatchObject({ port: 11434 });
    for (const endpoint of ['https://example.com', 'http://192.0.2.10:11434', 'http://0.0.0.0:11434']) {
      expect(privateSecurityEndpoint({ ...localProvider(11434), envVars: { ANTHROPIC_BASE_URL: endpoint } })).toBeNull();
    }
  });

  it.skipIf(process.platform !== 'darwin')('enforces file isolation and permits only the chosen local inference port in a real child', async () => {
    const root = await mkdtemp(join(tmpdir(), 'portos-security-test-'));
    const cwd = join(root, 'scratch');
    await mkdir(cwd);
    const secret = join(root, 'secret.txt');
    await writeFile(secret, 'synthetic-private-data');
    const allowed = createServer((_req, res) => res.end('local inference fixture'));
    const forbidden = createServer((_req, res) => res.end('must not reach'));
    await Promise.all([allowed, forbidden].map((server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))));
    const port = allowed.address().port;
    const deniedPort = forbidden.address().port;
    const script = `
      const fs = require('node:fs/promises');
      const attempt = p => p.then(() => true, () => false);
      Promise.all([
        attempt(fs.readFile(${JSON.stringify(secret)})),
        attempt(fs.writeFile(${JSON.stringify(join(root, 'outside.txt'))}, 'no')),
        attempt(fs.writeFile('inside.txt', 'yes')),
        attempt(fetch('http://127.0.0.1:${port}', { signal: AbortSignal.timeout(2000) })),
        attempt(fetch('http://127.0.0.1:${deniedPort}', { signal: AbortSignal.timeout(2000) }))
      ]).then(results => console.log(JSON.stringify(results)));
    `;
    const launch = await preparePrivateSecuritySpawn({ command: process.execPath, args: ['-e', script],
      env: { PATH: process.env.PATH }, cwd, provider: localProvider(port) });
    const result = await promisify(execFile)(launch.command, launch.args, { cwd, env: launch.env, timeout: 10000 })
      .finally(async () => {
        await Promise.all([allowed, forbidden].map((server) => new Promise((resolve) => server.close(resolve))));
        await rm(root, { recursive: true, force: true });
      });
    expect(JSON.parse(result.stdout)).toEqual([false, false, true, true, false]);
    expect(launch.env.HOME).not.toBe(process.env.HOME);
  });
});
