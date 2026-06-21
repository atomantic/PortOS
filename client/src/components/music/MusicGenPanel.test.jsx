import { describe, it, expect, vi, beforeEach } from 'vitest';
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
});
