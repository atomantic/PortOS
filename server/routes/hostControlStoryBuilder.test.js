import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { expectAuthorizedWorkflows, expectRemoteRefusal } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

// Use the production router and gates, replacing only stores and execution
// boundaries. Refusal must happen before even reading the stored session.
const auth = vi.hoisted(() => ({ enabled: false }));
const effects = vi.hoisted(() => Object.fromEntries([
  'listStorySessions', 'getStorySession', 'createStorySession', 'updateStorySession',
  'deleteStorySession', 'lockStep', 'unlockStep', 'setCurrentStep', 'setIssueLock',
  'generateIssuesFromArc', 'setStorySessionSync', 'reconcileStorySession',
  'getStorySessionView', 'startStepRun', 'attachClient', 'listActiveStepRuns',
].map(name => [name, vi.fn(async () => ({ id: 'example-session' }))])));
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-story-authority-') }));
afterAll(cleanupTempDataRoots);
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(), isAuthEnabled: vi.fn(async () => auth.enabled),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(), getSettings: vi.fn(async () => ({})),
}));
vi.mock('../services/instanceIdentity.js', () => ({ loadData: vi.fn(async () => ({ peers: [] })) }));
vi.mock('../services/storyBuilder.js', () => ({
  ...effects, ERR_NOT_FOUND: 'STORY_BUILDER_NOT_FOUND', ERR_VALIDATION: 'STORY_BUILDER_VALIDATION',
}));
vi.mock('../services/storyBuilderRunner.js', () => ({
  startStepRun: effects.startStepRun, attachClient: effects.attachClient,
  listActiveStepRuns: effects.listActiveStepRuns,
}));

import storyRoutes from './storyBuilder.js';

const base = '/api/story-builder';
const session = `${base}/example-session`;
// Principal matrix: services/authGate.test.js. Kept: the refusal ahead of the
// session read, and each distinct generation op plus the writes still working.
const mounts = [[base, storyRoutes]];
const generation = [
  ['post', `${session}/steps/idea/generate`, { providerId: 'example-cli' }, effects.startStepRun, 200],
  ['post', `${session}/steps/idea/generate`, { providerId: 'example-api', fromDownstream: true }, effects.startStepRun, 200],
  ['post', `${session}/steps/idea/refine`, { providerId: 'example-tui', feedback: 'Example feedback' }, effects.startStepRun, 200],
  ['post', `${session}/issues/generate`, { providerId: 'example-api' }, effects.generateIssuesFromArc, 200],
];

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
  effects.getStorySessionView.mockResolvedValue({ session: { id: 'example-session' }, staleSteps: [], syncDrift: false });
  effects.startStepRun.mockReturnValue({ runId: 'example-run', alreadyRunning: false });
  effects.listActiveStepRuns.mockReturnValue([]);
  effects.attachClient.mockImplementation((_id, _step, res) => { res.end(); return true; });
});

describe('Story Builder generation behind the default-deny gate (#10670, #16114)', () => {
  it('refuses remote generation before any session read or SSE admission', async () => {
    await expectRemoteRefusal(mounts, generation[0]);
    for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
  });

  it('still runs generation, refinement, backfill, progress attachment and record writes for local and agent callers', async () => {
    await expectAuthorizedWorkflows({ auth, mounts, workflows: [
      ...generation,
      ['get', `${session}/steps/idea/progress`, undefined, effects.attachClient, 200],
      ['post', base, { title: 'Example story' }, effects.createStorySession, 201],
      ['patch', session, { title: 'Example edited story' }, effects.updateStorySession, 200],
      ['delete', session, undefined, effects.deleteStorySession, 200],
      ['post', `${session}/sync`, { sync: true }, effects.setStorySessionSync, 200],
      ['post', `${session}/reconcile`, {}, effects.reconcileStorySession, 200],
      ['post', `${session}/current-step/idea`, {}, effects.setCurrentStep, 200],
      ['post', `${session}/steps/idea/lock`, {}, effects.lockStep, 200],
      ['post', `${session}/steps/idea/unlock`, {}, effects.unlockStep, 200],
      ['post', `${session}/issues/example-issue/lock`, { locked: true }, effects.setIssueLock, 200],
    ] });
    expect(effects.startStepRun).toHaveBeenCalledWith('example-session', 'idea', expect.objectContaining({ op: 'refine', feedback: 'Example feedback' }));
  });
});
