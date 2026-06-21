import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../../services/api', () => ({
  PIPELINE_STAGE_LABELS: { audio: 'Audio' },
  PIPELINE_STAGE_STATUS_LABEL: { empty: 'Empty', ready: 'Ready' },
  PIPELINE_STAGE_STATUS_COLOR: {},
  extractPipelineAudioLines: vi.fn(),
  renderPipelineAudioLine: vi.fn(),
  patchPipelineAudioLine: vi.fn(),
  listPipelineMusicLibrary: vi.fn(),
  uploadPipelineMusicTrack: vi.fn(),
  attachPipelineMusicTrack: vi.fn(),
  detachPipelineMusicTrack: vi.fn(),
  deletePipelineMusicTrack: vi.fn(),
  listPipelineMusicGenerators: vi.fn(),
  generatePipelineMusic: vi.fn(),
  generatePipelineAudioCues: vi.fn(),
  renderPipelineAudioCue: vi.fn(),
  updatePipelineIssue: vi.fn(),
}));

vi.mock('../../ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

// VoicePicker fetches voices on mount — stub it out so the component renders
// without hitting the network.
vi.mock('../../voice/VoicePicker', () => ({ default: () => null }));

import AudioStage from './AudioStage';
import {
  updatePipelineIssue,
  generatePipelineAudioCues,
  renderPipelineAudioCue,
  listPipelineMusicGenerators,
} from '../../../services/api';

const READY_ENGINE = {
  engines: [
    {
      id: 'musicgen', name: 'MusicGen', models: [{ id: 'm', name: 'M' }],
      defaultModelId: 'm', defaultDurationSec: 12, minDurationSec: 1, maxDurationSec: 30,
      ready: true,
    },
    {
      id: 'audioldm2', name: 'AudioLDM2', models: [{ id: 'a', name: 'A' }],
      defaultModelId: 'a', defaultDurationSec: 30, minDurationSec: 1, maxDurationSec: 120,
      ready: true,
    },
  ],
  defaultEngine: 'musicgen',
};
const NOT_READY_ENGINE = {
  engines: [{
    id: 'musicgen', name: 'MusicGen', models: [], defaultModelId: 'm',
    defaultDurationSec: 12, minDurationSec: 1, maxDurationSec: 30, ready: false,
  }],
  defaultEngine: 'musicgen',
};

const makeIssue = (audio = {}) => ({
  id: 'iss-1',
  seriesId: 'ser-1',
  stages: {
    storyboards: { scenes: [{ id: 's1' }] },
    audio: { status: 'ready', lines: [], music: null, audioMode: 'per-clip', cues: [], ...audio },
  },
});

describe('AudioStage — whole-episode audio (#863)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listPipelineMusicGenerators.mockResolvedValue(READY_ENGINE);
  });

  it('renders the audio-mode selector with the persisted value', () => {
    render(<AudioStage issue={makeIssue({ audioMode: 'silent' })} onStageUpdate={() => {}} />);
    const select = screen.getByLabelText('Episode audio');
    expect(select).toHaveValue('silent');
  });

  it('persists a mode switch via updatePipelineIssue and lifts the new issue', async () => {
    const updated = makeIssue({ audioMode: 'silent' });
    updatePipelineIssue.mockResolvedValue(updated);
    const onStageUpdate = vi.fn();
    render(<AudioStage issue={makeIssue()} onStageUpdate={onStageUpdate} />);

    await userEvent.selectOptions(screen.getByLabelText('Episode audio'), 'silent');

    await waitFor(() => expect(updatePipelineIssue).toHaveBeenCalledWith(
      'iss-1',
      { stages: { audio: { audioMode: 'silent' } } },
      { silent: true },
    ));
    await waitFor(() => expect(onStageUpdate).toHaveBeenCalledWith('audio', updated.stages.audio, updated));
  });

  it('shows the cue panel only in generated mode', async () => {
    const { rerender } = render(<AudioStage issue={makeIssue()} onStageUpdate={() => {}} />);
    expect(screen.queryByText('Music cues')).not.toBeInTheDocument();
    rerender(<AudioStage issue={makeIssue({ audioMode: 'generated' })} onStageUpdate={() => {}} />);
    expect(screen.getByText('Music cues')).toBeInTheDocument();
    // The mount-time music-engine status fetch resolves asynchronously; flush it
    // inside act() so its setState doesn't land after the test returns.
    await act(async () => {});
  });

  it('derives cues via the generate route', async () => {
    const issue = makeIssue({ audioMode: 'generated', cues: [] });
    const result = { issue: makeIssue({ audioMode: 'generated' }), stage: { cues: [] }, cueCount: 3 };
    generatePipelineAudioCues.mockResolvedValue(result);
    render(<AudioStage issue={issue} onStageUpdate={() => {}} />);

    await userEvent.click(screen.getByRole('button', { name: /Generate cues/i }));

    await waitFor(() => expect(generatePipelineAudioCues).toHaveBeenCalledWith(
      'iss-1',
      { engine: 'musicgen', force: false },
      { silent: true },
    ));
  });

  it('renders one cue, awaiting an in-flight prompt save first', async () => {
    const cues = [{ id: 'cue-1', label: 'Act I', prompt: 'warm pads', startSec: 0, endSec: 10 }];
    const issue = makeIssue({ audioMode: 'generated', cues });
    renderPipelineAudioCue.mockResolvedValue({ issue, stage: { cues }, cueIdx: 0, cue: cues[0] });
    render(<AudioStage issue={issue} onStageUpdate={() => {}} />);

    // Let the lazily-fetched generators land so the engine reads as ready.
    await waitFor(() => expect(listPipelineMusicGenerators).toHaveBeenCalled());

    const cueItem = screen.getByText('Act I').closest('li');
    await userEvent.click(within(cueItem).getByRole('button', { name: /Render/i }));

    await waitFor(() => expect(renderPipelineAudioCue).toHaveBeenCalledWith(
      'iss-1',
      0,
      { engine: 'musicgen' },
      { silent: true },
    ));
  });

  it("renders a cue on its OWN stamped engine, not the UI default", async () => {
    const cues = [{ id: 'cue-1', label: 'Act I', prompt: 'longform', engine: 'audioldm2', startSec: 0, endSec: 60 }];
    const issue = makeIssue({ audioMode: 'generated', cues });
    renderPipelineAudioCue.mockResolvedValue({ issue, stage: { cues }, cueIdx: 0, cue: cues[0] });
    render(<AudioStage issue={issue} onStageUpdate={() => {}} />);

    await waitFor(() => expect(listPipelineMusicGenerators).toHaveBeenCalled());
    const cueItem = screen.getByText('Act I').closest('li');
    await userEvent.click(within(cueItem).getByRole('button', { name: /Render/i }));

    await waitFor(() => expect(renderPipelineAudioCue).toHaveBeenCalledWith(
      'iss-1',
      0,
      { engine: 'audioldm2' },
      { silent: true },
    ));
  });

  it('serializes overlapping cue-prompt saves so neither edit clobbers the other', async () => {
    const cues = [
      { id: 'cue-1', label: 'Act I', prompt: 'a0' },
      { id: 'cue-2', label: 'Act II', prompt: 'b0' },
    ];
    const onStageUpdate = vi.fn();
    // updatePipelineIssue returns the patched issue so the component lifts the
    // freshest cues[] for the next queued save to merge against.
    updatePipelineIssue.mockImplementation((_id, patch) => {
      const next = makeIssue({ audioMode: 'generated', cues: patch.stages.audio.cues });
      return Promise.resolve(next);
    });

    const issue = makeIssue({ audioMode: 'generated', cues });
    const { rerender } = render(<AudioStage issue={issue} onStageUpdate={onStageUpdate} />);

    // Edit cue 0, blur; then edit cue 1, blur — both before re-render lifts.
    const ta0 = within(screen.getByText('Act I').closest('li')).getByRole('textbox');
    await userEvent.clear(ta0);
    await userEvent.type(ta0, 'a1');
    fireEvent.blur(ta0); // fireEvent wraps in act; raw ta0.blur() would not
    const ta1 = within(screen.getByText('Act II').closest('li')).getByRole('textbox');
    await userEvent.clear(ta1);
    await userEvent.type(ta1, 'b1');
    fireEvent.blur(ta1);

    // Drive the lifted issue back in so the second save's tail reads it.
    await waitFor(() => expect(updatePipelineIssue).toHaveBeenCalledTimes(2));
    const lastPatch = updatePipelineIssue.mock.calls[1][1].stages.audio.cues;
    // The second patch must carry cue 0's new value (a1), proving it merged
    // against the freshest array rather than the original render-time snapshot.
    expect(lastPatch[0].prompt).toBe('a1');
    expect(lastPatch[1].prompt).toBe('b1');
    rerender(<AudioStage issue={issue} onStageUpdate={onStageUpdate} />);
  });

  it('aborts the render and keeps the draft when the pre-render prompt save fails', async () => {
    const cues = [{ id: 'cue-1', label: 'Act I', prompt: 'old' }];
    const issue = makeIssue({ audioMode: 'generated', cues });
    updatePipelineIssue.mockRejectedValue(new Error('boom'));
    render(<AudioStage issue={issue} onStageUpdate={() => {}} />);
    await waitFor(() => expect(listPipelineMusicGenerators).toHaveBeenCalled());

    const cueItem = screen.getByText('Act I').closest('li');
    const ta = within(cueItem).getByRole('textbox');
    await userEvent.clear(ta);
    await userEvent.type(ta, 'new draft');
    await userEvent.click(within(cueItem).getByRole('button', { name: /Render/i }));

    // Render must NOT fire (save failed → stale text would otherwise render).
    await waitFor(() => expect(updatePipelineIssue).toHaveBeenCalled());
    expect(renderPipelineAudioCue).not.toHaveBeenCalled();
    // Draft survives so the edit isn't lost.
    expect(ta).toHaveValue('new draft');
  });

  it('does not clobber a rendered cue track when a later prompt save runs', async () => {
    const cues = [{ id: 'cue-1', label: 'Act I', prompt: 'p' }];
    const issue = makeIssue({ audioMode: 'generated', cues });
    // The render stamps trackFilename onto the cue and lifts it back.
    const renderedCues = [{ ...cues[0], trackFilename: 'cue.wav', durationSec: 10 }];
    renderPipelineAudioCue.mockResolvedValue({
      issue: makeIssue({ audioMode: 'generated', cues: renderedCues }),
      stage: { cues: renderedCues },
      cueIdx: 0,
      cue: renderedCues[0],
    });
    updatePipelineIssue.mockImplementation((_id, patch) =>
      Promise.resolve(makeIssue({ audioMode: 'generated', cues: patch.stages.audio.cues })));
    render(<AudioStage issue={issue} onStageUpdate={() => {}} />);
    await waitFor(() => expect(listPipelineMusicGenerators).toHaveBeenCalled());

    const cueItem = screen.getByText('Act I').closest('li');
    await userEvent.click(within(cueItem).getByRole('button', { name: /Render/i }));
    await waitFor(() => expect(renderPipelineAudioCue).toHaveBeenCalled());

    // Now edit the prompt — the resulting PATCH must carry the rendered
    // trackFilename, proving the save merged against the post-render array.
    const ta = within(cueItem).getByRole('textbox');
    await userEvent.type(ta, ' more');
    fireEvent.blur(ta);
    await waitFor(() => expect(updatePipelineIssue).toHaveBeenCalled());
    const savedCues = updatePipelineIssue.mock.calls.at(-1)[1].stages.audio.cues;
    expect(savedCues[0].trackFilename).toBe('cue.wav');
  });

  it('surfaces a Retry when the generators fetch fails, instead of a perpetual "Checking" state', async () => {
    listPipelineMusicGenerators.mockRejectedValueOnce(new Error('offline'));
    const cues = [{ id: 'cue-1', label: 'Act I', prompt: 'p' }];
    const issue = makeIssue({ audioMode: 'generated', cues });
    render(<AudioStage issue={issue} onStageUpdate={() => {}} />);

    const retry = await screen.findByRole('button', { name: /Retry/i });
    expect(screen.getByText(/Couldn't check the music engine/i)).toBeInTheDocument();

    // Retry re-fetches; this time it succeeds and the error clears.
    listPipelineMusicGenerators.mockResolvedValueOnce(READY_ENGINE);
    await userEvent.click(retry);
    await waitFor(() => expect(screen.queryByText(/Couldn't check the music engine/i)).not.toBeInTheDocument());
  });

  it('disables cue render when the engine is not installed', async () => {
    listPipelineMusicGenerators.mockResolvedValue(NOT_READY_ENGINE);
    const cues = [{ id: 'cue-1', label: 'Act I', prompt: 'warm pads', startSec: 0, endSec: 10 }];
    const issue = makeIssue({ audioMode: 'generated', cues });
    render(<AudioStage issue={issue} onStageUpdate={() => {}} />);

    await waitFor(() => expect(listPipelineMusicGenerators).toHaveBeenCalled());

    const cueItem = screen.getByText('Act I').closest('li');
    await waitFor(() => expect(within(cueItem).getByRole('button', { name: /Render/i })).toBeDisabled());
    expect(renderPipelineAudioCue).not.toHaveBeenCalled();
  });
});
