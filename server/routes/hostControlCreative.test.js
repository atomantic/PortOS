import { afterAll, beforeEach, describe, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { expectAuthorizedWorkflows } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-creative-authority-') }));
afterAll(cleanupTempDataRoots);

// Creative Director and Commission steering (#10867) is gated by the default-deny
// write policy (#16018); the refusal and principal matrix live in
// services/authGate.test.js and hostControlCoverage.test.js. The production
// routers run with every service boundary doubled; the workflows watch the
// project starter and the commission scheduler.
const auth = vi.hoisted(() => ({ enabled: false }));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(),
  getSettings: vi.fn(async () => ({})),
}));

const project = vi.hoisted(() => ({ id: 'example-project', status: 'paused', treatment: null, plan: { steps: [] } }));
vi.mock('../services/creativeDirector/local.js', () => ({
  getProject: vi.fn(async () => project),
  updateProject: vi.fn(async (_id, patch) => ({ ...project, ...patch })),
}));
vi.mock('../services/creativeDirector/completionHook.js', () => ({
  startCreativeDirectorProject: vi.fn(async () => undefined),
}));
vi.mock('../services/creativeCommissions/store.js', () => ({
  ERR_NOT_FOUND: 'NOT_FOUND', ERR_VALIDATION: 'VALIDATION', getCommission: vi.fn(async (id) => ({ id })),
}));
vi.mock('../services/creativeCommissions/scheduler.js', () => ({
  runCommissionNow: vi.fn(async () => ({ outcome: 'started' })),
}));
// Service graphs the routers import; their handlers are not reached.
vi.mock('../services/creativeDirector/planAdvance.js', () => ({}));
vi.mock('../services/creative/toolRegistry.js', () => ({}));
vi.mock('../services/creativeDirector/autoCast.js', () => ({}));
vi.mock('../services/creativeDirector/firstPassGen.js', () => ({}));
vi.mock('../services/creativeDirector/firstPassMusicGen.js', () => ({}));
vi.mock('../services/creativeDirector/smokeTest.js', () => ({}));
vi.mock('../services/creativeDirector/stopProject.js', () => ({}));
vi.mock('../services/creativeDirector/videoReview.js', () => ({}));
vi.mock('../services/review.js', () => ({ reviewEvents: new EventEmitter() }));

const { startCreativeDirectorProject } = await import('../services/creativeDirector/completionHook.js');
const { runCommissionNow } = await import('../services/creativeCommissions/scheduler.js');
const mounts = [
  ['/api/creative-director', (await import('./creativeDirector.js')).default],
  ['/api/creative-commission', (await import('./creativeCommissions.js')).default],
];
// One write per router: [method, path, body, effect, success status].
const workflows = [
  ['post', '/api/creative-director/example-project/start', {}, startCreativeDirectorProject, 200],
  ['post', '/api/creative-commission/example-commission/run', {}, runCommissionNow, 202],
];

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

describe('Creative Director and Commission routers behind the default-deny gate (#16114)', () => {
  it('still start a project and run a commission for a local operator and a delegated agent session', async () => {
    await expectAuthorizedWorkflows({ auth, mounts, workflows });
  });
});
