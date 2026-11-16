/**
 * Music Video page suite for the Storyboard step container (`usePlanStageWiring`): the shot planner, the autopilot kickoff and the autonomous run.
 * Drives the real page through the shared scaffold in `test/musicVideoPageMocks.jsx`.
 */
import { describe, it, expect } from 'vitest';
// The scaffold registers the mocks, so it loads before any mocked module.
import {
  PROJECT_WITH_CLIP,
  PROJECT_NO_CLIP,
  feedbackCalls,
  pushSocket,
  PROJECT_ANALYZED,
  MV_ROUTES,
  renderMV,
  settle,
  openSettings,
  closeSettings,
  openStage,
  openProject,
  openCreateForm,
  LocationProbe,
  installMusicVideoPageHooks,
  savedSceneReplies,
} from '../../../test/musicVideoPageMocks.jsx';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { getMusicVideoProject, updateMusicVideoScene, listMusicVideoProjects, createMusicVideoProject, planMusicVideoProject, updateMusicVideoProject, analyzeMusicVideoProject, importMusicVideoTrackLyrics, separateMusicVideoVocals, alignMusicVideoLyrics, linkMusicVideoCastAndSetsToCatalog, approveMusicVideoCastAndSets } from '../../../services/apiMusicVideo.js';

installMusicVideoPageHooks();

describe('MusicVideo autonomous shot planner (#1855)', () => {
  it('disables AI Plan until the track is analyzed', async () => {
    await openProject(PROJECT_NO_CLIP, 'produce');
    const planBtn = await screen.findByRole('button', { name: /AI Plan/i });
    expect(planBtn).toHaveProperty('disabled', true);
  });

  it('calls the planner and replaces the project on success', async () => {
    const plannedProject = { ...PROJECT_ANALYZED, scenes: [{ sceneId: 's1', order: 0, prompt: 'p' }] };
    planMusicVideoProject.mockResolvedValue({ project: plannedProject, scenesAdded: 1, promptsSeeded: false, promptsSkippedReason: 'no-provider' });

    await openProject({ ...PROJECT_ANALYZED, scenes: [] }, 'produce');
    const planBtn = await screen.findByRole('button', { name: /AI Plan/i });
    expect(planBtn).toHaveProperty('disabled', false);

    fireEvent.click(planBtn);
    await waitFor(() => expect(planMusicVideoProject).toHaveBeenCalledWith('mv-3', { seedPrompts: true }, { silent: true }));
  });
});

// #16210: auto-arrange PATCHes every shot; each used to reload the whole project from its own broadcast.
describe('MusicVideo auto-arrange', () => {
  // Uniquely catches an arrangement whose per-shot writes reload the project instead of applying their replies.
  it('saves each shot as this tab\'s own write and reads the project no more', async () => {
    (await import('../../../services/socket.js')).default.id = 'tab-socket';
    const board = { ...PROJECT_ANALYZED, updatedAt: '2026-01-01T00:00:00.000Z', scenes: [{ sceneId: 's1', order: 0, prompt: 'p', startSec: 0, endSec: 2 }, { sceneId: 's2', order: 1, prompt: 'q', startSec: 2, endSec: 3 }] };
    updateMusicVideoScene.mockImplementation(savedSceneReplies(board));
    await openProject(board, 'produce');
    const loaded = getMusicVideoProject.mock.calls.length;
    fireEvent.click(await screen.findByRole('button', { name: /Auto-arrange/ }));
    await waitFor(() => expect(updateMusicVideoScene).toHaveBeenCalledTimes(2));
    for (const [, , , options] of updateMusicVideoScene.mock.calls) expect(options).toEqual({ silent: true, headers: { 'X-PortOS-Origin': 'tab-socket' } });
    await settle();
    expect(getMusicVideoProject.mock.calls.length).toBe(loaded);
  });
});

describe('MusicVideo AI Plan on a board that already has scenes (#10144)', () => {
  const withScenes = { ...PROJECT_ANALYZED, scenes: [{ sceneId: 's1', order: 0, prompt: 'p' }, { sceneId: 's2', order: 1, prompt: 'q' }] };

  it('sends no plan request until the director chooses Replace or Add', async () => {
    planMusicVideoProject.mockClear();
    planMusicVideoProject.mockResolvedValue({ project: withScenes, scenesAdded: 1, promptsSeeded: false });
    await openProject(withScenes, 'produce');
    fireEvent.click(await screen.findByRole('button', { name: /AI Plan/i }));
    expect(await screen.findByRole('button', { name: /Replace 2 shots/ })).toBeTruthy();
    expect(planMusicVideoProject).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(planMusicVideoProject).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /AI Plan/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Replace 2 shots/ }));
    await waitFor(() => expect(planMusicVideoProject).toHaveBeenCalledWith(withScenes.id, { seedPrompts: true, mode: 'replace' }, { silent: true }));
  });
});

describe('MusicVideo autonomous mode setup experience', () => {
  it('opens the autonomous run from the header Autopilot button, hides the lyrics fork callout when no lyrics exist, and reflects progress in next action', async () => {
    const autoProject = {
      id: 'mv-auto-1',
      name: 'Autonomous MV',
      mode: 'autonomous',
      status: 'draft',
      trackId: null,
      uploadedAudioFilename: null,
      audioAnalysis: null,
      scenes: [],
      autonomousRun: {
        id: 'run-1',
        status: 'running',
        stage: 'lyrics',
        stages: { lyrics: { step: 'draft' } },
        output: {},
        brief: { prompt: 'A synthwave adventure' },
      },
    };
    await openProject(autoProject, 'setup');

    // The header's Autopilot button names what the run is doing and opens its panel in Project settings › Autopilot.
    fireEvent.click(screen.getByRole('button', { name: /Autonomous run: writing the lyric draft/i }));
    const runRegion = await screen.findByRole('region', { name: 'Autonomous run' });
    expect(runRegion).toBeInTheDocument();

    // No lyrics yet: the song fork callout (Project settings › Audio) stays hidden.
    fireEvent.click(screen.getByRole('tab', { name: /^Audio/ }));
    expect(screen.queryByRole('heading', { name: 'Revise lyrics & song' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Fork & revise song' })).toBeNull();
    closeSettings();

    expect(screen.queryByRole('button', { name: 'Attach a track' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Writing the lyric draft…' })).toBeDisabled();

    expect(screen.queryByText(/Approvals: 0 of 3 approved/)).toBeNull();
    expect(screen.getByText(/Autonomous run: writing the lyric draft/i)).toBeInTheDocument();
  });
});

describe('MusicVideo YouTube audio import (#1945)', () => {
  it('creates an autopilot project by default with the chosen tools, guidance and budget', async () => {
    listMusicVideoProjects.mockResolvedValue([]);
    createMusicVideoProject.mockResolvedValue({ ...PROJECT_NO_CLIP, id: 'mv-new', name: 'Auto MV', mode: 'autonomous' });
    renderMV();
    await openCreateForm();
    fireEvent.change(await screen.findByPlaceholderText('Project name'), { target: { value: 'Auto MV' } });
    fireEvent.click(screen.getByLabelText(/fal\.ai video/));
    fireEvent.change(screen.getByLabelText('Guidance'), { target: { value: ' one long take ' } });
    fireEvent.change(screen.getByLabelText('Budget cap (USD)'), { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: /Create autopilot project/ }));
    await waitFor(() => expect(createMusicVideoProject).toHaveBeenCalled());
    const [body] = createMusicVideoProject.mock.calls[0];
    expect(body).toMatchObject({ name: 'Auto MV', mode: 'autonomous', trackId: null });
    expect(body.automation).toEqual({
      tools: ['image:external', 'image:local', 'video:local', 'video:fal', 'code:render'],
      guidance: 'one long take',
      budgetUsd: 40,
      // A new brief stops for the Cast & Sets check-in unless told otherwise.
      checkins: { castAndSets: 'review' },
    });
  });

  it('autopilot kickoff analyzes the song, tries the track lyrics, then plans the shots against the brief', async () => {
    // A check-in the director already skipped does not stop the run.
    const project = { ...PROJECT_NO_CLIP, trackId: 'track-1', lyricCues: [], scenes: [], castAndSets: { status: 'skipped' }, automation: { tools: ['image:local'], guidance: 'noir', budgetUsd: null } };
    const analyzed = { ...project, audioAnalysis: PROJECT_ANALYZED.audioAnalysis, status: 'analyzed' };
    analyzeMusicVideoProject.mockResolvedValue(analyzed);
    // An instrumental track: nothing to import, so nothing to separate or align.
    importMusicVideoTrackLyrics.mockResolvedValue({ project: analyzed, imported: 0, markers: 0, skipped: 'no-track-lyrics' });
    planMusicVideoProject.mockResolvedValue({ project: analyzed, scenesAdded: 3, promptsSeeded: true });
    await openProject(project);
    await openSettings('Autopilot');
    fireEvent.click(screen.getByRole('button', { name: /Analyze & plan/ }));
    await waitFor(() => expect(planMusicVideoProject).toHaveBeenCalledWith(project.id, { seedPrompts: true }, { silent: true }));
    expect(analyzeMusicVideoProject).toHaveBeenCalledWith(project.id, { silent: true });
    expect(importMusicVideoTrackLyrics).toHaveBeenCalledWith(project.id, { mode: 'if-empty' }, { silent: true });
    expect(separateMusicVideoVocals).not.toHaveBeenCalled();
    expect(alignMusicVideoLyrics).not.toHaveBeenCalled();
  });

  it('keeps the Cast & Sets check-in for a code-first board and waits for it before planning', async () => {
    const project = { ...PROJECT_ANALYZED, trackId: null, uploadedAudioFilename: 'song.mp3', lyricCues: [], scenes: [],
      composition: { mode: 'document' }, productionPolicy: { strategy: 'code-first', maxGeneratedVideoPercent: 0 },
      automation: { tools: ['code:render'], guidance: '', budgetUsd: null, checkins: { castAndSets: 'review' } } };
    const directing = { ...project, castAndSets: { status: 'directing', revision: 1, plan: {}, images: {} } };
    linkMusicVideoCastAndSetsToCatalog.mockResolvedValue({ project: directing, stage: directing.castAndSets });
    await openProject(project);
    await openSettings('Autopilot');
    fireEvent.click(screen.getByRole('button', { name: /Analyze & plan/ }));
    // The server directs it procedurally (no image backend for a code-only brief); the run still gates on it.
    await waitFor(() => expect(linkMusicVideoCastAndSetsToCatalog).toHaveBeenCalledWith(project.id, { silent: true }));
    expect(planMusicVideoProject).not.toHaveBeenCalled();
  });

  it('autopilot stops at the Cast & Sets check-in in review mode, and Approve & continue plans', async () => {
    const project = { ...PROJECT_ANALYZED, trackId: null, uploadedAudioFilename: 'song.mp3', lyricCues: [], scenes: [], automation: { tools: ['image:codex'], guidance: '', budgetUsd: null, checkins: { castAndSets: 'review' } } };
    const directing = { ...project, castAndSets: { status: 'directing', revision: 1, plan: {}, images: {} } };
    linkMusicVideoCastAndSetsToCatalog.mockResolvedValue({ project: directing, stage: directing.castAndSets });
    const sheet = { id: 'mvd-1', kind: 'cast-sets', title: 'Cast & Sets — Nova', status: 'pending', version: 1, mimeType: 'text/html', versions: [{ version: 1, mimeType: 'text/html', createdAt: '2026-01-01T00:00:00Z' }], notes: [] };
    const reviewing = { ...project, devArtifacts: [sheet], castAndSets: { status: 'review', revision: 1, artifactId: 'mvd-1', plan: {}, images: {} } };
    const approved = { ...reviewing, castAndSets: { ...reviewing.castAndSets, status: 'approved' }, devArtifacts: [{ ...sheet, status: 'approved' }] };
    approveMusicVideoCastAndSets.mockResolvedValue({ project: approved, stage: approved.castAndSets });
    planMusicVideoProject.mockResolvedValue({ project: approved, scenesAdded: 2, promptsSeeded: true });
    await openProject(project);
    await openSettings('Autopilot');

    fireEvent.click(screen.getByRole('button', { name: /Analyze & plan/ }));
    await waitFor(() => expect(linkMusicVideoCastAndSetsToCatalog).toHaveBeenCalledWith(project.id, { silent: true }));
    await pushSocket('music-video:cast-and-sets', { projectId: project.id, project: reviewing, stage: reviewing.castAndSets });
    closeSettings();
    // Existing Cast & Sets controls still apply references; Production review separately authorizes work.
    await openStage('cast-sets');
    expect(await screen.findByText('Waiting for your check-in.')).toBeTruthy();
    await settle();
    expect(planMusicVideoProject).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Approve & continue/ }));
    await waitFor(() => expect(planMusicVideoProject).toHaveBeenCalledWith(project.id, { seedPrompts: true }, { silent: true }));
    expect(approveMusicVideoCastAndSets).toHaveBeenCalledTimes(1);
  });

  it('autopilot continues straight to the plan when the check-in auto-approves', async () => {
    const project = { ...PROJECT_ANALYZED, trackId: null, uploadedAudioFilename: 'song.mp3', lyricCues: [], scenes: [], automation: { tools: ['image:codex'], guidance: '', budgetUsd: null, checkins: { castAndSets: 'auto' } } };
    const directing = { ...project, castAndSets: { status: 'directing', revision: 1, plan: {}, images: {} } };
    linkMusicVideoCastAndSetsToCatalog.mockResolvedValue({ project: directing, stage: directing.castAndSets });
    const approved = { ...project, castAndSets: { status: 'approved', revision: 1, plan: {}, images: {} } };
    planMusicVideoProject.mockResolvedValue({ project: approved, scenesAdded: 2, promptsSeeded: true });
    await openProject(project);
    await openSettings('Autopilot');

    fireEvent.click(screen.getByRole('button', { name: /Analyze & plan/ }));
    await waitFor(() => expect(linkMusicVideoCastAndSetsToCatalog).toHaveBeenCalled());
    // Progress pushes don't release the gate; only a checkpoint does.
    await pushSocket('music-video:cast-and-sets', { projectId: project.id, project: { ...directing, castAndSets: { ...directing.castAndSets, status: 'imaging' } } });
    expect(planMusicVideoProject).not.toHaveBeenCalled();
    await pushSocket('music-video:cast-and-sets', { projectId: project.id, project: approved, stage: approved.castAndSets });
    await waitFor(() => expect(planMusicVideoProject).toHaveBeenCalledWith(project.id, { seedPrompts: true }, { silent: true }));
    expect(approveMusicVideoCastAndSets).not.toHaveBeenCalled();
  });
});

describe('MusicVideo stage tabs (#9243)', () => {
  const renderAt = (path) => render(
    <MemoryRouter initialEntries={[path]}>
      <LocationProbe />
      {MV_ROUTES}
    </MemoryRouter>,
  );

  it('opens Project settings › Autopilot at the checkpoint editor from an attention deep link', async () => {
    listMusicVideoProjects.mockResolvedValue([{ ...PROJECT_WITH_CLIP,
      autonomousRun: { id: 'auto-1', status: 'awaiting-approval', awaiting: 'lyrics', stage: 'lyrics', output: { lyrics: 'Example lyric line' }, brief: {} },
    }]);
    renderAt('/music-video/mv-1/setup?mvPanel=autopilot#mv-auto-edit');
    await screen.findByRole('heading', { level: 2, name: PROJECT_WITH_CLIP.name });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('tab', { name: /^Autopilot/ })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(document.getElementById('mv-auto-edit')).toHaveFocus());
    expect(dialog.contains(document.getElementById('mv-auto-edit'))).toBe(true);
  });

  it('lets the header Autopilot button stand in for the attention row of a run awaiting its checkpoint', async () => {
    listMusicVideoProjects.mockResolvedValue([{ ...PROJECT_WITH_CLIP,
      autonomousRun: { id: 'auto-1', status: 'awaiting-approval', awaiting: 'lyrics', stage: 'lyrics', output: { lyrics: 'Example lyric line' }, brief: {} },
    }]);
    renderAt('/music-video/mv-1/setup');
    await screen.findByRole('heading', { level: 2, name: PROJECT_WITH_CLIP.name });
    expect(screen.queryByRole('region', { name: 'Needs attention' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Autonomous run/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('tab', { name: /^Autopilot/ })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(document.getElementById('mv-auto-edit')).toHaveFocus());
  });
});

describe('stage checklist and project options', () => {
  // Uniquely catches a row left from a cut shot holding the board with no way to clear it from the checklist.
  it('lists the storyboard rows left from deleted shots by time and action, and removes them in one tap', async () => {
    const project = { ...PROJECT_ANALYZED, scenes: [{ sceneId: 's-a', order: 0, label: 'Drummer', startSec: 0, endSec: 4 }],
      productionReview: { draft: { storyboard: [] } },
      productionReadiness: { readyForProduction: false, basis: {}, art: { approved: true, problems: [] },
        storyboard: { approved: false, problems: ['Remove 2 storyboard rows left from deleted shots.'],
          staleRows: [{ id: null, sceneId: 'gone-1', startSec: 62.5, endSec: 64.25, action: 'A figure skids across the floor' },
            { id: null, sceneId: 'gone-2', startSec: 70, endSec: 71, action: '' }] }, proof: { approved: false, problems: [] } } };
    await openProject(project, 'board');
    const checklist = screen.getByRole('region', { name: 'What this step needs' });
    expect(checklist).toHaveTextContent('Rows from deleted shots');
    expect(checklist).toHaveTextContent('1:02.50–1:04.25 · A figure skids across the floor');
    expect(checklist).toHaveTextContent('1:10.00–1:11.00');
    expect(checklist).not.toHaveTextContent('Remove 2 storyboard rows');
    fireEvent.click(within(checklist).getByRole('button', { name: /Remove all 2/ }));
    expect(feedbackCalls.removeStaleRows).toHaveBeenCalledWith();
  });

  it('shows the project options in Project settings and saves a media mode and an autopilot tool change', async () => {
    const project = { ...PROJECT_ANALYZED, mediaMode: 'code-images-video',
      automation: { tools: ['image:local'], guidance: 'g', budgetUsd: 5, checkins: { castAndSets: 'review' } } };
    updateMusicVideoProject.mockImplementation((_id, patch) => Promise.resolve({ ...project, ...patch }));
    await openProject(project, 'setup');
    // The Song step holds only the song; the project options are one header button away.
    expect(screen.queryByLabelText('Design and composition media')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Project settings' }));
    const drawer = await screen.findByRole('dialog', { name: 'Project settings' });
    expect(within(drawer).getByRole('tab', { name: /^Project/ })).toHaveAttribute('aria-selected', 'true');
    expect(within(drawer).getByLabelText('Design and composition media')).toHaveValue('code-images-video');
    fireEvent.change(screen.getByLabelText('Design and composition media'), { target: { value: 'code-only' } });
    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenCalledWith(project.id, { mediaMode: 'code-only' }, expect.objectContaining({ edit: true })));
    fireEvent.click(screen.getByLabelText('Local video gen'));
    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenCalledWith(project.id, expect.objectContaining({
      mode: 'autonomous', automation: expect.objectContaining({ tools: ['image:local', 'video:local'], guidance: 'g', budgetUsd: 5 }),
    }), { silent: true }));
  });
});

describe('Autopilot collapsed review summary', () => {
  it('shows the current blocker on the run while retaining the historical error in run details', async () => {
    const error = 'Review and approve the current art direction first.';
    const project = { ...PROJECT_ANALYZED, autonomousRun: { id: 'history-run', status: 'needs-human', stage: 'produce',
      error, errorCode: 'MUSIC_VIDEO_APPROVAL_REQUIRED', brief: { autoApprove: [] }, stages: {}, output: {} },
      productionReadiness: { basis: {}, art: { approved: true, problems: [] }, storyboard: { approved: false, problems: ['Approve the current lyric-timed storyboard.'] },
        proof: { approved: false, problems: [] } } };
    listMusicVideoProjects.mockResolvedValue([project]);
    render(<MemoryRouter initialEntries={['/music-video/mv-3/review']}>{MV_ROUTES}</MemoryRouter>);
    // Collapsed, the run is the header's Autopilot button: it never repeats the stale error.
    const autopilot = await screen.findByRole('button', { name: /^(Autopilot|Autonomous run)/ });
    expect(autopilot.textContent).not.toContain(error);
    fireEvent.click(autopilot);
    const drawer = await screen.findByRole('dialog', { name: 'Project settings' });
    const run = within(drawer).getByRole('region', { name: 'Autonomous run' });
    expect(within(run).getByText(`Historical stop reason: ${error}`)).toBeInTheDocument();
    const current = within(run).getByText(/Approve the current lyric-timed storyboard/);
    expect(current.textContent).not.toContain(error);
  });
});
