import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

// Z-Image dispatches through the same shared torch venv FLUX.2 does
// (usesDiffusersRunner in runnerFamilies.js / runners.js), so a broken venv
// must surface the same install banner FLUX.2 models get — with FLUX.2-only
// wording (and the HF-gated-repo token banner) suppressed, since Z-Image
// isn't a gated repo.
const MODEL = { id: 'z-turbo', name: 'Z-Image Turbo', runner: 'z-image' };

vi.mock('../services/api', () => ({
  getInstances: vi.fn(async () => ({ peers: [] })),
  getImageGenStatus: vi.fn(async () => ({ connected: true, mode: 'local', model: 'Z-Image Turbo' })),
  generateImage: vi.fn(async () => ({ jobId: 'job-1' })),
  generateImageMultipart: vi.fn(async () => ({})),
  listImageModels: vi.fn(async () => [MODEL]),
  listLorasFull: vi.fn(async () => []),
  listImageGallery: vi.fn(async () => []),
  cancelImageGen: vi.fn(async () => ({})),
  deleteImage: vi.fn(async () => ({})),
  setImageHidden: vi.fn(async () => ({})),
  cleanGalleryImage: vi.fn(async () => ({})),
  getActiveImageJob: vi.fn(async () => ({ activeJob: null })),
  getSettings: vi.fn(async () => ({ imageGen: { mode: 'local', local: { pythonPath: '/usr/bin/python3', modelId: 'z-turbo' } } })),
  buildFormData: vi.fn(() => new FormData()),
  listMediaJobs: vi.fn(async () => ({ jobs: [] })),
  regenerateGalleryImage: vi.fn(async () => ({})),
  getRegenAvailability: vi.fn(async () => ({ available: false })),
  removeImageWatermark: vi.fn(async () => ({})),
  getFlux2Status: vi.fn(async () => ({
    venvInstalled: false, hfTokenPresent: false, licenseUrl: 'https://huggingface.co/example',
  })),
}));

vi.mock('../hooks/useImageGenProgress', () => ({
  useImageGenProgress: () => ({ progress: null, begin: vi.fn(), end: vi.fn(), resume: vi.fn() }),
}));
vi.mock('../hooks/useMediaJobSse', () => ({
  useMediaJobSse: () => ({ attach: vi.fn(), eventSourceRef: { current: null } }),
}));
vi.mock('../hooks/useModelDownloadStatus', () => ({
  useModelDownloadStatus: () => ({
    getStatus: () => ({ cached: true }), start: vi.fn(), cancel: vi.fn(), repair: vi.fn(), refresh: vi.fn(),
    downloading: false, repairing: false, progress: null, lastError: null, activeModelId: null, extra: {}, loading: false, statusError: null,
  }),
}));
vi.mock('../hooks/useHfTokenStatus', () => ({ useHfTokenStatus: () => ({ present: true, refresh: vi.fn() }) }));
vi.mock('../hooks/useAgyModels', () => ({ useAgyModels: () => ({ models: [], error: null }) }));
vi.mock('../hooks/useMediaCompletionRefresh', () => ({ useMediaCompletionRefresh: vi.fn() }));
vi.mock('../hooks/useMediaAnnotations', () => ({
  useMediaAnnotations: () => ({ annotations: {}, updateAnnotation: vi.fn(), getCardProps: vi.fn(() => ({})) }),
}));
vi.mock('../hooks/useAutoRefetch', () => ({ useAutoRefetch: vi.fn() }));
vi.mock('../hooks/usePreviewRoute', () => ({ default: () => [null, vi.fn()] }));
vi.mock('../components/ui/Toast', () => ({
  default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), loading: vi.fn() }),
}));
vi.mock('../components/media/PromptEnhancer', () => ({ default: () => null }));
vi.mock('../components/media/PromptFromMedia', () => ({ default: () => null }));
vi.mock('../components/media/UniverseStylePicker', () => ({ default: () => null }));
vi.mock('../components/media/StylePresetPicker', () => ({ default: () => null }));
vi.mock('../components/media/MediaPreview', () => ({ default: () => null }));
vi.mock('../components/media/MediaJobsQueue', () => ({ default: () => null }));
vi.mock('../components/media/ResolutionField', () => ({ default: () => null }));
vi.mock('../components/Drawer', () => ({ default: () => null }));
vi.mock('../components/settings/ImageGenTab', () => ({ ImageGenTab: () => null }));
vi.mock('../components/imageGen/Flux2InstallModal', () => ({ default: () => null }));
vi.mock('../components/imageGen/GalleryImagePicker', () => ({ default: () => null }));
vi.mock('../components/imageGen/InitImagePicker', () => ({ default: () => null }));
vi.mock('../components/imageGen/ReferenceImagePicker', () => ({ default: () => null }));
vi.mock('../components/imageGen/LoraPicker', () => ({ default: () => null }));

const { default: ImageGen } = await import('./ImageGen.jsx');

const mount = async () => {
  await act(async () => {
    render(
      <MemoryRouter initialEntries={['/media/image']}>
        <ImageGen />
      </MemoryRouter>,
    );
  });
};

describe('ImageGen shared-venv install banner for non-flux2 diffusers models', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the install banner (with model-specific wording, not an HF-token banner) when the shared venv is unhealthy', async () => {
    await mount();

    const banner = await screen.findByRole('button', { name: /Install FLUX.2/i });
    expect(banner).toBeInTheDocument();
    expect(screen.getByText(/Z-Image Turbo shares the FLUX.2 torch runtime/i)).toBeInTheDocument();
    expect(screen.queryByText(/accept.*license/i)).not.toBeInTheDocument();
  });
});
