import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('./cosEvents.js', () => ({ cosEvents: { emit: vi.fn() }, emitLog: vi.fn() }));
vi.mock('../lib/childProcess.js', async (original) => ({ ...(await original()), spawn: vi.fn() }));
vi.mock('./forgeAuth.js', () => ({ resolveForgeTokenEnv: vi.fn() }));

import { spawn } from '../lib/childProcess.js';
import { resolveForgeTokenEnv } from './forgeAuth.js';
import { detectGithubIssues } from './perpetualWork.js';

beforeEach(() => {
  vi.resetAllMocks();
  spawn.mockImplementation(() => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    queueMicrotask(() => { child.stdout.emit('data', '[]'); child.emit('close', 0); });
    return child;
  });
});
afterEach(() => vi.unstubAllEnvs());

it('carries the enterprise account through every issue scan probe', async () => {
  vi.stubEnv('GH_TOKEN', 'public-ambient-token');
  vi.stubEnv('GITHUB_ENTERPRISE_TOKEN', 'enterprise-ambient-token');
  resolveForgeTokenEnv.mockResolvedValue({ GH_HOST: 'ghe.example.com', GH_ENTERPRISE_TOKEN: 'enterprise-pin-token' });
  await detectGithubIssues({ id: 'example', repoPath: '/example/repo' }, { issueAuthorFilter: 'any' });
  const probes = spawn.mock.calls.filter(([cmd]) => cmd === 'gh');
  expect(probes.length).toBeGreaterThan(0);
  for (const [, , { env }] of probes) {
    expect(env).toMatchObject({ GH_HOST: 'ghe.example.com', GH_ENTERPRISE_TOKEN: 'enterprise-pin-token' });
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_ENTERPRISE_TOKEN).toBeUndefined();
  }
});

it('refuses an issue scan when its account pin is unavailable', async () => {
  resolveForgeTokenEnv.mockRejectedValue(Object.assign(new Error('Pin unavailable'), { code: 'FORGE_ACCOUNT_UNAVAILABLE' }));
  await expect(detectGithubIssues({ id: 'example', repoPath: '/example/repo' }, { issueAuthorFilter: 'any' }))
    .rejects.toMatchObject({ code: 'FORGE_ACCOUNT_UNAVAILABLE' });
  expect(spawn).not.toHaveBeenCalled();
});
