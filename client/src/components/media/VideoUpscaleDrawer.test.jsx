import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import VideoUpscaleDrawer from './VideoUpscaleDrawer';
import { upscaleVideo, getUpscalePlan, upscaleAdapterDownloadUrl, quoteTopazUpscale, startTopazUpscale } from '../../services/apiImageVideo';

vi.mock('../../services/apiImageVideo', () => ({
  upscaleVideo: vi.fn(),
  getUpscalePlan: vi.fn(),
  upscaleAdapterDownloadUrl: vi.fn(() => null),
  quoteTopazUpscale: vi.fn(),
  startTopazUpscale: vi.fn(),
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

afterEach(() => vi.unstubAllGlobals());

describe('VideoUpscaleDrawer', () => {
  it('requires an explicit estimate and start before submitting Topaz', async () => {
    quoteTopazUpscale.mockResolvedValue({ quote: { token: 'quote-1', source: { resolution: { width: 640, height: 480 } }, padding: { width: 864, height: 486 }, target: { width: 1920, height: 1080 }, credits: [8, 9] } });
    startTopazUpscale.mockResolvedValue({ job: { jobId: 'job-1' } });
    render(<VideoUpscaleDrawer item={ITEM} onClose={vi.fn()} onUpscaled={vi.fn()} />);
    fireEvent.click(screen.getByLabelText(/Topaz Labs cloud/));
    expect(screen.getByRole('button', { name: 'Start Topaz upscale' })).toBeDisabled();
    expect(quoteTopazUpscale).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Get free estimate' }));
    expect(await screen.findByText(/Estimated 8–9 credits/)).toBeInTheDocument();
    expect(startTopazUpscale).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Start Topaz upscale' }));
    await waitFor(() => expect(startTopazUpscale).toHaveBeenCalledWith('video-1', 'quote-1', { silent: true }));
  });
  it('downloads the adapter through POST and allows an explicit retry after a dropped stream', async () => {
    getUpscalePlan.mockResolvedValue({ plan: missingAdapterPlan() });
    upscaleAdapterDownloadUrl.mockReturnValue('/api/video-gen/ic-loras/pixel-upscale/download');
    const fetchMock = vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.close(); } })));
    vi.stubGlobal('fetch', fetchMock);
    render(<VideoUpscaleDrawer item={ITEM} onClose={vi.fn()} onUpscaled={vi.fn()} />);
    fireEvent.click(await screen.findByText(/^Download adapter/));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await screen.findByText(/^Download adapter/);
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    fireEvent.click(screen.getByText(/^Download adapter/));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await screen.findByText(/^Download adapter/);
  });
  it('closing the mounted drawer aborts its download and does not restart for another item', async () => {
    getUpscalePlan.mockResolvedValue({ plan: missingAdapterPlan() });
    upscaleAdapterDownloadUrl.mockReturnValue('/api/video-gen/ic-loras/pixel-upscale/download');
    const fetchMock = vi.fn(async () => new Response(new ReadableStream({ start() {} })));
    vi.stubGlobal('fetch', fetchMock);
    const view = render(<VideoUpscaleDrawer item={ITEM} onClose={vi.fn()} onUpscaled={vi.fn()} />);
    fireEvent.click(await screen.findByText(/^Download adapter/));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    view.rerender(<VideoUpscaleDrawer item={null} onClose={vi.fn()} onUpscaled={vi.fn()} />);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    view.rerender(<VideoUpscaleDrawer item={{ id: 'video-other' }} onClose={vi.fn()} onUpscaled={vi.fn()} />);
    await screen.findByText(/^Download adapter/);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('ignores an old download completion plan response after the item changes', async () => {
    let finishOldPlan;
    getUpscalePlan.mockResolvedValueOnce({ plan: missingAdapterPlan() })
      .mockImplementationOnce(() => new Promise(resolve => { finishOldPlan = resolve; }))
      .mockResolvedValueOnce({ plan: READY_PLAN });
    upscaleAdapterDownloadUrl.mockReturnValue('/api/video-gen/ic-loras/pixel-upscale/download');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('data: {"type":"complete"}\n\n')));
    const view = render(<VideoUpscaleDrawer item={ITEM} onClose={vi.fn()} onUpscaled={vi.fn()} />);
    fireEvent.click(await screen.findByText(/^Download adapter/));
    await waitFor(() => expect(getUpscalePlan).toHaveBeenCalledTimes(2));
    view.rerender(<VideoUpscaleDrawer item={{ id: 'video-other' }} onClose={vi.fn()} onUpscaled={vi.fn()} />);
    const radio = screen.getByRole('radio', { name: /LTX-2.5 generative/ });
    await waitFor(() => expect(radio).not.toBeDisabled());
    await act(async () => finishOldPlan({ plan: missingAdapterPlan() }));
    expect(radio).not.toBeDisabled();
    expect(screen.queryByText(/^Download adapter/)).toBeNull();
  });

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
    expect(await screen.findByText(/adapter is not downloaded yet/i)).toBeTruthy();
  });

  it('disables the generative option with a reason when the runtime is unready', async () => {
    getUpscalePlan.mockResolvedValue({ plan: unsupportedRuntimePlan() });
    render(<VideoUpscaleDrawer item={ITEM} onClose={vi.fn()} onUpscaled={vi.fn()} />);

    const radio = await screen.findByLabelText(/LTX-2\.5 generative/i);
    await waitFor(() => expect(radio).toBeDisabled());
    expect(await screen.findByText(/no generative upscale backend exists/i)).toBeTruthy();
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
    expect(await screen.findByText(/is not downloaded/i)).toBeTruthy();
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

    // The radio starts disabled while loading; wait for the actual plan
    // disclosure before checking the host refusal. A mock call is not a render.
    expect(await screen.findByText(/unavailable on this machine/i)).toBeTruthy();
    expect(screen.getByLabelText(/LTX-2\.5 generative/i).disabled).toBe(true);
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
