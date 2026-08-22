import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import MusicGenPanel from './MusicGenPanel';
import * as api from '../../services/api';
import toast from '../ui/Toast';

vi.mock('../../services/api', () => ({
  listMusicEngines: vi.fn(),
  getInstances: vi.fn(),
  generateMusic: vi.fn(),
  getActiveProcessing: vi.fn(),
  getMediaJob: vi.fn(),
  getTrack: vi.fn(),
  cancelMediaJob: vi.fn(),
  installAudioModel: vi.fn(),
  removeAudioModel: vi.fn(),
}));

vi.mock('../ui/Toast', () => ({
  default: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
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
    api.getInstances.mockResolvedValue({ peers: [] });
  });

  // `clearAllMocks` resets calls but leaves a spy installed. A test that pins
  // Date.now and then fails before restoring it would leave the clock frozen
  // for every test after it, turning one failure into a cascade.
  afterEach(() => {
    vi.restoreAllMocks();
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
        vramProfileLabel: 'CUDA BF16 (automatic full-residency/offload placement)',
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

  const lyricCapablePeer = (capabilityOverrides = {}) => ({
    id: 'peer-example',
    name: 'Example GPU',
    status: 'online',
    mediaProvider: { enabled: true, audioModels: [{ engine: 'minimax-music3', modelId: 'minimax-music3' }] },
    mediaProviderStatus: {
      state: 'ready',
      // A capacity claim needs a verifiable freshness window: the panel
      // re-derives `stale` at render time rather than trusting the state
      // the probe recorded, so a snapshot with no window reads as stale.
      checkedAt: new Date().toISOString(),
      freshUntil: new Date(Date.now() + 60_000).toISOString(),
      snapshot: {
        queue: { accepting: true, running: 0, queued: 0 },
        capabilities: [{
          kind: 'audio', engine: 'minimax-music3', engineName: 'MiniMax Music 3', modelId: 'minimax-music3',
          modelName: 'MiniMax Music 3', ready: true, autoDuration: false, lyrics: true,
          minDurationSec: 10, maxDurationSec: 300, defaultDurationSec: 60,
          ...capabilityOverrides,
        }],
      },
    },
  });

  // The mixed-version case, and the reason `acceptsLyrics` exists at all: this
  // peer's MODEL sings (`lyrics: true`) but its build predates lyrical
  // federation and never publishes `acceptsLyrics`. Absent must read as false,
  // or the panel offers a render the peer answers with a 400.
  it('falls back to an instrumental remote render when the peer build cannot carry lyrics', async () => {
    api.listMusicEngines.mockResolvedValue({ defaultEngine: 'musicgen', engines: [engine({ ready: true })] });
    api.getInstances.mockResolvedValue({ peers: [lyricCapablePeer()] });
    api.generateMusic.mockResolvedValue({ track: { id: 'track-1' } });

    render(<MusicGenPanel track={{ id: 'track-1' }} prompt="private prompt" lyrics="private lyrics" />);

    fireEvent.change(await screen.findByRole('combobox', { name: /generation target/i }), { target: { value: 'peer-example' } });
    expect(screen.getByLabelText(/instrumental only/i)).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /^generate$/i }));

    await waitFor(() => expect(api.generateMusic).toHaveBeenCalledWith(expect.objectContaining({
      mediaProviderPeerId: 'peer-example',
      engine: 'minimax-music3',
      modelId: 'minimax-music3',
      instrumentalOnly: true,
      remoteMusicProfile: {
        style: 'ambient', mood: 'calm', tempo: 'moderate', energy: 'medium', instruments: [],
      },
    }), { silent: true }));
    const requestBody = api.generateMusic.mock.calls[0][0];
    expect(requestBody).not.toHaveProperty('lyrics');
  });

  // ADR docs/decisions/2026-08-22-federated-media-input-assets.md rule 2: the
  // words the model sings cross. The free-form style prompt still does not, but
  // that is the SERVER's doing — it blanks params.prompt and renders the wire
  // prompt from the profile — so this body legitimately carries it for the
  // track record. federatedMediaProvider.test.js guards the wire side.
  it('sends lyrics to a peer that advertises it accepts them', async () => {
    api.listMusicEngines.mockResolvedValue({ defaultEngine: 'musicgen', engines: [engine({ ready: true })] });
    api.getInstances.mockResolvedValue({ peers: [lyricCapablePeer({ acceptsLyrics: true })] });
    api.generateMusic.mockResolvedValue({ track: { id: 'track-1' } });

    render(<MusicGenPanel track={{ id: 'track-1' }} prompt="private prompt" lyrics="private lyrics" />);

    fireEvent.change(await screen.findByRole('combobox', { name: /generation target/i }), { target: { value: 'peer-example' } });
    // Instrumental is an ordinary choice again once the peer can sing.
    expect(screen.getByLabelText(/instrumental only/i)).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /^generate$/i }));

    await waitFor(() => expect(api.generateMusic).toHaveBeenCalledWith(expect.objectContaining({
      mediaProviderPeerId: 'peer-example',
      instrumentalOnly: false,
      lyrics: 'private lyrics',
    }), { silent: true }));
  });

  it('drops lyrics from a lyric-capable remote render when instrumental-only is chosen', async () => {
    api.listMusicEngines.mockResolvedValue({ defaultEngine: 'musicgen', engines: [engine({ ready: true })] });
    api.getInstances.mockResolvedValue({ peers: [lyricCapablePeer({ acceptsLyrics: true })] });
    api.generateMusic.mockResolvedValue({ track: { id: 'track-1' } });

    render(<MusicGenPanel track={{ id: 'track-1' }} prompt="private prompt" lyrics="private lyrics" />);

    fireEvent.change(await screen.findByRole('combobox', { name: /generation target/i }), { target: { value: 'peer-example' } });
    fireEvent.click(screen.getByLabelText(/instrumental only/i));
    fireEvent.click(screen.getByRole('button', { name: /^generate$/i }));

    // The field still rides along so the track record keeps the authored words;
    // `instrumentalOnly` is what the server reads to drop the conditioning.
    await waitFor(() => expect(api.generateMusic).toHaveBeenCalledWith(expect.objectContaining({
      instrumentalOnly: true,
    }), { silent: true }));
  });

  // The usable branch has no remedy text behind it, so without an assertion
  // here collapsing it back to `help || 'requires a ready peer'` would print
  // the not-ready sentence beside an enabled button and still ship green.
  it('reports a usable peer’s queue, and says it is ready when there is nothing to report', async () => {
    api.listMusicEngines.mockResolvedValue({ defaultEngine: 'musicgen', engines: [engine({ ready: true })] });
    const peer = (queue) => ({
      id: 'peer-example',
      name: 'Example GPU',
      status: 'online',
      enabled: true,
      mediaProvider: { enabled: true, audioModels: [{ engine: 'minimax-music3', modelId: 'minimax-music3' }] },
      mediaProviderStatus: {
        state: 'ready',
        checkedAt: new Date().toISOString(),
        freshUntil: new Date(Date.now() + 60_000).toISOString(),
        // The peer has to be advertising the allowlisted model for this to be
        // the USABLE branch at all: an allowlist the peer answers with nothing
        // is its own blocked state, and it now says so here instead of printing
        // a queue reading beside a disabled button.
        snapshot: {
          queue,
          capabilities: [{
            kind: 'audio', engine: 'minimax-music3', engineName: 'MiniMax Music 3', modelId: 'minimax-music3',
            modelName: 'MiniMax Music 3', ready: true, autoDuration: false, lyrics: true,
            minDurationSec: 10, maxDurationSec: 300, defaultDurationSec: 60,
          }],
        },
      },
    });

    api.getInstances.mockResolvedValue({
      peers: [peer({ accepting: true, running: 0, queued: 0, totalActive: 1, maxQueuedJobs: 4 })],
    });
    const { unmount } = render(<MusicGenPanel track={{ id: 'track-1' }} prompt="p" />);
    fireEvent.change(await screen.findByRole('combobox', { name: /generation target/i }), { target: { value: 'peer-example' } });
    expect(screen.getByText(/1\/4 shared slots active/)).toBeInTheDocument();
    unmount();

    // Same peer, but a queue block with no reportable counts at all.
    api.getInstances.mockResolvedValue({ peers: [peer({ accepting: true })] });
    render(<MusicGenPanel track={{ id: 'track-2' }} prompt="p" />);
    fireEvent.change(await screen.findByRole('combobox', { name: /generation target/i }), { target: { value: 'peer-example' } });
    expect(screen.getByText('Peer is ready.')).toBeInTheDocument();
  });

  // `state` is the provider's verdict on its own surface, so a peer switched off
  // inside its freshness window still reads `ready`. Showing its queue there
  // suppressed the one line explaining why Generate was disabled.
  it('explains a switched-off peer instead of showing its last queue reading', async () => {
    api.listMusicEngines.mockResolvedValue({ defaultEngine: 'musicgen', engines: [engine({ ready: true })] });
    api.getInstances.mockResolvedValue({
      peers: [{
        id: 'peer-example',
        name: 'Example GPU',
        status: 'online',
        enabled: false,
        mediaProvider: { enabled: true, audioModels: [{ engine: 'minimax-music3', modelId: 'minimax-music3' }] },
        mediaProviderStatus: {
          state: 'ready',
          checkedAt: new Date().toISOString(),
          freshUntil: new Date(Date.now() + 60_000).toISOString(),
          snapshot: {
            queue: { accepting: true, running: 0, queued: 0, totalActive: 0, maxQueuedJobs: 4 },
            capabilities: [{
              kind: 'audio', engine: 'minimax-music3', engineName: 'MiniMax Music 3', modelId: 'minimax-music3',
              modelName: 'MiniMax Music 3', ready: true, autoDuration: false, lyrics: true,
              minDurationSec: 10, maxDurationSec: 300, defaultDurationSec: 60,
            }],
          },
        },
      }],
    });

    render(<MusicGenPanel track={{ id: 'track-1' }} prompt="private prompt" />);
    fireEvent.change(await screen.findByRole('combobox', { name: /generation target/i }), { target: { value: 'peer-example' } });

    expect(screen.getByRole('button', { name: /^generate$/i })).toBeDisabled();
    expect(screen.getByText(/peer connection is switched off/i)).toBeInTheDocument();
    expect(screen.queryByText(/shared slots active/i)).not.toBeInTheDocument();
  });

  // The dropdown, the caption and the button all describe the same peer. A
  // switched-off peer keeps a stored `state: 'ready'` for as long as its
  // snapshot stays fresh, so gating the suffix on `state` would list it with no
  // suffix — reading as ready — beside a caption saying it is switched off.
  it('marks a switched-off peer in the target dropdown, not just in the caption', async () => {
    api.listMusicEngines.mockResolvedValue({ defaultEngine: 'musicgen', engines: [engine({ ready: true })] });
    api.getInstances.mockResolvedValue({
      peers: [{
        id: 'peer-example',
        name: 'Example GPU',
        status: 'online',
        enabled: false,
        mediaProvider: { enabled: true, audioModels: [{ engine: 'minimax-music3', modelId: 'minimax-music3' }] },
        mediaProviderStatus: {
          state: 'ready',
          checkedAt: new Date().toISOString(),
          freshUntil: new Date(Date.now() + 60_000).toISOString(),
          snapshot: { queue: { accepting: true, running: 0, queued: 0, totalActive: 0, maxQueuedJobs: 4 }, capabilities: [] },
        },
      }],
    });

    render(<MusicGenPanel track={{ id: 'track-1' }} prompt="private prompt" />);
    await screen.findByRole('combobox', { name: /generation target/i });
    expect(screen.getByRole('option', { name: /Example GPU \(peer disabled\)/ })).toBeInTheDocument();
  });

  // A capacity window expires on the clock, not on a state change, so between
  // polls the button can still be enabled against a peer that has gone stale.
  it('refuses at click time when the window expired since the last render', async () => {
    api.listMusicEngines.mockResolvedValue({ defaultEngine: 'musicgen', engines: [engine({ ready: true })] });
    const freshUntil = new Date(Date.now() + 60_000).toISOString();
    api.getInstances.mockResolvedValue({
      peers: [{
        id: 'peer-example',
        name: 'Example GPU',
        status: 'online',
        mediaProvider: { enabled: true, audioModels: [{ engine: 'minimax-music3', modelId: 'minimax-music3' }] },
        mediaProviderStatus: {
          state: 'ready',
          checkedAt: new Date().toISOString(),
          freshUntil,
          snapshot: {
            queue: { accepting: true, running: 0, queued: 0 },
            capabilities: [{
              kind: 'audio', engine: 'minimax-music3', engineName: 'MiniMax Music 3', modelId: 'minimax-music3',
              modelName: 'MiniMax Music 3', ready: true, autoDuration: false, lyrics: true,
              minDurationSec: 10, maxDurationSec: 300, defaultDurationSec: 60,
            }],
          },
        },
      }],
    });

    render(<MusicGenPanel track={{ id: 'track-1' }} prompt="private prompt" />);
    fireEvent.change(await screen.findByRole('combobox', { name: /generation target/i }), { target: { value: 'peer-example' } });
    const generate = screen.getByRole('button', { name: /^generate$/i });
    expect(generate).toBeEnabled();

    // The window lapses without anything re-rendering the panel. Advancing the
    // clock rather than sleeping keeps this instant and load-independent —
    // `resolvePeerMediaReadiness` reads Date.now(), no timers are involved.
    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 120_000);
    fireEvent.click(generate);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/capacity snapshot expired/i)));
    expect(api.generateMusic).not.toHaveBeenCalled();
  });

  // The stored probe keeps saying `ready` long after the server would refuse
  // the submission. Leaving Generate enabled beside a caption reading "stale"
  // just moves the rejection to the server, after the user committed to it.
  it('blocks generation on a peer whose capacity window has expired', async () => {
    api.listMusicEngines.mockResolvedValue({ defaultEngine: 'musicgen', engines: [engine({ ready: true })] });
    api.getInstances.mockResolvedValue({
      peers: [{
        id: 'peer-example',
        name: 'Example GPU',
        status: 'online',
        mediaProvider: { enabled: true, audioModels: [{ engine: 'minimax-music3', modelId: 'minimax-music3' }] },
        mediaProviderStatus: {
          state: 'ready',
          checkedAt: new Date(Date.now() - 120_000).toISOString(),
          freshUntil: new Date(Date.now() - 60_000).toISOString(),
          snapshot: {
            queue: { accepting: true, running: 0, queued: 0 },
            capabilities: [{
              kind: 'audio', engine: 'minimax-music3', engineName: 'MiniMax Music 3', modelId: 'minimax-music3',
              modelName: 'MiniMax Music 3', ready: true, autoDuration: false, lyrics: true,
              minDurationSec: 10, maxDurationSec: 300, defaultDurationSec: 60,
            }],
          },
        },
      }],
    });

    render(<MusicGenPanel track={{ id: 'track-1' }} prompt="private prompt" />);

    fireEvent.change(await screen.findByRole('combobox', { name: /generation target/i }), { target: { value: 'peer-example' } });
    expect(screen.getByRole('button', { name: /^generate$/i })).toBeDisabled();
    expect(screen.getByText(/capacity snapshot expired/i)).toBeInTheDocument();
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

  // Switching engine and immediately picking one of the NEW engine's snapshots
  // is the closest this harness gets to the interleaving that failed on CI
  // (#4819): the engine-defaults effect is queued holding the OLD engine's
  // model id, which is absent from the new list, so a drain that ran after the
  // pick would reset it. `act()` drains between the two discrete events, so
  // this passes either way — it is here for the end-to-end behaviour (the pick
  // survives an engine switch and every selected-snapshot gate follows it), NOT
  // as the guard for the stale-closure reset. That guard has to read the source,
  // and lives in musicGenModelSelection.guard.test.js.
  it('follows a model picked right after an engine switch', async () => {
    const alpha = engine({
      id: 'alpha', name: 'Alpha', ready: true, customModels: false,
      models: [{ id: 'alpha-1', name: 'Alpha One' }],
      defaultModelId: 'alpha-1',
    });
    const beta = engine({
      id: 'beta', name: 'Beta', ready: true, runtimeReady: true, customModels: false,
      fixedModelInstall: true, modelReady: true,
      modelReadyById: { 'beta-1': true, 'beta-2': false },
      modelSizeGbById: { 'beta-1': 14, 'beta-2': 29 },
      models: [{ id: 'beta-1', name: 'Beta One' }, { id: 'beta-2', name: 'Beta Two' }],
      defaultModelId: 'beta-1',
    });
    api.listMusicEngines.mockResolvedValue({ defaultEngine: 'alpha', engines: [alpha, beta] });

    render(<MusicGenPanel prompt="cinematic score" lyrics="" />);
    const engineSelect = await screen.findByRole('combobox', { name: /engine/i });

    await act(async () => {
      // Commit 1: engine becomes Beta while modelId is still 'alpha-1', queuing
      // the defaults effect with that stale id.
      fireEvent.change(engineSelect, { target: { value: 'beta' } });
      // Commit 2: the user picks Beta's un-installed snapshot before the drain.
      fireEvent.change(screen.getByRole('combobox', { name: /model/i }), { target: { value: 'beta-2' } });
    });

    expect(screen.getByRole('combobox', { name: /model/i })).toHaveValue('beta-2');
    expect(screen.getByText(/selected model weights are not installed yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /download model weights \(~29 GB\)/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /generate track/i })).toBeDisabled();
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
