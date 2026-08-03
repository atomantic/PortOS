import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import ChiptunePanel from './ChiptunePanel';
import * as api from '../../services/api';

vi.mock('../../services/api', () => ({
  generateTrackChiptune: vi.fn(),
  renderTrackChiptune: vi.fn(),
  publishTrackChiptune: vi.fn(),
  getApps: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock('../../hooks/useProviderModels', () => ({
  default: () => ({
    providers: [{ id: 'anthropic', name: 'Anthropic', models: ['claude'], defaultModel: 'claude' }],
    selectedProviderId: 'anthropic',
    selectedModel: 'claude',
    availableModels: ['claude'],
    setSelectedProviderId: vi.fn(),
    setSelectedModel: vi.fn(),
    loading: false,
  }),
}));

const SCORE = {
  title: 'Test Loop',
  bpm: 120,
  stepsPerBeat: 4,
  beatsPerBar: 4,
  channels: [{ id: 'lead', wave: 'square' }],
  patterns: { a: { bars: 1, notes: { lead: [] } } },
  order: ['a'],
};

const TRACK = { id: 'track-1', title: 'My Test Song', chiptunePrompt: 'Bouncy 8-bit theme', chiptuneScore: SCORE };

const GAME_APP = { id: 'game-app', name: 'Game App', repoPath: '/repo/game', archived: false };

// Never-resolving promise, for pinning "in flight" UI states.
const pending = () => new Promise(() => {});

describe('ChiptunePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getSettings.mockResolvedValue({ music: {} });
    api.getApps.mockResolvedValue([GAME_APP]);
    api.updateSettings.mockResolvedValue({});
  });

  it('baseline: enables Generate, Render, and Publish when nothing is in flight', async () => {
    render(<ChiptunePanel track={TRACK} onTrackUpdate={vi.fn()} />);

    const generateBtn = await screen.findByRole('button', { name: /revise score/i });
    const renderBtn = screen.getByRole('button', { name: /render take/i });
    const publishBtn = screen.getByRole('button', { name: /publish to app/i });

    expect(generateBtn).not.toBeDisabled();
    expect(renderBtn).not.toBeDisabled();
    expect(publishBtn).not.toBeDisabled();
  });

  it('disables Generate and Publish while a render is in flight', async () => {
    api.renderTrackChiptune.mockReturnValue(pending());
    render(<ChiptunePanel track={TRACK} onTrackUpdate={vi.fn()} />);

    const renderBtn = await screen.findByRole('button', { name: /render take/i });
    fireEvent.click(renderBtn);

    await waitFor(() => expect(screen.getByRole('button', { name: /rendering/i })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /revise score/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /publish to app/i })).toBeDisabled();
  });

  it('disables Render while a generate is in flight', async () => {
    api.generateTrackChiptune.mockReturnValue(pending());
    render(<ChiptunePanel track={TRACK} onTrackUpdate={vi.fn()} />);

    const generateBtn = await screen.findByRole('button', { name: /revise score/i });
    fireEvent.click(generateBtn);

    await waitFor(() => expect(screen.getByRole('button', { name: /composing/i })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /render take/i })).toBeDisabled();
  });

  describe('stale publish-target guard', () => {
    it('clears a saved publish target that no longer appears in the fresh apps list', async () => {
      // The saved prefs point at an app that has since been deleted/archived —
      // getApps() no longer returns it.
      api.getSettings.mockResolvedValue({ music: { chiptune: { publishAppId: 'ghost-app' } } });
      render(<ChiptunePanel track={TRACK} onTrackUpdate={vi.fn()} />);

      const publishToggle = await screen.findByRole('button', { name: /publish to app/i });
      await act(async () => { fireEvent.click(publishToggle); });

      await waitFor(() => expect(api.getApps).toHaveBeenCalled());
      const select = await screen.findByLabelText(/target app/i);
      // The stale id is gone; the select falls back to the empty placeholder.
      expect(select).toHaveValue('');
      expect(screen.getByRole('button', { name: /^publish loop$/i })).toBeDisabled();

      fireEvent.click(screen.getByRole('button', { name: /^publish loop$/i }));
      expect(api.publishTrackChiptune).not.toHaveBeenCalled();
    });

    it('keeps a saved publish target that is still valid and publishes with it', async () => {
      api.getSettings.mockResolvedValue({ music: { chiptune: { publishAppId: 'game-app', publishSubdir: 'game/assets/music' } } });
      api.publishTrackChiptune.mockResolvedValue({ appName: 'Game App', files: ['loop.ogg'], note: 'done' });
      render(<ChiptunePanel track={TRACK} onTrackUpdate={vi.fn()} />);

      const publishToggle = await screen.findByRole('button', { name: /publish to app/i });
      await act(async () => { fireEvent.click(publishToggle); });

      await waitFor(() => expect(api.getApps).toHaveBeenCalled());
      const select = await screen.findByLabelText(/target app/i);
      expect(select).toHaveValue('game-app');

      const publishBtn = screen.getByRole('button', { name: /^publish loop$/i });
      expect(publishBtn).not.toBeDisabled();
      fireEvent.click(publishBtn);

      await waitFor(() => expect(api.publishTrackChiptune).toHaveBeenCalledTimes(1));
      expect(api.publishTrackChiptune).toHaveBeenCalledWith(
        'track-1',
        { appId: 'game-app', subdir: 'game/assets/music', slug: 'my-test-song' },
        { silent: true },
      );
    });
  });
});
