import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import VideoUpscaleDrawer from './VideoUpscaleDrawer';
import { upscaleVideo, getUpscalePlan } from '../../services/apiImageVideo';

vi.mock('../../services/apiImageVideo', () => ({
  upscaleVideo: vi.fn(),
  getUpscalePlan: vi.fn(),
  upscaleAdapterDownloadUrl: vi.fn(() => null),
}));

vi.mock('../ui/Toast', () => ({
  default: { loading: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

const ITEM = { id: 'video-1' };

const READY_PLAN = {
  id: 'video-1',
  method: 'ltx',
  scale: 2,
  alreadyUpscaled: false,
  source: { width: 848, height: 480, fps: 24, frameCount: 121, durationSeconds: 5, hasAudio: false },
  target: { width: 1728, height: 960, frameCount: 129 },
  alignment: {
    spatialMultiple: 64,
    padWidth: 32,
    padHeight: 16,
    padFrames: 8,
    trimFrames: 0,
    paddedSource: { width: 864, height: 480, frameCount: 129 },
    conforming: false,
  },
  runtime: { id: 'ltx25', label: 'LTX-2.5 MLX', supported: true, installed: true, reason: null },
  adapter: {
    key: 'pixel-upscale', label: 'Pixel Spatial Upscaler', repo: 'Lightricks/example', filename: 'weight.safetensors',
    sizeBytes: 327_322_640, gated: true, cached: true,
  },
};

const missingAdapterPlan = () => ({
  ...READY_PLAN,
  adapter: { ...READY_PLAN.adapter, cached: false },
});

const unsupportedRuntimePlan = () => ({
  ...READY_PLAN,
  runtime: { id: null, label: null, supported: false, installed: false, reason: 'No generative upscale backend exists for this platform.' },
  adapter: { ...READY_PLAN.adapter, cached: false },
});

beforeEach(() => {
  vi.clearAllMocks();
  getUpscalePlan.mockResolvedValue({ plan: READY_PLAN });
  upscaleVideo.mockResolvedValue({ ok: true, video: { id: 'video-2', upscaledFrom: 'video-1' } });
});

describe('VideoUpscaleDrawer', () => {
  it('opening the drawer fetches the plan but queues no mutation', async () => {
    render(<VideoUpscaleDrawer item={ITEM} onClose={vi.fn()} onUpscaled={vi.fn()} />);

    await waitFor(() => expect(getUpscalePlan).toHaveBeenCalledWith('video-1', 'ltx'));
    expect(upscaleVideo).not.toHaveBeenCalled();
  });

  it('choosing Lanczos (the default) submits method: "lanczos"', async () => {
    const onUpscaled = vi.fn();
    render(<VideoUpscaleDrawer item={ITEM} onClose={vi.fn()} onUpscaled={onUpscaled} />);
    await waitFor(() => expect(getUpscalePlan).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: /upscale 2×/i }));

    await waitFor(() => expect(upscaleVideo).toHaveBeenCalledWith('video-1', { method: 'lanczos', silent: true }));
    await waitFor(() => expect(onUpscaled).toHaveBeenCalledWith({ id: 'video-2', upscaledFrom: 'video-1' }));
  });

  it('choosing the generative method submits method: "ltx"', async () => {
    render(<VideoUpscaleDrawer item={ITEM} onClose={vi.fn()} onUpscaled={vi.fn()} />);
    await waitFor(() => expect(getUpscalePlan).toHaveBeenCalled());

    fireEvent.click(screen.getByLabelText(/LTX-2\.5 generative/i));
    fireEvent.click(screen.getByRole('button', { name: /upscale 2×/i }));

    await waitFor(() => expect(upscaleVideo).toHaveBeenCalledWith('video-1', { method: 'ltx', silent: true }));
  });

  it('renders target dimensions and the synthesized-detail warning once generative is picked', async () => {
    render(<VideoUpscaleDrawer item={ITEM} onClose={vi.fn()} onUpscaled={vi.fn()} />);
    await waitFor(() => expect(getUpscalePlan).toHaveBeenCalled());

    fireEvent.click(screen.getByLabelText(/LTX-2\.5 generative/i));

    expect(screen.getByText(/1728×960/)).toBeTruthy();
    expect(screen.getByText(/synthesized, not pixel-faithfully refined/i)).toBeTruthy();
  });

  it('disables the generative option with a reason when the adapter is not cached', async () => {
    getUpscalePlan.mockResolvedValue({ plan: missingAdapterPlan() });
    render(<VideoUpscaleDrawer item={ITEM} onClose={vi.fn()} onUpscaled={vi.fn()} />);

    const radio = await screen.findByLabelText(/LTX-2\.5 generative/i);
    await waitFor(() => expect(radio).toBeDisabled());
    expect(screen.getByText(/adapter is not downloaded yet/i)).toBeTruthy();
  });

  it('disables the generative option with a reason when the runtime is unready', async () => {
    getUpscalePlan.mockResolvedValue({ plan: unsupportedRuntimePlan() });
    render(<VideoUpscaleDrawer item={ITEM} onClose={vi.fn()} onUpscaled={vi.fn()} />);

    const radio = await screen.findByLabelText(/LTX-2\.5 generative/i);
    await waitFor(() => expect(radio).toBeDisabled());
    expect(screen.getByText(/no generative upscale backend exists/i)).toBeTruthy();
  });

  it('renders nothing when no item is open', () => {
    render(<VideoUpscaleDrawer item={null} onClose={vi.fn()} onUpscaled={vi.fn()} />);
    expect(getUpscalePlan).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeFalsy();
  });
});
