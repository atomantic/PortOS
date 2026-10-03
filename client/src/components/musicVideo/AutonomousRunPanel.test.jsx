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
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('../../hooks/useProviderModels.js', () => ({
  default: ({ filter } = {}) => ({
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

function Harness({ initial, url = '/music-video/mv-1' }) {
  const [project, setProject] = useState({ id: 'mv-1', autonomousRun: initial });
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

  it('offers a retry for a run that needs the director, and shows why', async () => {
    api.resumeAutonomousMusicVideo.mockResolvedValue({ project: { id: 'mv-1', autonomousRun: baseRun() }, run: baseRun() });
    render(<Harness initial={baseRun({ status: 'needs-human', stage: 'song', error: 'Sign in to Suno in the PortOS Browser' })} />);
    expect(screen.getByRole('status').textContent).toContain('Sign in to Suno');
    fireEvent.click(screen.getByRole('button', { name: /resume/i }));
    await waitFor(() => expect(api.resumeAutonomousMusicVideo).toHaveBeenCalledWith('mv-1', {}, { silent: true }));
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
    fireEvent.change(screen.getByLabelText(/local image gen model/i), { target: { value: 'flux2-dev' } });
    fireEvent.change(screen.getByLabelText(/budget cap/i), { target: { value: '12' } });
    await waitFor(() => expect(screen.getByRole('option', { name: 'Neon Rain' })).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Mood board'), { target: { value: 'mb-1' } });
    fireEvent.change(screen.getByLabelText('Code authoring provider'), { target: { value: 'fixture-api' } });
    fireEvent.click(screen.getByRole('button', { name: /start autonomous video/i }));
    await waitFor(() => expect(api.startAutonomousMusicVideo).toHaveBeenCalled());
    expect(api.startAutonomousMusicVideo.mock.calls[0][0]).toMatchObject({
      checkpoints: ['lyrics'], models: { 'image:local': 'flux2-dev' }, budgetUsd: 12, moodBoardId: 'mb-1',
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
  const refusal = () => Object.assign(new Error('Enter the instance password yourself to let the run approve production review stages.'), { status: 403, code: 'OPERATOR_REAUTH_REQUIRED' });

  it('starts with the picked stages and the password, asking for the password only once a stage is picked, and shows a refusal inline', async () => {
    api.startAutonomousMusicVideo.mockRejectedValueOnce(refusal()).mockResolvedValue({ project: { id: 'mv-new' }, run: baseRun() });
    render(<AutonomousStartDrawer open onClose={() => {}} onStarted={() => {}} />);
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'p' } });
    fireEvent.change(screen.getByLabelText('Code authoring provider'), { target: { value: 'fixture-api' } });
    expect(screen.queryByLabelText('Instance password to grant this')).toBeNull();
    fireEvent.click(screen.getByLabelText('Proof', { selector: '#mv-auto-auto-approve-proof' }));
    fireEvent.click(screen.getByLabelText('Art', { selector: '#mv-auto-auto-approve-art' }));
    const submit = screen.getByRole('button', { name: /start autonomous video/i });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Instance password to grant this'), { target: { value: 'wrong-password' } });
    fireEvent.click(submit);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Enter the instance password yourself'));
    expect(api.startAutonomousMusicVideo.mock.calls[0][0]).toMatchObject({ autoApprove: ['art', 'proof'], password: 'wrong-password' });
    // The password is never kept for a retry.
    expect(screen.getByLabelText('Instance password to grant this').value).toBe('');
    fireEvent.change(screen.getByLabelText('Instance password to grant this'), { target: { value: 'synthetic-password' } });
    fireEvent.click(submit);
    await waitFor(() => expect(api.startAutonomousMusicVideo).toHaveBeenCalledTimes(2));
    expect(api.startAutonomousMusicVideo.mock.calls[1][0]).toMatchObject({ autoApprove: ['art', 'proof'], password: 'synthetic-password' });
  });

  it('resumes a parked run with "auto-approve the rest", showing a refused password next to the control', async () => {
    api.resumeAutonomousMusicVideo.mockRejectedValueOnce(refusal()).mockResolvedValue({ project: { id: 'mv-1', autonomousRun: baseRun() }, run: baseRun() });
    render(<Harness initial={baseRun({ status: 'needs-human', stage: 'produce', error: 'Review and approve the current art direction first.', brief: { origin: { kind: 'manual' }, autoApprove: [] } })} />);
    for (const stage of ['storyboard', 'art', 'proof']) fireEvent.click(screen.getByLabelText(stage[0].toUpperCase() + stage.slice(1), { selector: `#mv-run-auto-approve-${stage}` }));
    const resume = screen.getByRole('button', { name: /resume/i });
    expect(resume.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Instance password to grant this'), { target: { value: 'wrong-password' } });
    fireEvent.click(resume);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Enter the instance password yourself'));
    expect(api.resumeAutonomousMusicVideo).toHaveBeenLastCalledWith('mv-1', { autoApprove: ['art', 'storyboard', 'proof'], password: 'wrong-password' }, { silent: true });
    fireEvent.change(screen.getByLabelText('Instance password to grant this'), { target: { value: 'synthetic-password' } });
    fireEvent.click(resume);
    await waitFor(() => expect(api.resumeAutonomousMusicVideo).toHaveBeenLastCalledWith('mv-1', { autoApprove: ['art', 'storyboard', 'proof'], password: 'synthetic-password' }, { silent: true }));
  });
});
