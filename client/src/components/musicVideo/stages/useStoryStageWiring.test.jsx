/**
 * Music Video page suite for the Story step container (`useStoryStageWiring`): concept, style and direction drafts and their chained saves.
 * Drives the real page through the shared scaffold in `test/musicVideoPageMocks.jsx`.
 */
import { describe, it, expect } from 'vitest';
// The scaffold registers the mocks, so it loads before any mocked module.
import {
  PROJECT_WITH_CLIP,
  PROJECT_NO_CLIP,
  PROJECT_ANALYZED,
  MV_ROUTES,
  renderMV,
  settle,
  selectProject,
  openStage,
  openProject,
  LocationProbe,
  installMusicVideoPageHooks,
} from '../../../test/musicVideoPageMocks.jsx';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { listMusicVideoProjects, updateMusicVideoProject } from '../../../services/apiMusicVideo.js';

installMusicVideoPageHooks();

describe('MusicVideo concept & style editor (#3168)', () => {
  it('seeds the fields from the project and persists each on blur', async () => {
    const withConcept = { ...PROJECT_NO_CLIP, concept: { prompt: 'A road trip through neon ruins', style: 'Cyberpunk anime' } };
    await openProject(withConcept, 'story');

    const conceptField = await screen.findByLabelText('Concept');
    const styleField = screen.getByLabelText('Visual style');
    expect(conceptField).toHaveValue('A road trip through neon ruins');
    expect(styleField).toHaveValue('Cyberpunk anime');

    fireEvent.change(conceptField, { target: { value: 'A heist across a dying star' } });
    fireEvent.blur(conceptField);
    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenCalledWith(
      'mv-2',
      { concept: { prompt: 'A heist across a dying star' } },
      { silent: true },
    ));

    fireEvent.change(styleField, { target: { value: 'Watercolor noir' } });
    fireEvent.blur(styleField);
    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenCalledWith(
      'mv-2',
      { concept: { style: 'Watercolor noir' } },
      { silent: true },
    ));
  });

  it('does not re-PATCH when a field is focused and blurred without an edit', async () => {
    const withConcept = { ...PROJECT_NO_CLIP, concept: { prompt: 'Unchanged', style: 'Unchanged' } };
    await openProject(withConcept, 'story');
    const conceptField = await screen.findByLabelText('Concept');
    fireEvent.focus(conceptField);
    fireEvent.blur(conceptField);
    await settle();
    expect(updateMusicVideoProject).not.toHaveBeenCalled();
  });

  it('discards an unsaved draft on project switch instead of leaking it onto the next project', async () => {
    // The page reuses one component instance across projects (route param
    // change, no remount) — an edit left unblurred when the selection changes
    // (deep link, browser Back, ⌘K) must not survive to be committed against
    // whichever project is now selected.
    const projectB = { ...PROJECT_NO_CLIP, id: 'mv-3', name: 'Other Project', concept: { prompt: 'B original' } };
    listMusicVideoProjects.mockResolvedValue([PROJECT_NO_CLIP, projectB]);
    renderMV();
    await selectProject(PROJECT_NO_CLIP.id);
    // Concept and style are creative direction, on the Story step.
    await openStage('story');

    const conceptField = await screen.findByLabelText('Concept');
    fireEvent.change(conceptField, { target: { value: 'A unsaved draft' } });
    // No blur — switch projects while the edit is still pending.
    await selectProject(projectB.id);
    await openStage('story');

    await waitFor(() => expect(screen.getByLabelText('Concept')).toHaveValue('B original'));
    fireEvent.blur(screen.getByLabelText('Concept'));
    await settle();
    expect(updateMusicVideoProject).not.toHaveBeenCalledWith(
      'mv-3',
      { concept: { prompt: 'A unsaved draft' } },
      { silent: true },
    );
  });

  it('starts empty and enables AI Plan to use them once set', async () => {
    await openProject(PROJECT_ANALYZED, 'story');
    const conceptField = await screen.findByLabelText('Concept');
    expect(conceptField).toHaveValue('');

    fireEvent.change(conceptField, { target: { value: 'Underwater festival' } });
    fireEvent.blur(conceptField);
    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenCalledWith(
      'mv-3',
      { concept: { prompt: 'Underwater festival' } },
      { silent: true },
    ));
  });
});

describe('MusicVideo stage tabs (#9243)', () => {
  const renderAt = (path) => render(
    <MemoryRouter initialEntries={[path]}>
      <LocationProbe />
      {MV_ROUTES}
    </MemoryRouter>,
  );

  it('opens Story without a preview and keeps a rough draft across stage navigation', async () => {
    listMusicVideoProjects.mockResolvedValue([{ ...PROJECT_WITH_CLIP, concept: { prompt: 'Existing direction', style: 'Blue', songStyle: 'Synth' } }]);
    renderAt('/music-video/mv-1/story');
    await screen.findByRole('heading', { level: 2, name: PROJECT_WITH_CLIP.name });
    expect(screen.getByLabelText('Concept')).toHaveValue('Existing direction');
    expect(screen.getByLabelText('Visual style')).toHaveValue('Blue');
    expect(screen.getByLabelText('Song style')).toHaveValue('Synth');
    expect(screen.queryByRole('complementary', { name: 'Preview' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Story in your own words'), { target: { value: 'A rough story draft' } });
    await openStage('cast-sets');
    expect(screen.getByLabelText('Concept')).not.toBeVisible();
    await openStage('story');
    expect(screen.getByLabelText('Story in your own words')).toHaveValue('A rough story draft');
    expect(screen.queryByRole('complementary', { name: 'Preview' })).toBeNull();
  });

  it('keeps failed direction text visible and offers a retry', async () => {
    listMusicVideoProjects.mockResolvedValue([{ ...PROJECT_WITH_CLIP, concept: { prompt: 'Original direction' } }]);
    updateMusicVideoProject.mockRejectedValueOnce(new Error('Could not save'));
    renderAt('/music-video/mv-1/story');
    const concept = await screen.findByLabelText('Concept');
    fireEvent.change(concept, { target: { value: 'My unsaved direction' } });
    fireEvent.blur(concept);
    const retry = await screen.findByRole('button', { name: 'Retry saving' });
    expect(concept).toHaveValue('My unsaved direction');
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry saving' })).toBeNull());
    expect(updateMusicVideoProject).toHaveBeenLastCalledWith('mv-1', { concept: { prompt: 'My unsaved direction' } }, { silent: true });
  });

  it('saves successive direction edits in order after an earlier request fails', async () => {
    listMusicVideoProjects.mockResolvedValue([{ ...PROJECT_WITH_CLIP, concept: { prompt: 'Original direction' } }]);
    let rejectFirst;
    updateMusicVideoProject.mockImplementationOnce(() => new Promise((_, reject) => { rejectFirst = reject; }));
    renderAt('/music-video/mv-1/story');
    const concept = await screen.findByLabelText('Concept');
    fireEvent.change(concept, { target: { value: 'First edit' } });
    fireEvent.blur(concept);
    await waitFor(() => expect(rejectFirst).toBeTypeOf('function'));
    fireEvent.change(concept, { target: { value: 'Second edit' } });
    fireEvent.blur(concept);
    expect(updateMusicVideoProject).toHaveBeenCalledTimes(1);
    await act(async () => rejectFirst(new Error('First request failed')));
    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenCalledTimes(2));
    expect(updateMusicVideoProject).toHaveBeenLastCalledWith('mv-1', { concept: { prompt: 'Second edit' } }, { silent: true });
    expect(concept).toHaveValue('Second edit');
    expect(screen.queryByRole('button', { name: 'Retry saving' })).toBeNull();
  });
});
