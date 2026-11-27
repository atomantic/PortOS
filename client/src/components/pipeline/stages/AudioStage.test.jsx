import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../../services/apiPipeline.js', () => ({
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

vi.mock('../../ui/Toast');

// VoicePicker fetches voices on mount — stub it out so the component renders
// without hitting the network.
vi.mock('../../voice/VoicePicker', () => ({ default: () => null }));

import AudioStage from './AudioStage';
import toast from '../../ui/Toast';
import {
  updatePipelineIssue,
  generatePipelineAudioCues,
  generatePipelineMusic,
  renderPipelineAudioCue,
  listPipelineMusicGenerators,
  listPipelineMusicLibrary,
  patchPipelineAudioLine,
  renderPipelineAudioLine,
} from '../../../services/apiPipeline.js';

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
    unavailableReason: 'runtime-unavailable', installEnv: 'INSTALL_MUSICGEN',
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

  it('releases Render all cues after the stage update callback throws', async () => {
    const cues = [{ id: 'cue-1', label: 'Act I', prompt: 'warm pads' }];
    const issue = makeIssue({ audioMode: 'generated', cues });
    const onStageUpdate = vi.fn(() => { throw new Error('Synthetic update failure'); });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    let finishRender;
    renderPipelineAudioCue.mockImplementationOnce(() => new Promise(resolve => { finishRender = resolve; }));
    render(<AudioStage issue={issue} onStageUpdate={onStageUpdate} />);
    const button = screen.getByRole('button', { name: /Render all cues/i });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    expect(button).toBeDisabled();
    await act(async () => { finishRender({ issue, stage: { cues } }); });
    expect(onStageUpdate).toHaveBeenCalledOnce();
    expect(button).toBeEnabled();
    expect(toast.error).toHaveBeenCalledWith('Could not finish updating audio cues — reload to see the result');
    expect(toast.success).not.toHaveBeenCalled();
    log.mockRestore();
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


describe('AudioStage generator readiness', () => {
  beforeEach(() => vi.clearAllMocks());

  const openGenerator = () => userEvent.click(screen.getByRole('button', { name: 'Generate music' }));

  it.each([
    ['vram-insufficient', /requires at least 20 GB of VRAM/i],
    ['vram-unknown-size', /VRAM requirement.*has not been measured/i],
    ['cuda-absent', /requires an available NVIDIA CUDA GPU/i],
    ['platform-unsupported', /requires macOS on Apple Silicon/i],
  ])('blocks Generate and cue render for %s without suggesting the installer', async (unavailableReason, warning) => {
    const engine = {
      ...READY_ENGINE.engines[0],
      id: 'blocked-engine', name: 'Blocked engine',
      ready: false, unavailableReason, minVramGb: 20, maxVramGb: 12,
      platformLabel: 'macOS on Apple Silicon', installEnv: 'INSTALL_EXAMPLE',
    };
    listPipelineMusicGenerators.mockResolvedValue({
      defaultEngine: 'musicgen', engines: [...READY_ENGINE.engines, engine],
    });
    const cues = [{ id: 'cue-1', label: 'Act I', prompt: 'warm pads', engine: engine.id }];
    render(<AudioStage issue={makeIssue({ audioMode: 'generated', cues })} />);

    await openGenerator();
    await userEvent.selectOptions(await screen.findByLabelText('Engine'), engine.id);
    await userEvent.type(screen.getByLabelText('Describe the music'), 'warm pads');
    expect(screen.getAllByText(warning)).toHaveLength(2);
    expect(screen.queryByText(/scripts\/setup-image-video.sh/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled();
    const cue = screen.getByRole('button', { name: 'Render' });
    expect(cue).toBeDisabled();
    expect(cue.title).toMatch(warning);
    expect(screen.getByRole('button', { name: 'Render all cues' })).toBeDisabled();
    expect(generatePipelineMusic).not.toHaveBeenCalled();
    expect(renderPipelineAudioCue).not.toHaveBeenCalled();
  });

  it('allows generation with the cached checkpoint when the default checkpoint is missing', async () => {
    const engine = {
      ...READY_ENGINE.engines[0],
      id: 'fixed-engine', name: 'Fixed engine',
      models: [{ id: 'm', name: 'Default' }, { id: 'cached', name: 'Cached' }],
      ready: false, unavailableReason: 'model-unavailable',
      unavailableReasonByModelId: { m: 'model-unavailable', cached: null },
    };
    listPipelineMusicGenerators.mockResolvedValue({ defaultEngine: engine.id, engines: [engine] });
    generatePipelineMusic.mockResolvedValue({ modelId: 'cached' });
    render(<AudioStage issue={makeIssue()} />);

    await openGenerator();
    const prompt = '  warm pads\n';
    await userEvent.type(await screen.findByLabelText('Describe the music'), prompt);
    const generate = screen.getByRole('button', { name: 'Generate' });
    expect(generate).toBeDisabled();
    expect(screen.getByText(/selected Fixed engine model weights are not installed/i)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Model'), 'cached');
    expect(generate).toBeEnabled();
    await userEvent.click(generate);
    expect(generatePipelineMusic).toHaveBeenCalledWith('iss-1', {
      prompt, engine: engine.id, durationSec: 12, modelId: 'cached',
    }, { silent: true });
  });

  it('retries a failed generator lookup from the single-track panel', async () => {
    listPipelineMusicGenerators.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(READY_ENGINE);
    render(<AudioStage issue={makeIssue()} />);
    await openGenerator();
    await userEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText('Describe the music')).toBeInTheDocument();
  });

  it('shows the runtime installation command when the runtime is unavailable', async () => {
    listPipelineMusicGenerators.mockResolvedValue(NOT_READY_ENGINE);
    render(<AudioStage issue={makeIssue()} />);
    await openGenerator();
    expect(await screen.findByText('INSTALL_MUSICGEN=1 bash scripts/setup-image-video.sh')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled();
  });
});

describe('AudioStage dialogue edits', () => {
  const lines = [{ id: 'line-1', text: 'Original line', offsetSec: 2 }];

  beforeEach(() => {
    vi.clearAllMocks();
    patchPipelineAudioLine.mockReset();
    renderPipelineAudioLine.mockReset();
  });

  it.each([
    ['text', 'Dialogue line 1 text', 'Revised line', 'Revised line'],
    ['offsetSec', 'Start (s)', '3.5', 3.5],
  ])('preserves the %s draft through a failed PATCH and saves it on the next blur', async (field, label, input, value) => {
    let failSave;
    patchPipelineAudioLine.mockImplementationOnce(() => new Promise((_resolve, reject) => { failSave = reject; }));
    const updated = makeIssue({ lines: [{ ...lines[0], [field]: value }] });
    patchPipelineAudioLine.mockResolvedValueOnce({ stage: updated.stages.audio, issue: updated });
    const onStageUpdate = vi.fn();
    const { rerender } = render(<AudioStage issue={makeIssue({ lines })} onStageUpdate={onStageUpdate} />);
    const editor = screen.getByLabelText(label);

    fireEvent.change(editor, { target: { value: input } });
    fireEvent.blur(editor);
    await waitFor(() => expect(patchPipelineAudioLine).toHaveBeenCalledWith('iss-1', 0, { [field]: value }, { silent: true }));
    expect(editor).toHaveValue(value);

    await act(async () => failSave(new Error('Save unavailable')));
    expect(toast.error).toHaveBeenCalledWith('Save unavailable');
    expect(onStageUpdate).not.toHaveBeenCalled();
    expect(editor).toHaveValue(value);

    fireEvent.focus(editor);
    fireEvent.blur(editor);
    await waitFor(() => expect(onStageUpdate).toHaveBeenCalledWith('audio', updated.stages.audio, updated));
    expect(patchPipelineAudioLine).toHaveBeenCalledTimes(2);

    // The draft has cleared, so a later external update is reflected in the editor.
    rerender(<AudioStage issue={makeIssue({ lines })} onStageUpdate={onStageUpdate} />);
    expect(editor).toHaveValue(lines[0][field]);
  });

  it('keeps a newer edit when an older save succeeds', async () => {
    let finishSave;
    patchPipelineAudioLine.mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; }));
    const updated = makeIssue({ lines: [{ ...lines[0], text: 'First edit' }] });
    const { rerender } = render(<AudioStage issue={makeIssue({ lines })} />);
    const editor = screen.getByRole('textbox', { name: 'Dialogue line 1 text' });

    fireEvent.change(editor, { target: { value: 'First edit' } });
    fireEvent.blur(editor);
    await waitFor(() => expect(patchPipelineAudioLine).toHaveBeenCalledOnce());
    fireEvent.change(editor, { target: { value: 'Second edit' } });

    await act(async () => finishSave({ stage: updated.stages.audio, issue: updated }));
    rerender(<AudioStage issue={updated} />);
    expect(editor).toHaveValue('Second edit');
  });

  it('awaits a pending draft save before rendering and stops when it fails', async () => {
    let failSave;
    patchPipelineAudioLine.mockImplementationOnce(() => new Promise((_resolve, reject) => { failSave = reject; }));
    render(<AudioStage issue={makeIssue({ lines })} />);

    const editor = screen.getByRole('textbox', { name: 'Dialogue line 1 text' });
    fireEvent.change(editor, { target: { value: 'Edited line' } });
    fireEvent.blur(editor);
    await waitFor(() => expect(patchPipelineAudioLine).toHaveBeenCalledOnce());

    const renderLine = screen.getByRole('button', { name: 'Render' });
    await userEvent.click(renderLine);
    expect(renderLine).toBeDisabled();
    expect(renderPipelineAudioLine).not.toHaveBeenCalled();

    await act(async () => failSave(new Error('Save unavailable')));
    expect(patchPipelineAudioLine).toHaveBeenCalledOnce();
    expect(renderPipelineAudioLine).not.toHaveBeenCalled();
    expect(editor).toHaveValue('Edited line');
    expect(renderLine).toBeEnabled();
  });
});

describe('AudioStage music library', () => {
  it('shows a load error and replaces it with the library results on Retry', async () => {
    listPipelineMusicLibrary.mockRejectedValueOnce(new Error('Library unavailable')).mockResolvedValueOnce({
      tracks: [{ filename: 'theme.wav', label: 'Theme' }],
    });
    render(<AudioStage issue={makeIssue()} />);

    await userEvent.click(screen.getByRole('button', { name: 'Pick from library' }));
    const error = await screen.findByRole('alert');
    expect(error).toHaveTextContent('Could not load music library');
    expect(error).toHaveTextContent('Library unavailable');
    expect(screen.queryByText(/Library is empty/)).not.toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();

    await userEvent.click(within(error).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Theme')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(listPipelineMusicLibrary).toHaveBeenCalledTimes(2);
  });
});
