import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { getRunwayImageModel } from '../../lib/imageGenBackends';
import ImageGenProviderSections from './ImageGenProviderSections';

vi.mock('./LocalSetupPanel', () => ({ default: () => null }));
vi.mock('../../hooks/useLocalImageModels', () => ({ default: () => ({ models: [] }) }));
vi.mock('../../services/apiImageVideo.js', () => ({
  getVideoGenModelContext: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../services/apiRunwayCatalog.js', async (importOriginal) => ({
  ...await importOriginal(),
  loadRunwayCatalog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../services/apiProviders.js', () => ({
  getProviders: vi.fn().mockResolvedValue({ providers: [] }),
}));

function renderSection(mediaTab, initialValues = {}) {
  const set = vi.fn();
  const makeSection = (values) => (
    <MemoryRouter>
      <Routes>
        <Route path="/" element={
          <ImageGenProviderSections
            mediaTab={mediaTab}
            setMediaTab={vi.fn()}
            form={{ values: {
              codexEnabled: false, codexModel: '', codexPath: '', codexEffort: '',
              cleanC2PAByMode: {}, denoiseByMode: {},
              runwayEnabled: false, runwayModel: 'gen4_image', runwayResolution: '1080p',
              googleEnabled: false, googleModel: '', googleProjectId: '', googleLocation: '',
              ...initialValues, ...values,
            }, set }}
            parallelBounds={{ min: 1, max: 8, default: 1 }}
            localRuntime={{ runtime: null }}
            runwayCredential={{ configured: true }}
          />
        } />
        <Route path="/models/media" element={<h1>Media model management</h1>} />
      </Routes>
    </MemoryRouter>
  );
  const view = render(makeSection());
  return { set, update: (values) => view.rerender(makeSection(values)) };
}

describe('image generation provider sections', () => {
  it('gates Runway controls and resets resolution when the shared picker changes model', () => {
    const { set, update } = renderSection('runway');
    expect(screen.getByText('Runway credential configured.')).toBeVisible();
    expect(screen.queryByLabelText('Default model')).toBeNull();
    expect(screen.queryByLabelText('Resolution')).toBeNull();
    expect(screen.queryByLabelText(/Clean C2PA/)).toBeNull();
    expect(screen.queryByLabelText('Parallel video render limit')).toBeNull();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable Runway Imagegen' }));
    expect(set).toHaveBeenCalledWith('runwayEnabled', true);
    update({ runwayEnabled: true });
    expect(screen.getByLabelText('Resolution')).toBeVisible();
    expect(screen.getByLabelText('Parallel video render limit')).toBeVisible();
    const picker = screen.getByLabelText('Default model');
    expect(picker.querySelector('option[value=""]')).toBeNull();
    const modelId = 'gen4_image_turbo';
    fireEvent.change(picker, { target: { value: modelId } });
    expect(set).toHaveBeenCalledWith('runwayModel', modelId);
    expect(set).toHaveBeenCalledWith('runwayResolution', getRunwayImageModel(modelId).defaultResolution);
  });

  it('gates both Google render limits and keeps shared Cloud configuration accessible', () => {
    const { update } = renderSection('google');
    expect(screen.getByLabelText('Google Cloud project')).toBeVisible();
    expect(screen.queryByLabelText('Parallel image render limit')).toBeNull();
    expect(screen.queryByLabelText('Parallel video render limit')).toBeNull();

    update({ googleEnabled: true, googleVideoParallelLimit: 4 });
    expect(screen.getByLabelText('Parallel image render limit')).toBeVisible();
    expect(screen.getByLabelText('Parallel video render limit')).toHaveValue(4);
  });

  it('clamps the Codex limit on blur while allowing a user to finish typing', async () => {
    const { set } = renderSection('codex', { codexEnabled: true, codexParallelLimit: 6 });
    await act(async () => {});
    expect(screen.getByText(/6 concurrent renders can burn credits/)).toBeVisible();
    const limit = screen.getByLabelText('Parallel render limit');
    fireEvent.change(limit, { target: { value: '82' } });
    expect(limit).toHaveValue(82);
    expect(set).not.toHaveBeenCalled();
    fireEvent.blur(limit);
    expect(set).toHaveBeenCalledWith('codexParallelLimit', 8);
    expect(limit).toHaveValue(8);
  });

  it('navigates to media model management through the router', () => {
    renderSection('local');
    fireEvent.click(screen.getAllByRole('link').find((link) => link.getAttribute('href') === '/models/media'));
    expect(screen.getByRole('heading', { name: 'Media model management' })).toBeVisible();
  });
});
