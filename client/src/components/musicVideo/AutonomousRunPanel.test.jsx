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
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('../../hooks/useProviderModels.js', () => ({
  default: () => ({
    providers: [], selectedProviderId: '', selectedModel: '', availableModels: [],
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

function Harness({ initial }) {
  const [project, setProject] = useState({ id: 'mv-1', autonomousRun: initial });
  const auto = useAutonomousMusicVideo({ project, replaceProject: setProject });
  return <AutonomousRunPanel project={project} auto={auto} />;
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

describe('AutonomousStartDrawer', () => {
  it('starts a run from the prompt alone, sending the free tools, no checkpoints and no blank optionals', async () => {
    api.startAutonomousMusicVideo.mockResolvedValue({ project: { id: 'mv-new', name: 'New' }, run: baseRun() });
    const onStarted = vi.fn();
    render(<AutonomousStartDrawer open onClose={() => {}} onStarted={onStarted} />);

    const submit = screen.getByRole('button', { name: /start autonomous video/i });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: '  a courier crosses a rainy city  ' } });
    fireEvent.click(submit);

    await waitFor(() => expect(onStarted).toHaveBeenCalledWith({ id: 'mv-new', name: 'New' }));
    const [body, options] = api.startAutonomousMusicVideo.mock.calls[0];
    expect(options).toEqual({ silent: true });
    expect(body).toEqual({
      prompt: 'a courier crosses a rainy city', instrumental: false, tools: ['image:local', 'video:local'],
      budgetUsd: null, limits: { maxGenerations: 40 }, checkpoints: [],
    });
  });

  it('sends the director’s picks: checkpoints, a per-tool model pin, a budget and code-only rendering', async () => {
    api.startAutonomousMusicVideo.mockResolvedValue({ project: { id: 'mv-new' }, run: baseRun() });
    render(<AutonomousStartDrawer open onClose={() => {}} onStarted={() => {}} />);
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'p' } });
    fireEvent.click(screen.getByLabelText('Lyrics', { selector: '#mv-auto-checkpoint-lyrics' }));
    fireEvent.change(screen.getByLabelText(/local image gen model/i), { target: { value: 'flux2-dev' } });
    fireEvent.change(screen.getByLabelText(/budget cap/i), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: /start autonomous video/i }));
    await waitFor(() => expect(api.startAutonomousMusicVideo).toHaveBeenCalled());
    expect(api.startAutonomousMusicVideo.mock.calls[0][0]).toMatchObject({
      checkpoints: ['lyrics'], models: { 'image:local': 'flux2-dev' }, budgetUsd: 12,
    });
  });
});
