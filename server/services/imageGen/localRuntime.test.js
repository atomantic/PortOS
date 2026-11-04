import { describe, expect, it, vi, beforeEach } from 'vitest';

const settings = vi.hoisted(() => ({ value: {} }));
const models = vi.hoisted(() => ({ value: [] }));

vi.mock('../settings.js', () => ({ getSettings: vi.fn(async () => settings.value) }));
vi.mock('../../lib/mediaModels.js', () => ({ getImageModels: vi.fn(() => models.value) }));
vi.mock('./setup.js', () => ({ getSetupCheck: vi.fn() }));
vi.mock('./flux3Runtime.js', () => ({ diagnoseFlux3Runtime: vi.fn() }));
vi.mock('./mossRuntime.js', () => ({ diagnoseMossRuntime: vi.fn(), MOSS_MANIFEST: { repo: 'example/moss', revision: 'pinned' } }));
vi.mock('./mossWeights.js', () => ({ verifyMossWeights: vi.fn() }));
vi.mock('../../lib/pythonSetup.js', () => ({
  isFlux2VenvHealthy: vi.fn(),
  FLUX2_VENV_DEFAULT: '/test/venv-flux2/bin/python3',
}));

import { diagnoseLocalRuntime } from './localRuntime.js';
import { getSetupCheck } from './setup.js';
import { isFlux2VenvHealthy } from '../../lib/pythonSetup.js';
import { diagnoseMossRuntime } from './mossRuntime.js';
import { diagnoseFlux3Runtime } from './flux3Runtime.js';
import { verifyMossWeights } from './mossWeights.js';

const mflux = { id: 'dev', name: 'FLUX.1 Dev', runner: 'mflux', hardwareCompatibility: { state: 'available', reasons: [] } };

beforeEach(() => {
  vi.clearAllMocks();
  models.value = [mflux];
  settings.value = { imageGen: { local: { modelId: 'dev', pythonPath: '/test/python3' } } };
});

// Every unavailable verdict has to name the ONE action that fixes it, or the UI
// falls back to "go look in Settings" — which is precisely the loop this module
// exists to close, because the Settings panel probes a different interpreter and
// reported "All required packages installed" for an unrenderable machine.
describe('diagnoseLocalRuntime remedies', () => {
  it('checks the isolated FLUX.3 runtime without depending on the configured legacy Python', async () => {
    models.value = [{ ...mflux, id: 'flux3-klein-q4', runner: 'flux3' }];
    settings.value = {};
    diagnoseFlux3Runtime.mockResolvedValue({ readiness: 'unavailable', reason: 'Repair runtime', remedy: { kind: 'install-flux3' } });
    await expect(diagnoseLocalRuntime({ modelId: 'flux3-klein-q4' })).resolves.toMatchObject({ runtime: 'flux3', readiness: 'unavailable', remedy: { kind: 'install-flux3' } });
    diagnoseFlux3Runtime.mockResolvedValue({ readiness: 'ready' });
    await expect(diagnoseLocalRuntime({ modelId: 'flux3-klein-q4' })).resolves.toMatchObject({ readiness: 'ready' });
    expect(getSetupCheck).not.toHaveBeenCalled();
    expect(isFlux2VenvHealthy).not.toHaveBeenCalled();
  });

  it('keeps native installation, pinned weights and readiness separate without a Python dependency', async () => {
    models.value = [{ ...mflux, id: 'moss-image-sft-bf16', runner: 'moss-swift', repo: 'example/moss', revision: 'pinned' }];
    settings.value = { imageGen: { local: { modelId: 'moss-image-sft-bf16' } } };
    diagnoseMossRuntime.mockResolvedValue({ readiness: 'unavailable', reason: 'Metal resources missing', remedy: { kind: 'install-moss-swift' } });
    await expect(diagnoseLocalRuntime()).resolves.toMatchObject({ runtime: 'moss-swift', readiness: 'unavailable', remedy: { kind: 'install-moss-swift' } });
    expect(verifyMossWeights).not.toHaveBeenCalled();
    diagnoseMossRuntime.mockResolvedValue({ readiness: 'ready' });
    verifyMossWeights.mockResolvedValue({ cached: false });
    await expect(diagnoseLocalRuntime()).resolves.toMatchObject({ readiness: 'unavailable', remedy: { kind: 'download-moss-weights' } });
    verifyMossWeights.mockResolvedValue({ cached: true });
    await expect(diagnoseLocalRuntime()).resolves.toMatchObject({ readiness: 'ready', remedy: null });
    expect(getSetupCheck).not.toHaveBeenCalled();
    expect(isFlux2VenvHealthy).not.toHaveBeenCalled();
    models.value[0].revision = 'unvalidated';
    await expect(diagnoseLocalRuntime()).resolves.toMatchObject({ readiness: 'unavailable', remedy: { kind: 'choose-model' } });
  });
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
