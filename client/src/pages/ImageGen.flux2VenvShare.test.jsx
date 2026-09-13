// Z-Image dispatches through the same shared torch venv FLUX.2 does
// (usesDiffusersRunner in runnerFamilies.js / runners.js), so a broken venv
// must surface the same install banner FLUX.2 models get — with FLUX.2-only
// wording (and the HF-gated-repo token banner) suppressed, since Z-Image
// isn't a gated repo.
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

describe('ImageGen shared-venv install banner for non-flux2 diffusers models', () => {
  beforeEach(() => {
    resetImageGenMockState();
    state.models = [imageGenModel('z-turbo', { name: 'Z-Image Turbo', runner: 'z-image' })];
    state.settings = { imageGen: { mode: 'local', local: { pythonPath: '/usr/bin/python3', modelId: 'z-turbo' } } };
    state.flux2Status = { venvInstalled: false, hfTokenPresent: false, licenseUrl: 'https://huggingface.co/example' };
  });

  it('shows the install banner (with model-specific wording, not an HF-token banner) when the shared venv is unhealthy', async () => {
    await renderImageGenPage();

    const banner = await screen.findByRole('button', { name: /Install FLUX.2/i });
    expect(banner).toBeInTheDocument();
    expect(screen.getByText(/Z-Image Turbo shares the FLUX.2 torch runtime/i)).toBeInTheDocument();
    expect(screen.queryByText(/accept.*license/i)).not.toBeInTheDocument();
  });
});
