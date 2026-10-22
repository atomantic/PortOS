import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import EpisodeComposer from './EpisodeComposer';
import { MockEventSource, lastEventSource } from '../../test/mockEventSource';
import { awaitEnabled } from '../../test/enabledBarrier.js';

vi.mock('../../services/api', () => ({
  lintContinuousVideoEpisode: vi.fn(),
  generateContinuousVideoEpisode: vi.fn(),
  continuousVideoEpisodeEventsUrl: (jobId) => `/api/continuous-video/${jobId}/events`,
}));

import {
  lintContinuousVideoEpisode, generateContinuousVideoEpisode,
} from '../../services/api';

const FAILING_PREVIEW = {
  clips: [{
    cutType: 'fresh', speakers: ['mara'], prompt: 'Mara paces.', references: [{ kind: 'cast', id: 'mara' }],
  }],
  lint: { pass: false, results: [{ index: 0, pass: false, reasons: ['no bible descriptor found for cast/mara'] }] },
};

const PASSING_PREVIEW = {
  clips: [{
    cutType: 'fresh', speakers: ['mara'], prompt: 'gritty noir. a cell. Mara paces.', references: [{ kind: 'cast', id: 'mara' }],
  }],
  lint: { pass: true, results: [{ index: 0, pass: true, reasons: [] }] },
};

async function writeScene() {
  const [textInput] = screen.getAllByPlaceholderText('what happens');
  fireEvent.change(textInput, { target: { value: 'Mara paces the cell.' } });
}

describe('EpisodeComposer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockEventSource.reset();
    global.EventSource = MockEventSource;
  });
  afterEach(() => {
    delete global.EventSource;
  });

  it('renders a beat preview with camera-cut and slot-lock info once scenes have content', async () => {
    lintContinuousVideoEpisode.mockResolvedValue(PASSING_PREVIEW);
    render(<EpisodeComposer />);
    await writeScene();
    await waitFor(() => expect(lintContinuousVideoEpisode).toHaveBeenCalled(), { timeout: 2000 });
    expect(await screen.findByText('fresh cut')).toBeTruthy();
    expect(screen.getByText('mara')).toBeTruthy();
    expect(screen.getByText('cast/mara')).toBeTruthy();
  });

  it('shows lint failure reasons for a failing beat and keeps Queue disabled', async () => {
    lintContinuousVideoEpisode.mockResolvedValue(FAILING_PREVIEW);
    render(<EpisodeComposer />);
    await writeScene();
    await waitFor(() => expect(lintContinuousVideoEpisode).toHaveBeenCalled(), { timeout: 2000 });
    expect(await screen.findByText(/no bible descriptor found for cast\/mara/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Queue episode/i })).toBeDisabled();
  });

  it('gates Queue episode on a passing lint, then streams progress and disables the form while queuing', async () => {
    lintContinuousVideoEpisode.mockResolvedValue(PASSING_PREVIEW);
    generateContinuousVideoEpisode.mockResolvedValue({ jobId: 'job-1', generationId: 'job-1', status: 'running' });
    render(<EpisodeComposer />);
    await writeScene();
    await waitFor(() => expect(lintContinuousVideoEpisode).toHaveBeenCalled(), { timeout: 2000 });

    const queueButton = await screen.findByRole('button', { name: /Queue episode/i });
    await awaitEnabled(queueButton);
    fireEvent.click(queueButton);

    await waitFor(() => expect(generateContinuousVideoEpisode).toHaveBeenCalled());
    await waitFor(() => expect(lastEventSource()).toBeTruthy());

    // Streaming — the scene text input is disabled (save-gating: no editing mid-generation).
    await waitFor(() => {
      const [textInput] = screen.getAllByPlaceholderText('what happens');
      expect(textInput.disabled).toBe(true);
    });

    act(() => lastEventSource().emit({ type: 'progress', progress: 0.5, message: 'Rendering clip 1/1' }));
    expect(await screen.findByText('Rendering clip 1/1')).toBeTruthy();

    act(() => lastEventSource().emit({ type: 'complete', result: { jobId: 'job-1' } }));
    expect(await screen.findByText(/Compose another episode/i)).toBeTruthy();
  });

  it('applies a FableLoom import that arrives after mount (async loom fetch)', async () => {
    lintContinuousVideoEpisode.mockResolvedValue(PASSING_PREVIEW);
    // VideoGen mounts EpisodeComposer before its getLoom() fetch resolves —
    // initialScenes starts null/undefined and updates on a later render.
    const { rerender } = render(<EpisodeComposer initialScenes={null} />);
    expect(screen.queryByDisplayValue('Imported scene')).toBeNull();

    rerender(<EpisodeComposer initialScenes={[{ sceneId: 's1', location: '', lines: [{ type: 'action', text: 'Imported scene' }] }]} />);
    expect(await screen.findByDisplayValue('Imported scene')).toBeTruthy();
  });

  describe('preview lint lifetimes', () => {
    // Deferred lint settles on demand so the test controls out-of-order arrival.
    function deferLint() {
      const pending = [];
      lintContinuousVideoEpisode.mockImplementation(() => new Promise((resolve) => { pending.push(resolve); }));
      return pending;
    }
    const flush = () => act(async () => { await Promise.resolve(); });

    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('drops a pending lint response once the script is cleared', async () => {
      const pending = deferLint();
      render(<EpisodeComposer />);
      const [textInput] = screen.getAllByPlaceholderText('what happens');
      fireEvent.change(textInput, { target: { value: 'Mara paces the cell.' } });
      act(() => { vi.advanceTimersByTime(1000); });
      expect(lintContinuousVideoEpisode).toHaveBeenCalledTimes(1);

      // Clear the only line while that lint is still in flight.
      fireEvent.change(textInput, { target: { value: '' } });
      await act(async () => { pending[0](PASSING_PREVIEW); });
      await flush();

      expect(screen.queryByText('fresh cut')).toBeNull();
      expect(screen.getByRole('button', { name: /Queue episode/i })).toBeDisabled();
    });

    it('lets the newest edit win when an earlier lint resolves last', async () => {
      const pending = deferLint();
      render(<EpisodeComposer />);
      const [textInput] = screen.getAllByPlaceholderText('what happens');
      fireEvent.change(textInput, { target: { value: 'Mara paces the cell.' } });
      act(() => { vi.advanceTimersByTime(1000); });
      fireEvent.change(textInput, { target: { value: 'Mara stops.' } });
      act(() => { vi.advanceTimersByTime(1000); });
      expect(lintContinuousVideoEpisode).toHaveBeenCalledTimes(2);

      await act(async () => { pending[1](FAILING_PREVIEW); });
      await act(async () => { pending[0](PASSING_PREVIEW); });
      await flush();

      expect(screen.getByText(/no bible descriptor found for cast\/mara/)).toBeTruthy();
      expect(screen.getByRole('button', { name: /Queue episode/i })).toBeDisabled();
    });
  });
});
