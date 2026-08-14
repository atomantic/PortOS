import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import MusicGenPanel from './MusicGenPanel';
import * as api from '../../services/api';

vi.mock('../../services/api', () => ({
  listMusicEngines: vi.fn(),
  generateMusic: vi.fn(),
  installAudioModel: vi.fn(),
  removeAudioModel: vi.fn(),
}));

vi.mock('../install/RuntimeInstallModal', () => ({
  default: ({ open, label }) => (open ? <div>Installing {label}</div> : null),
}));

const engine = (overrides) => ({
  id: 'musicgen',
  name: 'MusicGen (MLX)',
  models: [{ id: 'musicgen-medium', name: 'MusicGen Medium', userAdded: false }],
  defaultModelId: 'musicgen-medium',
  minDurationSec: 1,
  maxDurationSec: 30,
  defaultDurationSec: 12,
  lyrics: false,
  customModels: true,
  ready: true,
  ...overrides,
});

describe('MusicGenPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not show a missing-runtime warning immediately for an empty saved track', async () => {
    api.listMusicEngines.mockResolvedValue({
      defaultEngine: 'acestep',
      engines: [
        engine({
          id: 'acestep',
          name: 'ACE-Step (full song + vocals)',
          models: [{ id: 'ace-step-v1-3.5b', name: 'ACE-Step v1 3.5B', userAdded: false }],
          defaultModelId: 'ace-step-v1-3.5b',
          maxDurationSec: 240,
          defaultDurationSec: 60,
          lyrics: true,
          customModels: false,
          ready: false,
        }),
      ],
    });

    const { rerender } = render(<MusicGenPanel track={{ id: 'track-1' }} prompt="" lyrics="" />);

    await waitFor(() => expect(screen.getByRole('combobox', { name: /engine/i })).toHaveValue('acestep'));
    expect(screen.queryByText(/ACE-Step .* is not installed yet/i)).not.toBeInTheDocument();

    rerender(<MusicGenPanel track={{ id: 'track-1' }} prompt="warm folk song" lyrics="" />);
    expect(await screen.findByText(/ACE-Step .* is not installed yet/i)).toBeInTheDocument();
  });

  it('shows the missing-runtime warning when the user explicitly selects a missing engine', async () => {
    api.listMusicEngines.mockResolvedValue({
      defaultEngine: 'musicgen',
      engines: [
        engine({ id: 'musicgen', name: 'MusicGen (MLX)', ready: true }),
        engine({
          id: 'acestep',
          name: 'ACE-Step (full song + vocals)',
          models: [{ id: 'ace-step-v1-3.5b', name: 'ACE-Step v1 3.5B', userAdded: false }],
          defaultModelId: 'ace-step-v1-3.5b',
          maxDurationSec: 240,
          defaultDurationSec: 60,
          lyrics: true,
          customModels: false,
          ready: false,
        }),
      ],
    });

    render(<MusicGenPanel track={{ id: 'track-1' }} prompt="" lyrics="" />);

    const select = await screen.findByRole('combobox', { name: /engine/i });
    expect(select).toHaveValue('musicgen');
    expect(screen.queryByText(/ACE-Step .* is not installed yet/i)).not.toBeInTheDocument();

    fireEvent.change(select, { target: { value: 'acestep' } });
    expect(await screen.findByText(/ACE-Step .* is not installed yet/i)).toBeInTheDocument();
  });

  // The app mounts under <React.StrictMode> (client/src/main.jsx), whose dev
  // double-mount reuses the component's refs. A cleanup-only mounted guard is
  // left false by the simulated unmount, so `loadEngines` bailed before
  // `setLoading(false)` and the panel sat on "Loading generators…" forever
  // (#3264). Rendering the real StrictMode wrapper is the only way this
  // regression is visible — every other test here mounts the panel bare.
  it('loads the engine list under StrictMode instead of hanging on "Loading generators…"', async () => {
    api.listMusicEngines.mockResolvedValue({
      defaultEngine: 'musicgen',
      engines: [engine({ id: 'musicgen', name: 'MusicGen (MLX)', ready: true })],
    });

    render(
      <StrictMode>
        <MusicGenPanel track={{ id: 'track-1' }} prompt="" lyrics="" />
      </StrictMode>,
    );

    const select = await screen.findByRole('combobox', { name: /engine/i });
    expect(select).toHaveValue('musicgen');
    expect(screen.queryByText(/Loading generators/i)).not.toBeInTheDocument();
  });

  it('explains CUDA gating and hides install actions on an unsupported host', async () => {
    api.listMusicEngines.mockResolvedValue({
      defaultEngine: 'minimax-music3',
      engines: [engine({
        id: 'minimax-music3', name: 'MiniMax Music 3 (CUDA only)', ready: false,
        cudaRequired: true, cudaState: 'absent', fixedModelInstall: true, modelReady: false,
        customModels: false, lyrics: true, maxDurationSec: 300, defaultDurationSec: 60,
        models: [{ id: 'minimax-music3', repo: 'MiniMaxAI/MiniMax-Music3', name: 'MiniMax Music 3' }],
        defaultModelId: 'minimax-music3',
      })],
    });

    render(<MusicGenPanel track={{ id: 'track-1' }} prompt="cinematic score" lyrics="Example lyrics" />);

    expect(await screen.findByText(/requires an NVIDIA CUDA GPU/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /install runtime/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /install model/i })).not.toBeInTheDocument();
  });
});
