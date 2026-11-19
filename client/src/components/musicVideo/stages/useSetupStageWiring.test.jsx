/**
 * Music Video page suite for the Song step container (`useSetupStageWiring`): track import and relink, audio preview, the musical timeline, MIDI, and lyric import and alignment.
 * Drives the real page through the shared scaffold in `test/musicVideoPageMocks.jsx`.
 */
import { describe, it, expect } from 'vitest';
// The scaffold registers the mocks, so it loads before any mocked module.
import {
  PROJECT_WITH_CLIP,
  PROJECT_NO_CLIP,
  sseState,
  getYtSseState,
  PROJECT_ANALYZED,
  renderMV,
  settle,
  selectProject,
  openSettings,
  openStage,
  openProject,
  pushSocket,
  openCreateForm,
  forceRerender,
  renderMVWithNav,
  installMusicVideoPageHooks,
  editResult,
} from '../../../test/musicVideoPageMocks.jsx';
import { screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import toast from '../../ui/Toast';
import { listMusicVideoProjects, createMusicVideoProject, renderMusicVideoProject, updateMusicVideoProject, deleteMusicVideoProject, transcribeMusicVideoMidi, prepareMusicVideoSong, importMusicVideoLyrics, alignMusicVideoLyrics, getMusicVideoActiveJobs, getMusicVideoProject } from '../../../services/apiMusicVideo.js';
import { importTrackFromYoutube, importTrackFromSuno, trackImportEventsUrl, listTracks } from '../../../services/apiTracks.js';

installMusicVideoPageHooks();

describe('MusicVideo audio preview + download', () => {
  it('shows preview player + download link for a linked track', async () => {
    listTracks.mockResolvedValue([{ id: 't1', title: 'Neon Song', audioFilename: 'neon song.mp3' }]);
    await openProject(PROJECT_WITH_CLIP, 'setup');
    const player = await screen.findByLabelText('Preview track audio');
    expect(player.getAttribute('src')).toBe('/data/music/neon%20song.mp3');
    const dl = screen.getByRole('link', { name: /Download audio/i });
    expect(dl.getAttribute('href')).toBe('/data/music/neon%20song.mp3');
    expect(dl.getAttribute('download')).toBe('neon song.mp3');
  });

  it('labels a linked track whose active take was imported from a Suno export (#8967)', async () => {
    listTracks.mockResolvedValue([{
      id: 't1', title: 'Neon Song', audioFilename: 'neon.mp3',
      renders: [{ id: 'r-old', audioFilename: 'old.wav', source: '' }, { id: 'r-1', audioFilename: 'neon.mp3', source: 'suno' }],
    }]);
    await openProject(PROJECT_WITH_CLIP, 'setup');
    expect(await screen.findByTitle('Audio imported from Suno')).toHaveTextContent('Suno');
  });

  it('falls back to the project uploaded-audio file when there is no linked track', async () => {
    await openProject({ ...PROJECT_WITH_CLIP, trackId: null, uploadedAudioFilename: 'upload.wav' }, 'setup');
    const player = await screen.findByLabelText('Preview track audio');
    expect(player.getAttribute('src')).toBe('/data/music/upload.wav');
  });

  it('renders no audio controls when the project has no audio', async () => {
    await openProject({ ...PROJECT_WITH_CLIP, trackId: null, uploadedAudioFilename: null }, 'setup');
    // Setup opened (the track picker is present) but no audio surface.
    await screen.findByLabelText('Change track');
    expect(screen.queryByLabelText('Preview track audio')).toBeNull();
    expect(screen.queryByRole('link', { name: /Download audio/i })).toBeNull();
  });
});

describe('MusicVideo audio → MIDI transcription (MuScriptor)', () => {
  it('shows a saved failure and retries from the Song step', async () => {
    await openProject({ ...PROJECT_WITH_CLIP, midiTranscriptionError: 'FFmpeg could not decode the song audio.' }, 'setup');
    expect(await screen.findByText(/FFmpeg could not decode the song audio/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Retry MIDI transcription' }));
    await waitFor(() => expect(transcribeMusicVideoMidi).toHaveBeenCalledWith('mv-1', { model: 'medium' }, { silent: true }));
    expect(await screen.findByRole('button', { name: /Transcribing.*Cancel/ })).toBeVisible();
  });

  it('follows a transcription started elsewhere while the Song page is open', async () => {
    await openProject(PROJECT_WITH_CLIP, 'setup');
    expect(await screen.findByText('MIDI transcription · Never run')).toBeVisible();
    getMusicVideoProject.mockResolvedValueOnce({ ...PROJECT_WITH_CLIP, activeMidiJob: 'midi-live' });
    await pushSocket('music-video:project:changed', { id: 'mv-1' });
    expect(await screen.findByRole('button', { name: /Transcribing.*Cancel/ })).toBeVisible();
    expect(transcribeMusicVideoMidi).not.toHaveBeenCalled();
  });

  it('disables the MIDI button when the project has no audio source', async () => {
    await openProject({ ...PROJECT_WITH_CLIP, trackId: null, uploadedAudioFilename: null });
    await openSettings('Audio');
    const btn = await screen.findByRole('button', { name: /^MIDI$/ });
    expect(btn).toHaveProperty('disabled', true);
  });

  it('kicks off a transcription for the selected project with the default model', async () => {
    await openProject(PROJECT_WITH_CLIP);
    await openSettings('Audio');
    const btn = await screen.findByRole('button', { name: /^MIDI$/ });
    expect(btn).toHaveProperty('disabled', false);
    fireEvent.click(btn);
    await waitFor(() => expect(transcribeMusicVideoMidi).toHaveBeenCalledWith('mv-1', { model: 'medium' }, { silent: true }));
  });

  it('kicks off a transcription with the chosen model size', async () => {
    await openProject(PROJECT_WITH_CLIP);
    await openSettings('Audio');
    fireEvent.change(await screen.findByLabelText('MuScriptor model size'), { target: { value: 'large' } });
    fireEvent.click(await screen.findByRole('button', { name: /^MIDI$/ }));
    await waitFor(() => expect(transcribeMusicVideoMidi).toHaveBeenCalledWith('mv-1', { model: 'large' }, { silent: true }));
  });

  it('shows the MIDI download link once the project carries a transcription pointer', async () => {
    listTracks.mockResolvedValue([{ id: 't1', title: 'Neon Song', audioFilename: 'neon.mp3' }]);
    await openProject({ ...PROJECT_WITH_CLIP, midiTranscription: { filename: 'neon-midi.mid', model: 'medium' } });
    await openSettings('Audio');
    // Two links now: the download button and the MidiVisualization panel's
    // download icon (#2477) — both serve from the music dir (same static route
    // as the master audio) so the federated .mid resolves on peers too.
    const links = await screen.findAllByRole('link', { name: /Download MIDI/i });
    expect(links.length).toBeGreaterThanOrEqual(1);
    links.forEach((dl) => expect(dl.getAttribute('href')).toBe('/data/music/neon-midi.mid'));
  });
});

describe('MusicVideo lyrics and shot coverage (#8964)', () => {
  it('imports pasted lyrics, shows the cues, and persists an edited line on blur', async () => {
    const cues = [
      { id: 'lc-1', text: 'first line', startSec: 1, endSec: 3 },
      { id: 'lc-2', text: 'second line', startSec: 3, endSec: null },
    ];
    importMusicVideoLyrics.mockResolvedValue({ edit: editResult([], [], { updatedAt: '2026-01-01T00:00:00.500Z', project: { lyricCues: cues, lyricMarkers: [] } }), imported: 2, format: 'lrc' });
    await openProject(PROJECT_ANALYZED, 'setup');

    fireEvent.change(screen.getByLabelText('Lyrics to import'), { target: { value: '[00:01.00]first line\n[00:03.00]second line' } });
    fireEvent.click(screen.getByRole('button', { name: /^Import lyrics$/ }));
    await waitFor(() => expect(importMusicVideoLyrics).toHaveBeenCalledWith(
      'mv-3',
      { text: '[00:01.00]first line\n[00:03.00]second line', format: 'auto', mode: 'replace' },
      { silent: true, edit: true },
    ));
    const line = await screen.findByLabelText('Line 2 text');
    expect(line).toHaveValue('second line');
    expect(screen.getByLabelText('Lyrics to import')).toHaveValue('');

    updateMusicVideoProject.mockResolvedValue({ edit: editResult([], [], { updatedAt: '2026-01-01T00:00:01.000Z', project: { lyricCues: cues } }) });
    fireEvent.change(line, { target: { value: 'second line, retold' } });
    expect(alignMusicVideoLyrics).not.toHaveBeenCalled();
    fireEvent.blur(line);
    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenCalledWith(
      'mv-3',
      { lyricCues: [cues[0], { ...cues[1], text: 'second line, retold' }] },
      { silent: true, edit: true },
    ));
  });

  it('aligns imported lyrics on its own and follows the alignment it started', async () => {
    const cues = [{ id: 'lc-1', text: 'first line', startSec: null, endSec: null }];
    importMusicVideoLyrics.mockResolvedValue({ edit: editResult([], [], { project: { lyricCues: cues, lyricMarkers: [] } }), imported: 1, format: 'text' });
    prepareMusicVideoSong.mockResolvedValueOnce({ project: { ...PROJECT_ANALYZED, lyricCues: cues }, analyzed: false, alignJobId: 'align-auto' });
    await openProject(PROJECT_ANALYZED, 'setup');
    fireEvent.change(screen.getByLabelText('Lyrics to import'), { target: { value: 'first line' } });
    fireEvent.click(screen.getByRole('button', { name: /^Import lyrics$/ }));
    await waitFor(() => expect(prepareMusicVideoSong).toHaveBeenCalledWith('mv-3', { silent: true }));
    expect((await screen.findAllByRole('button', { name: 'Aligning…' })).length).toBeGreaterThan(0);
    expect(alignMusicVideoLyrics).not.toHaveBeenCalled();
  });

  it('re-aligns words from the button and shows the returned timings', async () => {
    const cues = [{
      id: 'lc-1', text: 'walking home', startSec: 0.5, endSec: 1.5,
      words: [
        { w: 'walking', startSec: 0.5, endSec: 1, conf: 'matched' },
        { w: 'home', startSec: 1, endSec: 1.5, conf: 'interpolated' },
      ],
    }];
    await openProject({ ...PROJECT_ANALYZED, vocalStemFilename: 'stem.wav', lyricCues: [{ id: 'lc-1', text: 'walking home', startSec: null, endSec: null }] }, 'setup');
    expect(alignMusicVideoLyrics).not.toHaveBeenCalled();
    alignMusicVideoLyrics.mockResolvedValue({ jobId: 'align-job-1' });
    fireEvent.click(screen.getByRole('button', { name: 'Align words' }));
    await waitFor(() => expect(alignMusicVideoLyrics).toHaveBeenCalledWith('mv-3', {}, { silent: true }));
    await settle();
    sseState.latest = { type: 'complete', project: { id: 'mv-3', vocalStemFilename: 'stem.wav', lyricCues: cues, updatedAt: 't' } };
    forceRerender();
    expect(await screen.findByText('walking')).toHaveClass('text-port-accent');
    expect(screen.getByText('home')).toHaveClass('text-port-warning');
    sseState.latest = null;
    fireEvent.click(screen.getByRole('button', { name: 'Re-align line 1' }));
    await waitFor(() => expect(alignMusicVideoLyrics).toHaveBeenLastCalledWith('mv-3', { cueId: 'lc-1' }, { silent: true }));
  });

  it('reattaches to an alignment the server is still running after a reload (#10155)', async () => {
    getMusicVideoActiveJobs.mockResolvedValueOnce({ alignment: 'align-live', separation: null, midi: null });
    await openProject({ ...PROJECT_ANALYZED, lyricCues: [{ id: 'lc-1', text: 'walking home', startSec: null, endSec: null }] }, 'setup');
    const running = await screen.findAllByRole('button', { name: 'Aligning…' });
    running.forEach((button) => expect(button).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Re-align line 1' })).toBeDisabled();
    expect(alignMusicVideoLyrics).not.toHaveBeenCalled();
  });
});

describe('MusicVideo YouTube audio import (#1945)', () => {
  // Uniquely catches an older library response hiding a completed import.
  it.each([false, true])('reconciles an import during loading, with reconciliation failure=%s', async (fails) => {
    let resolveOld;
    let resolveFresh;
    const track = { id: 'track-new', title: 'New imported song' };
    listTracks.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    if (fails) listTracks.mockRejectedValueOnce(new Error('Library reconciliation offline'));
    else listTracks.mockImplementationOnce(() => new Promise((resolve) => { resolveFresh = resolve; }));
    renderMV();
    await openCreateForm();
    const input = await screen.findByPlaceholderText(/Paste a YouTube or Suno link/i);
    fireEvent.change(input, { target: { value: 'https://youtu.be/example' } });
    fireEvent.click(within(input.closest('div')).getByRole('button', { name: /Import/i }));
    await waitFor(() => expect(importTrackFromYoutube).toHaveBeenCalled());
    await settle();
    getYtSseState(trackImportEventsUrl('yt-job-1')).latest = { type: 'complete', trackId: track.id, track };
    fireEvent.change(input, { target: { value: 'https://youtu.be/completed' } });
    if (fails) {
      expect(await screen.findByRole('alert')).toHaveTextContent('Library reconciliation offline');
      expect(screen.queryByText(/No tracks in the music library yet/)).not.toBeInTheDocument();
      listTracks.mockResolvedValueOnce([track]);
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    } else {
      await waitFor(() => expect(resolveFresh).toBeTypeOf('function'));
      await act(async () => resolveFresh([track]));
    }
    expect(await screen.findByRole('option', { name: /New imported song/ })).toBeInTheDocument();
    await act(async () => resolveOld([]));
    expect(screen.getByRole('option', { name: /New imported song/ })).toBeInTheDocument();
  });

  it('starts an import from the detail view and attaches the finished track to the project', async () => {
    await openProject(PROJECT_NO_CLIP, 'setup');
    const urlInput = screen.getByPlaceholderText(/Paste a YouTube or Suno link/i);
    fireEvent.change(urlInput, { target: { value: 'https://youtu.be/dQw4w9WgXcQ' } });
    const row = urlInput.closest('div');
    fireEvent.click(within(row).getByRole('button', { name: /Import/i }));
    await waitFor(() => expect(importTrackFromYoutube).toHaveBeenCalledWith('https://youtu.be/dQw4w9WgXcQ', { silent: true }));

    // Simulate the SSE terminal frame the job's kickoff subscribed to. The mock
    // hook returns a plain mutable object (not real React state), so mutating
    // it alone doesn't trigger a re-render — nudge one via an unrelated input
    // so the component re-reads the hook and its effect dependency changes.
    const url = trackImportEventsUrl('yt-job-1');
    getYtSseState(url).latest = {
      type: 'complete', trackId: 'track-yt-1', track: { id: 'track-yt-1', title: 'Imported Song' },
    };
    fireEvent.change(urlInput, { target: { value: 'https://youtu.be/refresh' } });
    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenCalledWith('mv-2', { trackId: 'track-yt-1' }, { silent: true }));
  });

  it('imports a pasted Suno song link through the Suno import', async () => {
    await openProject(PROJECT_NO_CLIP, 'setup');
    const urlInput = screen.getByPlaceholderText(/Paste a YouTube or Suno link/i);
    const songUrl = 'https://suno.com/song/11111111-2222-4333-8444-555555555555';
    fireEvent.change(urlInput, { target: { value: songUrl } });
    fireEvent.click(within(urlInput.closest('div')).getByRole('button', { name: /Import/i }));
    await waitFor(() => expect(importTrackFromSuno).toHaveBeenCalledWith(songUrl, { silent: true }));
    expect(importTrackFromYoutube).not.toHaveBeenCalled();
  });

  it('disables the Import button until a URL is entered', async () => {
    await openProject(PROJECT_NO_CLIP, 'setup');
    // Exact name: other stages also carry "Import take" / handoff import controls.
    const importBtns = screen.getAllByRole('button', { name: /^Import$/i });
    expect(importBtns.length).toBeGreaterThan(0);
    importBtns.forEach((btn) => expect(btn).toHaveProperty('disabled', true));
  });

  it('running the create-form and detail-view imports at once does not orphan either job', async () => {
    await openProject(PROJECT_NO_CLIP, 'setup');
    await openCreateForm();
    importTrackFromYoutube
      .mockResolvedValueOnce({ jobId: 'yt-job-create' })
      .mockResolvedValueOnce({ jobId: 'yt-job-edit' });

    const inputs = screen.getAllByPlaceholderText(/Paste a YouTube or Suno link/i);
    const createInput = inputs.find((el) => el.id === 'mv-yt-create');
    const editInput = inputs.find((el) => el.id !== 'mv-yt-create');

    fireEvent.change(createInput, { target: { value: 'https://youtu.be/create111' } });
    fireEvent.click(within(createInput.closest('div')).getByRole('button', { name: /Import/i }));
    await waitFor(() => expect(importTrackFromYoutube).toHaveBeenCalledWith('https://youtu.be/create111', { silent: true }));

    fireEvent.change(editInput, { target: { value: 'https://youtu.be/edit222' } });
    fireEvent.click(within(editInput.closest('div')).getByRole('button', { name: /Import/i }));
    await waitFor(() => expect(importTrackFromYoutube).toHaveBeenCalledWith('https://youtu.be/edit222', { silent: true }));

    // Both slots must independently show themselves as in-flight — a shared
    // slot would have the second kickoff silently take over the first's spot.
    const cancelBtns = screen.getAllByRole('button', { name: /%$/ });
    expect(cancelBtns).toHaveLength(2);

    // Completing the EDIT job must attach to the project without disturbing
    // the still-in-flight CREATE job.
    getYtSseState(trackImportEventsUrl('yt-job-edit')).latest = {
      type: 'complete', trackId: 'track-edit', track: { id: 'track-edit', title: 'Edit Track' },
    };
    fireEvent.change(screen.getByPlaceholderText('Project name'), { target: { value: 'x' } });
    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenCalledWith('mv-2', { trackId: 'track-edit' }, { silent: true }));
    // The create-form job is still running — its Cancel/percent button remains.
    expect(screen.getAllByRole('button', { name: /%$/ })).toHaveLength(1);

    // Completing the CREATE job independently attaches to the form.
    getYtSseState(trackImportEventsUrl('yt-job-create')).latest = {
      type: 'complete', trackId: 'track-create', track: { id: 'track-create', title: 'Create Track' },
    };
    fireEvent.change(screen.getByPlaceholderText('Project name'), { target: { value: 'y' } });
    await waitFor(() => expect(screen.getByText(/Track set: Create Track/i)).toBeTruthy());
  });

  it('blocks switching projects while the detail-view import is in flight (single shared job slot)', async () => {
    const projectB = { ...PROJECT_NO_CLIP, id: 'mv-3', name: 'Other Project' };
    listMusicVideoProjects.mockResolvedValue([PROJECT_NO_CLIP, projectB]);
    renderMV();
    const picker = await selectProject(PROJECT_NO_CLIP.id);

    const editInput = screen.getAllByPlaceholderText(/Paste a YouTube or Suno link/i)
      .find((el) => el.id !== 'mv-yt-create');
    fireEvent.change(editInput, { target: { value: 'https://youtu.be/xyz' } });
    fireEvent.click(within(editInput.closest('div')).getByRole('button', { name: /Import/i }));
    await waitFor(() => expect(importTrackFromYoutube).toHaveBeenCalled());

    // Switching to the OTHER project while this one's import is in flight
    // must be blocked — it would silently orphan the in-flight job's SSE
    // subscription and misattribute its progress UI to the new selection.
    fireEvent.change(picker, { target: { value: projectB.id } });
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/before switching projects/i));
    expect(picker).toHaveValue(PROJECT_NO_CLIP.id);
  });

  it('bounces URL-driven navigation (deep link / Back / ⌘K) away from a project with an in-flight import back to it', async () => {
    listMusicVideoProjects.mockResolvedValue([PROJECT_NO_CLIP]); // mv-2
    renderMVWithNav('/music-video/mv-3');
    // Open mv-2 and start its detail-view import.
    await selectProject(PROJECT_NO_CLIP.id);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/music-video/mv-2'));
    const editInput = screen.getAllByPlaceholderText(/Paste a YouTube or Suno link/i)
      .find((el) => el.id !== 'mv-yt-create');
    fireEvent.change(editInput, { target: { value: 'https://youtu.be/xyz' } });
    fireEvent.click(within(editInput.closest('div')).getByRole('button', { name: /Import/i }));
    await waitFor(() => expect(importTrackFromYoutube).toHaveBeenCalled());

    // A router-driven jump to another project (not via the list buttons, so it
    // bypasses selectProject's guard) must be bounced back to the import's
    // project with the same guard message.
    fireEvent.click(screen.getByRole('button', { name: 'go-/music-video/mv-3' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/before switching projects/i)));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/music-video/mv-2'));
  });

  it('blocks deleting the selected project while its import is in flight', async () => {
    await openProject(PROJECT_NO_CLIP, 'setup');
    const editInput = screen.getAllByPlaceholderText(/Paste a YouTube or Suno link/i)
      .find((el) => el.id !== 'mv-yt-create');
    fireEvent.change(editInput, { target: { value: 'https://youtu.be/xyz' } });
    fireEvent.click(within(editInput.closest('div')).getByRole('button', { name: /Import/i }));
    await waitFor(() => expect(importTrackFromYoutube).toHaveBeenCalled());

    await openSettings('Project');
    fireEvent.click(screen.getByTitle('Delete project'));
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/before deleting this project/i));
    expect(deleteMusicVideoProject).not.toHaveBeenCalled();
  });

  it('pressing Enter in the create-form URL input starts the import instead of submitting the form', async () => {
    listMusicVideoProjects.mockResolvedValue([]);
    renderMV();
    await openCreateForm();
    const createInput = await screen.findByPlaceholderText(/Paste a YouTube or Suno link/i);
    fireEvent.change(createInput, { target: { value: 'https://youtu.be/enterkey' } });
    fireEvent.keyDown(createInput, { key: 'Enter' });
    await waitFor(() => expect(importTrackFromYoutube).toHaveBeenCalledWith('https://youtu.be/enterkey', { silent: true }));
    expect(createMusicVideoProject).not.toHaveBeenCalled();
  });

  it('ignores a second Import click while the first kickoff request is still in flight', async () => {
    listMusicVideoProjects.mockResolvedValue([]);
    let resolveKickoff;
    importTrackFromYoutube.mockImplementation(() => new Promise((resolve) => { resolveKickoff = resolve; }));
    renderMV();
    await openCreateForm();
    const createInput = await screen.findByPlaceholderText(/Paste a YouTube or Suno link/i);
    fireEvent.change(createInput, { target: { value: 'https://youtu.be/doubleclick' } });
    const importBtn = within(createInput.closest('div')).getByRole('button', { name: /Import/i });
    fireEvent.click(importBtn);
    fireEvent.click(importBtn); // fires before the first request resolves
    resolveKickoff({ jobId: 'yt-job-1' });
    await waitFor(() => expect(importTrackFromYoutube).toHaveBeenCalledTimes(1));
  });

  it('blocks switching projects during the pending kickoff window, before the job even exists', async () => {
    const projectB = { ...PROJECT_NO_CLIP, id: 'mv-3', name: 'Other Project' };
    listMusicVideoProjects.mockResolvedValue([PROJECT_NO_CLIP, projectB]);
    let resolveKickoff;
    importTrackFromYoutube.mockImplementation(() => new Promise((resolve) => { resolveKickoff = resolve; }));
    renderMV();
    const picker = await selectProject(PROJECT_NO_CLIP.id);

    const editInput = screen.getAllByPlaceholderText(/Paste a YouTube or Suno link/i)
      .find((el) => el.id !== 'mv-yt-create');
    fireEvent.change(editInput, { target: { value: 'https://youtu.be/pending' } });
    fireEvent.click(within(editInput.closest('div')).getByRole('button', { name: /Import/i }));
    // The kickoff POST has NOT resolved yet — no jobId, no SSE subscription —
    // but switching away must already be blocked, or this project's import
    // would attach with nobody listening once it lands.
    expect(importTrackFromYoutube).toHaveBeenCalledTimes(1);

    fireEvent.change(picker, { target: { value: projectB.id } });
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/before switching projects/i));
    expect(picker).toHaveValue(PROJECT_NO_CLIP.id);

    resolveKickoff({ jobId: 'yt-job-pending' });
    // Settle the kickoff's .then (jobId + SSE-subscription state) inside act —
    // the pending-window assertions above must stay pre-settle.
    await settle();
  });

  it('blocks creating the project while the create-form YouTube import is in flight', async () => {
    listMusicVideoProjects.mockResolvedValue([]);
    renderMV();
    await openCreateForm();
    const nameInput = await screen.findByPlaceholderText('Project name');
    fireEvent.change(nameInput, { target: { value: 'New MV' } });
    const createInput = screen.getAllByPlaceholderText(/Paste a YouTube or Suno link/i)
      .find((el) => el.id === 'mv-yt-create');
    fireEvent.change(createInput, { target: { value: 'https://youtu.be/xyz' } });
    fireEvent.click(within(createInput.closest('div')).getByRole('button', { name: /Import/i }));
    await waitFor(() => expect(importTrackFromYoutube).toHaveBeenCalled());

    const createBtn = screen.getByRole('button', { name: /^Create/ });
    expect(createBtn).toHaveProperty('disabled', true);
    fireEvent.click(createBtn);
    expect(createMusicVideoProject).not.toHaveBeenCalled();
  });

  it('selects track first in create drawer, auto-fills name, reads track metadata, and passes concept/style on create', async () => {
    listMusicVideoProjects.mockResolvedValue([]);
    listTracks.mockResolvedValue([{
      id: 'track-cool',
      title: 'Neon Horizon',
      artist: 'SynthWave Artist',
      lyrics: 'Line 1\nLine 2\nLine 3',
      concept: 'Futuristic city chase',
      prompt: 'Cyberpunk neon aesthetics',
      durationSec: 180,
    }]);
    createMusicVideoProject.mockResolvedValue({ ...PROJECT_NO_CLIP, id: 'mv-cool', name: 'Neon Horizon', trackId: 'track-cool' });
    renderMV();
    await openCreateForm();

    const trackSelect = await screen.findByLabelText(/Track/i);
    fireEvent.change(trackSelect, { target: { value: 'track-cool' } });

    // Project name was auto-filled from track title
    expect(screen.getByPlaceholderText('Project name')).toHaveValue('Neon Horizon');
    // Track info badge showing lyrics and concept detected
    expect(screen.getByText(/3 lyric lines loaded/i)).toBeInTheDocument();
    expect(screen.getByText(/Concept loaded/i)).toBeInTheDocument();
    expect(screen.getByText(/Style prompt loaded/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Create/ }));
    await waitFor(() => expect(createMusicVideoProject).toHaveBeenCalled());
    const [body] = createMusicVideoProject.mock.calls[0];
    expect(body).toMatchObject({
      name: 'Neon Horizon',
      trackId: 'track-cool',
    });
    // The new song is analyzed and its lyrics aligned without another click.
    await waitFor(() => expect(prepareMusicVideoSong).toHaveBeenCalledWith('mv-cool', { silent: true }));
  });

  it('changing a track in the edit view auto-seeds the track concept, leaving the song style to the server', async () => {
    const project = { ...PROJECT_NO_CLIP, trackId: null, concept: null };
    listTracks.mockResolvedValue([{
      id: 'track-new',
      title: 'Solar Flare',
      concept: 'Space journey',
      prompt: 'Cosmic sci-fi',
    }]);
    updateMusicVideoProject.mockResolvedValue({ ...project, trackId: 'track-new', concept: { prompt: 'Space journey', songStyle: 'Cosmic sci-fi' } });
    await openProject(project, 'setup');

    const changeTrackSelect = screen.getByLabelText('Change track');
    fireEvent.change(changeTrackSelect, { target: { value: 'track-new' } });

    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenCalledWith(
      project.id,
      {
        trackId: 'track-new',
        // The Suno style is the song's sound, not the visual style on every frame prompt.
        concept: { prompt: 'Space journey' },
      },
      { silent: true },
    ));
  });

  it('blocks relinking the track while a render is in progress for the selected project', async () => {
    await openProject(PROJECT_WITH_CLIP, 'review');
    fireEvent.click(await screen.findByRole('button', { name: /^Render final$/ }));
    await waitFor(() => expect(renderMusicVideoProject).toHaveBeenCalled());

    await openStage('setup');
    const trackSelect = screen.getByLabelText('Change track');
    expect(trackSelect).toHaveProperty('disabled', true);
    fireEvent.change(trackSelect, { target: { value: 'other-track' } });
    expect(updateMusicVideoProject).not.toHaveBeenCalled();

    const editInput = screen.getAllByPlaceholderText(/Paste a YouTube or Suno link/i)
      .find((el) => el.id !== 'mv-yt-create');
    expect(editInput).toHaveProperty('disabled', true);
  });
});
