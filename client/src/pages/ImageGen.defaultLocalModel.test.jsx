/**
 * The Image Gen form seeds its model picker from the install-wide default
 * (`settings.imageGen.local.modelId`, set on Settings → Media → Local) rather
 * than from whatever the catalog happens to list first. Every other local
 * render surface already honoured that pin; this page did not, so one install
 * rendered a different model depending on which screen you started from.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { getSettings } from '../services/api';

const DEV = { id: 'dev', name: 'FLUX.1 Dev', runner: 'mflux', steps: 20, guidance: 3.5 };
// Deliberately NOT first in the catalog — the regression this suite pins is the
// page opening on models[0] and ignoring the saved pin.
const KLEIN = { id: 'flux2-klein-4b', name: 'FLUX.2 Klein', runner: 'flux2', steps: 20, guidance: 3.5 };

vi.mock('../services/api', () => ({
  getInstances: vi.fn(async () => ({ peers: [] })),
  getImageGenStatus: vi.fn(async () => ({ connected: true, mode: 'local', readiness: 'ready' })),
  generateImage: vi.fn(async () => ({})),
  generateImageMultipart: vi.fn(async () => ({})),
  listImageModels: vi.fn(async () => [DEV, KLEIN]),
  listLorasFull: vi.fn(async () => []),
  listImageGalleryPage: vi.fn(async () => ({ items: [], total: 0, hiddenTotal: 0 })),
  cancelImageGen: vi.fn(async () => ({})),
  deleteImage: vi.fn(async () => ({})),
  setImageHidden: vi.fn(async () => ({})),
  cleanGalleryImage: vi.fn(async () => ({})),
  getActiveImageJob: vi.fn(async () => ({ activeJob: null })),
  getSettings: vi.fn(async () => ({ imageGen: { mode: 'local', local: { pythonPath: '/usr/bin/python3' } } })),
  buildFormData: vi.fn(() => new FormData()),
  listMediaJobs: vi.fn(async () => ({ jobs: [] })),
  regenerateGalleryImage: vi.fn(async () => ({})),
  getRegenAvailability: vi.fn(async () => ({ available: false })),
  removeImageWatermark: vi.fn(async () => ({})),
  getFlux2Status: vi.fn(async () => ({ installed: true, ready: true })),
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
vi.mock('../components/ui/Toast', () => ({
  default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), loading: vi.fn() }),
}));
vi.mock('../components/media/PromptEnhancer', () => ({ default: () => null }));
vi.mock('../components/media/PromptFromMedia', () => ({ default: () => null }));
vi.mock('../components/media/UniverseStylePicker', () => ({ default: () => null }));
vi.mock('../components/media/StylePresetPicker', () => ({ default: () => null }));
vi.mock('../components/media/MediaCard', () => ({ default: () => null }));
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

const mount = async (path = '/media/image') => {
  await act(async () => {
    render(
      <MemoryRouter initialEntries={[path]}>
        <ImageGen />
      </MemoryRouter>,
    );
  });
};


const settingsWith = (local) => ({ imageGen: { mode: 'local', local: { pythonPath: '/usr/bin/python3', ...local } } });
const modelSelect = () => screen.getByLabelText('Model');

describe('ImageGen default local model', () => {
  beforeEach(() => {
    window.matchMedia = vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  });

  it('opens on the model pinned in settings, not the first catalog entry', async () => {
    getSettings.mockResolvedValue(settingsWith({ modelId: 'flux2-klein-4b' }));
    await mount();
    await waitFor(() => expect(modelSelect().value).toBe('flux2-klein-4b'));
  });

  it('falls back to the first catalog entry when nothing is pinned', async () => {
    getSettings.mockResolvedValue(settingsWith({}));
    await mount();
    await waitFor(() => expect(modelSelect().value).toBe('dev'));
  });

  it('falls back to the first catalog entry when the pin no longer resolves', async () => {
    // A retired/incompatible pin must not leave the select empty — the form
    // would then submit a blank modelId the local runner cannot dispatch.
    getSettings.mockResolvedValue(settingsWith({ modelId: 'retired-model' }));
    await mount();
    await waitFor(() => expect(modelSelect().value).toBe('dev'));
  });

  it('still settles on a model when the settings fetch fails', async () => {
    getSettings.mockRejectedValue(new Error('offline'));
    await mount();
    await waitFor(() => expect(modelSelect().value).toBe('dev'));
  });

  it('lets a ?modelId= deep link win over the pin', async () => {
    getSettings.mockResolvedValue(settingsWith({ modelId: 'flux2-klein-4b' }));
    await mount('/media/image?modelId=dev');
    await waitFor(() => expect(modelSelect().value).toBe('dev'));
  });
});
