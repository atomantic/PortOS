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
import toast from '../ui/Toast';
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
  const providerToggle = () => screen.getByLabelText(/Accept media generation jobs/i);

  it('keeps provider opt-in disabled until an instance password exists', async () => {
    render(<SharingTab />);
    await waitFor(() => expect(providerToggle()).toBeInTheDocument());
    expect(providerToggle()).toBeDisabled();
    expect(screen.getByText(/instance password is required/i)).toBeInTheDocument();
  });

  it('persists an allowlisted model while preserving unknown mediaProvider fields', async () => {
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

    // #4703 — the patch carries `mediaProvider` alone; `strictPullAuthorization`
    // and the unknown `somethingElse` are the server merge's job to carry.
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      federation: {
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

  it('patches the toggle alone and leaves sibling sub-keys to the server merge', async () => {
    getSettings.mockResolvedValue({ federation: { strictPullAuthorization: false, somethingElse: 'keep-me' } });
    render(<SharingTab />);
    await waitFor(() => expect(strictToggle()).toBeInTheDocument());
    fireEvent.click(strictToggle());
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      federation: { strictPullAuthorization: true },
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

// #4348 — the provider side could not share visual models at all before this,
// so no peer ever advertised an image/video capability to route at.
describe('SharingTab — visual provider models', () => {
  const candidate = (overrides) => ({
    engine: 'local', ready: true, unavailableReason: null, ...overrides,
  });

  it('shares a local image model into its own allowlist', async () => {
    getMediaShareCandidates.mockResolvedValue({
      image: [candidate({ modelId: 'flux-dev', modelName: 'FLUX dev' })],
      video: [],
    });
    getSettings.mockResolvedValue({
      sharingDisplayName: '', sharingBio: '',
      federation: { mediaProvider: { enabled: true, audioModels: [] } },
    });
    getAuthStatus.mockResolvedValue({ enabled: true });

    render(<SharingTab />);
    fireEvent.click(await screen.findByLabelText('FLUX dev'));
    fireEvent.click(screen.getByRole('button', { name: 'Save provider' }));

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      federation: {
        mediaProvider: {
          enabled: true,
          maxQueuedJobs: 2,
          audioModels: [],
          imageModels: [{ engine: 'local', modelId: 'flux-dev' }],
          videoModels: [],
        },
      },
    }, { silent: true }));
  });

  // Otherwise the provider keeps advertising a stale unknown-model entry with
  // no checkbox left to clear it.
  it('keeps an already-shared model listed after it leaves the local catalog', async () => {
    getMediaShareCandidates.mockResolvedValue({ image: [], video: [] });
    getSettings.mockResolvedValue({
      sharingDisplayName: '', sharingBio: '',
      federation: {
        mediaProvider: {
          enabled: true, audioModels: [],
          imageModels: [{ engine: 'local', modelId: 'uninstalled-model' }],
        },
      },
    });
    getAuthStatus.mockResolvedValue({ enabled: true });

    render(<SharingTab />);
    const checkbox = await screen.findByLabelText(/uninstalled-model/);
    expect(checkbox).toBeChecked();
    // Togglable despite being unavailable — that is the whole point.
    expect(checkbox).toBeEnabled();
    expect(screen.getByText(/no longer installed/)).toBeInTheDocument();
  });
});

// #4703 — the Instances page owns `federation.mediaRouting`. This tab must not
// name that sub-key at all: a patch that carried it would replace the routing
// map with whatever this tab happened to read, however stale.
describe('SharingTab — patches only the federation sub-keys it owns', () => {
  it('never names mediaRouting in a provider save', async () => {
    getMediaShareCandidates.mockResolvedValue({ image: [], video: [] });
    getAuthStatus.mockResolvedValue({ enabled: true });
    // Start enabled, then turn sharing OFF — disabling needs no model selection,
    // so the save actually reaches updateSettings.
    getSettings.mockResolvedValueOnce({
      sharingDisplayName: '', sharingBio: '',
      federation: {
        mediaProvider: {
          enabled: true, maxQueuedJobs: 2,
          audioModels: [{ engine: 'minimax-music3', modelId: 'minimax-music3' }],
        },
      },
    });

    render(<SharingTab />);
    const toggle = await screen.findByLabelText(/Accept media generation jobs/i);

    // The Instances page saves a route while this tab is sitting open.
    const route = { peerId: 'peer-1', engine: 'comfy', modelId: 'sdxl-base' };
    getSettings.mockResolvedValueOnce({
      federation: {
        mediaProvider: {
          enabled: true, maxQueuedJobs: 2,
          audioModels: [{ engine: 'minimax-music3', modelId: 'minimax-music3' }],
        },
        mediaRouting: { image: route },
      },
    });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Save provider' }));

    await waitFor(() => expect(updateSettings).toHaveBeenCalled());
    const [patch] = updateSettings.mock.calls.at(-1);
    expect(Object.keys(patch.federation)).toEqual(['mediaProvider']);
  });
});

describe('SharingTab — a failed candidate fetch is not an empty catalog', () => {
  it('says the list could not load rather than "no models installed"', async () => {
    getMediaShareCandidates.mockRejectedValue(new Error('offline'));
    getAuthStatus.mockResolvedValue({ enabled: true });
    getSettings.mockResolvedValue({
      sharingDisplayName: '', sharingBio: '',
      federation: { mediaProvider: { enabled: true, audioModels: [] } },
    });

    render(<SharingTab />);
    expect(await screen.findByText(/Could not load the local image model list/i)).toBeInTheDocument();
    expect(screen.queryByText(/No local image models are installed/i)).not.toBeInTheDocument();
  });

  it('still reports a genuinely empty catalog as empty', async () => {
    getMediaShareCandidates.mockResolvedValue({ image: [], video: [] });
    getAuthStatus.mockResolvedValue({ enabled: true });
    getSettings.mockResolvedValue({
      sharingDisplayName: '', sharingBio: '',
      federation: { mediaProvider: { enabled: true, audioModels: [] } },
    });

    render(<SharingTab />);
    expect(await screen.findByText(/No local image models are installed/i)).toBeInTheDocument();
  });
});

describe('SharingTab — an absent federation slice is not a failed read', () => {
  it('aborts a provider save only when the read actually failed', async () => {
    getMediaShareCandidates.mockResolvedValue({ image: [], video: [] });
    getAuthStatus.mockResolvedValue({ enabled: true });
    getSettings.mockResolvedValueOnce({
      sharingDisplayName: '', sharingBio: '',
      federation: {
        mediaProvider: {
          enabled: true, maxQueuedJobs: 2,
          audioModels: [{ engine: 'minimax-music3', modelId: 'minimax-music3' }],
        },
      },
    });

    render(<SharingTab />);
    const toggle = await screen.findByLabelText(/Accept media generation jobs/i);

    getSettings.mockRejectedValueOnce(new Error('offline'));
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Save provider' }));

    await waitFor(() => expect(toast.error)
      .toHaveBeenCalledWith('Could not read current settings — provider not saved'));
    expect(updateSettings).not.toHaveBeenCalled();
  });
});
