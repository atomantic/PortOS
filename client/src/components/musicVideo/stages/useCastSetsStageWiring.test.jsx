/**
 * Music Video page suite for the Look step container (`useCastSetsStageWiring`): visual-spec references, the queued look saves, the check-in and its development files.
 * Drives the real page through the shared scaffold in `test/musicVideoPageMocks.jsx`.
 */
import { describe, it, expect, vi } from 'vitest';
// The scaffold registers the mocks, so it loads before any mocked module.
import {
  PROJECT_WITH_CLIP,
  PROJECT_NO_CLIP,
  PROJECT_ANALYZED,
  MV_ROUTES,
  openStage,
  openProject,
  LocationProbe,
  savedProjectEdits,
  editResult,
  installMusicVideoPageHooks,
} from '../../../test/musicVideoPageMocks.jsx';
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import toast from '../../ui/Toast';
import { listMusicVideoProjects, updateMusicVideoProject, linkMusicVideoCastAndSetsToCatalog } from '../../../services/apiMusicVideo.js';
import { getUniverse } from '../../../services/apiUniverseBuilder.js';

installMusicVideoPageHooks();

describe('MusicVideo YouTube audio import (#1945)', () => {
  it('opens a development file from its deep link in a sandboxed viewer', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true });
    const sheet = {
      id: 'mvd-1', kind: 'cast-sets', title: 'Cast & Sets — Nova', status: 'approved', version: 2, mimeType: 'text/html', updatedAt: '2026-01-02T00:00:00Z',
      versions: [{ version: 1, mimeType: 'text/html', source: 'upload', createdAt: '2026-01-01T00:00:00Z' }, { version: 2, mimeType: 'text/html', source: 'upload', createdAt: '2026-01-02T00:00:00Z' }],
      notes: [{ id: 'n1', text: 'Shorter braid', target: null, version: 1, createdAt: '2026-01-01T00:00:00Z', resolvedAt: null }],
    };
    const project = { ...PROJECT_NO_CLIP, devArtifacts: [sheet] };
    listMusicVideoProjects.mockResolvedValue([project]);
    render(
      <MemoryRouter initialEntries={[`/music-video/${project.id}/cast-sets/dev/mvd-1?v=1`]}>{MV_ROUTES}</MemoryRouter>,
    );
    const frame = await screen.findByTitle('Cast & Sets — Nova v1');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('src')).toBe(`/api/music-video/${project.id}/dev-artifacts/mvd-1/file?version=1`);
    expect(screen.getByText('Shorter braid')).toBeTruthy();
    // The Development section lists it with its review status.
    expect(screen.getAllByText('Approved').length).toBeGreaterThan(0);
  });
});

describe('MusicVideo pull references from universe (#8978)', () => {
  const UNIVERSE_PROJECT = {
    ...PROJECT_NO_CLIP,
    id: 'mv-universe',
    name: 'Universe Project',
    concept: { universeId: 'u1' },
    visualSpec: { references: [{ id: 'r0', imageId: 'harbor.png', role: 'mood', condition: false }] },
  };

  it('adds the universe\'s canon images as new references, skipping ones already present', async () => {
    getUniverse.mockResolvedValueOnce({
      characters: [{ id: 'c1', name: 'Nyra', primaryImageRef: 'nyra.png' }],
      places: [{ id: 'p1', name: 'Harbor', imageRefs: ['harbor.png'] }], // already a reference
      objects: [],
    });
    updateMusicVideoProject.mockImplementation(savedProjectEdits(UNIVERSE_PROJECT));
    await openProject(UNIVERSE_PROJECT, 'cast-sets');

    fireEvent.click(await screen.findByRole('button', { name: /^Pull from universe$/ }));
    await waitFor(() => expect(getUniverse).toHaveBeenCalledWith('u1', { silent: true }));
    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenCalledWith(
      'mv-universe',
      { visualSpec: { references: [
        { id: 'r0', imageId: 'harbor.png', role: 'mood', condition: false },
        // Pulled references get their own client-minted id (not the server's
        // stable one yet) so multiple additions never collide on `undefined`.
        { id: expect.any(String), imageId: 'nyra.png', role: 'character', label: 'Nyra', condition: false },
      ] } },
      { silent: true, edit: true },
    ));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/Pulled 1 reference/)));
  });

  it('is idempotent — a second pull adds nothing once every canon image is already a reference', async () => {
    getUniverse.mockResolvedValue({
      characters: [], places: [{ id: 'p1', name: 'Harbor', imageRefs: ['harbor.png'] }], objects: [],
    });
    await openProject(UNIVERSE_PROJECT, 'cast-sets');
    fireEvent.click(await screen.findByRole('button', { name: /^Pull from universe$/ }));
    await waitFor(() => expect(getUniverse).toHaveBeenCalledTimes(1));
    expect(updateMusicVideoProject).not.toHaveBeenCalled();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Every canon image is already a reference'));
  });

  it('applies the pull against the latest references, not a stale click-time snapshot (race guard)', async () => {
    let resolveUniverse;
    getUniverse.mockReturnValueOnce(new Promise((resolve) => { resolveUniverse = resolve; }));
    updateMusicVideoProject.mockImplementation(savedProjectEdits(UNIVERSE_PROJECT));
    await openProject(UNIVERSE_PROJECT, 'cast-sets');

    fireEvent.click(await screen.findByRole('button', { name: /^Pull from universe$/ }));
    await waitFor(() => expect(getUniverse).toHaveBeenCalledTimes(1));

    // While the universe fetch is still in flight, remove the existing
    // reference — a stale click-time snapshot would resurrect it below.
    fireEvent.click(screen.getByRole('button', { name: 'Remove reference' }));
    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenCalledWith(
      'mv-universe', { visualSpec: { references: [] } }, { silent: true, edit: true },
    ));

    await act(async () => {
      resolveUniverse({ characters: [{ id: 'c1', name: 'Nyra', primaryImageRef: 'nyra.png' }], places: [], objects: [] });
    });

    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenLastCalledWith(
      'mv-universe',
      { visualSpec: { references: [
        { id: expect.any(String), imageId: 'nyra.png', role: 'character', label: 'Nyra', condition: false },
      ] } },
      { silent: true, edit: true },
    ));
  });

  it('does not offer Pull from universe when the project has no linked universe', async () => {
    await openProject(PROJECT_NO_CLIP, 'cast-sets');
    expect(screen.queryByRole('button', { name: /Pull from universe/i })).toBeNull();
  });
});

describe('MusicVideo stage tabs (#9243)', () => {
  const renderAt = (path) => render(
    <MemoryRouter initialEntries={[path]}>
      <LocationProbe />
      {MV_ROUTES}
    </MemoryRouter>,
  );

  // Uniquely catches the opening title card form leaving the Look step or reappearing on Plan/Shots.
  it('edits the opening title card on the Look step only, right under the preview', async () => {
    listMusicVideoProjects.mockResolvedValue([PROJECT_WITH_CLIP]);
    renderAt('/music-video/mv-1/cast-sets');
    await screen.findByRole('heading', { level: 2, name: PROJECT_WITH_CLIP.name });
    const preview = screen.getByRole('complementary', { name: 'Preview' });
    const card = screen.getByRole('region', { name: 'Opening title card' });
    expect(preview.nextElementSibling).toBe(card);
    for (const stage of ['board', 'produce']) {
      await openStage(stage);
      expect(screen.queryByRole('region', { name: 'Opening title card' })).toBeNull();
    }
  });
});

describe('stage checklist and project options', () => {
  it('keeps Cast & Sets on the art approval after the unwanted sheet is gone, and says an approved sheet file is not that approval', async () => {
    // The guide pick itself is covered by stageChecklist's unit test; selecting
    // one here would make the open approvals panel fetch the sheet's file.
    const project = { ...PROJECT_ANALYZED, scenes: [], castAndSets: { status: 'skipped' },
      devArtifacts: [{ id: 'sheet', kind: 'cast-sets', title: 'Cast sheet', mimeType: 'text/html', version: 1, status: 'approved' }],
      productionReview: { draft: { cast: 'c', environments: 'e', visualLanguage: 'v', motionLanguage: 'm', guideArtifactId: null,
        lyricsMode: 'vocal', timingStatus: 'provisional', timingNotes: '', storyboard: [] } },
      productionReadiness: { readyForProduction: false, basis: {}, art: { approved: false, problems: [] },
        storyboard: { approved: false, problems: [] }, proof: { approved: false, problems: [] } } };
    await openProject(project, 'cast-sets');
    const checklist = screen.getByRole('region', { name: 'What this step needs' });
    expect(checklist).toHaveTextContent('1 of 3 done');
    expect(checklist).toHaveTextContent('Pick a file below with Use as visual guide, or import one.');
    expect(checklist).toHaveTextContent('Art direction approved');
    expect(checklist).toHaveTextContent('Opens once the art direction is written and a guide is chosen.');
    // The guide row lands on the files, where each sheet has Use as visual guide.
    fireEvent.click(within(checklist).getByRole('button', { name: 'Choose a guide' }));
    await waitFor(() => expect(document.getElementById('mv-look-guides')).toHaveFocus());
    expect(within(document.getElementById('mv-look-guides')).getByRole('button', { name: 'Use Cast sheet as visual guide' })).toBeInTheDocument();
  });

  it('builds the cast & sets from the Look checklist when nothing is written yet', async () => {
    const project = { ...PROJECT_ANALYZED, scenes: [], castAndSets: undefined, devArtifacts: [],
      productionReadiness: { readyForProduction: false, basis: {}, art: { approved: false, problems: ['Cast guide needs editable direction.'] },
        storyboard: { approved: false, problems: [] }, proof: { approved: false, problems: [] } } };
    linkMusicVideoCastAndSetsToCatalog.mockResolvedValue({ project, stage: null });
    await openProject(project, 'cast-sets');
    const checklist = screen.getByRole('region', { name: 'What this step needs' });
    expect(checklist).toHaveTextContent('Link the cast & sets from the catalog, then write the art direction separately.');
    expect(checklist).toHaveTextContent('Pick a file below with Use as visual guide, or import one.');
    expect(checklist).not.toHaveTextContent('needs editable direction');
    fireEvent.click(within(checklist).getByRole('button', { name: 'Link cast & sets' }));
    await waitFor(() => expect(linkMusicVideoCastAndSetsToCatalog).toHaveBeenCalledWith(project.id, { silent: true }));
    fireEvent.click(within(checklist).getByRole('button', { name: 'Write it yourself' }));
    await waitFor(() => expect(screen.getByLabelText('Cast guide')).toHaveFocus());
  });
});

describe('queued look reference saves', () => {
  const project = () => ({
    ...PROJECT_NO_CLIP,
    id: 'mv-object', name: 'Object references',
    concept: { subjects: [] },
    visualSpec: { references: [
      { id: 'first', imageId: 'first.png', label: 'First', role: 'prop', condition: false },
      { id: 'second', imageId: 'second.png', label: 'Second', role: 'prop', condition: false },
    ] },
  });
  const openLook = async () => {
    await openProject(project(), 'cast-sets');
    fireEvent.click(await screen.findByText('Mood board & other asset links'));
    return within(screen.getByRole('region', { name: 'Look references' }));
  };

  it('keeps a later reference edit when an earlier save resolves', async () => {
    const saves = [];
    updateMusicVideoProject.mockReset();
    updateMusicVideoProject.mockImplementation((_id, patch) => new Promise((resolve) => {
      saves.push(() => resolve({ edit: editResult([], [], { project: { visualSpec: patch.visualSpec } }) }));
    }));
    const look = await openLook();
    fireEvent.click(look.getAllByLabelText('Condition frames')[0]);
    await waitFor(() => expect(saves).toHaveLength(1));
    fireEvent.click(look.getAllByLabelText('Condition frames')[1]);
    await act(async () => saves[0]());
    await waitFor(() => expect(saves).toHaveLength(2));
    expect(look.getAllByLabelText('Condition frames').map((box) => box.checked)).toEqual([true, true]);
    await act(async () => saves[1]());
    expect(updateMusicVideoProject.mock.calls[1][1].visualSpec.references.map((ref) => ref.condition)).toEqual([true, true]);
  });

  it('rolls back a failed edit so it can be retried', async () => {
    updateMusicVideoProject.mockReset();
    updateMusicVideoProject.mockRejectedValueOnce(new Error('Save failed'));
    const look = await openLook();
    await act(async () => fireEvent.click(look.getAllByLabelText('Condition frames')[0]));
    await waitFor(() => expect(look.getAllByLabelText('Condition frames')[0]).not.toBeChecked());
    expect(toast.error).toHaveBeenCalledWith('Save failed');
  });

  it('restores the last saved references when two queued edits both fail', async () => {
    const failures = [];
    updateMusicVideoProject.mockReset();
    updateMusicVideoProject.mockImplementation(() => new Promise((_, reject) => failures.push(() => reject(new Error('Save failed')))));
    const look = await openLook();
    fireEvent.click(look.getAllByLabelText('Condition frames')[0]);
    await waitFor(() => expect(failures).toHaveLength(1));
    fireEvent.click(look.getAllByLabelText('Condition frames')[1]);
    await act(async () => failures[0]());
    await waitFor(() => expect(failures).toHaveLength(2));
    expect(look.getAllByLabelText('Condition frames')[1]).toBeChecked();
    await act(async () => failures[1]());
    expect(look.getAllByLabelText('Condition frames').map((box) => box.checked)).toEqual([false, false]);
  });
});
