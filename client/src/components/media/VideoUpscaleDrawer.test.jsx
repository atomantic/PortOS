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
  baseModel: {
    id: 'ltx25_mlx_q8', name: 'LTX-2.5 MLX Q8', repo: 'Example/ltx25-mlx-q8', revision: 'abc1234',
    path: '/cache/ltx25-mlx-q8', cached: true, reason: null,
    hardwareCompatibility: { state: 'available', reasons: [], requirements: {} },
  },
};

const missingAdapterPlan = () => ({
  ...READY_PLAN,
  adapter: { ...READY_PLAN.adapter, cached: false },
});

const missingBaseModelPlan = () => ({
  ...READY_PLAN,
  baseModel: {
    ...READY_PLAN.baseModel,
    path: null,
    cached: false,
    reason: 'LTX-2.5 MLX Q8 is not downloaded — download or repair it in Video Gen.',
  },
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

  it('choosing the generative method submits method: "ltx" and closes on the queued job', async () => {
    // The generative pass answers with a QUEUED JOB, not a finished row (#6511),
    // so the drawer must close on `job` instead of waiting for a `video` that
    // only arrives minutes later, in history.
    upscaleVideo.mockResolvedValue({ ok: true, job: { jobId: 'job-1', position: 1, status: 'queued' } });
    const onClose = vi.fn();
    const onUpscaled = vi.fn();
    render(<VideoUpscaleDrawer item={ITEM} onClose={onClose} onUpscaled={onUpscaled} />);
    await waitFor(() => expect(getUpscalePlan).toHaveBeenCalled());

    fireEvent.click(screen.getByLabelText(/LTX-2\.5 generative/i));
    fireEvent.click(screen.getByRole('button', { name: /upscale 2×/i }));

    await waitFor(() => expect(upscaleVideo).toHaveBeenCalledWith('video-1', { method: 'ltx', silent: true }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onUpscaled).not.toHaveBeenCalled();
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

  // #6512: the base pack is a third, independent download. Before this the
  // drawer read ready off runtime + adapter alone and offered a button for a
  // job the dispatch refuses with UPSCALE_BASE_MODEL_UNRESOLVED.
  it('disables the generative method when the base model pack is missing', async () => {
    getUpscalePlan.mockResolvedValue({ plan: missingBaseModelPlan() });
    render(<VideoUpscaleDrawer item={ITEM} onClose={vi.fn()} onUpscaled={vi.fn()} />);
    await waitFor(() => expect(getUpscalePlan).toHaveBeenCalled());

    expect(screen.getByLabelText(/LTX-2\.5 generative/i).disabled).toBe(true);
    expect(screen.getByText(/is not downloaded/i)).toBeTruthy();
  });

  // #6537: the host is a fourth axis. Every download can be present on a machine
  // that still cannot run the pack — the CUDA pack asks for 64 GB of system
  // memory, and on a 32 GB host the render dies inside the runtime's own loader
  // seconds in. The dispatch refuses that host, so the button must not offer it.
  it('disables the generative method when the host cannot run the pack, even with everything downloaded', async () => {
    getUpscalePlan.mockResolvedValue({
      plan: {
        ...READY_PLAN,
        baseModel: {
          ...READY_PLAN.baseModel,
          name: 'LTX-2.5 CUDA Distilled',
          hardwareCompatibility: {
            state: 'unavailable',
            reasons: ['Requires at least 64 GB of system memory'],
            requirements: { minMemoryGb: 64 },
          },
        },
      },
    });
    render(<VideoUpscaleDrawer item={ITEM} onClose={vi.fn()} onUpscaled={vi.fn()} />);
    await waitFor(() => expect(getUpscalePlan).toHaveBeenCalled());

    expect(screen.getByLabelText(/LTX-2\.5 generative/i).disabled).toBe(true);
    expect(screen.getByText(/unavailable on this machine/i)).toBeTruthy();
    // The adapter IS cached here, so the inline download button would be a
    // pointless offer — a 327 MB pull that changes nothing about the refusal.
    expect(screen.queryByText(/Download adapter/i)).toBeNull();
  });

  // Forward-compat: a plan from an older server carries no annotation. Absent must
  // not read as incompatible, or updating the client alone would disable a
  // button that install has always been able to press.
  it('stays enabled when an older plan carries no host annotation', async () => {
    const { hardwareCompatibility, ...baseModel } = READY_PLAN.baseModel;
    getUpscalePlan.mockResolvedValue({ plan: { ...READY_PLAN, baseModel } });
    render(<VideoUpscaleDrawer item={ITEM} onClose={vi.fn()} onUpscaled={vi.fn()} />);
    await waitFor(() => expect(getUpscalePlan).toHaveBeenCalled());

    expect(screen.getByLabelText(/LTX-2\.5 generative/i).disabled).toBe(false);
  });
});
