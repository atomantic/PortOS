import { afterAll, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { extractToken } from '../../lib/portosAuthCore.js';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';
import * as pty from 'node-pty';

const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-agent-auth-transport-' });
vi.mock('../lib/fileUtils.js', async (importOriginal) => makeProxy(await importOriginal()));
afterAll(cleanup);

describe('agent API credential transport', () => {
  it('distinguishes a simulated PTY shell override from a revoked agent token without key fallback', async () => {
    const { buildCliChildEnv, composeProviderEnv } = await import('../lib/cliChildEnv.js');
    const { cliProviderAuthDescriptor } = await import('../lib/processEnv.js');
    const auth = await import('./auth.js');
    const { resolveAgentApiEnv } = await import('./agentApiAuth.js');
    await auth.setPassword({ newPassword: 'synthetic-transport-password' });
    const agentEnv = await resolveAgentApiEnv();
    const key = await auth.createSession({ label: 'agent-key' });
    const keyFile = join(tempRoot, 'agent-key.json');
    const observations = [];
    const server = createServer((request, response) => {
      const sameAgentToken = extractToken(request) === agentEnv.PORTOS_API_TOKEN;
      void auth.verifyRequestSession(request).then((token) => {
        observations.push({ sameAgentToken, accepted: !!token });
        response.writeHead(token ? 200 : 401, { 'Content-Type': 'application/json' });
        response.end(token ? '{"found":true}' : '{"code":"AUTH_REQUIRED"}');
      }).catch(() => { response.writeHead(500); response.end(); });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const provider = { id: 'codex-tui', command: 'codex' };
    const cwd = resolve('..');
    // The server sends a delta; the durable runner bases it on its own env.
    const delta = composeProviderEnv({ before: agentEnv, provider });
    const env = buildCliChildEnv({ before: delta, provider: cliProviderAuthDescriptor(provider), cwd });
    Object.assign(env, { PORTOS_URL: url, PORTOS_AGENT_KEY_FILE: keyFile });
    const launch = (childEnv = env) => new Promise((resolve, reject) => {
      const child = pty.spawn(process.execPath, ['scripts/portos-api.js', 'get', '/api/cos/agents/example'], { cwd, env: childEnv });
      let output = '';
      const timeout = setTimeout(() => { child.kill(); reject(new Error('Credential transport fixture timed out')); }, 10_000);
      child.onData(data => { output += data; });
      child.onExit(({ exitCode }) => { clearTimeout(timeout); resolve({ exitCode, output }); });
    });
    try {
      await writeFile(keyFile, JSON.stringify({ url, token: key.token }));
      expect(env.PORTOS_API_TOKEN).toBe(agentEnv.PORTOS_API_TOKEN);
      expect(agentEnv.PORTOS_API_TOKEN).toBeTruthy();
      const first = await launch();
      expect(first.exitCode).toBe(0);
      expect(first.output).toContain('"found": true');
      // Model a Codex shell policy overriding the environment of its tool call.
      const overridden = await launch({ ...env, PORTOS_API_TOKEN: 'synthetic-stale-override' });
      expect(overridden.exitCode).toBe(1);
      expect(overridden.output).toContain('shell_environment_policy.set.PORTOS_API_TOKEN');
      expect(overridden.output).not.toContain('synthetic-stale-override');
      expect(overridden.output).not.toContain(key.token);
      expect((await launch()).exitCode).toBe(0);
      const identity = await auth.describeSession(agentEnv.PORTOS_API_TOKEN);
      await auth.revokeSessionById(identity.id);
      const revoked = await launch();
      expect(revoked.exitCode).toBe(1);
      expect(revoked.output).toContain('selected PORTOS_API_TOKEN credential; the API responded');
      expect(revoked.output).not.toContain(agentEnv.PORTOS_API_TOKEN);
      expect(revoked.output).not.toContain(key.token);
      expect(observations).toEqual([
        { sameAgentToken: true, accepted: true },
        { sameAgentToken: false, accepted: false },
        { sameAgentToken: true, accepted: true },
        { sameAgentToken: true, accepted: false },
      ]);
      expect(await auth.verifySession(key.token)).toBe(true);
      const restricted = await resolveAgentApiEnv({ safetyProfile: 'public-review' });
      const publicEnv = buildCliChildEnv({ before: { ...agentEnv, ...restricted }, provider, cwd, safetyProfile: 'public-review' });
      expect(restricted).toEqual({});
      expect(publicEnv).not.toHaveProperty('PORTOS_API_TOKEN');
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
});
