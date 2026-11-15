/**
 * Music Video page suite for the Final render step container (`useReviewStageWiring`): the final render job and draft excerpts.
 * Drives the real page through the shared scaffold in `test/musicVideoPageMocks.jsx`.
 */
import { describe, it, expect } from 'vitest';
// The scaffold registers the mocks, so it loads before any mocked module.
import {
  PROJECT_WITH_CLIP,
  PROJECT_NO_CLIP,
  sseState,
  renderMV,
  settle,
  selectProject,
  openStage,
  openProject,
  clickNewProject,
  forceRerender,
  installMusicVideoPageHooks,
} from '../../../test/musicVideoPageMocks.jsx';
import { screen, waitFor, fireEvent, act } from '@testing-library/react';
import toast from '../../ui/Toast';
import { listMusicVideoProjects, renderMusicVideoProject, updateMusicVideoProject, cancelMusicVideoRender, renderMusicVideoExcerpt, deleteMusicVideoExcerpt, addMusicVideoExcerptNote, updateMusicVideoExcerptNote, deleteMusicVideoExcerptNote, getMusicVideoProject, getMusicVideoActiveRender } from '../../../services/apiMusicVideo.js';

installMusicVideoPageHooks();

describe('MusicVideo render control (#1760)', () => {
  it('enables Render and kicks off the job when a scene has a clip', async () => {
    await openProject(PROJECT_WITH_CLIP, 'review');
    const renderBtn = await screen.findByRole('button', { name: /^Render final$/ });
    expect(renderBtn).toHaveProperty('disabled', false);

    fireEvent.click(renderBtn);
    await waitFor(() => expect(renderMusicVideoProject).toHaveBeenCalledWith('mv-1', { silent: true }));
  });

  it('reloads the project when render finishes so stale render status clears and new render loads', async () => {
    const staleProject = {
      ...PROJECT_WITH_CLIP,
      renderHistoryId: 'rh-old',
      renderDependencyState: { status: 'stale', reasons: ['Scene clip changed'] },
    };
    const freshProject = {
      ...PROJECT_WITH_CLIP,
      renderHistoryId: 'rh-new',
      status: 'complete',
      renderDependencyState: { status: 'current', reasons: [] },
    };
    let currentProject = staleProject;
    getMusicVideoProject.mockImplementation(async (id) => (id === staleProject.id ? currentProject : null));
    await openProject(staleProject, 'review');
    expect(screen.getAllByText(/Final render is out of date/i).length).toBeGreaterThan(0);

    sseState.latest = null;
    currentProject = freshProject;
    fireEvent.click(screen.getByRole('button', { name: /^Render final$/ }));
    await screen.findAllByRole('button', { name: 'Cancel render' });

    sseState.latest = { type: 'complete', result: { id: 'rh-new' } };
    forceRerender();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Music video rendered'));
    await waitFor(() => expect(getMusicVideoProject).toHaveBeenCalledWith(staleProject.id, { silent: true }));
    await waitFor(() => expect(screen.queryAllByText(/Final render is out of date/i)).toHaveLength(0));
  });

  it('reserves preparation across project navigation and applies completion to the captured project', async () => {
    const other = { ...PROJECT_WITH_CLIP, id: 'mv-other', name: 'Other Project' };
    listMusicVideoProjects.mockResolvedValue([PROJECT_WITH_CLIP, other]);
    let resolveKickoff;
    renderMusicVideoProject.mockImplementationOnce(() => new Promise((resolve) => { resolveKickoff = resolve; }));
    renderMV();
    await selectProject(PROJECT_WITH_CLIP.id);
    await openStage('review');

    fireEvent.click(screen.getByRole('button', { name: /^Render final$/ }));
    expect(screen.getByText('Preparing render…')).toBeInTheDocument();
    // No job id yet, so there is nothing to stop.
    expect(screen.queryByRole('button', { name: 'Cancel render' })).not.toBeInTheDocument();
    await openStage('setup');
    expect(screen.getByLabelText('Change track')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Change track'), { target: { value: 'other-track' } });
    expect(updateMusicVideoProject).not.toHaveBeenCalled();

    await selectProject(other.id);
    await openStage('review');
    const otherRender = screen.getByRole('button', { name: 'Rendering another project…' });
    expect(otherRender).toBeDisabled();
    fireEvent.click(otherRender);
    expect(renderMusicVideoProject).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Cancel render' })).not.toBeInTheDocument();
    await openStage('setup');
    expect(screen.getByLabelText('Change track')).not.toBeDisabled();

    await act(async () => { resolveKickoff({ jobId: 'render-first' }); });
    sseState.latest = { type: 'progress', progress: 0.375 };
    await selectProject(PROJECT_WITH_CLIP.id);
    await openStage('review');
    expect(screen.getByText('Rendering 38%')).toBeInTheDocument();
    // The header offers no second render while this one is in flight — it shows the progress.
    expect(screen.getByRole('button', { name: 'Rendering… 38%' })).toBeDisabled();
    await openStage('setup');
    expect(screen.getByLabelText('Change track')).toBeDisabled();

    // A metadata frame omits progress; the final-render adapter keeps 38%.
    sseState.latest = { type: 'status', message: 'Finishing output' };
    await clickNewProject();
    await openStage('review');
    expect(screen.getByText('Rendering 38%')).toBeInTheDocument();
    await selectProject(other.id);
    sseState.latest = { type: 'complete', result: { id: 'rh-9' } };
    // The server persists the render result before it emits the terminal
    // frame; the project is read back whole when it is next opened.
    listMusicVideoProjects.mockResolvedValue([{ ...PROJECT_WITH_CLIP, renderHistoryId: 'rh-9' }, other]);
    fireEvent.change(screen.getByPlaceholderText('Project name'), { target: { value: 'Unrelated draft' } });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Music video rendered'));
    await openStage('review');
    expect(screen.queryByText(/Open in Media History/i)).not.toBeInTheDocument();
    await selectProject(PROJECT_WITH_CLIP.id);
    await openStage('review');
    expect(screen.getByText(/Open in Media History/i).closest('a')).toHaveAttribute('href', expect.stringContaining('preview=video%3Arh-9'));
  });

  it('recovers from a preparing 409 and attaches/cancels an existing render with a job id', async () => {
    renderMusicVideoProject
      .mockRejectedValueOnce(Object.assign(new Error('Render is still preparing'), { status: 409, context: { jobId: null } }))
      .mockRejectedValueOnce(Object.assign(new Error('Render already exists'), { status: 409, context: { jobId: 'existing-render' } }));
    await openProject(PROJECT_WITH_CLIP, 'review');
    fireEvent.click(screen.getByRole('button', { name: /^Render final$/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Render is still preparing'));
    expect(screen.getByRole('button', { name: /^Render final$/ })).toBeEnabled();
    await openStage('setup');
    expect(screen.getByLabelText('Change track')).toBeEnabled();
    await openStage('review');

    fireEvent.click(screen.getByRole('button', { name: /^Render final$/ }));
    // Stopping discards the partial render, so the first tap only asks.
    fireEvent.click((await screen.findAllByRole('button', { name: 'Cancel render' }))[0]);
    expect(cancelMusicVideoRender).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Stop the render' }));
    expect(cancelMusicVideoRender).toHaveBeenCalledWith('existing-render', { silent: true });
    await waitFor(() => expect(screen.getAllByText('Stopping…').length).toBeGreaterThan(0));
    expect(toast.error).toHaveBeenCalledTimes(1);
    sseState.latest = { type: 'canceled' };
    forceRerender();
    expect(toast.info).toHaveBeenCalledWith('Render cancelled');
    // A cancelled render says nothing about the project's status: the page asks the server (#9940).
    await waitFor(() => expect(getMusicVideoProject).toHaveBeenCalledWith('mv-1', { silent: true }));
    expect(screen.getByRole('button', { name: /^Render final$/ })).toBeEnabled();
  });

  it('attributes a render failure after navigation and releases the slot after a dropped stream', async () => {
    const other = { ...PROJECT_WITH_CLIP, id: 'mv-other', name: 'Other Project' };
    listMusicVideoProjects.mockResolvedValue([PROJECT_WITH_CLIP, other]);
    renderMV();
    await selectProject(PROJECT_WITH_CLIP.id);
    await openStage('review');
    fireEvent.click(screen.getByRole('button', { name: /^Render final$/ }));
    await screen.findAllByRole('button', { name: 'Cancel render' });
    await selectProject(other.id);
    await openStage('review');
    sseState.latest = { type: 'error', error: 'Renderer stopped' };
    await clickNewProject();
    expect(toast.error).toHaveBeenCalledWith('Renderer stopped');
    // The picker shows only the project name: no status word or shot counts. The failure stays on mv-1.
    const picker = screen.getByLabelText('Project');
    expect(picker.querySelector('option[value="mv-1"]').textContent).toBe(PROJECT_WITH_CLIP.name);
    expect(picker.querySelector('option[value="mv-other"]').textContent).toBe(other.name);
    expect(screen.queryByText('Renderer stopped')).not.toBeInTheDocument();
    await selectProject(PROJECT_WITH_CLIP.id);
    await openStage('review');
    expect(screen.getByText('Renderer stopped')).toBeInTheDocument();
    await openStage('compose');
    expect(screen.getByText('Renderer stopped')).toBeInTheDocument();
    await selectProject(other.id);
    await openStage('review');


    sseState.latest = null;
    fireEvent.click(screen.getByRole('button', { name: /^Render final$/ }));
    await screen.findAllByRole('button', { name: 'Cancel render' });
    sseState.latest = { type: 'progress', progress: 0.4 };
    fireEvent.change(screen.getByPlaceholderText('Project name'), { target: { value: 'Draft' } });
    sseState.closed = true;
    fireEvent.change(screen.getByPlaceholderText('Project name'), { target: { value: 'Draft updated' } });
    expect(toast.info).toHaveBeenCalledWith('Lost connection to the render — check Media History for the result');
    await waitFor(() => expect(getMusicVideoProject).toHaveBeenCalledWith('mv-other', { silent: true }));
    expect(screen.getByRole('button', { name: /^Render final$/ })).toBeEnabled();
  });

  it('re-attaches a live final render on load without a Render click (#9940)', async () => {
    getMusicVideoActiveRender.mockResolvedValue({ jobId: 'render-live' });
    sseState.latest = { type: 'progress', progress: 0.5 };
    await openProject({ ...PROJECT_WITH_CLIP, status: 'rendering' }, 'review');
    await screen.findAllByRole('button', { name: 'Cancel render' });
    await waitFor(() => expect(screen.getByText('Rendering 50%')).toBeInTheDocument());
    expect(getMusicVideoActiveRender).toHaveBeenCalledWith('mv-1', { silent: true });
    // A page load only READS the render — it never starts one.
    expect(renderMusicVideoProject).not.toHaveBeenCalled();
    // It is on screen, so the header does not flag it as an unwatched render.
    expect(screen.queryByRole('button', { name: 'Reattach to the final render' })).not.toBeInTheDocument();
  });

  it('flags a rendering project nobody is watching and reattaches on request (#9940)', async () => {
    getMusicVideoActiveRender.mockResolvedValueOnce({ jobId: null }).mockResolvedValueOnce({ jobId: 'render-late' });
    sseState.latest = { type: 'progress', progress: 0.25 };
    await openProject({ ...PROJECT_WITH_CLIP, status: 'rendering' }, 'review');
    const reattach = await screen.findByRole('button', { name: 'Reattach to the final render' });
    fireEvent.click(reattach);
    await screen.findAllByRole('button', { name: 'Cancel render' });
    await waitFor(() => expect(screen.getByText('Rendering 25%')).toBeInTheDocument());
    expect(renderMusicVideoProject).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reattach to the final render' })).not.toBeInTheDocument());
  });

  it('disables Render when no scene has a generated clip', async () => {
    await openProject(PROJECT_NO_CLIP, 'review');
    const renderBtn = await screen.findByRole('button', { name: /^Render final$/ });
    expect(renderBtn).toHaveProperty('disabled', true);
  });

  it('keeps full-quality and sharing controls together in the final render section', async () => {
    await openProject({ ...PROJECT_WITH_CLIP, renderHistoryId: 'rh-9' }, 'review');
    const fullQuality = await screen.findByRole('link', { name: /Download MP4/i });
    const sharing = await screen.findByRole('button', { name: 'Prepare sharing copy' });
    const section = fullQuality.closest('#mv-final-video');
    expect(section).toHaveAccessibleName('Final render');
    expect(section).toContainElement(sharing);
    expect(sharing).toHaveClass('min-h-[44px]');
    const link = await screen.findByText(/Open in Media History/i);
    // Media History matches video items by their `video:<id>` key via ?preview=.
    expect(link.closest('a').getAttribute('href')).toContain('preview=video%3Arh-9');
  });
});

describe('MusicVideo draft excerpt render (#8986)', () => {
  it('kicks off an excerpt render with the typed range and shows progress', async () => {
    await openProject(PROJECT_WITH_CLIP, 'review');
    fireEvent.change(screen.getByLabelText('Start (sec)'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('End (sec)'), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: /Render excerpt/i }));
    await waitFor(() => expect(renderMusicVideoExcerpt).toHaveBeenCalledWith('mv-1', { startSec: 10, endSec: 20 }, { silent: true }));
    await settle(); // let the resolved kickoff's jobId land before feeding the SSE frame

    sseState.latest = { type: 'progress', progress: 0.5 };
    // The mocked useSseProgress hook returns the shared, directly-mutated
    // `sseState` object rather than its own React state, so nothing re-renders
    // the component until something else does — force one (mirrors the
    // existing render-job tests' use of this same mock).
    forceRerender();
    await screen.findByText(/Rendering draft — 50%/);
  });

  it('reloads the project on a completed excerpt render and shows the player + contact sheet + notes', async () => {
    getMusicVideoProject.mockResolvedValue({
      ...PROJECT_WITH_CLIP,
      excerpts: [{
        id: 'mve-1', startSec: 10, endSec: 20, status: 'complete',
        filename: 'excerpt-1.mp4', contactSheetFilename: 'excerpt-1-sheet.png', error: null,
        notes: [{ id: 'mvn-1', atSec: 3, note: 'lip-sync drifts here', verdict: null }],
      }],
    });
    await openProject(PROJECT_WITH_CLIP, 'review');
    fireEvent.click(screen.getByRole('button', { name: /Render excerpt/i }));
    await waitFor(() => expect(renderMusicVideoExcerpt).toHaveBeenCalled());
    await settle();
    sseState.latest = { type: 'complete', result: { excerptId: 'mve-1', filename: 'excerpt-1.mp4' } };
    forceRerender();

    await screen.findByLabelText(/Play excerpt/i);
    expect(screen.getByText('lip-sync drifts here')).toBeInTheDocument();
    const contactSheet = await screen.findByAltText(/contact sheet/i);
    expect(contactSheet.getAttribute('src')).toBe('/data/video-thumbnails/excerpt-1-sheet.png');
  });

  it('adds, edits and removes a review note against the excerpt', async () => {
    const project = {
      ...PROJECT_WITH_CLIP,
      excerpts: [{
        id: 'mve-1', startSec: 10, endSec: 20, status: 'complete',
        filename: 'excerpt-1.mp4', contactSheetFilename: null, error: null, notes: [],
      }],
    };
    addMusicVideoExcerptNote.mockResolvedValue({
      project: { ...project, excerpts: [{ ...project.excerpts[0], notes: [{ id: 'mvn-1', atSec: 0, note: 'looks great', verdict: null }] }] },
      note: { id: 'mvn-1', atSec: 0, note: 'looks great', verdict: null },
    });
    await openProject(project, 'review');

    fireEvent.change(screen.getByLabelText('New review note'), { target: { value: 'looks great' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(addMusicVideoExcerptNote).toHaveBeenCalledWith('mv-1', 'mve-1', { atSec: 0, note: 'looks great' }, { silent: true }));
    await screen.findByText('looks great');

    updateMusicVideoExcerptNote.mockResolvedValue({
      project: { ...project, excerpts: [{ ...project.excerpts[0], notes: [{ id: 'mvn-1', atSec: 0, note: 'looks great', verdict: 'approved' }] }] },
      note: { id: 'mvn-1', atSec: 0, note: 'looks great', verdict: 'approved' },
    });
    // A note can render before the add action clears its in-flight gate.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Looks good' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Looks good' }));
    await waitFor(() => expect(updateMusicVideoExcerptNote).toHaveBeenCalledWith('mv-1', 'mve-1', 'mvn-1', { verdict: 'approved' }, { silent: true }));

    deleteMusicVideoExcerptNote.mockResolvedValue({ ...project, excerpts: [{ ...project.excerpts[0], notes: [] }] });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete note' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Delete note' }));
    await waitFor(() => expect(deleteMusicVideoExcerptNote).toHaveBeenCalledWith('mv-1', 'mve-1', 'mvn-1', { silent: true }));
    await waitFor(() => expect(screen.queryByText('looks great')).not.toBeInTheDocument());
  });

  it('deletes a completed excerpt', async () => {
    const project = {
      ...PROJECT_WITH_CLIP,
      excerpts: [{ id: 'mve-1', startSec: 10, endSec: 20, status: 'complete', filename: 'excerpt-1.mp4', contactSheetFilename: null, error: null, notes: [] }],
    };
    deleteMusicVideoExcerpt.mockResolvedValue({ ...project, excerpts: [] });
    await openProject(project, 'review');
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
    await waitFor(() => expect(deleteMusicVideoExcerpt).toHaveBeenCalledWith('mv-1', 'mve-1', { silent: true }));
    await waitFor(() => expect(screen.queryByLabelText(/Play excerpt/i)).not.toBeInTheDocument());
  });
});
