import { afterAll, beforeEach, describe, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { expectAuthorizedWorkflows, expectRemoteRefusal } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-runtime-installers-authority-') }));
afterAll(cleanupTempDataRoots);

// Runtime installers (#9555) are plain writes under the default-deny gate (#16018),
// whose principal matrix lives in services/authGate.test.js. This suite keeps one
// authorized workflow per router; each installer takes its already-installed path,
// so nothing is cloned or spawned.
const auth = vi.hoisted(() => ({ enabled: false }));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(),
  getSettings: vi.fn(async () => ({})),
}));
const effects = vi.hoisted(() => ({
  isInstalled: vi.fn(() => true),
  isMuscriptorRuntimeReady: vi.fn(async () => true),
  installYtDlp: vi.fn(async () => ({ success: true, version: '1.0.1' })),
  updateYtDlp: vi.fn(async () => ({ success: true, version: '1.0.1' })),
}));
vi.mock('../lib/setupScriptRunner.js', async (importOriginal) => ({
  ...await importOriginal(), stopSetupScript: vi.fn(), spawnSetupScript: vi.fn(),
}));
vi.mock('../lib/pythonSetup.js', async (importOriginal) => ({
  ...await importOriginal(),
  isMuscriptorRuntimeReady: effects.isMuscriptorRuntimeReady,
  invalidateMuscriptorPython: vi.fn(),
  resolveMuscriptorPython: vi.fn(() => '/opt/example/python'),
}));
vi.mock('../services/ytdlpUpdate.js', () => ({
  getYtDlpUpdateStatus: vi.fn(async () => ({ version: '1.0.0' })),
  installYtDlp: effects.installYtDlp,
  updateYtDlp: effects.updateYtDlp,
}));
vi.mock('../services/videoDownload.js', () => ({}));
vi.mock('../services/imageTo3d/targets.js', () => ({
  getTarget: vi.fn(() => ({ id: 'trellis2', label: 'TRELLIS.2' })),
  listTargets: vi.fn(() => []),
  detectHostCapabilities: vi.fn(() => ({})),
  unavailableReason: vi.fn(() => null),
  unavailableReasonLabel: vi.fn(() => ''),
  IMAGE_TO_3D_TARGET_IDS: ['trellis2', 'pixal3d', 'pixal3d-cuda'],
  renderOptionSupportFor: vi.fn(() => ({})),
}));
vi.mock('../services/imageTo3d/adapters.js', () => ({
  getTargetAdapter: vi.fn(() => ({ install: vi.fn(), isInstalled: effects.isInstalled })),
}));
vi.mock('../services/imageTo3d/models.js', () => ({ USDZ_MAX_BYTES: 1 }));

const mounts = [
  ['/api/image-to-3d', (await import('./imageTo3d.js')).default],
  ['/api/midi-runtime', (await import('./midiRuntime.js')).default],
  ['/api/devtools/video-download', (await import('./videoDownload.js')).default],
];

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

describe('runtime installers behind the default-deny gate (#16114)', () => {
  it('refuses remote installation on a password-free host', async () => {
    await expectRemoteRefusal(mounts, ['post', '/api/devtools/video-download/yt-dlp/install', undefined, effects.installYtDlp]);
  });

  it('still runs each installer for a local operator and a delegated agent session', async () => {
    await expectAuthorizedWorkflows({ auth, mounts, workflows: [
      ['post', '/api/image-to-3d/targets/trellis2/install', {}, effects.isInstalled, 200],
      ['post', '/api/midi-runtime/install', {}, effects.isMuscriptorRuntimeReady, 200],
      ['post', '/api/devtools/video-download/yt-dlp/install', undefined, effects.installYtDlp, 200],
      ['post', '/api/devtools/video-download/yt-dlp/update', {}, effects.updateYtDlp, 200],
    ] });
  });
});
