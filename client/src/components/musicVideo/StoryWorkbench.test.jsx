import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import StoryWorkbench from './StoryWorkbench.jsx';

const api = vi.hoisted(() => ({
  applyMusicVideoStory: vi.fn(), applyMusicVideoStoryBeats: vi.fn(), getMusicVideoStoryContext: vi.fn(),
  proposeMusicVideoStory: vi.fn(), saveMusicVideoStorySummary: vi.fn(),
}));
vi.mock('../../services/apiMusicVideo.js', () => api);
vi.mock('../../hooks/useProviderModels.js', () => ({ default: () => ({ providers: [{ id: 'llm', toolFreeOneShot: false }], selectedProviderId: 'llm', selectedModel: 'model-a', availableModels: ['model-a'], setSelectedProviderId: vi.fn(), setSelectedModel: vi.fn() }) }));
vi.mock('../ProviderModelSelector.jsx', () => ({ default: ({ onEffortChange, onExecutionOptionsChange }) => <div>
  <button type="button" onClick={() => onEffortChange('high')}>Choose high effort</button>
  <button type="button" onClick={() => onExecutionOptionsChange({ serviceTier: 'fast' })}>Choose fast</button>
</div> }));
vi.mock('../media/SentPromptPanel.jsx', () => ({ default: () => <p>Prompt available</p> }));

const original = { id: 'mv-test', storySummary: '', storyboardId: 'sb-test', concept: { prompt: 'Original', style: 'Blue', subjects: [] }, treatment: null };
const current = { basis: 'basis-1', inputs: { summary: '', concept: original.concept, brief: {} }, board: { id: 'sb-test', name: 'My board', basis: 'board-1', beats: [] } };
const proposed = { concept: { prompt: 'A rough arc', style: 'Gold' }, subjects: [{ kind: 'place', name: 'Station' }], beats: [{ title: 'Arrival', panels: [{ action: 'Walk in' }] }] };
function Fixture({ active = true }) {
  const [project, setProject] = useState(original);
  return <StoryWorkbench project={project} active={active} onProject={(patch) => setProject((previous) => ({ ...previous, ...patch }))} />;
}
beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.saveMusicVideoStorySummary.mockImplementation(async (_id, { summary }) => ({ project: { ...original, storySummary: summary } }));
  api.getMusicVideoStoryContext.mockResolvedValue(current);
  api.proposeMusicVideoStory.mockResolvedValue({ ...current, proposal: proposed, reply: 'Try a return home.', sentPrompt: 'Exact prompt', promptAdditions: [] });
  api.applyMusicVideoStory.mockResolvedValue({ project: { ...original, concept: { ...original.concept, prompt: 'Edited arc' } } });
  api.applyMusicVideoStoryBeats.mockResolvedValue({ board: { id: 'sb-test' } });
});

async function develop() {
  fireEvent.change(screen.getByLabelText('Story in your own words'), { target: { value: 'My rough story' } });
  fireEvent.blur(screen.getByLabelText('Story in your own words'));
  await waitFor(() => expect(api.saveMusicVideoStorySummary).toHaveBeenCalledWith('mv-test', { summary: 'My rough story', baseSummary: '' }, { silent: true }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Develop story' })).not.toBeDisabled());
  fireEvent.click(screen.getByRole('button', { name: 'Develop story' }));
  await screen.findByText('Review proposed changes');
}

describe('Story workbench', () => {
  it.each(['Develop story', 'Preview prompt and context'])('saves notes before %s on the first click', async (action) => {
    let finishSave;
    api.saveMusicVideoStorySummary.mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; }));
    const user = userEvent.setup();
    render(<Fixture />);
    await user.type(screen.getByLabelText('Story in your own words'), 'A rough ending');
    await user.click(screen.getByRole('button', { name: action }));
    expect(api.saveMusicVideoStorySummary).toHaveBeenCalledTimes(1);
    expect(api.proposeMusicVideoStory).not.toHaveBeenCalled();
    await act(async () => finishSave({ project: { ...original, storySummary: 'A rough ending' } }));
    await waitFor(() => expect(api.proposeMusicVideoStory).toHaveBeenCalledWith('mv-test', expect.objectContaining({ preview: action.startsWith('Preview') }), { silent: true }));
  });

  it('saves newer notes after an earlier save finishes before developing the story', async () => {
    let finishFirstSave, finishSecondSave;
    api.saveMusicVideoStorySummary.mockImplementationOnce(() => new Promise((resolve) => { finishFirstSave = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishSecondSave = resolve; }));
    render(<Fixture />);
    const notes = screen.getByLabelText('Story in your own words');
    fireEvent.change(notes, { target: { value: 'First draft' } });
    fireEvent.blur(notes);
    fireEvent.change(notes, { target: { value: 'Newer draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Develop story' }));
    await act(async () => finishFirstSave({ project: { ...original, storySummary: 'First draft' } }));
    await waitFor(() => expect(api.saveMusicVideoStorySummary).toHaveBeenLastCalledWith('mv-test', { summary: 'Newer draft', baseSummary: 'First draft' }, { silent: true }));
    expect(api.proposeMusicVideoStory).not.toHaveBeenCalled();
    await act(async () => finishSecondSave({ project: { ...original, storySummary: 'Newer draft' } }));
    await waitFor(() => expect(api.proposeMusicVideoStory).toHaveBeenCalledTimes(1));
  });

  it('does not develop when saving notes conflicts', async () => {
    api.saveMusicVideoStorySummary.mockRejectedValueOnce(Object.assign(new Error('Changed elsewhere'), { status: 409 }));
    api.getMusicVideoStoryContext.mockResolvedValue({ ...current, inputs: { ...current.inputs, summary: 'A newer story' } });
    const user = userEvent.setup();
    render(<Fixture />);
    await user.type(screen.getByLabelText('Story in your own words'), 'My notes');
    await user.click(screen.getByRole('button', { name: 'Develop story' }));
    await screen.findByText(/The saved summary changed elsewhere/);
    expect(api.proposeMusicVideoStory).not.toHaveBeenCalled();
  });

  it('shows both versions after a notes conflict and keeps the selected current version', async () => {
    api.saveMusicVideoStorySummary.mockRejectedValueOnce(Object.assign(new Error('Changed elsewhere'), { status: 409 }));
    api.getMusicVideoStoryContext.mockResolvedValue({ ...current, inputs: { ...current.inputs, summary: 'A newer story' } });
    render(<Fixture />);
    fireEvent.change(screen.getByLabelText('Story in your own words'), { target: { value: 'My notes' } });
    fireEvent.blur(screen.getByLabelText('Story in your own words'));
    await screen.findByText(/The saved summary changed elsewhere/);
    expect(screen.getByText(/A newer story/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use current' }));
    await waitFor(() => expect(screen.getByLabelText('Story in your own words')).toHaveValue('A newer story'));
    expect(screen.queryByRole('button', { name: 'Save story notes' })).toBeNull();
  });

  it('saves rough notes, passes the selected route, and selectively applies editable fields', async () => {
    render(<Fixture />);
    expect(screen.getByText('This provider can use tools and requires host control.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Choose high effort' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose fast' }));
    await develop();
    expect(api.proposeMusicVideoStory).toHaveBeenCalledWith('mv-test', expect.objectContaining({ providerId: 'llm', model: 'model-a', effort: 'high', executionOptions: { serviceTier: 'fast' } }), { silent: true });
    expect(api.applyMusicVideoStory).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Proposed Concept'), { target: { value: 'Edited arc' } });
    fireEvent.click(screen.getByLabelText('Concept'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply selected direction and cast' }));
    await waitFor(() => expect(api.applyMusicVideoStory).toHaveBeenCalledWith('mv-test', { basis: 'basis-1', proposal: { concept: { prompt: 'Edited arc' } } }, { silent: true }));
    expect(screen.queryByLabelText('Proposed Concept')).toBeNull();
    expect(screen.getByLabelText('Proposed Visual style')).toHaveValue('Gold');
    expect(api.applyMusicVideoStoryBeats).not.toHaveBeenCalled();
  });

  it('keeps a conflicted proposal for review, requires re-selection, and can discard it', async () => {
    api.applyMusicVideoStory.mockRejectedValueOnce(Object.assign(new Error('Changed elsewhere'), { status: 409 }));
    render(<Fixture />);
    await develop();
    fireEvent.click(screen.getByLabelText('Visual style'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply selected direction and cast' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Changed elsewhere');
    expect(screen.getByLabelText('Proposed Visual style')).toHaveValue('Gold');
    fireEvent.click(screen.getByRole('button', { name: 'Review current values' }));
    await screen.findByText(/Current values refreshed/);
    expect(screen.getByRole('button', { name: 'Apply selected direction and cast' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard proposal' }));
    expect(screen.queryByText('Review proposed changes')).toBeNull();
    expect(screen.queryByText(/Current values refreshed/)).toBeNull();
    expect(api.applyMusicVideoStory).toHaveBeenCalledTimes(1);
    expect(api.applyMusicVideoStoryBeats).not.toHaveBeenCalled();
  });

  it('clears an earlier success notice when a later apply conflicts', async () => {
    render(<Fixture />);
    await develop();
    fireEvent.click(screen.getByLabelText('Concept'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply selected direction and cast' }));
    await screen.findByText(/Selected direction and cast changes applied/);
    api.applyMusicVideoStory.mockRejectedValueOnce(Object.assign(new Error('Changed elsewhere'), { status: 409 }));
    fireEvent.click(screen.getByLabelText('Visual style'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply selected direction and cast' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Changed elsewhere');
    expect(screen.queryByText(/Selected direction and cast changes applied/)).toBeNull();
  });

  it('applies only explicitly selected beats to the reviewed storyboard', async () => {
    render(<Fixture />);
    await develop();
    fireEvent.click(screen.getByLabelText('Add beat'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply selected beats to storyboard' }));
    await waitFor(() => expect(api.applyMusicVideoStoryBeats).toHaveBeenCalledWith('mv-test', {
      boardId: 'sb-test', boardBasis: 'board-1', basis: 'basis-1', beats: [proposed.beats[0]],
    }, { silent: true }));
    expect(api.applyMusicVideoStory).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Add beat')).toBeNull();
    expect(screen.getByLabelText('Proposed Concept')).toHaveValue('A rough arc');
  });

  it('uses the prior conversation and edited proposal for a follow-up without applying beats', async () => {
    const view = render(<Fixture />);
    await develop();
    fireEvent.change(screen.getByLabelText('Proposed Concept'), { target: { value: 'A revised draft' } });
    view.rerender(<Fixture active={false} />);
    view.rerender(<Fixture active />);
    expect(screen.getByLabelText('Proposed Concept')).toHaveValue('A revised draft');
    fireEvent.change(screen.getByLabelText('Direction or follow-up'), { target: { value: 'Make the ending quieter' } });
    fireEvent.click(screen.getByRole('button', { name: 'Refine story' }));
    await waitFor(() => expect(api.proposeMusicVideoStory).toHaveBeenCalledTimes(2));
    expect(api.proposeMusicVideoStory.mock.calls[1][1]).toMatchObject({ draft: { concept: { prompt: 'A revised draft' } },
      messages: [{ role: 'user' }, { role: 'assistant', content: 'Try a return home.' }, { role: 'user', content: 'Make the ending quieter' }] });
    expect(api.applyMusicVideoStoryBeats).not.toHaveBeenCalled();
  });

  it('prevents draft edits while a refinement is in flight', async () => {
    render(<Fixture />);
    await develop();
    let resolveRefinement;
    api.proposeMusicVideoStory.mockImplementationOnce(() => new Promise((resolve) => { resolveRefinement = resolve; }));
    fireEvent.change(screen.getByLabelText('Direction or follow-up'), { target: { value: 'Make it quieter' } });
    fireEvent.click(screen.getByRole('button', { name: 'Refine story' }));
    expect(screen.getByLabelText('Direction or follow-up')).toBeDisabled();
    expect(screen.getByLabelText('Proposed Concept')).toBeDisabled();
    await waitFor(() => expect(api.proposeMusicVideoStory).toHaveBeenCalledTimes(2));
    await act(async () => resolveRefinement({ ...current, proposal: proposed, reply: 'A quieter ending.', sentPrompt: 'Prompt' }));
    expect(screen.getByLabelText('Direction or follow-up')).not.toBeDisabled();
    expect(screen.getByText(/A quieter ending/)).toBeInTheDocument();
  });

  it('shows the values an existing subject and panel will retain when their proposal omits them', async () => {
    const existingSubject = { id: 'subject-1', kind: 'character', name: 'Ari', role: 'protagonist', description: 'A singer' };
    const existingPanel = { id: 'panel-1', action: 'Walk', camera: 'Dolly', framing: 'wide', seconds: 5 };
    const snapshot = { ...current, inputs: { ...current.inputs, concept: { ...current.inputs.concept, subjects: [existingSubject] } },
      board: { ...current.board, beats: [{ id: 'beat-1', title: 'Arrival', musicalRole: 'verse', panels: [existingPanel] }] } };
    api.proposeMusicVideoStory.mockResolvedValue({ ...snapshot, reply: 'Update the name and action.', sentPrompt: 'Prompt',
      proposal: { subjects: [{ id: 'subject-1', kind: 'character', name: 'Ari again' }], beats: [{ id: 'beat-1', panels: [{ id: 'panel-1', action: 'Run' }] }] } });
    render(<Fixture />);
    await develop();
    expect(screen.getByText('Current: Ari · character · protagonist · A singer')).toBeInTheDocument();
    expect(screen.getByText('Current: Panel 1 Action: Walk')).toBeInTheDocument();
    expect(screen.queryByText(/"id":/)).toBeNull();
    expect(screen.getByLabelText('Role')).toHaveValue('protagonist');
    expect(screen.getByLabelText('Description')).toHaveValue('A singer');
    expect(screen.getByLabelText('Title')).toHaveValue('Arrival');
    expect(screen.getByLabelText('Musical role')).toHaveValue('verse');
    expect(screen.getByLabelText('Camera')).toHaveValue('Dolly');
    expect(screen.getByLabelText('Framing')).toHaveValue('wide');
    expect(screen.getByLabelText('Estimated seconds')).toHaveValue(5);
    fireEvent.click(screen.getByLabelText('Update beat'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply selected beats to storyboard' }));
    await waitFor(() => expect(api.applyMusicVideoStoryBeats).toHaveBeenCalledWith('mv-test', expect.objectContaining({
      beats: [{ id: 'beat-1', panels: [{ id: 'panel-1', action: 'Run' }] }],
    }), { silent: true }));
  });
});
