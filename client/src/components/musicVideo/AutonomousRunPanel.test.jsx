/**
 * The autonomous run panel + start drawer over the real useAutonomousMusicVideo
 * hook, with a mocked API and socket: the drawer sends only what the director
 * chose (unmetered tools by default, no checkpoints, blank optionals omitted),
 * a checkpoint offers the one output worth editing and approves with the edit,
 * a failed/needs-you run offers a retry, and a pushed project updates the
 * visible run without polling.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, useSearchParams } from 'react-router';

const listeners = vi.hoisted(() => new Map());
vi.mock('../../services/socket', () => ({
  default: { on: (ev, fn) => listeners.set(ev, fn), off: (ev) => listeners.delete(ev) },
}));
vi.mock('../../services/apiMusicVideo.js', () => ({
  startAutonomousMusicVideo: vi.fn(),
  resumeAutonomousMusicVideo: vi.fn(),
  stopAutonomousMusicVideo: vi.fn(),
  cancelAutonomousMusicVideo: vi.fn(),
}));
vi.mock('../../services/apiMoodBoard.js', () => ({ listMoodBoardNames: vi.fn(async () => [{ id: 'mb-1', name: 'Neon Rain' }]) }));
vi.mock('../../services/apiMusic.js', () => ({
  listMusicEngines: vi.fn(async () => ({ engines: [{ id: 'acestep', name: 'ACE-Step', ready: true, lyrics: true }] })),
}));
vi.mock('../../services/apiSystem.js', () => ({ getSettings: vi.fn(async () => ({ imageGen: { local: { modelId: 'example-image' } } })) }));
vi.mock('../../services/apiImageVideo.js', () => ({
  listImageModels: vi.fn(async () => [{ id: 'example-image', name: 'Example image' }]),
  getVideoGenModelContext: vi.fn(async () => ({
    models: [
      { id: 'example-ltx', name: 'Example LTX' },
      { id: 'example-wan', name: 'Example Wan' },
    ],
    defaultModel: 'example-ltx',
  })),
}));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));
// A picker with no Auto option (the orchestrator's) opens on the active provider.
vi.mock('../../hooks/useProviderModels.js', () => ({
  default: ({ filter, allowDefault } = {}) => (!filter && !allowDefault ? {
    providers: [{ id: 'fixture-api', name: 'Fixture API', type: 'api', enabled: true, defaultModel: 'fixture-model', models: ['fixture-model'] }],
    selectedProviderId: 'fixture-api', selectedModel: 'fixture-model', availableModels: ['fixture-model'],
    setSelectedProviderId: () => {}, setSelectedModel: () => {},
  } : {
    providers: filter ? [
      { id: 'fixture-api', name: 'Fixture API', type: 'api', enabled: true, defaultModel: 'fixture-model', models: ['fixture-model'] },
      { id: 'fixture-tui', name: 'Fixture TUI', type: 'tui', enabled: true },
      { id: 'fixture-cli', name: 'Unverified CLI', type: 'cli', enabled: true },
    ].filter(filter) : [], selectedProviderId: '', selectedModel: '', availableModels: filter ? ['fixture-model'] : [],
    setSelectedProviderId: () => {}, setSelectedModel: () => {},
  }),
}));

import AutonomousRunPanel from './AutonomousRunPanel.jsx';
import AutonomousStartDrawer from './AutonomousStartDrawer.jsx';
import useAutonomousMusicVideo from '../../hooks/useAutonomousMusicVideo.js';
import * as api from '../../services/apiMusicVideo.js';
import { getVideoGenModelContext } from '../../services/apiImageVideo.js';

const stages = (overrides = {}) => ({
  brief: { status: 'done' }, lyrics: { status: 'done' }, style: { status: 'pending' }, song: { status: 'pending' },
  analyze: { status: 'pending' }, produce: { status: 'pending' }, ...overrides,
});
const baseRun = (over = {}) => ({
  id: 'mvar-1', status: 'running', stage: 'style', awaiting: null, interrupted: false, error: null,
  brief: { origin: { kind: 'manual' } }, stages: stages(), output: { lyrics: '[verse]\nrain', sunoStyle: 'synthwave' }, ...over,
});

// The page owns `?run-stage=`; the harness does the same so the panel's rows drive a real URL.
function PanelWithUrl({ project, auto }) {
  const [params, setParams] = useSearchParams();
  const onSelectStage = (id) => setParams((prev) => { const next = new URLSearchParams(prev); if (id) next.set('run-stage', id); else next.delete('run-stage'); return next; });
  return (
    <>
      <AutonomousRunPanel project={project} auto={auto} selectedStage={params.get('run-stage')} onSelectStage={onSelectStage} />
      <div data-testid="search">{params.toString()}</div>
    </>
  );
}

function Harness({ initial, url = '/music-video/mv-1', extra = {} }) {
  const [project, setProject] = useState({ id: 'mv-1', autonomousRun: initial, ...extra });
  const auto = useAutonomousMusicVideo({ project, replaceProject: setProject });
  return <MemoryRouter initialEntries={[url]}><PanelWithUrl project={project} auto={auto} /></MemoryRouter>;
}

beforeEach(() => {
  vi.clearAllMocks();
  listeners.clear();
});

describe('AutonomousRunPanel', () => {
  it('shows the stage progress and updates from a pushed project, with no polling', async () => {
    render(<Harness initial={baseRun()} />);
    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Autonomous stages' }).querySelectorAll('li')).toHaveLength(6);

    await act(async () => {
      listeners.get('music-video:autonomous')({ projectId: 'mv-1', run: baseRun({ status: 'completed', stage: 'produce' }), project: { id: 'mv-1', autonomousRun: baseRun({ status: 'completed', stage: 'produce' }) } });
    });
    expect(screen.getByText('Finished')).toBeTruthy();
    // A finished run offers nothing to press.
    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull();
  });

  it('approves a lyrics checkpoint, sending the director’s edit only when they changed it', async () => {
    api.resumeAutonomousMusicVideo.mockResolvedValue({ project: { id: 'mv-1', autonomousRun: baseRun() }, run: baseRun() });
    render(<Harness initial={baseRun({ status: 'awaiting-approval', awaiting: 'lyrics' })} />);

    fireEvent.click(screen.getByRole('button', { name: /approve & continue/i }));
    await waitFor(() => expect(api.resumeAutonomousMusicVideo).toHaveBeenCalledWith('mv-1', {}, { silent: true }));
  });

  it('sends the edited lyrics when approving after an edit', async () => {
    api.resumeAutonomousMusicVideo.mockResolvedValue({ project: { id: 'mv-1', autonomousRun: baseRun() }, run: baseRun() });
    render(<Harness initial={baseRun({ status: 'awaiting-approval', awaiting: 'lyrics' })} />);
    fireEvent.change(screen.getByLabelText(/lyrics \(edit before continuing\)/i), { target: { value: '[verse]\nedited' } });
    fireEvent.click(screen.getByRole('button', { name: /save edit & approve/i }));
    await waitFor(() => expect(api.resumeAutonomousMusicVideo).toHaveBeenCalledWith('mv-1', { lyrics: '[verse]\nedited' }, { silent: true }));
  });

  it('offers the Suno style line to edit at the style checkpoint (the last stop before Suno is used)', async () => {
    render(<Harness initial={baseRun({ status: 'awaiting-approval', awaiting: 'style' })} />);
    expect(screen.getByLabelText(/suno style \(edit before continuing\)/i).value).toBe('synthwave');
  });

  it('offers a song retake only at the song checkpoint', async () => {
    api.resumeAutonomousMusicVideo.mockResolvedValue({ project: { id: 'mv-1', autonomousRun: baseRun() }, run: baseRun() });
    const { unmount } = render(<Harness initial={baseRun({ status: 'awaiting-approval', awaiting: 'lyrics' })} />);
    expect(screen.queryByRole('button', { name: /retake song/i })).toBeNull();
    unmount();

    render(<Harness initial={baseRun({ status: 'awaiting-approval', awaiting: 'song', stage: 'analyze' })} />);
    fireEvent.click(screen.getByRole('button', { name: /retake song/i }));
    await waitFor(() => expect(api.resumeAutonomousMusicVideo).toHaveBeenCalledWith('mv-1', { retakeSong: true }, { silent: true }));
  });

  it('offers Resume, not Cancel, for a run canceled while it waited on production', async () => {
    api.resumeAutonomousMusicVideo.mockResolvedValue({ project: { id: 'mv-1', autonomousRun: baseRun() }, run: baseRun() });
    render(<Harness initial={baseRun({ status: 'canceled', stage: 'produce', error: 'Production was canceled' })} />);
    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /resume/i }));
    await waitFor(() => expect(api.resumeAutonomousMusicVideo).toHaveBeenCalledWith('mv-1', {}, { silent: true }));
  });

  it('offers nothing to resume for a run canceled before production', () => {
    render(<Harness initial={baseRun({ status: 'canceled', stage: 'song' })} />);
    expect(screen.queryByRole('button', { name: /resume/i })).toBeNull();
  });

  it('swaps the video model on Resume of a run parked in production, offering only image-capable models', async () => {
    getVideoGenModelContext.mockResolvedValueOnce({
      models: [
        { id: 'example-ltx', name: 'Example LTX', supportedModes: ['text', 'image'] },
        { id: 'example-text-only', name: 'Example text only', supportedModes: ['text'] },
      ],
      defaultModel: 'example-ltx',
    });
    api.resumeAutonomousMusicVideo.mockResolvedValue({ project: { id: 'mv-1', autonomousRun: baseRun() }, run: baseRun() });
    render(<Harness initial={baseRun({
      status: 'needs-human', stage: 'produce', error: 'Video model refused',
      brief: { origin: { kind: 'manual' }, tools: ['image:local', 'video:local'], models: { 'video:local': 'example-wan' } },
      output: { productionRunId: 'prod-1' },
    })} />);
    const select = await screen.findByLabelText('Local video gen model');
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(screen.queryByRole('option', { name: 'Example text only' })).toBeNull();
    fireEvent.change(select, { target: { value: 'example-ltx' } });
    fireEvent.click(screen.getByRole('button', { name: /resume/i }));
    await waitFor(() => expect(api.resumeAutonomousMusicVideo).toHaveBeenCalledWith('mv-1', { models: { 'video:local': 'example-ltx' } }, { silent: true }));
  });

  it('sends no models on Resume when the video model was not changed', async () => {
    api.resumeAutonomousMusicVideo.mockResolvedValue({ project: { id: 'mv-1', autonomousRun: baseRun() }, run: baseRun() });
    render(<Harness initial={baseRun({ status: 'needs-human', stage: 'produce', brief: { origin: { kind: 'manual' }, tools: ['video:local'] } })} />);
    await screen.findByLabelText('Local video gen model');
    fireEvent.click(screen.getByRole('button', { name: /resume/i }));
    await waitFor(() => expect(api.resumeAutonomousMusicVideo).toHaveBeenCalledWith('mv-1', {}, { silent: true }));
  });

  it('offers a retry for a run that needs the director, and shows why', async () => {
    api.resumeAutonomousMusicVideo.mockResolvedValue({ project: { id: 'mv-1', autonomousRun: baseRun() }, run: baseRun() });
    render(<Harness initial={baseRun({ status: 'needs-human', stage: 'song', error: 'Sign in to Suno in the PortOS Browser' })} />);
    expect(screen.getByRole('status').textContent).toContain('Sign in to Suno');
    fireEvent.click(screen.getByRole('button', { name: /resume/i }));
    await waitFor(() => expect(api.resumeAutonomousMusicVideo).toHaveBeenCalledWith('mv-1', {}, { silent: true }));
  });

  it('reads "Rendering final video" while the render runs, links the final video once finished, and retries only the render when it failed', () => {
    const produce = (step) => baseRun({ stage: 'produce', status: 'running', stages: stages({ style: { status: 'done' }, produce: { status: 'running', step } }), output: { renderJobId: 'job-1' } });
    const { unmount } = render(<Harness initial={produce('rendering')} />);
    expect(screen.getByRole('status').textContent).toContain('Rendering final video');
    expect(screen.queryByRole('link', { name: /watch final video/i })).toBeNull();
    unmount();

    const failed = baseRun({ stage: 'produce', status: 'failed', error: 'ffmpeg exit 1', output: { renderJobId: 'job-1' } });
    const { unmount: unmountFailed } = render(<Harness initial={failed} />);
    expect(screen.getByRole('button', { name: /retry render/i })).toBeTruthy();
    unmountFailed();

    render(<Harness initial={baseRun({ stage: 'produce', status: 'completed' })} extra={{ renderHistoryId: 'job-1' }} />);
    expect(screen.getByRole('link', { name: /watch final video/i }).getAttribute('href')).toBe('/music-video/mv-1/review');
  });

  it('flags a run left over from before a server restart and offers to resume it', () => {
    render(<Harness initial={baseRun({ interrupted: true })} />);
    expect(screen.getByText(/interrupted — resume to continue/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /resume/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /pause/i })).toBeNull();
  });
});

describe('AutonomousRunPanel stage output', () => {
  const finished = (over = {}) => baseRun({
    status: 'running', stage: 'song',
    stages: stages({ style: { status: 'done' }, song: { status: 'done' } }),
    output: {
      title: 'Neon Rain', musicalDescription: 'Slow synthwave.', concept: { prompt: 'A courier in rain', style: 'Teal and magenta' },
      lyrics: '[verse]\nrain on glass', sunoStyle: 'synthwave, 90 bpm', moodBoardId: 'board-1', moodBoard: { name: 'Neon Rain board' },
      sunoSongIds: ['song-a', 'song-b'], songSource: 'suno',
    },
    ...over,
  });

  it('opens a finished stage’s output read-only from its row and writes the choice to the URL', () => {
    render(<Harness initial={finished()} />);
    expect(screen.queryByRole('region', { name: /lyrics output/i })).toBeNull();
    const row = screen.getByRole('button', { name: /lyrics/i });
    expect(row.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(row);
    const region = screen.getByRole('region', { name: /lyrics output/i });
    expect(region.textContent).toContain('rain on glass');
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('search').textContent).toBe('run-stage=lyrics');
    // Read-only: the stage output is text, not a form field.
    expect(region.querySelector('textarea, input')).toBeNull();

    fireEvent.click(row);
    expect(screen.queryByRole('region', { name: /lyrics output/i })).toBeNull();
    expect(screen.getByTestId('search').textContent).toBe('');
  });

  it('deep-links: a ?run-stage= URL opens that stage, and the style and song outputs stay viewable after the run moved on', () => {
    const { unmount } = render(<Harness initial={finished()} url="/music-video/mv-1?run-stage=style" />);
    const style = screen.getByRole('region', { name: /mood board & style output/i });
    expect(style.textContent).toContain('synthwave, 90 bpm');
    expect(style.textContent).toContain('Teal and magenta');
    // The run's mood board is a link to the board page.
    expect(screen.getByRole('link', { name: /neon rain board/i }).getAttribute('href')).toBe('/mood-boards/board-1');
    unmount();

    render(<Harness initial={finished({ status: 'completed', stage: 'produce' })} url="/music-video/mv-1?run-stage=song" />);
    expect(screen.getByRole('region', { name: /song output/i }).textContent).toContain('song-a, song-b');
  });

  it('opens nothing for a stage that has not finished, is not viewable, or is not a stage at all', () => {
    render(<Harness initial={finished({ stages: stages({ lyrics: { status: 'running' } }) })} url="/music-video/mv-1?run-stage=lyrics" />);
    expect(screen.queryByRole('region', { name: / output$/i })).toBeNull();
    // Unfinished and non-viewable rows are plain text, not buttons.
    expect(screen.queryByRole('button', { name: /produce video/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /analyze song/i })).toBeNull();
  });

  it('points a checkpoint stage at the approval box instead of offering a second editor', () => {
    render(<Harness initial={finished({ status: 'awaiting-approval', awaiting: 'lyrics', stage: 'style', stages: stages({ style: { status: 'pending' } }) })} url="/music-video/mv-1?run-stage=lyrics" />);
    expect(screen.getByRole('region', { name: /lyrics output/i }).textContent).toMatch(/edit this in the approval box/i);
    expect(screen.getAllByLabelText(/lyrics \(edit before continuing\)/i)).toHaveLength(1);
  });

  it('shows the Song stage’s current sub-step while it runs and updates it from a pushed event', async () => {
    const running = (step) => baseRun({ stage: 'song', stages: stages({ style: { status: 'done' }, song: { status: 'running', step } }) });
    render(<Harness initial={running('generating')} />);
    expect(screen.getByRole('status').textContent).toContain('Generating the song on Suno');

    await act(async () => {
      listeners.get('music-video:autonomous')({ projectId: 'mv-1', run: running('exporting'), project: { id: 'mv-1', autonomousRun: running('exporting') } });
    });
    expect(screen.getByRole('status').textContent).toContain('Exporting the M4A');
  });
});

describe('AutonomousStartDrawer', () => {
  it('requires an explicit compatible code author before starting with the free tools', async () => {
    api.startAutonomousMusicVideo.mockResolvedValue({ project: { id: 'mv-new', name: 'New' }, run: baseRun() });
    const onStarted = vi.fn();
    render(<AutonomousStartDrawer open onClose={() => {}} onStarted={onStarted} />);

    const submit = screen.getByRole('button', { name: /start autonomous video/i });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: '  a courier crosses a rainy city  ' } });
    expect(submit.disabled).toBe(true);
    expect(screen.queryByRole('option', { name: 'Fixture TUI' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Unverified CLI' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Code authoring provider'), { target: { value: 'fixture-api' } });
    fireEvent.click(submit);

    await waitFor(() => expect(onStarted).toHaveBeenCalledWith({ id: 'mv-new', name: 'New' }));
    const [body, options] = api.startAutonomousMusicVideo.mock.calls[0];
    expect(options).toEqual({ silent: true });
    expect(body).toEqual({
      prompt: 'a courier crosses a rainy city', mediaMode: 'code-images-video', songSource: 'suno', localFallback: false, instrumental: false, tools: ['image:local', 'video:local'],
      budgetUsd: null, limits: { maxGenerations: 40 }, checkpoints: [],
      authoring: { providerId: 'fixture-api', model: 'fixture-model' },
    });
  });

  it('sends the director’s picks: checkpoints, a per-tool model pin, a budget and code-only rendering', async () => {
    api.startAutonomousMusicVideo.mockResolvedValue({ project: { id: 'mv-new' }, run: baseRun() });
    render(<AutonomousStartDrawer open onClose={() => {}} onStarted={() => {}} />);
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'p' } });
    fireEvent.click(screen.getByLabelText('Lyrics', { selector: '#mv-auto-checkpoint-lyrics' }));
    await waitFor(() => expect(screen.getByRole('option', { name: 'Example image' })).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/local image gen model/i), { target: { value: 'example-image' } });
    fireEvent.change(screen.getByLabelText(/video generation budget/i), { target: { value: '12' } });
    await waitFor(() => expect(screen.getByRole('option', { name: 'Neon Rain' })).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Mood board'), { target: { value: 'mb-1' } });
    fireEvent.change(screen.getByLabelText('Code authoring provider'), { target: { value: 'fixture-api' } });
    fireEvent.click(screen.getByRole('button', { name: /start autonomous video/i }));
    await waitFor(() => expect(api.startAutonomousMusicVideo).toHaveBeenCalled());
    expect(api.startAutonomousMusicVideo.mock.calls[0][0]).toMatchObject({
      checkpoints: ['lyrics'], models: { 'image:local': 'example-image' }, budgetUsd: 12, moodBoardId: 'mb-1',
    });
  });

  it('sends the Suno form options only when set, and blocks an unrecognizable model version', async () => {
    api.startAutonomousMusicVideo.mockResolvedValue({ project: { id: 'mv-new' }, run: baseRun() });
    render(<AutonomousStartDrawer open onClose={() => {}} onStarted={() => {}} />);
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'p' } });
    fireEvent.change(screen.getByLabelText('Code authoring provider'), { target: { value: 'fixture-api' } });
    const submit = screen.getByRole('button', { name: /start autonomous video/i });
    fireEvent.change(screen.getByLabelText('Suno model'), { target: { value: 'latest' } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Suno model'), { target: { value: 'v6' } });
    fireEvent.change(screen.getByLabelText('Exclude styles'), { target: { value: ' metal ' } });
    fireEvent.change(screen.getByLabelText('Vocal gender'), { target: { value: 'female' } });
    fireEvent.click(submit);
    await waitFor(() => expect(api.startAutonomousMusicVideo).toHaveBeenCalledTimes(1));
    expect(api.startAutonomousMusicVideo.mock.calls[0][0].suno).toEqual({ excludeStyles: 'metal', vocalGender: 'female', model: 'v6' });
  });

  it('offers local video models in a menu and pins only the one the director picks', async () => {
    api.startAutonomousMusicVideo.mockResolvedValue({ project: { id: 'mv-new' }, run: baseRun() });
    render(<AutonomousStartDrawer open onClose={() => {}} onStarted={() => {}} />);
    const model = screen.getByLabelText(/local video gen model/i);
    expect(model.tagName).toBe('SELECT');
    expect(await screen.findByRole('option', { name: 'Install default (Example LTX)' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Example Wan' })).toBeTruthy();
    expect(model.value).toBe('');

    fireEvent.change(model, { target: { value: 'example-wan' } });
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'p' } });
    fireEvent.change(screen.getByLabelText('Code authoring provider'), { target: { value: 'fixture-api' } });
    fireEvent.click(screen.getByRole('button', { name: /start autonomous video/i }));
    await waitFor(() => expect(api.startAutonomousMusicVideo).toHaveBeenCalledTimes(1));
    expect(api.startAutonomousMusicVideo.mock.calls[0][0].models).toEqual({ 'video:local': 'example-wan' });
  });

  it('keeps the local video field a menu when the catalog cannot load or is empty', async () => {
    getVideoGenModelContext.mockRejectedValueOnce(new Error('offline'));
    const { unmount } = render(<AutonomousStartDrawer open onClose={() => {}} onStarted={() => {}} />);
    const failed = await screen.findByLabelText(/local video gen model/i);
    expect(failed.tagName).toBe('SELECT');
    expect(await screen.findByText('Could not load local video models.')).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Example Wan' })).toBeNull();
    unmount();

    getVideoGenModelContext.mockResolvedValueOnce({ models: [], defaultModel: null });
    render(<AutonomousStartDrawer open onClose={() => {}} onStarted={() => {}} />);
    expect(await screen.findByText('No local video models are compatible with this machine.')).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Install default (no compatible local model)' })).toBeTruthy();
  });

  it('offers the local song source, and the Suno-only fallback opt-in only while Suno is the source', async () => {
    api.startAutonomousMusicVideo.mockResolvedValue({ project: { id: 'mv-new' }, run: baseRun() });
    render(<AutonomousStartDrawer open onClose={() => {}} onStarted={() => {}} />);
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'p' } });
    fireEvent.click(screen.getByLabelText(/render locally if suno is unavailable/i));
    fireEvent.change(screen.getByLabelText('Code authoring provider'), { target: { value: 'fixture-api' } });
    fireEvent.click(screen.getByRole('button', { name: /start autonomous video/i }));
    await waitFor(() => expect(api.startAutonomousMusicVideo).toHaveBeenCalledTimes(1));
    expect(api.startAutonomousMusicVideo.mock.calls[0][0]).toMatchObject({ songSource: 'suno', localFallback: true });

    fireEvent.change(screen.getByLabelText('Song source'), { target: { value: 'local' } });
    expect(screen.queryByLabelText(/render locally if suno is unavailable/i)).toBeNull();
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'p' } });
    fireEvent.change(screen.getByLabelText('Code authoring provider'), { target: { value: 'fixture-api' } });
    fireEvent.click(screen.getByRole('button', { name: /start autonomous video/i }));
    await waitFor(() => expect(api.startAutonomousMusicVideo).toHaveBeenCalledTimes(2));
    // The stale fallback tick must not ride along once Suno is no longer the source.
    expect(api.startAutonomousMusicVideo.mock.calls[1][0]).toMatchObject({ songSource: 'local', localFallback: false });
  });
});

describe('auto-approve the rest', () => {
  const refusal = () => Object.assign(new Error('Sign in to grant automatic planning approvals.'), { status: 401, code: 'AUTH_REQUIRED' });

  it('starts with selected planning grants using the session and shows sign-in failures inline', async () => {
    api.startAutonomousMusicVideo.mockRejectedValueOnce(refusal()).mockResolvedValue({ project: { id: 'mv-new' }, run: baseRun() });
    render(<AutonomousStartDrawer open onClose={() => {}} onStarted={() => {}} />);
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'p' } });
    fireEvent.change(screen.getByLabelText('Code authoring provider'), { target: { value: 'fixture-api' } });
    expect(screen.queryByLabelText('Instance password to grant this')).toBeNull();
    expect(screen.queryByLabelText('Proof', { selector: '#mv-auto-auto-approve-proof' })).toBeNull();
    fireEvent.click(screen.getByLabelText('Art', { selector: '#mv-auto-auto-approve-art' }));
    const submit = screen.getByRole('button', { name: /start autonomous video/i });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Sign in to grant automatic planning approvals'));
    expect(api.startAutonomousMusicVideo.mock.calls[0][0]).toMatchObject({ autoApprove: ['art'] });
    fireEvent.click(submit);
    await waitFor(() => expect(api.startAutonomousMusicVideo).toHaveBeenCalledTimes(2));
    expect(api.startAutonomousMusicVideo.mock.calls[1][0]).toMatchObject({ autoApprove: ['art'] });
  });

  it('shows existing planning grants and sends an explicit empty list when revoked', async () => {
    api.resumeAutonomousMusicVideo.mockResolvedValue({ project: { id: 'mv-1', autonomousRun: baseRun() }, run: baseRun() });
    render(<Harness initial={baseRun({ status: 'needs-human', stage: 'produce', brief: { autoApprove: ['art'] } })} />);
    const art = screen.getByLabelText('Art', { selector: '#mv-run-auto-approve-art' });
    expect(art.checked).toBe(true);
    fireEvent.click(art);
    fireEvent.click(screen.getByRole('button', { name: /resume/i }));
    await waitFor(() => expect(api.resumeAutonomousMusicVideo).toHaveBeenCalledWith('mv-1', { autoApprove: [] }, { silent: true }));
  });

  it('resumes a parked run with session-authorized planning grants and shows sign-in failures', async () => {
    api.resumeAutonomousMusicVideo.mockRejectedValueOnce(refusal()).mockResolvedValue({ project: { id: 'mv-1', autonomousRun: baseRun() }, run: baseRun() });
    render(<Harness initial={baseRun({ status: 'needs-human', stage: 'produce', error: 'Review and approve the current art direction first.', brief: { origin: { kind: 'manual' }, autoApprove: [] } })} />);
    for (const stage of ['storyboard', 'art']) fireEvent.click(screen.getByLabelText(stage[0].toUpperCase() + stage.slice(1), { selector: `#mv-run-auto-approve-${stage}` }));
    const resume = screen.getByRole('button', { name: /resume/i });
    expect(resume.disabled).toBe(false);
    fireEvent.click(resume);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Sign in to grant automatic planning approvals'));
    expect(api.resumeAutonomousMusicVideo).toHaveBeenLastCalledWith('mv-1', { autoApprove: ['art', 'storyboard'] }, { silent: true });
    fireEvent.click(resume);
    await waitFor(() => expect(api.resumeAutonomousMusicVideo).toHaveBeenLastCalledWith('mv-1', { autoApprove: ['art', 'storyboard'] }, { silent: true }));
  });
});

describe('Current autonomous review guidance', () => {
  it('keeps an approval failure historical as the current review gate advances', () => {
    const error = 'Review and approve the current art direction first.';
    const project = { id: 'history-fixture', autonomousRun: baseRun({ status: 'needs-human', stage: 'produce', error, errorCode: 'MUSIC_VIDEO_APPROVAL_REQUIRED' }) };
    const auto = { busy: false, resume: vi.fn(), cancel: vi.fn() };
    const readiness = { art: { approved: true, problems: [] }, storyboard: { approved: false, problems: ['Approve the current lyric-timed storyboard.'] }, proof: { approved: false, problems: ['Render and watch a current animated chorus proof with the master song.'] } };
    const view = render(<MemoryRouter><AutonomousRunPanel project={project} auto={auto} readiness={readiness} /></MemoryRouter>);
    expect(screen.getByRole('status')).toHaveTextContent('Approve the current lyric-timed storyboard.');
    expect(screen.getByText(`Historical stop reason: ${error}`)).toBeTruthy();
    // The optional proof never holds the run: storyboard approval is enough to resume.
    view.rerender(<MemoryRouter><AutonomousRunPanel project={project} auto={auto} readiness={{ ...readiness, storyboard: { approved: true, problems: [] } }} /></MemoryRouter>);
    expect(screen.getByRole('status')).toHaveTextContent('ready to resume explicitly');
    expect(auto.resume).not.toHaveBeenCalled();
  });
});

describe('orchestrated mode', () => {
  it('sends the orchestrator instead of checkpoints and planning grants, and shows a sign-in refusal inline', async () => {
    const refusal = Object.assign(new Error('Sign in to start an orchestrated run: the orchestrator approves stages for you.'), { status: 401, code: 'AUTH_REQUIRED' });
    api.startAutonomousMusicVideo.mockRejectedValueOnce(refusal).mockResolvedValue({ project: { id: 'mv-new' }, run: baseRun() });
    render(<AutonomousStartDrawer open onClose={() => {}} onStarted={() => {}} />);
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'p' } });
    fireEvent.change(screen.getByLabelText('Code authoring provider'), { target: { value: 'fixture-api' } });
    fireEvent.click(screen.getByLabelText('Lyrics', { selector: '#mv-auto-checkpoint-lyrics' }));
    fireEvent.change(screen.getByLabelText('Who reviews each step'), { target: { value: 'orchestrated' } });
    // The orchestrator clears every review point, so the director's stops and grants go away.
    expect(screen.queryByLabelText('Lyrics', { selector: '#mv-auto-checkpoint-lyrics' })).toBeNull();
    expect(screen.queryByLabelText('Art', { selector: '#mv-auto-auto-approve-art' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Revisions per step'), { target: { value: '2' } });
    const submit = screen.getByRole('button', { name: /start autonomous video/i });
    fireEvent.click(submit);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Sign in to start an orchestrated run'));
    const [body] = api.startAutonomousMusicVideo.mock.calls[0];
    expect(body).toMatchObject({ checkpoints: [], orchestrator: { providerId: 'fixture-api', model: 'fixture-model' }, limits: { maxGenerations: 40, maxReviewAttempts: 2 } });
    expect(body.autoApprove).toBeUndefined();
  });

  it('shows who orchestrates and its latest decision, folding the earlier ones', () => {
    const run = baseRun({ status: 'running', stage: 'produce', brief: { origin: { kind: 'manual' }, orchestrator: { providerId: 'fixture-api', model: 'judge', effort: 'high' } },
      orchestration: { reviews: [
        { id: 'r1', checkpoint: 'lyrics', verdict: 'revise', score: 5, notes: 'The hook never repeats.', route: { providerId: 'fixture-api' } },
        { id: 'r2', checkpoint: 'final', verdict: 'noted', score: 6, notes: 'The ending drags.', issues: [{ atSec: 75, text: 'Static hold' }], route: { providerId: 'fixture-api' } },
      ] } });
    render(<Harness initial={run} />);
    expect(screen.getByText('Orchestrated by fixture-api / judge · high')).toBeTruthy();
    const log = screen.getByLabelText('Orchestrator decisions');
    expect(log.textContent).toContain('Final video');
    expect(log.textContent).toContain('1:15.00 Static hold');
    expect(screen.getByText('Earlier decisions (1)')).toBeTruthy();
    // The orchestrator approves planning, so the run offers no grant chips.
    expect(screen.queryByLabelText('Art', { selector: '#mv-run-auto-approve-art' })).toBeNull();
  });
});
