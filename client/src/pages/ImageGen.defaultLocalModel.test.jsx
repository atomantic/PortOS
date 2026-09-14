/**
 * The Image Gen form seeds its model picker from the install-wide default
 * (`settings.imageGen.local.modelId`, set on Settings → Media → Local) rather
 * than from whatever the catalog happens to list first. Every other local
 * render surface already honoured that pin; this page did not, so one install
 * rendered a different model depending on which screen you started from.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';

import {
  imageGenModel,
  loadImageGenPage,
  renderImageGenPage,
  resetImageGenMockState,
  state,
} from '../test/imageGenPageMocks.jsx';

const DEV = imageGenModel('dev', { name: 'FLUX.1 Dev' });
// Deliberately NOT first in the catalog — the regression this suite pins is the
// page opening on models[0] and ignoring the saved pin.
const KLEIN = imageGenModel('flux2-klein-4b', { name: 'FLUX.2 Klein', runner: 'flux2' });

await loadImageGenPage();

const settingsWith = (local) => ({ imageGen: { mode: 'local', local: { pythonPath: '/usr/bin/python3', ...local } } });
const modelSelect = () => screen.getByLabelText('Model');

describe('ImageGen default local model', () => {
  beforeEach(() => {
    resetImageGenMockState();
    state.models = [DEV, KLEIN];
    window.matchMedia = vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  });

  it('opens on the model pinned in settings, not the first catalog entry', async () => {
    state.getSettings.mockResolvedValue(settingsWith({ modelId: 'flux2-klein-4b' }));
    await renderImageGenPage();
    await waitFor(() => expect(modelSelect().value).toBe('flux2-klein-4b'));
  });

  it('falls back to the first catalog entry when nothing is pinned', async () => {
    state.getSettings.mockResolvedValue(settingsWith({}));
    await renderImageGenPage();
    await waitFor(() => expect(modelSelect().value).toBe('dev'));
  });

  it('falls back to the first catalog entry when the pin no longer resolves', async () => {
    // A retired/incompatible pin must not leave the select empty — the form
    // would then submit a blank modelId the local runner cannot dispatch.
    state.getSettings.mockResolvedValue(settingsWith({ modelId: 'retired-model' }));
    await renderImageGenPage();
    await waitFor(() => expect(modelSelect().value).toBe('dev'));
  });

  it('still settles on a model when the settings fetch fails', async () => {
    state.getSettings.mockRejectedValue(new Error('offline'));
    await renderImageGenPage();
    await waitFor(() => expect(modelSelect().value).toBe('dev'));
  });

  it('lets a ?modelId= deep link win over the pin', async () => {
    state.getSettings.mockResolvedValue(settingsWith({ modelId: 'flux2-klein-4b' }));
    await renderImageGenPage('/media/image?modelId=dev');
    await waitFor(() => expect(modelSelect().value).toBe('dev'));
  });
});
