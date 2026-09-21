import { describe, expect, it, vi, beforeEach } from 'vitest';

const settings = vi.hoisted(() => ({ value: {} }));
const models = vi.hoisted(() => ({ value: [] }));

vi.mock('../settings.js', () => ({ getSettings: vi.fn(async () => settings.value) }));
vi.mock('../../lib/mediaModels.js', () => ({ getImageModels: vi.fn(() => models.value) }));
vi.mock('./setup.js', () => ({ getSetupCheck: vi.fn() }));
vi.mock('../../lib/pythonSetup.js', () => ({
  isFlux2VenvHealthy: vi.fn(),
  FLUX2_VENV_DEFAULT: '/test/venv-flux2/bin/python3',
}));

import { diagnoseLocalRuntime } from './localRuntime.js';
import { getSetupCheck } from './setup.js';
import { isFlux2VenvHealthy } from '../../lib/pythonSetup.js';

const mflux = { id: 'dev', name: 'FLUX.1 Dev', runner: 'mflux', hardwareCompatibility: { state: 'available', reasons: [] } };

beforeEach(() => {
  vi.clearAllMocks();
  models.value = [mflux];
  settings.value = { imageGen: { local: { pythonPath: '/test/python3' } } };
});

// Every unavailable verdict has to name the ONE action that fixes it, or the UI
// falls back to "go look in Settings" — which is precisely the loop this module
// exists to close, because the Settings panel probes a different interpreter and
// reported "All required packages installed" for an unrenderable machine.
describe('diagnoseLocalRuntime remedies', () => {
  it('offers the runtime install for a model whose shared torch venv is unhealthy', async () => {
    models.value = [{ ...mflux, id: 'qwen-image-2.1', runner: 'qwen', pipelineClass: 'QwenImage21Pipeline' }];
    settings.value = { imageGen: { local: { modelId: 'qwen-image-2.1' } } };
    isFlux2VenvHealthy.mockResolvedValue(false);

    await expect(diagnoseLocalRuntime()).resolves.toMatchObject({
      readiness: 'unavailable',
      runtime: 'torch-venv',
      remedy: { kind: 'install-torch-venv', venvPath: '/test/venv-flux2/bin/python3' },
    });
    expect(isFlux2VenvHealthy).toHaveBeenCalledWith('QwenImage21Pipeline');
  });

  it('says the runtime needs an UPDATE when the venv works but predates the model pipeline', async () => {
    // Otherwise the banner claims nothing is installed while the installer it
    // launches answers "already installed — nothing to do".
    models.value = [{ ...mflux, id: 'qwen-image-2.1', runner: 'qwen', pipelineClass: 'QwenImage21Pipeline' }];
    settings.value = { imageGen: { local: { modelId: 'qwen-image-2.1' } } };
    isFlux2VenvHealthy.mockImplementation(async (cls) => !cls);

    const verdict = await diagnoseLocalRuntime();
    expect(verdict.readiness).toBe('unavailable');
    expect(verdict.reason).toContain('too old for QwenImage21Pipeline');
    expect(verdict.remedy).toMatchObject({ kind: 'install-torch-venv', label: 'Update runtime' });
  });

  it('offers the pip install, with the pip-spec names, for a missing mflux package', async () => {
    getSetupCheck.mockResolvedValue({ missing: ['cv2'], missingPip: ['opencv-python'], archMismatch: false });

    await expect(diagnoseLocalRuntime()).resolves.toMatchObject({
      readiness: 'unavailable',
      runtime: 'mflux-python',
      remedy: { kind: 'install-packages', pythonPath: '/test/python3', packages: ['opencv-python'] },
    });
  });

  it('offers the suggested interpreter when the configured one is the wrong architecture', async () => {
    getSetupCheck.mockResolvedValue({
      missing: [], archMismatch: true, interpreterArch: 'x86_64', hostArch: 'arm64',
      suggestedArm64Python: '/opt/homebrew/bin/python3',
    });

    await expect(diagnoseLocalRuntime()).resolves.toMatchObject({
      readiness: 'unavailable',
      remedy: { kind: 'switch-python', pythonPath: '/opt/homebrew/bin/python3' },
    });
  });

  it('leaves an unverifiable runtime without a remedy rather than guessing one', async () => {
    getSetupCheck.mockRejectedValue(new Error('spawn failed'));

    await expect(diagnoseLocalRuntime()).resolves.toMatchObject({ readiness: 'unknown', remedy: null });
  });
});
