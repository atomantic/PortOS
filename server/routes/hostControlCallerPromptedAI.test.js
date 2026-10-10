import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { derivePeerAuthToken, PEER_AUTH_HEADER, PEER_INSTANCE_HEADER } from '../lib/peerHttpClient.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-caller-prompted-ai-') }));
afterAll(cleanupTempDataRoots);
afterEach(() => vi.restoreAllMocks());
vi.mock('../services/instanceIdentity.js', () => ({
  loadData: vi.fn(async () => ({ peers: [{
    id: 'example-peer', instanceId: 'example-instance', enabled: true, syncSecret: 'a'.repeat(32),
  }] })),
}));

// Caller-prompted AI outside Pipeline (#10908). Real routers behind the real
// auth + host-control gates. The games feedback service runs for real so the
// provider sink (`runPromptThroughProvider`) can be asserted with a synthetic
// CLI provider; the other families double their AI service so no provider,
// run record or job can start.
const auth = vi.hoisted(() => ({ enabled: false }));
const cliProvider = vi.hoisted(() => ({
  id: 'example-cli', name: 'Example CLI', type: 'cli', enabled: true, command: 'example-agent', args: [], defaultModel: 'example-model',
}));
const sink = vi.hoisted(() => ({
  runPromptThroughProvider: vi.fn(async () => ({ text: 'Example feedback', model: 'example-model', provider: { id: 'example-cli' } })),
}));

vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
  verifyPassword: vi.fn(async () => true),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
  getSettings: vi.fn(async () => ({})),
}));
vi.mock('../services/providers.js', async (importOriginal) => ({
  ...await importOriginal(),
  getProviderById: vi.fn(async (providerId) => (providerId === cliProvider.id ? cliProvider : null)),
}));
vi.mock('../services/promptRunner.js', async (importOriginal) => ({
  ...await importOriginal(),
  runPromptThroughProvider: sink.runPromptThroughProvider,
}));
vi.mock('../services/games/records.js', async (importOriginal) => ({
  ...await importOriginal(),
  getGame: vi.fn(async (id) => ({
    id, name: 'Example Game', appId: 'example-app', spriteBindings: [], musicBindings: [], artworkBindings: [],
    feedbackHistory: [], compiledManifest: null,
  })),
  mutateGame: vi.fn(async (id) => ({ id, feedbackHistory: [{ id: 'feedback-example' }] })),
}));
vi.mock('../services/apps.js', async (importOriginal) => ({
  ...await importOriginal(),
  getAppById: vi.fn(async () => ({ id: 'example-app', name: 'Example App' })),
}));
vi.mock('../services/rounds.js', async (importOriginal) => ({
  ...await importOriginal(),
  getRound: vi.fn(async (id) => ({ id, title: 'Example Round', artist: 'Example Artist' })),
}));
vi.mock('../services/roundsAI.js', () => ({
  generateRound: vi.fn(async () => ({ round: {}, llm: {} })),
  evaluateRound: vi.fn(async () => ({ evaluation: {}, llm: {} })),
  deriveRoundParts: vi.fn(async () => ({ scoreParts: [], llm: {} })),
}));
vi.mock('../services/agentPersonalityGenerator.js', () => ({
  generateAgentPersonality: vi.fn(async () => ({ name: 'Example Agent' })),
}));
vi.mock('../services/systemResources.js', async (importOriginal) => ({
  ...await importOriginal(),
  triageSystemResources: vi.fn(async () => ({ findings: [] })),
  getTrackedModelInventory: vi.fn(async () => ({ models: [] })),
}));
vi.mock('../services/moodBoard/index.js', async (importOriginal) => ({
  ...await importOriginal(),
  getBoard: vi.fn(async (id) => ({ id, name: 'Example Board', items: [] })),
  updateBoard: vi.fn(async (id, patch) => ({ id, ...patch })),
}));
vi.mock('../services/moodBoardStyleSynthesis.js', () => ({
  synthesizeBoardStyle: vi.fn(async () => ({ styleNotes: 'Example' })),
}));
vi.mock('../services/moodBoardCompositeStyle.js', () => ({
  composeBoardPrompt: vi.fn(async () => ({ prompt: 'Example' })),
}));
vi.mock('../services/moodBoard/analyzeJob.js', () => ({
  startAnalyzeJob: vi.fn(() => ({ status: 'running' })),
  getAnalyzeJob: vi.fn(() => ({ status: 'idle' })),
}));
vi.mock('../services/taskEnhancer.js', () => ({
  enhanceTaskPrompt: vi.fn(async () => ({ enhancedDescription: 'Example' })),
}));

import { authGate, hostControlRouteGate } from '../services/authGate.js';
import { createSession } from '../services/auth.js';
import gamesRoutes from './games.js';
import roundsRoutes from './rounds.js';
import agentPersonalitiesRoutes from './agentPersonalities.js';
import systemResourcesRoutes from './systemResources.js';
import moodBoardRoutes from './moodBoard.js';
import cosTaskRoutes from './cosTaskRoutes.js';
import { generateRound, evaluateRound, deriveRoundParts } from '../services/roundsAI.js';
import { generateAgentPersonality } from '../services/agentPersonalityGenerator.js';
import { triageSystemResources } from '../services/systemResources.js';
import { synthesizeBoardStyle } from '../services/moodBoardStyleSynthesis.js';
import { composeBoardPrompt } from '../services/moodBoardCompositeStyle.js';
import { startAnalyzeJob } from '../services/moodBoard/analyzeJob.js';
import { enhanceTaskPrompt } from '../services/taskEnhancer.js';

const id = '00000000-0000-4000-8000-000000000001';
const picker = { providerId: cliProvider.id, model: 'example-model' };
// [path, body, doubled service (the effect that must not run), success status]
const operations = [
  [`/api/games/${id}/feedback`, { ...picker, prompt: 'Example request' }, sink.runPromptThroughProvider, 201],
  ['/api/rounds/generate', { brief: 'Example brief', ...picker }, generateRound, 200],
  [`/api/rounds/${id}/generate`, { brief: 'Example brief', ...picker }, generateRound, 200],
  [`/api/rounds/${id}/evaluate`, { ...picker }, evaluateRound, 200],
  [`/api/rounds/${id}/derive-parts`, { ...picker }, deriveRoundParts, 200],
  ['/api/agents/personalities/generate', { seed: { name: 'Example' }, ...picker }, generateAgentPersonality, 200],
  ['/api/system-resources/triage', { providerId: cliProvider.id }, triageSystemResources, 200],
  [`/api/mood-boards/${id}/synthesize-style`, { styleNotes: 'Example notes', ...picker }, synthesizeBoardStyle, 200],
  [`/api/mood-boards/${id}/compose-prompt`, { ...picker }, composeBoardPrompt, 200],
  [`/api/mood-boards/${id}/analyze`, { ...picker }, startAnalyzeJob, 202],
  ['/api/cos/tasks/enhance', { description: 'Example task' }, enhanceTaskPrompt, 200],
];
// Distinct services touched by the table, so the "never ran" check covers each once.
const sinks = [...new Set(operations.map(([, , service]) => service))];

const appFor = (address = '192.0.2.10') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json());
  app.use('/api/games', gamesRoutes);
  app.use('/api/rounds', roundsRoutes);
  app.use('/api/agents/personalities', agentPersonalitiesRoutes);
  app.use('/api/system-resources', systemResourcesRoutes);
  app.use('/api/mood-boards', moodBoardRoutes);
  app.use('/api/cos', cosTaskRoutes);
  app.use(errorMiddleware);
  return app;
};
const post = (app, [path, body], headers = {}) => {
  const pending = request(app).post(path);
  for (const [name, value] of Object.entries(headers)) pending.set(name, value);
  return pending.send(body);
};
const expectNoEffects = () => {
  for (const service of sinks) expect(service).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

describe('caller-prompted AI operator authority (#10908)', () => {
  it('refuses a remote password-free caller, including spoofed-proxy variants, before any provider call', async () => {
    for (const operation of operations) {
      for (const [address, headers] of [
        ['192.0.2.10', {}],
        ['127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' }],
        ['192.0.2.10', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '127.0.0.1' }],
      ]) {
        const response = await post(appFor(address), operation, headers);
        expect([response.status, response.body.code], operation[0]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
      }
    }
    expectNoEffects();
  });

  it('requires authentication with a password, denies legacy Basic and scoped-peer credentials', async () => {
    auth.enabled = true;
    for (const operation of operations) {
      for (const [headers, status, code] of [
        [{}, 401, 'AUTH_REQUIRED'],
        [{ Authorization: 'Bearer invalid-session' }, 401, 'AUTH_REQUIRED'],
        [{ Authorization: 'Basic ' + Buffer.from(':example-password').toString('base64') }, 403, 'HOST_CONTROL_FORBIDDEN'],
        [{
          [PEER_AUTH_HEADER]: derivePeerAuthToken('a'.repeat(32), 'example-instance'),
          [PEER_INSTANCE_HEADER]: 'example-instance',
        }, 403, 'PEER_SCOPE_FORBIDDEN'],
      ]) {
        const response = await post(appFor(), operation, headers);
        expect([response.status, response.body.code], operation[0]).toEqual([status, code]);
      }
    }
    expectNoEffects();
  });

  it('matches case and trailing-slash variants before any provider call', async () => {
    for (const operation of operations) {
      const variant = [operation[0].toUpperCase() + '/', operation[1]];
      const response = await post(appFor(), variant);
      expect([response.status, response.body.code], operation[0]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    }
    expectNoEffects();
  });

  it('keeps working for local callers, operator sessions and delegated agent sessions', async () => {
    const operator = await createSession();
    const agent = await createSession({ label: 'agent' });
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [true, '192.0.2.10', { Authorization: `Bearer ${operator.token}` }],
      [true, '192.0.2.10', { Cookie: `portos_auth=${agent.token}` }],
      [true, '192.0.2.10', { Authorization: `Bearer ${agent.token}` }],
    ]) {
      auth.enabled = enabled;
      for (const operation of operations) {
        const response = await post(appFor(address), operation, headers);
        expect(response.status, `${operation[0]}: ${JSON.stringify(response.body)}`).toBe(operation[3]);
      }
    }
  });

  it('lets an authorized games feedback request reach the chosen CLI provider and nobody else', async () => {
    const operation = operations[0];
    expect((await post(appFor('192.0.2.10'), operation)).status).toBe(403);
    expect(sink.runPromptThroughProvider).not.toHaveBeenCalled();

    expect((await post(appFor('127.0.0.1'), operation)).status).toBe(201);
    expect(sink.runPromptThroughProvider).toHaveBeenCalledTimes(1);
    expect(sink.runPromptThroughProvider.mock.calls[0][0]).toEqual(expect.objectContaining({
      provider: cliProvider, source: 'game-asset-feedback', model: 'example-model',
    }));
  });

  it('leaves reads open to a remote caller', async () => {
    const response = await request(appFor()).get('/api/system-resources/models/manifest');
    expect(response.status).toBe(200);
    expectNoEffects();
  });
});
