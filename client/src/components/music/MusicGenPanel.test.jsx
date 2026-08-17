import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import MusicGenPanel from './MusicGenPanel';
import * as api from '../../services/api';

vi.mock('../../services/api', () => ({
  listMusicEngines: vi.fn(),
  generateMusic: vi.fn(),
  getActiveProcessing: vi.fn(),
  getMediaJob: vi.fn(),
  getTrack: vi.fn(),
  cancelMediaJob: vi.fn(),
  installAudioModel: vi.fn(),
  removeAudioModel: vi.fn(),
}));

vi.mock('../install/RuntimeInstallModal', () => ({
  default: ({ open, label, onClose }) => (open ? (
    <div>
      Installing {label}
      <button type="button" onClick={onClose}>close installer</button>
    </div>
  ) : null),
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

// MiniMax Music 3 as the server reports it: CUDA-only, one fixed checkpoint,
// and a runtime venv installed separately from the weights.
const minimax = (overrides) => engine({
  id: 'minimax-music3',
  name: 'MiniMax Music 3 (CUDA only)',
  models: [{ id: 'minimax-music3', repo: 'MiniMaxAI/MiniMax-Music3', name: 'MiniMax Music 3' }],
  defaultModelId: 'minimax-music3',
  maxDurationSec: 300,
  defaultDurationSec: 60,
  lyrics: true,
  customModels: false,
  fixedModelInstall: true,
  modelReady: false,
  modelSizeGb: 29,
  cudaRequired: true,
  cudaState: 'available',
  ready: false,
  ...overrides,
});

describe('MusicGenPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getActiveProcessing.mockResolvedValue({ jobs: [] });
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
    expect(screen.queryByRole('button', { name: /install/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /download model weights/i })).not.toBeInTheDocument();
  });

  it('explains an insufficient CUDA VRAM profile and hides install actions', async () => {
    api.listMusicEngines.mockResolvedValue({
      defaultEngine: 'minimax-music3',
      engines: [minimax({
        ready: false,
        runtimeReady: true,
        modelReady: true,
        vramState: 'insufficient',
        minVramGb: 32,
        maxVramGb: 24,
        vramProfileLabel: 'CUDA BF16 (single GPU)',
      })],
    });

    render(<MusicGenPanel track={{ id: 'track-1' }} prompt="cinematic score" lyrics="Example lyrics" />);

    expect(await screen.findByText(/requires at least 32 GB of VRAM/i)).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /insufficient VRAM/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /install/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^generate$/i })).toBeDisabled();
  });

  it('keeps an unknown-size CUDA profile distinct from insufficient VRAM', async () => {
    api.listMusicEngines.mockResolvedValue({
      defaultEngine: 'minimax-music3',
      engines: [minimax({
        ready: false,
        runtimeReady: true,
        modelReady: true,
        vramState: 'unknown-size',
        maxVramGb: null,
        minVramGb: null,
      })],
    });

    render(<MusicGenPanel track={{ id: 'track-1' }} prompt="cinematic score" lyrics="Example lyrics" />);

    expect(await screen.findByText(/VRAM requirement has not been measured/i)).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /VRAM unknown/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /install/i })).not.toBeInTheDocument();
  });

  it('shows the configured profile and the active render effective placement', async () => {
    api.listMusicEngines.mockResolvedValue({
      defaultEngine: 'minimax-music3',
      engines: [minimax({
        ready: true,
        runtimeReady: true,
        modelReady: true,
        vramState: 'sufficient',
        executionProfile: 'cuda-bf16-auto-experimental',
        vramProfileLabel: 'CUDA BF16 (experimental automatic placement)',
      })],
    });
    const track = {
      id: 'track-1',
      audioFilename: 'fake.wav',
      renders: [{
        id: 'render-1', audioFilename: 'fake.wav', engine: 'minimax-music3',
        executionProfile: 'cuda-bf16-component-offload',
      }],
    };

    render(<MusicGenPanel track={track} prompt="cinematic score" lyrics="Example lyrics" />);

    expect(await screen.findByText(/Active render profile:/i)).toHaveTextContent('CUDA BF16 (component offload)');
  });

  it('generates an unsaved standalone track without requiring a title or associations', async () => {
    api.listMusicEngines.mockResolvedValue({
      defaultEngine: 'musicgen',
      engines: [engine({ ready: true })],
    });
    api.generateMusic.mockResolvedValue({ track: { id: 'generated-track', title: 'Ambient sunrise' } });
    const onGenerated = vi.fn();

    render(<MusicGenPanel prompt="Ambient sunrise" lyrics="" onGenerated={onGenerated} />);

    fireEvent.click(await screen.findByRole('button', { name: /generate track/i }));
    await waitFor(() => expect(api.generateMusic).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'Ambient sunrise',
      title: '',
      artistId: '',
      artist: '',
      albumId: '',
    }), { silent: true }));
    expect(api.generateMusic.mock.calls[0][0]).not.toHaveProperty('trackId');
    expect(onGenerated).toHaveBeenCalledWith(expect.objectContaining({ id: 'generated-track' }));
  });

  it('can render instrumentally without conditioning on or clearing the track lyrics', async () => {
    api.listMusicEngines.mockResolvedValue({
      defaultEngine: 'acestep',
      engines: [engine({
        id: 'acestep',
        name: 'ACE-Step (full song + vocals)',
        models: [{ id: 'ace-step-v1-3.5b', name: 'ACE-Step v1 3.5B', userAdded: false }],
        defaultModelId: 'ace-step-v1-3.5b',
        maxDurationSec: 240,
        defaultDurationSec: 60,
        lyrics: true,
        customModels: false,
        ready: true,
      })],
    });
    api.generateMusic.mockResolvedValue({ track: { id: 'track-1' } });

    render(<MusicGenPanel track={{ id: 'track-1' }} prompt="warm folk" lyrics={'[verse]\nKeep these words'} />);

    const instrumental = await screen.findByRole('checkbox', { name: /instrumental only/i });
    expect(instrumental).not.toBeChecked();
    expect(instrumental).toBeEnabled();
    fireEvent.click(instrumental);
    expect(screen.getByText(/saved lyrics will not condition this render/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^generate$/i }));

    await waitFor(() => expect(api.generateMusic).toHaveBeenCalled());
    const requestBody = api.generateMusic.mock.calls[0][0];
    expect(requestBody).toEqual(expect.objectContaining({
      trackId: 'track-1',
      instrumentalOnly: true,
      lyrics: '[verse]\nKeep these words',
    }));
  });

  it('keeps lyricless vocal textures possible until instrumental mode is explicitly selected', async () => {
    api.listMusicEngines.mockResolvedValue({
      defaultEngine: 'acestep',
      engines: [engine({
        id: 'acestep',
        name: 'ACE-Step (full song + vocals)',
        models: [{ id: 'ace-step-v1-3.5b', name: 'ACE-Step v1 3.5B', userAdded: false }],
        defaultModelId: 'ace-step-v1-3.5b',
        lyrics: true,
        customModels: false,
        ready: true,
      })],
    });
    api.generateMusic.mockResolvedValue({ track: { id: 'track-1' } });

    render(<MusicGenPanel track={{ id: 'track-1' }} prompt="distant wordless choir" lyrics="" />);

    const instrumental = await screen.findByRole('checkbox', { name: /instrumental only/i });
    expect(instrumental).not.toBeChecked();
    expect(instrumental).toBeEnabled();
    expect(screen.getByText(/vocals may still follow the prompt/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^generate$/i }));

    await waitFor(() => expect(api.generateMusic).toHaveBeenCalledWith(expect.objectContaining({
      instrumentalOnly: false,
      lyrics: '',
    }), { silent: true }));
  });

  it('offers instrumental-only conditioning for engines without a separate lyrics input', async () => {
    api.listMusicEngines.mockResolvedValue({ defaultEngine: 'musicgen', engines: [engine({ ready: true })] });
    api.generateMusic.mockResolvedValue({ track: { id: 'track-1' } });

    render(<MusicGenPanel track={{ id: 'track-1' }} prompt="ambient choir textures" lyrics="" />);

    const instrumental = await screen.findByRole('checkbox', { name: /instrumental only/i });
    fireEvent.click(instrumental);
    fireEvent.click(screen.getByRole('button', { name: /^generate$/i }));

    await waitFor(() => expect(api.generateMusic).toHaveBeenCalled());
    const requestBody = api.generateMusic.mock.calls[0][0];
    expect(requestBody.instrumentalOnly).toBe(true);
    expect(requestBody).not.toHaveProperty('lyrics');
  });

  it('rehydrates a running Music Studio job when the panel remounts', async () => {
    api.listMusicEngines.mockResolvedValue({ defaultEngine: 'musicgen', engines: [engine({ ready: true })] });
    api.getActiveProcessing.mockResolvedValue({ jobs: [{
      id: 'job-remounted', kind: 'audio', status: 'running', startedAt: new Date(Date.now() - 5000).toISOString(),
      params: { musicStudio: { trackId: 'track-1', instrumentalOnly: true } },
    }] });
    api.getMediaJob.mockResolvedValue({ status: 'running', startedAt: new Date(Date.now() - 5000).toISOString() });
    render(<MusicGenPanel track={{ id: 'track-1' }} prompt="warm folk" lyrics="" />);
    expect(await screen.findByText(/processing on the gpu|rendering audio/i)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/elapsed/);
    expect(screen.getByRole('checkbox', { name: /instrumental only/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /instrumental only/i })).toBeDisabled();
  });

  it('suggests a lyric-aware MiniMax ceiling and sends Auto mode', async () => {
    api.listMusicEngines.mockResolvedValue({
      defaultEngine: 'minimax-music3',
      engines: [engine({
        id: 'minimax-music3',
        name: 'MiniMax Music 3 (CUDA only)',
        autoDuration: true,
        lyrics: true,
        maxDurationSec: 300,
        defaultDurationSec: 60,
        models: [{ id: 'minimax-music3', repo: 'MiniMaxAI/MiniMax-Music3', name: 'MiniMax Music 3' }],
        defaultModelId: 'minimax-music3',
      })],
    });
    api.generateMusic.mockResolvedValue({ track: { id: 'track-auto' } });

    const lyrics = `[verse]\n${'word '.repeat(150)}\n[outro]`;
    render(<MusicGenPanel track={{ id: 'track-1' }} prompt="warm cinematic pop" lyrics={lyrics} />);

    expect(await screen.findByRole('combobox', { name: /duration mode/i })).toHaveValue('auto');
    expect(screen.getByLabelText(/duration \(s\)/i)).toHaveValue(120);
    expect(screen.getByText(/ceiling from 150 lyric words/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^generate$/i }));
    await waitFor(() => expect(api.generateMusic).toHaveBeenCalledWith(expect.objectContaining({
      durationMode: 'auto',
    }), { silent: true }));
    expect(api.generateMusic.mock.calls[0][0]).not.toHaveProperty('durationSec');
  });

  it('does not advertise Auto mode when the server omits the capability', async () => {
    api.listMusicEngines.mockResolvedValue({
      defaultEngine: 'minimax-music3',
      engines: [engine({
        id: 'minimax-music3',
        name: 'MiniMax Music 3 (CUDA only)',
        lyrics: true,
        maxDurationSec: 300,
        defaultDurationSec: 60,
        models: [{ id: 'minimax-music3', repo: 'MiniMaxAI/MiniMax-Music3', name: 'MiniMax Music 3' }],
        defaultModelId: 'minimax-music3',
      })],
    });

    render(<MusicGenPanel track={{ id: 'track-1' }} prompt="warm cinematic pop" lyrics="Long lyric text" />);

    await screen.findByRole('combobox', { name: /engine/i });
    expect(screen.queryByRole('combobox', { name: /duration mode/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/duration \(s\)/i)).not.toBeDisabled();
  });

  it('warns when lyric text has no structure tags for MiniMax to pace', async () => {
    api.listMusicEngines.mockResolvedValue({
      defaultEngine: 'minimax-music3',
      engines: [engine({
        id: 'minimax-music3',
        name: 'MiniMax Music 3 (CUDA only)',
        autoDuration: true,
        lyrics: true,
        maxDurationSec: 300,
        defaultDurationSec: 60,
        models: [{ id: 'minimax-music3', repo: 'MiniMaxAI/MiniMax-Music3', name: 'MiniMax Music 3' }],
        defaultModelId: 'minimax-music3',
      })],
    });

    render(<MusicGenPanel track={{ id: 'track-1' }} prompt="warm cinematic pop" lyrics="plain lyric text without sections" />);

    expect(await screen.findByText(/no structured lyric sections detected/i)).toBeInTheDocument();
  });

  it('warns when a manual MiniMax duration is shorter than the lyric recommendation', async () => {
    api.listMusicEngines.mockResolvedValue({
      defaultEngine: 'minimax-music3',
      engines: [engine({
        id: 'minimax-music3',
        name: 'MiniMax Music 3 (CUDA only)',
        autoDuration: true,
        lyrics: true,
        maxDurationSec: 300,
        defaultDurationSec: 60,
        models: [{ id: 'minimax-music3', repo: 'MiniMaxAI/MiniMax-Music3', name: 'MiniMax Music 3' }],
        defaultModelId: 'minimax-music3',
      })],
    });

    const lyrics = `[verse]\n${'word '.repeat(150)}\n[outro]`;
    render(<MusicGenPanel track={{ id: 'track-1' }} prompt="warm cinematic pop" lyrics={lyrics} />);

    fireEvent.change(await screen.findByRole('combobox', { name: /duration mode/i }), { target: { value: 'manual' } });
    fireEvent.change(screen.getByLabelText(/duration \(s\)/i), { target: { value: '60' } });
    expect(screen.getByText(/shorter than the lyric estimate/i)).toBeInTheDocument();
  });

  it('names the host requirement and hides Install for a platform-gated engine', async () => {
    // MusicGen is MLX-only. Before this, a Windows/Linux user got an Install
    // button whose installer skipped and exited 0, surfaced as 'installer exited
    // 0 but MusicGen (MLX) is still not available'.
    api.listMusicEngines.mockResolvedValue({
      defaultEngine: 'musicgen',
      engines: [engine({
        ready: false,
        runtimeReady: false,
        platformSupported: false,
        platformLabel: 'macOS on Apple Silicon (MLX)',
      })],
    });

    render(<MusicGenPanel track={{ id: 'track-1' }} prompt="ambient bed" lyrics="" />);

    expect(await screen.findByText(/requires macOS on Apple Silicon/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /install runtime/i })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /unavailable on this host/i })).toBeInTheDocument();
  });

  it('offers the fixed-model install without suggesting a runtime reinstall', async () => {
    api.listMusicEngines.mockResolvedValue({
      defaultEngine: 'minimax-music3',
      engines: [minimax({ runtimeReady: true })],
    });
    api.installAudioModel.mockResolvedValue({});

    render(<MusicGenPanel prompt="cinematic score" lyrics="" />);

    expect(await screen.findByText(/model weights are not installed yet/i)).toBeInTheDocument();
    // Runtime is already there, so the one action is the weights pull — sized,
    // because the user is about to spend 29 GB of disk on it.
    const install = screen.getByRole('button', { name: /download model weights \(~29 GB\)/i });
    expect(screen.queryByRole('button', { name: /install runtime/i })).not.toBeInTheDocument();

    fireEvent.click(install);
    await waitFor(() => expect(api.installAudioModel).toHaveBeenCalledWith(
      { engine: 'minimax-music3', repo: 'MiniMaxAI/MiniMax-Music3' },
      expect.any(Function),
    ));
  });

  // Runtime and weights are separate installs, but a user who picks MiniMax
  // wants the engine, not a two-step scavenger hunt: the missing-runtime state
  // used to offer "Install runtime" and leave the weights to a second button
  // elsewhere in the panel.
  it('installs runtime and weights from one action when both are missing', async () => {
    api.listMusicEngines
      .mockResolvedValueOnce({ defaultEngine: 'minimax-music3', engines: [minimax({ runtimeReady: false })] })
      .mockResolvedValue({ defaultEngine: 'minimax-music3', engines: [minimax({ runtimeReady: true })] });
    api.installAudioModel.mockResolvedValue({});

    render(<MusicGenPanel prompt="cinematic score" lyrics="" />);

    fireEvent.click(await screen.findByRole('button', { name: /install runtime \+ weights \(~29 GB\)/i }));
    expect(await screen.findByText(/Installing MiniMax Music 3/i)).toBeInTheDocument();
    expect(api.installAudioModel).not.toHaveBeenCalled(); // weights wait for the venv

    fireEvent.click(screen.getByRole('button', { name: /close installer/i }));
    await waitFor(() => expect(api.installAudioModel).toHaveBeenCalledWith(
      { engine: 'minimax-music3', repo: 'MiniMaxAI/MiniMax-Music3' },
      expect.any(Function),
    ));
  });

  // A cancelled or failed runtime install must not start a 29 GB download that
  // has no interpreter to load it.
  it('does not chain into the weights download when the runtime install did not land', async () => {
    api.listMusicEngines.mockResolvedValue({
      defaultEngine: 'minimax-music3',
      engines: [minimax({ runtimeReady: false })],
    });

    render(<MusicGenPanel prompt="cinematic score" lyrics="" />);

    fireEvent.click(await screen.findByRole('button', { name: /install runtime \+ weights/i }));
    fireEvent.click(await screen.findByRole('button', { name: /close installer/i }));

    await waitFor(() => expect(api.listMusicEngines).toHaveBeenCalledTimes(2));
    expect(api.installAudioModel).not.toHaveBeenCalled();
  });

  it('gates the selected MLX snapshot independently and defaults to 8-bit', async () => {
    api.listMusicEngines.mockResolvedValue({
      defaultEngine: 'minimax-music3-mlx',
      engines: [engine({
        id: 'minimax-music3-mlx', name: 'MiniMax Music 3 (MLX)', ready: true,
        runtimeReady: true, modelReady: true, modelReadyById: {
          'minimax-music3-mlx-8bit': true,
          'minimax-music3-mlx-bf16': false,
        }, fixedModelInstall: true, customModels: false, lyrics: true,
        cudaState: 'available', platformSupported: true, maxDurationSec: 300, defaultDurationSec: 60,
        modelSizeGbById: { 'minimax-music3-mlx-8bit': 14, 'minimax-music3-mlx-bf16': 29 },
        models: [
          { id: 'minimax-music3-mlx-8bit', repo: 'mlx-community/MiniMax-Music3-8bit', name: 'MiniMax Music 3 MLX 8-bit' },
          { id: 'minimax-music3-mlx-bf16', repo: 'mlx-community/MiniMax-Music3-bf16', name: 'MiniMax Music 3 MLX BF16' },
        ],
        defaultModelId: 'minimax-music3-mlx-8bit',
      })],
    });

    render(<MusicGenPanel prompt="cinematic score" lyrics="[verse] Example" />);

    const modelSelect = await screen.findByRole('combobox', { name: /model/i });
    expect(modelSelect).toHaveValue('minimax-music3-mlx-8bit');
    expect(screen.queryByRole('button', { name: /download model weights/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /generate track/i })).toBeEnabled();

    fireEvent.change(modelSelect, { target: { value: 'minimax-music3-mlx-bf16' } });
    expect(await screen.findByText(/selected model weights are not installed yet/i)).toBeInTheDocument();
    const install = screen.getByRole('button', { name: /download model weights \(~29 GB\)/i });
    expect(install).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /generate track/i })).toBeDisabled();

    fireEvent.click(install);
    await waitFor(() => expect(api.installAudioModel).toHaveBeenCalledWith(
      { engine: 'minimax-music3-mlx', repo: 'mlx-community/MiniMax-Music3-bf16' },
      expect.any(Function),
    ));
  });

  it('shows honest elapsed GPU feedback while MiniMax generation is running', async () => {
    api.listMusicEngines.mockResolvedValue({
      defaultEngine: 'minimax-music3',
      engines: [engine({
        id: 'minimax-music3', name: 'MiniMax Music 3 (CUDA only)', ready: true,
        cudaRequired: true, cudaState: 'available', customModels: false, lyrics: true,
        maxDurationSec: 300, defaultDurationSec: 60,
        models: [{ id: 'minimax-music3', repo: 'MiniMaxAI/MiniMax-Music3', name: 'MiniMax Music 3' }],
        defaultModelId: 'minimax-music3',
      })],
    });
    api.generateMusic.mockReturnValue(new Promise(() => {}));

    render(<MusicGenPanel track={{ id: 'track-1' }} prompt="cinematic score" lyrics="Example lyrics" />);

    fireEvent.click(await screen.findByRole('button', { name: /generate/i }));
    expect(await screen.findByRole('status')).toHaveTextContent('Processing on the GPU');
    expect(screen.getByRole('status')).toHaveTextContent('0:00 elapsed');
    expect(screen.getByRole('status')).toHaveTextContent(/does not report an exact percentage/i);
    expect(screen.getByRole('status')).toHaveTextContent(/tens of minutes on a 24 GB GPU/i);
  });
});
