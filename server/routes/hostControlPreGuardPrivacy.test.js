import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { expectAuthorizedWorkflows, expectRemoteRefusal } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-privacy-authority-') }));
afterAll(cleanupTempDataRoots);

// Every write here is gated by the default-deny policy (#16018); the refusal and
// principal matrix live in services/authGate.test.js and server/test/guards/modules/hostControlCoverage.test.js.
// This suite proves each mounted router still runs behind the real gates for a
// local operator and a delegated agent session, and keeps the refusal/allow pair
// for the YouTube setup check, a HOST_CONTROL_GET_ROUTES read that drives the
// signed-in managed browser. The first service boundary is doubled.
const auth = vi.hoisted(() => ({ enabled: false }));
const effects = vi.hoisted(() => ({
  history: vi.fn(async () => ({ candidates: [] })),
  scan: vi.fn(async () => ({ scanned: 0 })),
  optOut: vi.fn(async () => ({ submitted: 0 })),
  youtubeSync: vi.fn(async () => ({ ok: true })),
  youtubeSetupCheck: vi.fn(async () => ({ ok: true })),
  rescheduleGoal: vi.fn(async () => ({ scheduled: 0 })),
}));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(),
  getSettings: vi.fn(async () => ({})),
  updateSettingsWith: vi.fn(),
}));
vi.mock('../services/privacyTwinHistory.js', () => ({ cleanHistoricalTwinArtifacts: effects.history }));
vi.mock('../services/privacyScan.js', () => ({ runScanPass: effects.scan }));
vi.mock('../services/privacyOptOut.js', () => ({}));
vi.mock('../services/privacyRecheckScheduler.js', () => ({}));
vi.mock('../services/privacySubjects.js', () => ({}));
vi.mock('../services/privacyVault.js', () => ({}));
vi.mock('../services/privacyWebsiteLogins.js', () => ({}));
vi.mock('../services/privacyOrgs.js', () => ({}));
vi.mock('../services/privacyBrokers.js', () => ({}));
vi.mock('../services/privacyChanges.js', () => ({}));
vi.mock('../services/youtubeSync.js', () => ({ runSync: effects.youtubeSync, checkSetup: effects.youtubeSetupCheck }));
vi.mock('../services/youtubePlaylists.js', () => ({}));
vi.mock('../services/goalCalendarScheduler.js', () => ({ rescheduleTimeBlocks: effects.rescheduleGoal }));
vi.mock('../services/identity.js', () => ({}));


const setupCheck = ['get', '/api/youtube/setup-check', undefined, effects.youtubeSetupCheck, 200];
// One write per router plus the sensitive read: [method, path, body, effect, success status].
const history = ['post', '/api/privacy/twin-history/cleanup', { action: 'list' }, effects.history, 200];
const workflows = [
  history,
  ['post', '/api/privacy/scan', {}, effects.scan, 200],
  ['post', '/api/youtube/sync', {}, effects.youtubeSync, 200],
  setupCheck,
  ['post', '/api/digital-twin/identity/goals/example-goal/reschedule', {}, effects.rescheduleGoal, 200],
];

const mounts = [
  ['/api/privacy', (await import('./privacy.js')).default],
  ['/api/youtube', (await import('./youtube.js')).default],
  ['/api/digital-twin/identity', (await import('./identity.js')).default],
];

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

describe('privacy, YouTube and goal calendar routers behind the host-control gate (#16114)', () => {
  it('refuses the YouTube setup check to a remote password-free caller before the browser opens', async () => {
    await expectRemoteRefusal(mounts, setupCheck);
  });

  it('refuses a remote password-free cleanup before reading artifacts', async () => {
    await expectRemoteRefusal(mounts, history);
  });

  it('still run for a local operator and a delegated agent session', async () => {
    await expectAuthorizedWorkflows({ auth, mounts, workflows });
    expect(effects.rescheduleGoal).toHaveBeenLastCalledWith('example-goal');
  });
});
