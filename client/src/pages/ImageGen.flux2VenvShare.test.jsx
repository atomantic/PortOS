// Z-Image dispatches through the same shared torch venv FLUX.2 does
// (usesDiffusersRunner in runnerFamilies.js / runners.js), so a broken venv
// must offer the same one-button install FLUX.2 models get — and NOT the
// HF-gated-repo token banner, since Z-Image isn't a gated repo.
//
// The offer now rides the readiness pill's own `remedy`, which comes from the
// shared server diagnosis (`services/imageGen/localRuntime.js`) rather than
// from a second probe: a page-specific banner beside the pill meant the page
// could render an install button from one producer and a verdict from another.
import { beforeEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';

import {
  imageGenModel,
  loadImageGenPage,
  renderImageGenPage,
  resetImageGenMockState,
  state,
} from '../test/imageGenPageMocks.jsx';

await loadImageGenPage();

describe('ImageGen shared-venv install offer for non-flux2 diffusers models', () => {
  beforeEach(() => {
    resetImageGenMockState();
    state.models = [imageGenModel('z-turbo', { name: 'Z-Image Turbo', runner: 'z-image' })];
    state.settings = { imageGen: { mode: 'local', local: { pythonPath: '/usr/bin/python3', modelId: 'z-turbo' } } };
    state.flux2Status = { venvInstalled: false, hfTokenPresent: false, licenseUrl: 'https://huggingface.co/example' };
    state.getImageGenStatus.mockResolvedValue({
      connected: false,
      mode: 'local',
      model: 'Z-Image Turbo',
      modelId: 'z-turbo',
      readiness: 'unavailable',
      runtime: 'torch-venv',
      reason: 'The shared torch image runtime is not installed or healthy (expected at /home/u/.portos/venv-flux2/bin/python3)',
      remedy: { kind: 'install-torch-venv', label: 'Install runtime', venvPath: '/home/u/.portos/venv-flux2/bin/python3' },
    });
  });

  it('offers the runtime install from the readiness pill, with no HF-token banner', async () => {
    await renderImageGenPage();

    expect(await screen.findByRole('button', { name: /Install runtime/i })).toBeInTheDocument();
    expect(screen.getByText(/not installed or healthy/i)).toBeInTheDocument();
    expect(screen.queryByText(/accept.*license/i)).not.toBeInTheDocument();
  });
});
