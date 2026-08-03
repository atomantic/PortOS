import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import ChiptunePanel from './ChiptunePanel';
import * as api from '../../services/api';

// The panel drives the real chiptune player, which needs WebAudio (absent in
// jsdom). Stub only the PLAYER — the pure schedule build stays real, since the
// summary line and the loop-length readout are derived from it — with a
// hand-driven transport so the preview playhead is assertable.
const audio = vi.hoisted(() => ({ playing: false, position: 0, loopSec: 0 }));
vi.mock('../../lib/chiptunePlayback.js', async (importOriginal) => ({
  ...(await importOriginal()),
  createChiptunePlayer: () => ({
    play: async () => { audio.playing = true; },
    stop: () => { audio.playing = false; },
    isPlaying: () => audio.playing,
    position: () => audio.position,
    loopSec: () => audio.loopSec,
  }),
}));

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
    audio.playing = false;
    audio.position = 0;
    audio.loopSec = 0;
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

  // The preview playhead is painted by a rAF loop straight into the DOM (no
  // per-frame setState) — stub requestAnimationFrame to a manual queue so each
  // frame() runs exactly one frame and the assertions read the painted nodes.
  describe('preview progress bar', () => {
    let rafQueue;
    let cancelSpy;
    const frame = () => {
      const q = rafQueue;
      rafQueue = [];
      act(() => { q.forEach((cb) => cb()); });
    };

    beforeEach(() => {
      rafQueue = [];
      cancelSpy = vi.fn();
      vi.stubGlobal('requestAnimationFrame', (cb) => { rafQueue.push(cb); return rafQueue.length; });
      vi.stubGlobal('cancelAnimationFrame', cancelSpy);
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    const startPreview = async () => {
      const result = render(<ChiptunePanel track={TRACK} onTrackUpdate={vi.fn()} />);
      const playBtn = await screen.findByRole('button', { name: /preview loop/i });
      await act(async () => { fireEvent.click(playBtn); });
      await screen.findByRole('button', { name: /^stop$/i });
      return result;
    };

    it('tracks the playhead across a loop pass and wraps on the next one', async () => {
      audio.loopSec = 20;
      await startPreview();
      const bar = screen.getByTestId('chiptune-progress-bar');

      audio.position = 5;
      frame();
      expect(bar.style.transform).toBe('scaleX(0.25)');
      expect(screen.getByTestId('chiptune-progress-time')).toHaveTextContent('0:05.00');

      // Second pass: position() keeps climbing (the player re-bases its cursor
      // rather than restarting), so the bar must wrap, not run off the end.
      audio.position = 25;
      frame();
      expect(bar.style.transform).toBe('scaleX(0.25)');
      expect(screen.getByTestId('chiptune-progress-time')).toHaveTextContent('0:05.00');
    });

    it('reads the total off the sounding schedule, not a score regenerated mid-preview', async () => {
      // The fixture score is a 2s loop; the player is sounding a 20s one (as it
      // would be after a mid-preview regeneration, since the schedule is built
      // at play()). Idle shows the score's length, playback the sounding one —
      // otherwise elapsed/total disagree about which loop is running.
      audio.loopSec = 20;
      render(<ChiptunePanel track={TRACK} onTrackUpdate={vi.fn()} />);
      const playBtn = await screen.findByRole('button', { name: /preview loop/i });
      expect(screen.getByTestId('chiptune-progress-total')).toHaveTextContent('0:02.00');

      await act(async () => { fireEvent.click(playBtn); });
      await screen.findByRole('button', { name: /^stop$/i });
      frame();
      expect(screen.getByTestId('chiptune-progress-total')).toHaveTextContent('0:20.00');

      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^stop$/i })); });
      expect(screen.getByTestId('chiptune-progress-total')).toHaveTextContent('0:02.00');
    });

    it('clamps the transport lead-in (negative position) to the start of the bar', async () => {
      audio.loopSec = 20;
      await startPreview();

      audio.position = -0.08;
      frame();
      expect(screen.getByTestId('chiptune-progress-bar').style.transform).toBe('scaleX(0)');
    });

    it('cancels the frame loop and resets the bar on stop', async () => {
      audio.loopSec = 20;
      await startPreview();
      audio.position = 10;
      frame();
      expect(screen.getByTestId('chiptune-progress-bar').style.transform).toBe('scaleX(0.5)');

      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^stop$/i })); });
      expect(cancelSpy).toHaveBeenCalled();
      expect(screen.getByTestId('chiptune-progress-bar').style.transform).toBe('scaleX(0)');
      expect(screen.getByTestId('chiptune-progress-time')).toHaveTextContent('0:00.00');
    });

    it('cancels the frame loop on unmount while playing', async () => {
      audio.loopSec = 20;
      const { unmount } = await startPreview();
      frame();
      cancelSpy.mockClear();
      unmount();
      expect(cancelSpy).toHaveBeenCalled();
    });
  });
});
