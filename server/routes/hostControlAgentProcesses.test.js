import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { expectAuthorizedWorkflows, expectRemoteRefusal } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { getRunningAgents, getProcessInfo } from '../services/agent/agents.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-agent-process-authority-') }));
afterAll(cleanupTempDataRoots);

// The kill is gated by the default-deny write policy (#16018); the refusal and
// principal matrix live in services/authGate.test.js and server/test/guards/modules/hostControlCoverage.test.js.
// killProcess (SIGKILL to the named host PID) is doubled at its service.
const auth = vi.hoisted(() => ({ enabled: false }));
const effects = vi.hoisted(() => ({ killProcess: vi.fn(async () => true) }));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(), isAuthEnabled: vi.fn(async () => auth.enabled),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(), getSettings: vi.fn(async () => ({})),
}));
vi.mock('../services/agent/agents.js', () => ({
  getRunningAgents: vi.fn(async () => []), getProcessInfo: vi.fn(async (pid) => ({ pid })), killProcess: effects.killProcess,
}));

const mounts = [['/api/agents', (await import('./agents.js')).default]];

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

describe('agent process router behind the default-deny gate (#16114)', () => {
  it('allows local and delegated agent reads of running agents and process details', async () => {
    await expectAuthorizedWorkflows({ auth, mounts, workflows: [
      ['get', '/api/agents', undefined, getRunningAgents, 200],
      ['get', '/api/agents/4242', undefined, getProcessInfo, 200],
    ] });
  });

  it('refuses remote password-free reads before process inspection', async () => {
    await expectRemoteRefusal(mounts, ['get', '/api/agents', undefined, getRunningAgents]);
    await expectRemoteRefusal(mounts, ['get', '/api/agents/4242', undefined, getProcessInfo]);
  });

  it('still kills for a local operator and a delegated agent session', async () => {
    await expectAuthorizedWorkflows({ auth, mounts, workflows: [['delete', '/api/agents/4242', undefined, effects.killProcess, 200]] });
    expect(effects.killProcess).toHaveBeenLastCalledWith(4242);
  });
});
