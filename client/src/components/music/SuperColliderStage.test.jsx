import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import SuperColliderStage from './SuperColliderStage';
import * as api from '../../services/api';
import toast from '../ui/Toast';
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
import { useSseProgress } from '../../hooks/useSseProgress';

vi.mock('../../services/api', () => ({
  getSuperColliderStatus: vi.fn(),
  setupSuperCollider: vi.fn(),
  renderSuperCollider: vi.fn(),
  cancelSuperColliderRender: vi.fn(),
  saveSuperColliderTake: vi.fn(),
  superColliderRenderEventsUrl: (id) => `/events/${id}`,
}));
vi.mock('../../hooks/useSseProgress', () => ({ useSseProgress: vi.fn() }));

const CODE = 'Pbind(\\degree, Pseq([0, 2, 4], inf))';
const READY = { state: 'ready', ready: true, message: 'ready', action: '' };
const PREVIEW = {
  jobId: 'job-12345678', audioUrl: '/api/music/supercollider/renders/job-12345678/audio', seed: 7,
  settings: { durationSec: 8, sampleRate: 48000 },
};

const mount = (props = {}) => render(
  <SuperColliderStage code={CODE} durationSec={8} trackId="track-1" description="a drone" title="Drone" {...props} />,
);

describe('<SuperColliderStage>', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSseProgress.mockReturnValue({ latest: null });
    api.getSuperColliderStatus.mockResolvedValue(READY);
    api.renderSuperCollider.mockResolvedValue({ jobId: 'job-12345678', position: 1, seed: 7 });
    api.saveSuperColliderTake.mockResolvedValue({ track: { id: 'track-1' }, durationSec: 8 });
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('offers setup, without building, when the runtime is not ready', async () => {
    api.getSuperColliderStatus.mockResolvedValue({ state: 'image-missing', ready: false, message: 'image not built', action: 'Run setup' });
    api.setupSuperCollider.mockResolvedValue();
    mount();
    expect(await screen.findByText(/image not built/)).toBeTruthy();
    expect(api.setupSuperCollider).not.toHaveBeenCalled();
    expect(screen.queryByText('Render preview')).toBeNull();
    fireEvent.click(screen.getByText('Set up SuperCollider'));
    await waitFor(() => expect(api.setupSuperCollider).toHaveBeenCalledWith({ rebuild: false }, expect.any(Function)));
  });

  it('renders a preview without saving, then saves exactly that job as the take', async () => {
    const onRendered = vi.fn();
    const ui = (code) => <SuperColliderStage code={code} durationSec={8} trackId="track-1" description="a drone" title="Drone" onRendered={onRendered} />;
    const { rerender } = render(ui(CODE));
    fireEvent.click(await screen.findByText('Render preview'));
    await waitFor(() => expect(api.renderSuperCollider).toHaveBeenCalledWith({ code: CODE, durationSec: 8 }, { silent: true }));
    expect(api.saveSuperColliderTake).not.toHaveBeenCalled();

    useSseProgress.mockReturnValue({ latest: { type: 'complete', result: PREVIEW } });
    rerender(ui(CODE));
    expect(await screen.findByLabelText('SuperCollider preview')).toBeTruthy();
    expect(api.saveSuperColliderTake).not.toHaveBeenCalled(); // previewing never saves

    fireEvent.click(screen.getByText('Save as take'));
    await waitFor(() => expect(api.saveSuperColliderTake).toHaveBeenCalledWith('track-1', { jobId: 'job-12345678', prompt: 'a drone', title: 'Drone' }, { silent: true }));
    await waitFor(() => expect(onRendered).toHaveBeenCalledWith({ id: 'track-1' }));
  });

  it('blocks saving a preview once the code has changed', async () => {
    const ui = (code) => <SuperColliderStage code={code} durationSec={8} trackId="track-1" />;
    const { rerender } = render(ui(CODE));
    fireEvent.click(await screen.findByText('Render preview'));
    await waitFor(() => expect(api.renderSuperCollider).toHaveBeenCalled());
    useSseProgress.mockReturnValue({ latest: { type: 'complete', result: PREVIEW } });
    rerender(ui(CODE));
    await screen.findByLabelText('SuperCollider preview');
    rerender(ui(CODE + ' // edited'));
    expect(screen.getByText('Save as take').closest('button').disabled).toBe(true);
  });

  it('shows a failed render and leaves nothing to save', async () => {
    const ui = () => <SuperColliderStage code={CODE} durationSec={8} trackId="track-1" />;
    const { rerender } = render(ui());
    fireEvent.click(await screen.findByText('Render preview'));
    await waitFor(() => expect(api.renderSuperCollider).toHaveBeenCalled());
    useSseProgress.mockReturnValue({ latest: { type: 'error', error: 'parse error at line 2' } });
    rerender(ui());
    expect((await screen.findByRole('alert')).textContent).toContain('parse error at line 2');
    expect(screen.queryByText('Save as take')).toBeNull();
    expect(api.saveSuperColliderTake).not.toHaveBeenCalled();
  });
});

it('does not report readiness when the real setup stream ends without completion', async () => {
  const { setupSuperCollider } = await import('../../services/apiMusic.js');
  api.setupSuperCollider.mockImplementation(setupSuperCollider);
  api.getSuperColliderStatus.mockResolvedValue({ state: 'image-missing', ready: false, message: 'not built' });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: new ReadableStream({ start(c) { c.close(); } }) }));
  mount();
  fireEvent.click(await screen.findByText('Set up SuperCollider'));
  await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
  expect(toast.success).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
