import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../services/api', () => ({
  getAuthStatus: vi.fn(),
  getSettings: vi.fn(),
  listMusicEngines: vi.fn(),
  updateSettings: vi.fn(),
  getMediaShareCandidates: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({
  default: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  }),
}));

import { getAuthStatus, getMediaShareCandidates, getSettings, listMusicEngines, updateSettings } from '../../services/api';
import { SharingTab } from './SharingTab';

const strictToggle = () => screen.getByLabelText(/Enforce per-peer sharing settings/i);

beforeEach(() => {
  vi.clearAllMocks();
  getAuthStatus.mockResolvedValue({ enabled: false });
  getSettings.mockResolvedValue({ sharingDisplayName: '', sharingBio: '' });
  listMusicEngines.mockResolvedValue({ engines: [] });
  getMediaShareCandidates.mockResolvedValue({ image: [], video: [] });
  updateSettings.mockResolvedValue({});
});

describe('SharingTab — federated media provider (#4348)', () => {
  const providerToggle = () => screen.getByLabelText(/Accept audio generation jobs/i);

  it('keeps provider opt-in disabled until an instance password exists', async () => {
    render(<SharingTab />);
    await waitFor(() => expect(providerToggle()).toBeInTheDocument());
    expect(providerToggle()).toBeDisabled();
    expect(screen.getByText(/instance password is required/i)).toBeInTheDocument();
  });

  it('persists an allowlisted model while preserving the rest of the federation slice', async () => {
    getAuthStatus.mockResolvedValue({ enabled: true });
    getSettings.mockResolvedValue({
      federation: {
        strictPullAuthorization: false,
        somethingElse: 'keep-me',
        mediaProvider: {
          enabled: false,
          maxQueuedJobs: 2,
          audioModels: [{ engine: 'minimax-music3', modelId: 'minimax-music3', futureModelField: 'keep-model-too' }],
          futureField: 'keep-too',
        },
      },
    });
    listMusicEngines.mockResolvedValue({
      engines: [{
        id: 'minimax-music3',
        name: 'MiniMax Music 3',
        runtimeReady: true,
        platformSupported: true,
        cudaRequired: true,
        cudaState: 'available',
        fixedModelInstall: true,
        modelReadyById: { 'minimax-music3': true },
        models: [{ id: 'minimax-music3', name: 'MiniMax model' }],
      }],
    });

    render(<SharingTab />);
    await waitFor(() => expect(providerToggle()).toBeEnabled());
    await waitFor(() => expect(screen.getByLabelText('MiniMax model')).toBeInTheDocument());
    fireEvent.click(providerToggle());
    fireEvent.click(screen.getByRole('button', { name: 'Save provider' }));

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      federation: {
        strictPullAuthorization: false,
        somethingElse: 'keep-me',
        mediaProvider: {
          enabled: true,
          maxQueuedJobs: 2,
          audioModels: [{
            engine: 'minimax-music3',
            modelId: 'minimax-music3',
            futureModelField: 'keep-model-too',
          }],
          // Every kind's list is written on each save, so a peer that shares
          // only audio still records an explicit empty visual allowlist.
          imageModels: [],
          videoModels: [],
          futureField: 'keep-too',
        },
      },
    }, { silent: true }));
  });

  it('lets an auth-off install disable a provider that was previously enabled', async () => {
    getSettings.mockResolvedValue({
      federation: {
        mediaProvider: {
          enabled: true,
          maxQueuedJobs: 2,
          audioModels: [{ engine: 'minimax-music3', modelId: 'minimax-music3' }],
        },
      },
    });
    render(<SharingTab />);
    await waitFor(() => expect(providerToggle()).toBeEnabled());
    fireEvent.click(providerToggle());
    fireEvent.click(screen.getByRole('button', { name: 'Save provider' }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      federation: expect.objectContaining({ mediaProvider: expect.objectContaining({ enabled: false }) }),
    }), { silent: true }));
  });
});

describe('SharingTab — federation pull authorization (#3659)', () => {
  it('defaults the strict-pull toggle off when the setting is absent', async () => {
    render(<SharingTab />);
    await waitFor(() => expect(strictToggle()).toBeInTheDocument());
    expect(strictToggle().checked).toBe(false);
  });

  it('reflects the persisted setting', async () => {
    getSettings.mockResolvedValue({ federation: { strictPullAuthorization: true } });
    render(<SharingTab />);
    await waitFor(() => expect(strictToggle().checked).toBe(true));
  });

  it('carries the rest of the federation slice forward on save (shallow top-level merge)', async () => {
    getSettings.mockResolvedValue({ federation: { strictPullAuthorization: false, somethingElse: 'keep-me' } });
    render(<SharingTab />);
    await waitFor(() => expect(strictToggle()).toBeInTheDocument());
    fireEvent.click(strictToggle());
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      federation: { strictPullAuthorization: true, somethingElse: 'keep-me' },
    }));
    await waitFor(() => expect(strictToggle().checked).toBe(true));
  });

  it('leaves the toggle unchanged when the save fails', async () => {
    updateSettings.mockRejectedValue(new Error('nope'));
    render(<SharingTab />);
    await waitFor(() => expect(strictToggle()).toBeInTheDocument());
    fireEvent.click(strictToggle());
    await waitFor(() => expect(updateSettings).toHaveBeenCalled());
    await waitFor(() => expect(strictToggle().checked).toBe(false));
  });
});
