import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { expectAuthorizedWorkflows } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-caller-prompted-ai-') }));
afterAll(cleanupTempDataRoots);

// Caller-prompted AI outside Pipeline (#10908). Every such write is gated by the
// default-deny policy (#16018); the refusal and principal matrix live in
// services/authGate.test.js and server/test/guards/modules/hostControlCoverage.test.js. The games, mood-board
// and agent-personality routers keep their authorized workflows in the
// hostControlPreGuard*.test.js suites. Effects are doubled at their AI service.
const auth = vi.hoisted(() => ({ enabled: false }));
const effects = vi.hoisted(() => ({
  generateRound: vi.fn(async () => ({ round: {}, llm: {} })),
  triage: vi.fn(async () => ({ findings: [] })),
  enhance: vi.fn(async () => ({ enhancedDescription: 'Example' })),
}));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(),
  getSettings: vi.fn(async () => ({})),
}));
vi.mock('../services/roundsAI.js', () => ({ generateRound: effects.generateRound }));
vi.mock('../services/systemResources.js', async (importOriginal) => ({
  ...await importOriginal(),
  triageSystemResources: effects.triage,
}));
vi.mock('../services/taskEnhancer.js', () => ({ enhanceTaskPrompt: effects.enhance }));

const mounts = [
  ['/api/rounds', (await import('./rounds.js')).default],
  ['/api/system-resources', (await import('./systemResources.js')).default],
  ['/api/cos', (await import('./cosTaskRoutes.js')).default],
];
const picker = { providerId: 'example-cli', model: 'example-model' };
// One write per router: [method, path, body, effect, success status].
const workflows = [
  ['post', '/api/rounds/generate', { brief: 'Example brief', ...picker }, effects.generateRound, 200],
  ['post', '/api/system-resources/triage', { providerId: 'example-cli' }, effects.triage, 200],
  ['post', '/api/cos/tasks/enhance', { description: 'Example task' }, effects.enhance, 200],
];

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

describe('caller-prompted AI routers behind the default-deny gate (#16114)', () => {
  it('still run for a local operator and a delegated agent session', async () => {
    await expectAuthorizedWorkflows({ auth, mounts, workflows });
    expect(effects.generateRound).toHaveBeenLastCalledWith(expect.objectContaining({ brief: 'Example brief', ...picker }));
  });
});
