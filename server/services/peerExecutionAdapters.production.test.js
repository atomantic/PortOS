import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMaintenanceAdmission } from '../lib/maintenanceAdmission.js';

const tmp = vi.hoisted(() => ({ data: '' }));
vi.mock('../lib/paths.js', async () => {
  const actual = await vi.importActual('../lib/paths.js');
  // Lazy: the temp root is allocated in beforeAll, after this factory has run.
  return { ...actual, PATHS: new Proxy(actual.PATHS, { get: (target, key) => key === 'data' ? tmp.data : target[key] }) };
});
const detached = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('../lib/detachedSpawn.js', async () => ({
  ...await vi.importActual('../lib/detachedSpawn.js'), spawnDetached: detached.spawn,
}));
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

// Positive control for the peer-admin route test: an authorized restart reaches the
// same detachedSpawn seam that the refusal-path spies bind to, so those spies observe
// a real executor path rather than a phantom export.
describe('authorized production restart reaches the detached launch seam', () => {
  beforeAll(() => { tmp.data = mkdtempSync(join(tmpdir(), 'peer-restart-')); });
  afterAll(() => rmSync(tmp.data, { recursive: true, force: true }));
  it('spawns exactly one pm2 restart under an exclusive capability', async () => {
    const { peerExecutionEvidenceDigest, preparePeerExecution, runPeerExecution } = await import('./peerExecutionAdapters.js');
    detached.spawn.mockResolvedValueOnce({ on: vi.fn() });
    vi.mocked(countActiveCosAgents).mockResolvedValueOnce(0);
    vi.mocked(getPersistentMindImageWorkGuard).mockResolvedValueOnce({ trusted: true, safe: true });
    const intent = { action: 'portos.restart' };
    const evidence = await preparePeerExecution(intent);
    const coordinator = createMaintenanceAdmission(tmp.data);
    const hold = coordinator.begin({ reason: 'Fixture drain', owner: 'Fixture operator' }).hold;
    const claim = coordinator.claimReady({ id: hold.id, revision: hold.revision, operation: {
      operationId: randomUUID(), requestId: randomUUID(), peerInstanceId: randomUUID(), hostInstanceId: randomUUID(),
      grantId: randomUUID(), grantGeneration: 1, scope: 'execution-v1', pairBinding: 'd'.repeat(64),
      intent, receiverVersion: '1.2.3', evidenceDigest: peerExecutionEvidenceDigest(evidence),
    } }, coordinator.observeIdle());
    const started = coordinator.transitionExclusive({ id: claim.id, revision: claim.revision, fingerprint: claim.fingerprint },
      'in-flight', coordinator.observeIdle());
    const capability = coordinator.issueExecutionCapability(started);
    await expect(runPeerExecution(intent, evidence, { capability })).resolves.toEqual({
      state: 'awaiting-reconnect', code: 'PEER_EXECUTION_RESTART_STARTED' });
    expect(detached.spawn).toHaveBeenCalledTimes(1);
    expect(detached.spawn.mock.calls[0][1]).toEqual(expect.arrayContaining(['restart', 'portos-server']));
  });
});
