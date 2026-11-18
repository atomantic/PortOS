import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Router } from 'express';
import { expectAuthorizedWorkflows, expectRemoteRefusal } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-families-authority-') }));
afterAll(cleanupTempDataRoots);

// Feature-agent, loop, provider-runtime, GitHub and tool-registry writes (#8721,
// #9014, #10111) are plain writes under the default-deny gate (#16018), whose
// principal matrix lives in services/authGate.test.js. The settings-key split
// that once lived here is gone: every settings write is an operator write now.
// This suite keeps one authorized workflow per router with its sink doubled.
const auth = vi.hoisted(() => ({ enabled: false }));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(), isAuthEnabled: vi.fn(async () => auth.enabled),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(), getSettings: vi.fn(async () => ({})),
}));

const featureAgents = vi.hoisted(() => ({
  createFeatureAgent: vi.fn(),
  activateFeatureAgent: vi.fn(async () => ({ id: 'agent-1', status: 'active' })),
  triggerFeatureAgent: vi.fn(),
  stopFeatureAgent: vi.fn(),
}));
vi.mock('../services/featureAgents.js', () => featureAgents);

const loops = vi.hoisted(() => ({
  createLoop: vi.fn(),
  triggerLoop: vi.fn(async () => ({ id: 'loop-1' })),
  stopLoop: vi.fn(),
}));
vi.mock('../services/loops.js', () => loops);

const github = vi.hoisted(() => ({
  updateRepoFlags: vi.fn(),
  setRepoArchived: vi.fn(async () => ({ archived: true })),
  setSecret: vi.fn(),
  syncSecretToRepos: vi.fn(),
  syncRepos: vi.fn(),
}));
vi.mock('../services/github.js', () => github);

const tools = vi.hoisted(() => ({
  getTools: vi.fn(),
  getEnabledTools: vi.fn(),
  getToolsSummaryForPrompt: vi.fn(),
  getTool: vi.fn(),
  registerTool: vi.fn(async () => ({ id: 'example-tool' })),
  updateTool: vi.fn(async () => ({ id: 'example-tool' })),
  deleteTool: vi.fn(),
}));
vi.mock('../services/tools.js', () => tools);

const installer = vi.hoisted(() => ({
  getProviderRuntime: vi.fn(),
  getProviderRuntimeStatus: vi.fn(),
  getProviderRuntimeStatuses: vi.fn(),
  spawnRuntimeInstaller: vi.fn(),
  stopRuntimeInstaller: vi.fn(),
  describeRuntimeInstall: vi.fn(),
  buildRuntimeActionCommand: vi.fn(),
  RUNTIME_ACTIONS: ['install', 'update', 'uninstall'],
}));
vi.mock('../services/provider/providerRuntimeInstaller.js', () => installer);

import featureAgentsRoutes from './featureAgents.js';
import loopsRoutes from './loops.js';
import { createPortOSProviderRoutes } from './providers.js';
import githubRoutes from './github.js';
import toolsRoutes from './tools.js';

const mounts = [
  ['/api/feature-agents', featureAgentsRoutes],
  ['/api/loops', loopsRoutes],
  ['/api/providers', createPortOSProviderRoutes({ services: { providers: {} }, routes: { providers: Router() } })],
  ['/api/github', githubRoutes],
  ['/api/tools', toolsRoutes],
];

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

describe('agent, loop, provider, GitHub and tool-registry writes behind the default-deny gate (#8721, #9014, #16114)', () => {
  it('still starts agents and loops, archives repos and writes the tool registry for a local operator and a delegated agent session', async () => {
    await expectAuthorizedWorkflows({ auth, mounts, workflows: [
      ['post', '/api/feature-agents/agent-1/start', {}, featureAgents.activateFeatureAgent, 200],
      ['post', '/api/loops/loop-1/trigger', {}, loops.triggerLoop, 200],
      ['post', '/api/github/repos/example%2Fexample/archive', {}, github.setRepoArchived, 200],
      ['post', '/api/tools', { id: 'example-tool', name: 'Example tool', category: 'cli', enabled: true, promptHints: 'Use the example tool' }, tools.registerTool, 201],
      ['put', '/api/tools/example-tool', { description: 'Updated example tool' }, tools.updateTool, 200],
    ] });
    expect(github.setRepoArchived).toHaveBeenCalledWith('example/example', true);
    expect(tools.updateTool).toHaveBeenCalledWith('example-tool', { description: 'Updated example tool' });
  });

  it('refuses a remote caller on the provider-runtime installer before it spawns anything', async () => {
    await expectRemoteRefusal(mounts, ['post', '/api/providers/runtimes/install?runtime=codex', {}, installer.spawnRuntimeInstaller]);
    expect(installer.getProviderRuntimeStatus).not.toHaveBeenCalled();
  });

  it('refuses a remote caller on the secret and tool deletes that host control keeps', async () => {
    await expectRemoteRefusal(mounts, ['put', '/api/github/secrets/EXAMPLE_SECRET', { value: 'secret-value' }, github.setSecret]);
    await expectRemoteRefusal(mounts, ['delete', '/api/tools/example-tool', undefined, tools.deleteTool]);
  });
});
