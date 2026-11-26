/**
 * Renderer and editing cases from the Music Video page suite for `useProduceStageWiring`.
 * Drives the real page through the shared scaffold in `test/musicVideoPageMocks.jsx`.
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
// The scaffold registers the mocks, so it loads before any mocked module.
import {
  PROJECT_WITH_CLIP,
  PROJECT_NO_CLIP,
  feedbackCalls,
  pushSocket,
  PROJECT_ANALYZED,
  MV_ROUTES,
  renderMV,
  openStage,
  openProject,
  LocationProbe,
  showFrames,
  installMusicVideoPageHooks,
  editResult,
  savedSceneReplies,
} from '../../../test/musicVideoPageMocks.jsx';
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import { findEnabledByRole } from '../../../test/enabledBarrier.js';
import { MemoryRouter } from 'react-router';
import toast from '../../ui/Toast';
import { createTestPhaseDiagnostics } from '../../../../../lib/testPhaseDiagnostics.js';
import { listMusicVideoProjects, renderMusicVideoProject, updateMusicVideoProject, updateMusicVideoScene, addMusicVideoSceneTake, getMusicVideoProject, } from '../../../services/apiMusicVideo.js';
import { getVideoHistoryItem, } from '../../../services/apiImageVideo.js';
import { problem, withProblems } from '../../../test/musicVideoProblems.js';
import { warmSceneCard } from '../sceneCardTestWarmup.jsx';
beforeAll(warmSceneCard, 30000);

installMusicVideoPageHooks();

// Stage interaction tests can enter through the real route. This avoids mounting
// the default step and scanning its DOM for the picker and stage tabs on every run.
const renderProjectStage = async (project, stage, sceneId) => {
  listMusicVideoProjects.mockResolvedValue([project]);
  const path = `/music-video/${project.id}/${stage}${sceneId ? `/scene/${sceneId}` : ''}`;
  await act(async () => { renderMV(path); });
};

describe('MusicVideo clip timing saves', () => {
  it('previews each nudge immediately and coalesces unsent speed and offset changes while a save is slow', async () => {
    const project = {
      ...PROJECT_WITH_CLIP,
      scenes: [{ ...PROJECT_WITH_CLIP.scenes[0], startSec: 0, endSec: 4, beatAligned: true }],
    };
    const reply = savedSceneReplies(project);
    let finishFirst;
    let finishNext;
    updateMusicVideoScene
      .mockImplementationOnce((...args) => new Promise((resolve) => { finishFirst = () => resolve(reply(...args)); }))
      .mockImplementationOnce((...args) => new Promise((resolve) => { finishNext = () => resolve(reply(...args)); }));
    await openProject(project, 'produce');
    const faster = await screen.findByRole('button', { name: 'Play the clip one fps faster' });
    const further = screen.getByRole('button', { name: 'Start the clip one frame further in' });
    fireEvent.click(faster);
    fireEvent.click(faster);
    fireEvent.click(further);
    fireEvent.click(faster);
    fireEvent.click(further);

    expect(screen.getByLabelText('Speed')).toHaveValue(3);
    expect(screen.getByLabelText('Offset')).toHaveValue(2);
    expect(updateMusicVideoScene).toHaveBeenCalledTimes(1);
    expect(updateMusicVideoScene).toHaveBeenLastCalledWith('mv-1', 's1', { speedFps: 1 }, { silent: true });
    expect(screen.getByRole('button', { name: 'Prepare clip with music' })).toBeDisabled();

    await act(async () => finishFirst());
    expect(screen.getByLabelText('Speed')).toHaveValue(3);
    expect(screen.getByLabelText('Offset')).toHaveValue(2);
    expect(updateMusicVideoScene).toHaveBeenCalledTimes(2);
    expect(updateMusicVideoScene).toHaveBeenLastCalledWith('mv-1', 's1', { speedFps: 3, offsetFrames: 2 }, { silent: true });
    expect(screen.getByRole('button', { name: 'Prepare clip with music' })).toBeDisabled();

    await act(async () => finishNext());
    expect(screen.getByLabelText('Speed')).toHaveValue(3);
    expect(screen.getByLabelText('Offset')).toHaveValue(2);
    expect(screen.getByRole('button', { name: 'Prepare clip with music' })).toBeEnabled();
  });
});

describe('MusicVideo musical timeline', () => {
  it('renders waveform, beat evidence, legend, and the detected rhythmic window', async () => {
    await openProject(PROJECT_ANALYZED, 'produce');
    expect(screen.getByRole('img', { name: /audio waveform overview with 4 beats and 1 downbeats/i })).toBeTruthy();
    expect(screen.getByText(/waveform, sections, and 4\/4 beat-grid assumption/i)).toBeTruthy();
    expect(screen.getByText(/detected near 0:40\.00–1:10\.00/i)).toBeTruthy();
    expect(screen.getByLabelText('Timeline legend')).toBeTruthy();
  });
});

describe('MusicVideo lyrics and shot coverage (#8964)', () => {
  it('flags a non-looping shot longer than its clip and trims it; a legacy scene is left alone', async () => {
    // The scene cards' players; the preview dock's storyboard animatic plays the shot's clip on its own.
    const cardPlayers = () => [...document.body.querySelectorAll('video[src^="/data/videos/h"]')]
      .filter((video) => !video.closest('figure[aria-label="Storyboard animatic"]'));
    const project = {
      ...PROJECT_WITH_CLIP,
      scenes: [
        { sceneId: 's1', order: 0, prompt: 'a', referenceImageId: 'img1', videoHistoryId: 'h1', beatAligned: true, startSec: 2, endSec: 12, loop: false, lyricText: 'first line' },
        { sceneId: 's2', order: 1, prompt: 'b', referenceImageId: 'img1', videoHistoryId: 'h2', beatAligned: true, startSec: 12, endSec: 30 },
      ],
    };
    updateMusicVideoScene.mockImplementation(savedSceneReplies(project));
    await renderProjectStage(project, 'produce', 's1');
    // The card's summary row and its editor both quote the lyric.
    expect(screen.getAllByText(/first line/).length).toBeGreaterThan(0);

    const players = cardPlayers();
    expect(players).toHaveLength(1); // only the selected shot owns a player
    for (const player of players) {
      Object.defineProperty(player, 'duration', { configurable: true, value: 5 });
      fireEvent.loadedMetadata(player);
    }
    const alerts = await screen.findAllByRole('alert');
    expect(alerts).toHaveLength(1); // the legacy s2 keeps looping to fill its span
    expect(alerts[0].textContent).toContain('Shot runs 10.0s but its clip is 5.0s');

    fireEvent.click(within(alerts[0]).getByRole('button', { name: 'Trim to clip' }));
    await waitFor(() => expect(updateMusicVideoScene).toHaveBeenCalledWith('mv-1', 's1', { endSec: 7 }, { silent: true }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Open Shot 2' })));
    const legacyPlayers = cardPlayers();
    expect(legacyPlayers).toHaveLength(1);
    expect(legacyPlayers[0]).toHaveAttribute('src', '/data/videos/h2.mp4');
    Object.defineProperty(legacyPlayers[0], 'duration', { configurable: true, value: 5 });
    fireEvent.loadedMetadata(legacyPlayers[0]);
    expect(screen.queryByRole('alert')).toBeNull(); // legacy shots still loop to fill their span
  });
});

describe('MusicVideo typography composition (#8984)', () => {
  it('seeds text cues from the timed lyrics, switches to a composed render, and saves an edited cue whole', async () => {
    const lyricCues = [
      { id: 'lc-1', text: 'first line', startSec: 1, endSec: 3 },
      { id: 'lc-2', text: 'untimed line', startSec: null, endSec: null },
    ];
    let saves = 0;
    updateMusicVideoProject.mockImplementation(async (_id, patch) => ({ edit: editResult([], [], { updatedAt: `2026-01-01T00:00:0${++saves}.000Z`, project: patch }) }));
    await openProject({ ...PROJECT_ANALYZED, lyricCues }, 'compose');

    fireEvent.click(await screen.findByRole('button', { name: /Copy timed lyrics \(1\)/ }));
    const text = await screen.findByLabelText('Text cue 1 text');
    expect(text).toHaveValue('first line');
    expect(screen.queryByLabelText('Text cue 2 text')).toBeNull();
    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenLastCalledWith('mv-3', {
      composition: expect.objectContaining({ mode: 'concat', textCues: [expect.objectContaining({ text: 'first line', startSec: 1, endSec: 3, template: 'fade' })] }),
    }, { silent: true, edit: true }));

    expect(document.getElementById('mv-typo-mode')).toBeNull(); // render style is chosen in Setup only
    fireEvent.change(screen.getByLabelText('Text cue 1 motion'), { target: { value: 'typewriter' } });
    fireEvent.change(text, { target: { value: 'first line, typed' } });
    fireEvent.blur(text);
    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenLastCalledWith('mv-3', {
      composition: expect.objectContaining({
        mode: 'concat',
        textCues: [expect.objectContaining({ text: 'first line, typed', template: 'typewriter' })],
      }),
    }, { silent: true, edit: true }));
  });
});

it('reloads persisted shots when a one-tap render repair fails partway through', async () => {
  const first = { ...PROJECT_WITH_CLIP.scenes[0], startSec: 0, endSec: 4 };
  const second = { ...first, sceneId: 's2', order: 1, startSec: 4, endSec: 8 };
  const project = { ...PROJECT_WITH_CLIP, scenes: [first, second] };
  let persisted = project;
  getMusicVideoProject.mockImplementation(async () => persisted);
  renderMusicVideoProject.mockRejectedValueOnce(Object.assign(new Error('Clips are too short'), {
    code: 'INSUFFICIENT_CLIP_COVERAGE',
    context: { shortfalls: [{ sceneId: 's1' }, { sceneId: 's2' }] },
  }));
  updateMusicVideoScene.mockImplementationOnce(async (_id, _sceneId, patch) => {
    const scenes = [{ ...first, ...patch }, second];
    const updatedAt = '2026-01-01T00:00:01.000Z';
    persisted = { ...project, scenes, updatedAt };
    return { edit: editResult(scenes, ['s1'], { updatedAt }) };
  }).mockRejectedValueOnce(new Error('Second shot could not be saved'));

  await openProject(project, 'review');
  fireEvent.click(await findEnabledByRole('button', { name: 'Render final' }));
  const repair = await screen.findByRole('button', { name: 'Hold the last frame on these 2' });
  getMusicVideoProject.mockClear();
  fireEvent.click(repair);

  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Second shot could not be saved'));
  expect(updateMusicVideoScene).toHaveBeenNthCalledWith(1, project.id, 's1', { holdLastFrame: true }, expect.anything());
  expect(updateMusicVideoScene).toHaveBeenNthCalledWith(2, project.id, 's2', { holdLastFrame: true }, expect.anything());
  await waitFor(() => expect(getMusicVideoProject).toHaveBeenCalledWith(project.id, { silent: true }));
  await openStage('produce');
  fireEvent.click(await screen.findByRole('button', { name: 'Open Shot 1' }));
  expect(await screen.findByRole('checkbox', { name: /Hold last frame/ })).toBeChecked();
  fireEvent.click(await screen.findByRole('button', { name: 'Open Shot 2' }));
  await waitFor(() => expect(screen.getByRole('checkbox', { name: /Hold last frame/ })).not.toBeChecked());
});

describe('MusicVideo media lightbox (#3718)', () => {
  it('opens the lightbox from a reference-frame thumbnail click', async () => {
    await renderProjectStage(PROJECT_WITH_CLIP, 'produce', 's1');
    await showFrames();
    fireEvent.click(await screen.findByRole('button', { name: 'View scene 1 reference frame full size' }));
    const dialog = await screen.findByRole('dialog', { name: /Media viewer/i });
    expect(dialog).toBeTruthy();
    // Image uses previewUrl (/data/images/<id>); img may be MediaImage-wrapped.
    expect(dialog.querySelector('img')?.getAttribute('src') || dialog.innerHTML)
      .toMatch(/\/data\/images\/img1/);
  });

  it('opens the lightbox from an end-frame thumbnail click', async () => {
    await renderProjectStage({ ...PROJECT_WITH_CLIP, scenes: [{ ...PROJECT_WITH_CLIP.scenes[0], endImageId: 'end1' }] }, 'produce', 's1');
    await showFrames();
    fireEvent.click(await screen.findByRole('button', { name: 'View scene 1 end frame full size' }));
    const dialog = await screen.findByRole('dialog', { name: /Media viewer/i });
    expect(dialog.querySelector('img')?.getAttribute('src') || dialog.innerHTML).toMatch(/\/data\/images\/end1/);
  });

  it('opens the lightbox from a scene-clip expand control without hijacking play/pause', async ({ onTestFailed }) => {
    const phase = createTestPhaseDiagnostics(onTestFailed);
    await phase('render-selected-shot', () => renderProjectStage(PROJECT_WITH_CLIP, 'produce', 's1'));
    // Inline thumb keeps its own controls attribute for native play/pause.
    const inlineVideo = document.querySelector('video[src="/data/videos/h1.mp4"]');
    expect(inlineVideo).toBeTruthy();
    expect(inlineVideo.hasAttribute('controls')).toBe(true);

    const expand = await phase('find-expand-control', () => screen.findByRole('button', { name: 'View scene 1 clip full size' }));
    fireEvent.click(expand);
    const dialog = await phase('viewer-dialog', () => screen.findByRole('dialog', { name: /Media viewer/i }));
    const lightboxVideo = dialog.querySelector('video');
    expect(lightboxVideo?.getAttribute('src')).toBe('/data/videos/h1.mp4');
  });

  it('opens the final render from the resolved filename, not the history-id reconstruction', async () => {
    // getVideoHistoryItem is mocked → { id: 'rh-9', filename: 'final.mp4' }; the
    // final-render id is NOT its filename stem, so /data/videos/rh-9.mp4 404s.
    await renderProjectStage({ ...PROJECT_WITH_CLIP, renderHistoryId: 'rh-9' }, 'review');
    const expand = await screen.findByRole('button', { name: 'View final video full size' });
    fireEvent.click(expand);
    const dialog = await screen.findByRole('dialog', { name: /Media viewer/i });
    const lightboxVideo = dialog.querySelector('video');
    expect(lightboxVideo?.getAttribute('src')).toBe('/data/videos/final.mp4');
    expect(lightboxVideo?.getAttribute('src')).not.toBe('/data/videos/rh-9.mp4');
  });

  it('shows the styled prompt the renderer was sent, not the board label', async () => {
    // The scene's own prompt is 'a'; `useMusicVideoSceneMedia` appends the
    // project's concept style before rendering, so the board label is wording
    // the image model never saw. The sidecar is the only record of the real
    // one — and it also carries the `cleanedFrom` lineage the hand-rolled item
    // shape used to drop.
    await renderProjectStage(PROJECT_WITH_CLIP, 'produce', 's1');
    await showFrames();
    fireEvent.click(await screen.findByRole('button', { name: 'View scene 1 reference frame full size' }));
    const dialog = await screen.findByRole('dialog', { name: /Media viewer/i });
    await waitFor(() => {
      expect(dialog.querySelector('img')?.getAttribute('alt')).toBe('a wide desert shot, neon noir');
    });
  });

  it('opens Cast & Sets references and their inputs in the lightbox, not the raw file', async () => {
    const castAndSets = {
      revision: 1, status: 'review',
      plan: { lead: { key: 'lead', label: 'Lead', prompt: 'Lead portrait', deps: [], refKeys: [], moodRefs: true } },
      images: { lead: { status: 'done', imageId: 'lead.png', submittedPrompt: 'Lead portrait', submittedRevision: 1, submittedReferences: [{ kind: 'image-ref', filename: 'mood.png' }] } },
      moodImages: [{ kind: 'image-ref', filename: 'mood.png' }],
    };
    await renderProjectStage({ ...PROJECT_NO_CLIP, castAndSets }, 'cast-sets');
    const card = within(await screen.findByRole('article', { name: 'Lead' }));
    expect(card.queryByRole('link')).toBeNull();
    fireEvent.click(card.getByRole('button', { name: 'Preview Lead' }));
    let dialog = await screen.findByRole('dialog', { name: /Media viewer/i });
    expect(dialog.innerHTML).toMatch(/\/data\/images\/lead\.png/);
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Media viewer/i })).toBeNull());
    fireEvent.click(card.getByRole('button', { name: 'Lead input: mood.png' }));
    dialog = await screen.findByRole('dialog', { name: /Media viewer/i });
    expect(dialog.innerHTML).toMatch(/\/data\/image-refs\/mood\.png/);
  });

  it('opens the lightbox from a ?preview= deep link on mount', async () => {
    listMusicVideoProjects.mockResolvedValue([PROJECT_WITH_CLIP]);
    await act(async () => { renderMV('/music-video/mv-1?preview=image%3Aimg1'); });
    expect(screen.getByRole('heading', { level: 2, name: PROJECT_WITH_CLIP.name })).toBeInTheDocument();
    const dialog = await screen.findByRole('dialog', { name: /Media viewer/i });
    expect(dialog.getAttribute('aria-label')).toMatch(/img1|image:img1/);
  });
});

describe('MusicVideo per-scene clip import (#8978)', () => {
  it('imports a picked video-history clip as a candidate take for the scene, filling the empty slot', async () => {
    addMusicVideoSceneTake.mockResolvedValueOnce({
      scene: { ...PROJECT_NO_CLIP.scenes[0], videoHistoryId: 'rh-9', takes: [{ takeId: 't1', kind: 'video', assetId: 'rh-9', status: 'candidate' }] },
    });
    await openProject(PROJECT_NO_CLIP, 'produce');

    fireEvent.click(await screen.findByRole('button', { name: /^Import clip take$/ }));
    const dialog = await screen.findByRole('dialog', { name: /Pick a video from your gallery/i });
    const galleryItem = await within(dialog).findByText('(no prompt)');
    fireEvent.click(galleryItem.closest('.bg-port-card').querySelector('button'));

    await waitFor(() => expect(addMusicVideoSceneTake).toHaveBeenCalledWith(
      'mv-2', 's1', { kind: 'video', assetId: 'rh-9', source: 'imported' }, { silent: true },
    ));
  });
});

describe('MusicVideo scene clip non-MP4 playback (#8978)', () => {
  afterEach(() => {
    // Restore the file-level default so later tests keep seeing the 404
    // (reconstruction-fallback) behavior for 'h1'/'h2'.
    getVideoHistoryItem.mockImplementation((id) => (id === 'rh-9'
      ? Promise.resolve({ id: 'rh-9', filename: 'final.mp4' })
      : Promise.reject(Object.assign(new Error('Not found'), { status: 404 }))));
  });

  it('resolves the clip\'s real stored filename for inline playback instead of assuming .mp4', async () => {
    getVideoHistoryItem.mockImplementation((id) => (id === 'h1'
      ? Promise.resolve({ id: 'h1', filename: 'h1.mov' })
      : Promise.reject(Object.assign(new Error('Not found'), { status: 404 }))));
    await renderProjectStage(PROJECT_WITH_CLIP, 'produce', 's1');

    await waitFor(() => expect(document.querySelector('video[src="/data/videos/h1.mov"]')).toBeTruthy());
    expect(document.querySelector('video[src="/data/videos/h1.mp4"]')).toBeNull();
  });
});

describe('MusicVideo stage tabs (#9243)', () => {
  const renderAt = (path) => render(
    <MemoryRouter initialEntries={[path]}>
      <LocationProbe />
      {MV_ROUTES}
    </MemoryRouter>,
  );

  // Uniquely catches the shot list losing its read-through: shots in song order with their lyric, action and own problems, opening each shot.
  it('checks every shot on Shots in song order with its problems on its row, and opens a shot', async () => {
    listMusicVideoProjects.mockResolvedValue([{ ...PROJECT_WITH_CLIP,
      audioAnalysis: { ...PROJECT_ANALYZED.audioAnalysis, durationSec: 12 },
      scenes: [
        { sceneId: 's2', order: 1, startSec: 4, endSec: 12, lyricText: 'Second example line', visualIntent: 'Wide on the rink' },
        { sceneId: 's1', order: 0, startSec: 0, endSec: 4, lyricText: '', visualIntent: 'Close on the skates', panelArt: 'panel-a.png', referenceImageId: 'frame-a.png' },
        { sceneId: 's3', order: 2, startSec: null, endSec: null, label: 'New shot' },
      ],
      productionReadiness: { readyForProduction: false, basis: {}, art: { approved: true, problems: [] }, proof: { approved: false, problems: [] },
        storyboard: { approved: false, problems: [], coverage: [], incompleteShots: [{ sceneId: 's3', missing: ['timing'] }],
          shots: [{ sceneId: 's1', action: 'Close on the skates', camera: 'Low dolly' }],
          lyricAnchors: [{ sceneId: 's2', sung: ['Second example line'], anchored: [] }] } },
    }]);
    renderAt('/music-video/mv-1/produce');
    await screen.findByRole('heading', { level: 2, name: PROJECT_WITH_CLIP.name });
    const list = screen.getByRole('region', { name: 'Shot list' });
    const rows = within(list).getAllByRole('button', { name: /^Edit / });
    // A new shot with no timing yet stays listed, last and unnumbered, with its problem.
    expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual(['Edit Shot 1', 'Edit Shot 2', 'Edit untimed shot New shot']);
    expect(rows[2]).toHaveTextContent('Untimed');
    expect(rows[2]).toHaveTextContent('Missing timing');
    expect(rows[0]).toHaveTextContent('Instrumental');
    // The storyboard panel, not the shot's frame: Plan checks the board.
    expect(rows[0].querySelector('img')).toHaveAttribute('src', '/data/images/panel-a.png');
    expect(rows[0]).toHaveTextContent('Shot 1 · Low dolly · Close on the skates');
    expect(rows[1]).toHaveTextContent('“Second example line”');
    expect(rows[1]).toHaveTextContent('Sung “Second example line”, anchored to nothing');
    expect(within(list).getByText('2 need a fix')).toBeInTheDocument();

    fireEvent.click(within(list).getByRole('button', { name: 'Needs a fix (2)' }));
    expect(within(list).getAllByRole('button', { name: /^Edit / })).toHaveLength(2);
    fireEvent.click(within(list).getByRole('button', { name: 'Edit Shot 2' }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/music-video/mv-1/produce/scene/s2'));
  });

  // Uniquely catches a lingering ?shots=fix emptying the list once nothing needs a fix (its filter buttons are gone).
  it('lists every shot when the fix filter is left on but nothing needs a fix', async () => {
    listMusicVideoProjects.mockResolvedValue([{ ...PROJECT_WITH_CLIP, scenes: [{ sceneId: 's1', order: 0, startSec: 0, endSec: 4 }] }]);
    renderAt('/music-video/mv-1/produce?shots=fix');
    await screen.findByRole('heading', { level: 2, name: PROJECT_WITH_CLIP.name });
    const list = screen.getByRole('region', { name: 'Shot list' });
    expect(within(list).getByRole('button', { name: 'Edit Shot 1' })).toBeInTheDocument();
    expect(within(list).queryByRole('group', { name: 'Filter shots' })).toBeNull();
  });
});

it('waits for a grade save before rendering and keeps the saved look when a later save fails', async () => {
  const project = { ...PROJECT_WITH_CLIP, composition: { mode: 'composed', textCues: [], style: { color: '#ffffff', font: 'sans' } } };
  let finishSave;
  updateMusicVideoProject.mockImplementationOnce((_id, patch) => new Promise((resolve) => {
    finishSave = () => resolve({ edit: editResult(project.scenes || [], [], { updatedAt: '2026-01-01T00:00:01.000Z', project: patch }) });
  }));
  await openProject(project, 'compose');
  fireEvent.change(screen.getByLabelText('Default section look'), { target: { value: 'teal-night' } });
  await waitFor(() => expect(updateMusicVideoProject).toHaveBeenCalledWith(project.id,
    { composition: expect.objectContaining({ grade: expect.objectContaining({ preset: 'teal-night' }) }) }, { silent: true, edit: true }));
  expect(screen.getByLabelText('Default section look')).toBeDisabled();
  expect(screen.getByLabelText('Default section look').value).toBe('neutral');
  await openStage('review');
  expect(screen.getByRole('button', { name: /^Render final$/ })).toBeDisabled();
  expect(renderMusicVideoProject).not.toHaveBeenCalled();
  await act(async () => { finishSave(); });
  expect(screen.getByRole('button', { name: /^Render final$/ })).not.toBeDisabled();
  await openStage('compose');
  expect(screen.getByLabelText('Default section look').value).toBe('teal-night');
  updateMusicVideoProject.mockRejectedValueOnce(new Error('Grade save unavailable'));
  fireEvent.change(screen.getByLabelText('Default section look'), { target: { value: 'golden-hour' } });
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Grade save unavailable'));
  expect(screen.getByLabelText('Default section look').value).toBe('teal-night');
});

describe('stage checklist and project options', () => {
  it('lists open storyboard feedback on its own Feedback row, settled with buttons there, never under Lyrics', async () => {
    const note = { id: 'fb-a', stage: 'storyboard', target: 'Chorus', text: 'Put the lyrics on the wall, not the screen', decision: 'request-changes', basis: 'board' };
    const project = { ...PROJECT_ANALYZED, scenes: [{ sceneId: 's-a', order: 0, label: 'Chorus', startSec: 0, endSec: 4 }],
      productionReview: { draft: { storyboard: [] }, feedback: [note] },
      productionReadiness: { readyForProduction: false, basis: { storyboard: 'board' }, art: { approved: true, problems: [] },
        storyboard: withProblems({ approved: false }, [problem('feedback', `Resolve storyboard feedback for ${note.target}: ${note.text}`)]), proof: { approved: false, problems: [] } } };
    await renderProjectStage(project, 'board');
    const checklist = screen.getByRole('region', { name: 'What this step needs' });
    expect(within(checklist).queryByText('Lyrics')).toBeNull();
    expect(within(checklist).queryByRole('button', { name: /Import lyrics/ })).toBeNull();
    const requests = within(checklist).getByRole('list', { name: 'Open change requests' });
    expect(requests).toHaveTextContent('Chorus: Put the lyrics on the wall, not the screen');
    fireEvent.click(within(checklist).getByRole('button', { name: /Revise from feedback/ }));
    await waitFor(() => expect(feedbackCalls.revise).toHaveBeenCalledWith('storyboard'));
    fireEvent.click(within(requests).getByRole('button', { name: 'Mark resolved: Chorus' }));
    expect(feedbackCalls.resolveFeedback).toHaveBeenCalledWith('fb-a', '');
    // Storyboard approval, on Shots, waits on the same request.
    await openStage('produce', false);
    expect(screen.getByRole('region', { name: 'Approve: Lyric-timed storyboard' })).toHaveTextContent('Resolve the change request on Chorus first.');
  });

  // Uniquely catches a lyric anchor problem the director cannot find or settle from the checklist.
  it('names each shot whose lyric anchors differ from the singing, opens it, and anchors them all in one tap', async () => {
    const project = { ...PROJECT_ANALYZED, scenes: [{ sceneId: 's-a', order: 0, label: 'Drummer', startSec: 0, endSec: 4 }, { sceneId: 's-b', order: 1, label: 'Singer', startSec: 4, endSec: 8 }],
      productionReview: { draft: { storyboard: [] } },
      productionReadiness: { readyForProduction: false, basis: {}, art: { approved: true, problems: [] },
        storyboard: withProblems({ approved: false,
          lyricAnchors: [{ sceneId: 's-b', sung: ['If you think this is slop'], anchored: [] }] }, [problem('lyric-anchors', 'Review lyric anchors for Singer.', 's-b')]), proof: { approved: false, problems: [] } } };
    await renderProjectStage(project, 'board');
    const checklist = screen.getByRole('region', { name: 'What this step needs' });
    expect(checklist).not.toHaveTextContent('need lyric anchors reviewed');
    const shots = within(checklist).getByRole('list', { name: 'Lyric anchors shots' });
    expect(shots).toHaveTextContent('Shot 2Sung: “If you think this is slop” · anchored: nothing');
    fireEvent.click(within(checklist).getByRole('button', { name: /Anchor to the sung lyrics/ }));
    expect(feedbackCalls.syncLyricAnchors).toHaveBeenCalledWith();
    fireEvent.click(within(shots).getByRole('button', { name: 'Shot 2' }));
    await waitFor(() => expect(document.getElementById('scene-s-b')).toBeTruthy());
  });

  // Uniquely catches a coverage or details problem the director cannot trace to a shot.
  it('names the shots behind Shot coverage and Shot details, each opening its card', async () => {
    const project = { ...PROJECT_ANALYZED, scenes: [{ sceneId: 's-a', order: 0, label: 'Drummer', startSec: 0, endSec: 4 }, { sceneId: 's-b', order: 1, label: 'Singer', startSec: 4.5, endSec: 8 }],
      productionReview: { draft: { storyboard: [] } },
      productionReadiness: { readyForProduction: false, basis: {}, art: { approved: true, problems: [] },
        storyboard: withProblems({ approved: false,
          coverage: [{ sceneId: 's-b', issue: 'gap', startSec: 4, endSec: 4.5 }],
          incompleteShots: [{ sceneId: 's-b', missing: ['staging'] }] },
        [problem('coverage', 'Storyboard shots must cover the master without unintended gaps or overlaps.'), problem('shot-incomplete', 'Complete timing, action, staging, camera and transition for Singer.', 's-b')]), proof: { approved: false, problems: [] } } };
    await renderProjectStage(project, 'board');
    const checklist = screen.getByRole('region', { name: 'What this step needs' });
    expect(within(checklist).getByRole('list', { name: 'Shot coverage shots' })).toHaveTextContent('Shot 2Gap of 0.50 s before this shot, 0:04.00–0:04.50');
    expect(checklist).not.toHaveTextContent('without unintended gaps');
    const details = within(checklist).getByRole('list', { name: 'Shot details shots' });
    expect(details).toHaveTextContent('Shot 2Missing staging');
    expect(checklist).not.toHaveTextContent('1 shot missing timing');
    fireEvent.click(within(details).getByRole('button', { name: 'Shot 2' }));
    await waitFor(() => expect(document.getElementById('scene-s-b')).toBeTruthy());
  });
});

describe('Code video storyboard approval gating on Produce stage (#15723)', () => {
  it('enables Generate code video with default approved readiness', async () => {
    const codeProject = {
      ...PROJECT_WITH_CLIP,
      composition: { mode: 'code' },
    };

    // Default readiness (storyboard: { approved: true })
    await openProject(codeProject, 'produce');
    const generateBtn = await screen.findByRole('button', { name: /Generate code video/ });
    await waitFor(() => expect(generateBtn).toBeEnabled());
    expect(screen.queryByText('Approve the storyboard first')).toBeNull();
  });

  it('disables Generate code video with reason when storyboard is not approved', async () => {
    const unapprovedProject = {
      ...PROJECT_WITH_CLIP,
      id: 'mv-code-unapproved',
      name: 'Unapproved Code Video Project',
      composition: { mode: 'code' },
      productionReadiness: {
        readyForProduction: false,
        basis: {},
        art: { approved: true, problems: [] },
        storyboard: { approved: false, problems: ['Storyboard not approved'] },
        proof: { approved: false, problems: [] },
      },
    };
    await openProject(unapprovedProject, 'produce');
    const unapprovedBtn = await screen.findByRole('button', { name: /Generate code video/ });
    await waitFor(() => expect(unapprovedBtn).toBeDisabled());
    expect(await screen.findByText('Approve the storyboard first')).toBeTruthy();
  });
});

it('shares Done between editor, board and sheet, and accepts remote changes after a failed save', async () => {
  const project = { ...PROJECT_WITH_CLIP, scenes: [{ ...PROJECT_WITH_CLIP.scenes[0], label: 'Shot 1', shotSheet: { location: 'Park', checked: false } }] };
  let settle;
  updateMusicVideoScene.mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
  await openProject(project, 'produce');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Done', exact: true }));
  expect(updateMusicVideoScene).toHaveBeenCalledWith('mv-1', project.scenes[0].sceneId, { shotSheet: { checked: true } }, { silent: true });
  await act(async () => settle(await savedSceneReplies(project)(project.id, project.scenes[0].sceneId, { shotSheet: { checked: true } })));
  expect(screen.getByRole('checkbox', { name: 'Done', exact: true })).toBeChecked();
  expect(within(screen.getByLabelText('Storyboard thumbnails')).getByRole('button', { name: 'Open Shot 1' })).toHaveClass('border-port-success');
  fireEvent.click(screen.getByRole('button', { name: 'Close shot' }));
  fireEvent.click(screen.getByText('Shot sheet'));
  expect(screen.getByRole('checkbox', { name: 'Shot 1 done' })).toBeChecked();
  fireEvent.click(screen.getAllByRole('button', { name: 'Open Shot 1' }).find(button => button.closest('tr')));
  updateMusicVideoScene.mockRejectedValueOnce(new Error('Save unavailable'));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Done', exact: true }));
  await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Done', exact: true })).not.toBeDisabled());
  expect(screen.getByRole('checkbox', { name: 'Done', exact: true })).toBeChecked();
  getMusicVideoProject.mockResolvedValue({ ...project, scenes: [{ ...project.scenes[0], shotSheet: { location: 'Station', checked: false } }] });
  await pushSocket('music-video:project:changed', { id: project.id });
  await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Done', exact: true })).not.toBeChecked());
  expect(screen.getByRole('combobox', { name: 'Location' })).toHaveValue('Station');
});

// #16247: a shot edit from this tab patches the board from its reply and never reads the whole project again.
