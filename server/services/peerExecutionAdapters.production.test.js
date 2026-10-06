import { describe, expect, it, vi } from 'vitest';

vi.mock('./updateChecker.js', () => ({ getUpdateStatus: async () => ({ latestRelease: { tag: 'v1.2.3' },
  remoteInfo: { hasOrigin: true, isFork: false }, forkSyncFresh: false }) }));
vi.mock('./updateRepoReadiness.js', () => ({ checkUpdateRepoReadiness: async () => ({ ready: false,
  branch: 'main', reasons: ['agent-at-work'], repairable: [] }) }));
vi.mock('../lib/execGit.js', () => ({ execGitSafe: async args => ({ exitCode: 0,
  stdout: args[0] === 'remote' ? 'https://github.com/fixture/PortOS.git' : args[1] === 'HEAD' ? 'a'.repeat(40) : 'b'.repeat(40) }) }));
vi.mock('./pm2.js', async () => {
  const { PATHS } = await import('../lib/paths.js');
  const { join } = await import('node:path');
  return { listMaintenanceProcesses: async () => [{ name: 'portos-server', pid: 123,
    status: 'online', cwd: PATHS.root, script: join(PATHS.root, 'server/start.js') }] };
});
vi.mock('./updatePreflight.js', () => ({ countActiveCosAgents: vi.fn(async () => 2),
  getPersistentMindImageWorkGuard: vi.fn(async () => ({ trusted: true, safe: false })) }));
import { preparePeerExecution } from './peerExecutionAdapters.js';
import { countActiveCosAgents, getPersistentMindImageWorkGuard } from './updatePreflight.js';

describe('production preview before graceful draining', () => {
  it('can queue stable update/restart targets while admitted agent and mind work finishes', async () => {
    await expect(preparePeerExecution({ action: 'portos.update' })).resolves.toMatchObject({
      target: { headSha: 'a'.repeat(40), targetSha: 'b'.repeat(40) } });
    await expect(preparePeerExecution({ action: 'portos.restart' })).resolves.toMatchObject({
      target: { processes: [{ name: 'portos-server', pid: 123 }] } });
    expect(countActiveCosAgents).not.toHaveBeenCalled();
    expect(getPersistentMindImageWorkGuard).not.toHaveBeenCalled();
  });
});
