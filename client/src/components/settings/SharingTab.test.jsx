import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { awaitEnabled } from '../../test/enabledBarrier.js';

vi.mock('../../services/apiAuth.js', () => ({
  getAuthStatus: vi.fn(),
}));
vi.mock('../../services/apiSystem.js', () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getMediaShareCandidates: vi.fn(),
}));
vi.mock('../../services/apiMusic.js', () => ({
  listMusicEngines: vi.fn(),
}));
vi.mock('../ui/Toast');

import { getAuthStatus } from '../../services/apiAuth.js';
import { getMediaShareCandidates, getSettings, updateSettings } from '../../services/apiSystem.js';
import { listMusicEngines } from '../../services/apiMusic.js';
import toast from '../ui/Toast';
import { SharingTab } from './SharingTab';

const renderSharing = () => render(<SharingTab />, { wrapper: MemoryRouter });
const strictToggle = () => screen.getByLabelText(/Enforce per-peer sharing settings/i);

beforeEach(() => {
  vi.clearAllMocks();
  getAuthStatus.mockResolvedValue({ enabled: false });
  getSettings.mockResolvedValue({ sharingDisplayName: '', sharingBio: '' });
  listMusicEngines.mockResolvedValue({ engines: [] });
  getMediaShareCandidates.mockResolvedValue({ image: [], video: [] });
  updateSettings.mockResolvedValue({});
});

it('blocks settings edits after a failed read and restores the saved settings on Retry', async () => {
  getSettings.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({
    sharingDisplayName: 'Example instance',
    federation: { strictPullAuthorization: true },
  });

  renderSharing();
  const error = await screen.findByRole('alert');
  expect(error).toHaveTextContent('Could not load sharing settings — offline');
  expect(screen.queryByLabelText('Display name')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
  expect(screen.queryByText(/instance password is required/i)).not.toBeInTheDocument();

  fireEvent.click(within(error).getByRole('button', { name: 'Retry' }));
  expect(await screen.findByLabelText('Display name')).toHaveValue('Example instance');
  expect(strictToggle()).toBeChecked();
  expect(updateSettings).not.toHaveBeenCalled();
});

it('lets the active-job limit be cleared and saves the replacement number', async () => {
  renderSharing();
  const limit = await screen.findByRole('spinbutton', { name: 'Shared active-job limit' });
  fireEvent.change(limit, { target: { value: '' } });
  expect(limit).toHaveValue(null);
  expect(screen.getByRole('button', { name: 'Save provider' })).toBeDisabled();

  fireEvent.change(limit, { target: { value: '12' } });
  fireEvent.blur(limit);
  fireEvent.click(screen.getByRole('button', { name: 'Save provider' }));
  await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
    federation: { mediaProvider: expect.objectContaining({ maxQueuedJobs: 12 }) },
  }, { silent: true }));
});

describe('SharingTab — federated media provider (#4348)', () => {
  const providerToggle = () => screen.getByLabelText(/Accept media generation jobs/i);

  it('states accurate audio prompt/lyrics boundaries on the provider opt-in card (#18158)', async () => {
    renderSharing();
    await waitFor(() => expect(providerToggle()).toBeInTheDocument());
    expect(screen.getByText(/plus song lyrics when targeting a lyric-capable model/i)).toBeInTheDocument();
    expect(screen.queryByText(/never free text or lyrics/i)).not.toBeInTheDocument();
  });

  it('keeps provider opt-in disabled until an instance password exists', async () => {
    renderSharing();
    await waitFor(() => expect(providerToggle()).toBeInTheDocument());
    expect(providerToggle()).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Security tab' })).toHaveAttribute('href', '/settings/security');
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

    renderSharing();
    await awaitEnabled(providerToggle);
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
    renderSharing();
    await awaitEnabled(providerToggle);
    fireEvent.click(providerToggle());
    fireEvent.click(screen.getByRole('button', { name: 'Save provider' }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      federation: expect.objectContaining({ mediaProvider: expect.objectContaining({ enabled: false }) }),
    }), { silent: true }));
  });
});

describe('SharingTab — federation pull authorization (#3659)', () => {
  it('describes verified peer credentials and always-enforced personal categories (#18158)', async () => {
    renderSharing();
    await waitFor(() => expect(strictToggle()).toBeInTheDocument());
    expect(screen.getByText(/identified by their verified peer credential/i)).toBeInTheDocument();
    expect(screen.getByText(/Brain, Memory, Digital Twin, MeatSpace, and Character\) are always refused with 403/i)).toBeInTheDocument();
    expect(screen.getByText(/legacy non-PII categories/i)).toBeInTheDocument();
  });

  it('defaults the strict-pull toggle off when the setting is absent', async () => {
    renderSharing();
    await waitFor(() => expect(strictToggle()).toBeInTheDocument());
    expect(strictToggle().checked).toBe(false);
  });

  it('reflects the persisted setting', async () => {
    getSettings.mockResolvedValue({ federation: { strictPullAuthorization: true } });
    renderSharing();
    await waitFor(() => expect(strictToggle().checked).toBe(true));
  });

  it('patches the toggle alone and leaves sibling sub-keys to the server merge', async () => {
    getSettings.mockResolvedValue({ federation: { strictPullAuthorization: false, somethingElse: 'keep-me' } });
    renderSharing();
    await waitFor(() => expect(strictToggle()).toBeInTheDocument());
    fireEvent.click(strictToggle());
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      federation: { strictPullAuthorization: true },
    }));
    await waitFor(() => expect(strictToggle().checked).toBe(true));
  });

  it('leaves the toggle unchanged when the save fails', async () => {
    updateSettings.mockRejectedValue(new Error('nope'));
    renderSharing();
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

    renderSharing();
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

    renderSharing();
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

    renderSharing();
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

describe('SharingTab — bulk enable/disable and loading state', () => {
  it('shows a loading state, not the failure message, while candidates load', async () => {
    getMediaShareCandidates.mockReturnValue(new Promise(() => {}));
    renderSharing();
    expect(await screen.findByText(/Loading local image models/i)).toBeInTheDocument();
    expect(screen.queryByText(/Could not load local image models/i)).not.toBeInTheDocument();
  });

  it('Enable all checks every ready model; Disable all clears them', async () => {
    getAuthStatus.mockResolvedValue({ enabled: true });
    getMediaShareCandidates.mockResolvedValue({
      image: [
        { engine: 'local', modelId: 'img-a', modelName: 'img-a', ready: true },
        { engine: 'local', modelId: 'img-b', modelName: 'img-b', ready: false },
      ],
      video: [{ engine: 'local', modelId: 'vid-a', modelName: 'vid-a', ready: true }],
    });
    renderSharing();
    const imgA = await screen.findByLabelText(/img-a/);
    fireEvent.click(screen.getByRole('button', { name: 'Enable all' }));
    expect(imgA).toBeChecked();
    expect(screen.getByLabelText(/vid-a/)).toBeChecked();
    expect(screen.getByLabelText(/img-b/)).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Disable all' }));
    expect(imgA).not.toBeChecked();
    expect(screen.getByLabelText(/vid-a/)).not.toBeChecked();
  });
});

describe('SharingTab — a failed candidate fetch is not an empty catalog', () => {
  it('retries a failed candidate read while keeping already-shared models editable', async () => {
    getMediaShareCandidates.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({
      image: [{ engine: 'local', modelId: 'img-a', modelName: 'Example image model', ready: true }],
      video: [],
    });
    getAuthStatus.mockResolvedValue({ enabled: true });
    getSettings.mockResolvedValue({
      sharingDisplayName: '', sharingBio: '',
      federation: { mediaProvider: { enabled: true, imageModels: [{ engine: 'local', modelId: 'img-a' }] } },
    });

    renderSharing();
    const imagePicker = within(await screen.findByRole('group', { name: 'Allowed image models' }));
    const error = await imagePicker.findByRole('alert');
    expect(error).toHaveTextContent('Could not load local image models');
    expect(imagePicker.getByLabelText(/img-a/)).toBeChecked();
    expect(imagePicker.getByLabelText(/img-a/)).toBeEnabled();
    expect(screen.queryByText(/No local image models are installed/i)).not.toBeInTheDocument();
    fireEvent.click(within(error).getByRole('button', { name: 'Retry' }));
    expect(await imagePicker.findByLabelText('Example image model')).toBeChecked();
    expect(imagePicker.queryByRole('alert')).not.toBeInTheDocument();
    expect(getSettings).toHaveBeenCalledTimes(1);
  });

  it('still reports a genuinely empty catalog as empty', async () => {
    getMediaShareCandidates.mockResolvedValue({ image: [], video: [] });
    getAuthStatus.mockResolvedValue({ enabled: true });
    getSettings.mockResolvedValue({
      sharingDisplayName: '', sharingBio: '',
      federation: { mediaProvider: { enabled: true, audioModels: [] } },
    });

    renderSharing();
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

    renderSharing();
    const toggle = await screen.findByLabelText(/Accept media generation jobs/i);

    getSettings.mockRejectedValueOnce(new Error('offline'));
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Save provider' }));

    await waitFor(() => expect(toast.error)
      .toHaveBeenCalledWith('Could not read current settings — provider not saved: offline Check the connection and try again.'));
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('shows an error row with Retry when the music engine catalog fails, not the "not available" copy', async () => {
    listMusicEngines.mockRejectedValueOnce(new Error('engines 500'));
    renderSharing();

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the local music engine catalog — engines 500');
    expect(screen.queryByText(/music engine catalog is not available/)).not.toBeInTheDocument();

    listMusicEngines.mockResolvedValue({ engines: [{ id: 'e1', name: 'Example Engine', models: [{ id: 'm1', name: 'Example Model' }] }] });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Example Engine')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
