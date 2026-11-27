import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ImageClean from './ImageClean';
import toast from '../components/ui/Toast';
import { getRegenAvailability } from '../services/apiImageVideo.js';
import { cleanImage, fetchCleanResult, saveCleanResult } from '../services/apiMedia.js';
import { getMediaJob } from '../services/apiMediaJobs';
import socket from '../services/socket';

vi.mock('../services/apiMedia.js', () => ({
  cleanImage: vi.fn(),
  fetchCleanResult: vi.fn(),
  saveCleanResult: vi.fn(),
}));
vi.mock('../services/apiImageVideo.js', () => ({
  getRegenAvailability: vi.fn(),
}));
vi.mock('../services/apiMediaJobs', () => ({ getMediaJob: vi.fn() }));
vi.mock('../services/socket', async () => {
  const { EventEmitter } = await import('node:events');
  return { default: new EventEmitter() };
});
vi.mock('../components/ui/Toast');

// happy-dom never decodes images, so the dimension probe would hang. Resolve it
// on the next microtask instead.
class FakeImage {
  set src(value) { this._src = value; queueMicrotask(() => this.onload?.()); }
  get naturalWidth() { return 64; }
  get naturalHeight() { return 64; }
}

const cleanedResponse = () => ({
  blob: new Blob(['clean'], { type: 'image/png' }),
  mimeType: 'image/png',
  report: { width: 64, height: 64, c2paPresent: false, c2paStripped: false },
});

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const renderPage = () => render(<MemoryRouter><ImageClean /></MemoryRouter>);

const upload = async (container, name = 'sample.png', type = 'image/png') => {
  const input = container.querySelector('input[type="file"]');
  const file = new File(['sample-bytes'], name, { type });
  await act(async () => { fireEvent.change(input, { target: { files: [file] } }); });
  return file;
};

beforeEach(() => {
  vi.resetAllMocks();
  cleanImage.mockResolvedValue(cleanedResponse());
  getRegenAvailability.mockResolvedValue({ available: false });
  getMediaJob.mockResolvedValue({ status: 'queued' });
  vi.stubGlobal('Image', FakeImage);
  let nextUrl = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:example-${++nextUrl}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Image Cleaner failed CPU clean', () => {
  it('keeps the image and offers one Retry that replaces the error with the result', async () => {
    cleanImage
      .mockRejectedValueOnce(new Error('Service unavailable'))
      .mockResolvedValueOnce(cleanedResponse());
    const { container } = renderPage();
    await upload(container);

    expect(await screen.findByRole('alert')).toHaveTextContent('Service unavailable');
    expect(screen.getByAltText('Original')).toBeInTheDocument();
    expect(cleanImage).toHaveBeenCalledTimes(1);

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });

    expect(cleanImage).toHaveBeenCalledTimes(2);
    expect(cleanImage.mock.calls[1][0]).toBe(cleanImage.mock.calls[0][0]);
    expect(cleanImage.mock.calls[1][1]).toEqual(cleanImage.mock.calls[0][1]);
    expect(await screen.findByAltText('Cleaned')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('link', { name: /Download/ })).toBeInTheDocument();
  });

  it('ignores the error from a request superseded by a newer image', async () => {
    const stale = deferred();
    cleanImage
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(cleanedResponse());
    const { container } = renderPage();
    await upload(container, 'first.png');

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Choose another image' })); });
    await upload(container, 'second.png');
    expect(await screen.findByAltText('Cleaned')).toBeInTheDocument();

    await act(async () => { stale.reject(new Error('Stale failure')); });

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Stale failure')).toBeNull();
    expect(screen.getByAltText('Cleaned')).toBeInTheDocument();
  });
});

const toggleStep = (name) => fireEvent.click(screen.getByRole('checkbox', { name }));

describe('Image Cleaner file and CPU options', () => {
  it('rejects a file when both its extension and MIME type are unsupported', async () => {
    const { container } = renderPage();
    await upload(container, 'sample.gif', 'image/gif');

    expect(toast.error).toHaveBeenCalledWith('Only PNG, JPEG, and WebP images are supported');
    expect(screen.queryByAltText('Original')).not.toBeInTheDocument();
    expect(cleanImage).not.toHaveBeenCalled();
  });

  it.each([
    ['sample.JPG', 'application/octet-stream'],
    ['sample.bin', 'image/webp'],
    ['untitled', ''],
  ])('lets the server inspect %s (%s) when file metadata is supported or missing', async (name, type) => {
    const { container } = renderPage();
    const file = await upload(container, name, type);

    expect(await screen.findByAltText('Cleaned')).toBeInTheDocument();
    expect(cleanImage).toHaveBeenCalledWith(file, { metadata: true, denoise: false, diffusion: 'off' });
  });

  it('reruns the CPU clean with the chosen steps and only submits a painted mask when applied', async () => {
    const mask = new Blob(['mask'], { type: 'image/png' });
    // happy-dom has no native canvas renderer. The real painter owns the
    // pointer gesture and the export, while the browser encoder supplies bytes.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      clearRect: vi.fn(),
      fillRect: vi.fn(),
    });
    const encode = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => callback(mask));
    const { container } = renderPage();
    const file = await upload(container);

    toggleStep(/Strip metadata/);
    await screen.findByAltText('Cleaned');
    toggleStep(/Median \+ sharpen/);
    await screen.findByAltText('Cleaned');
    toggleStep(/Disrupt SynthID/);
    await screen.findByAltText('Cleaned');
    const options = { metadata: false, denoise: true, diffusion: 'light' };
    expect(cleanImage).toHaveBeenLastCalledWith(file, options);

    const apply = screen.getByRole('button', { name: 'Apply mask' });
    expect(apply).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Rectangle' }));
    fireEvent.load(screen.getByAltText('Paint an ignore zone to preserve'));
    const canvas = container.querySelector('canvas');
    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 1, clientY: 1 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 8, clientY: 8 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });
    expect(apply).toBeEnabled();
    fireEvent.change(screen.getByRole('slider', { name: 'Feather' }), { target: { value: '9' } });
    expect(encode).not.toHaveBeenCalled();
    fireEvent.click(apply);
    await screen.findByAltText('Cleaned');

    expect(encode).toHaveBeenCalledWith(expect.any(Function), 'image/png');
    expect(cleanImage).toHaveBeenLastCalledWith(file, { ...options, mask, feather: 9 });
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await screen.findByAltText('Cleaned');
    expect(apply).toBeDisabled();
    expect(cleanImage).toHaveBeenLastCalledWith(file, options);
  });

  it('does not start a clean if the image finishes decoding after unmount', async () => {
    let finishDecoding;
    vi.stubGlobal('Image', class extends FakeImage {
      set src(_) { finishDecoding = () => this.onload(); }
    });
    const { container, unmount } = renderPage();
    await upload(container);

    unmount();
    await act(async () => { finishDecoding(); });

    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(cleanImage).not.toHaveBeenCalled();
  });

  it('does not create a result URL if a pending CPU clean resolves after unmount', async () => {
    const pending = deferred();
    cleanImage.mockReturnValueOnce(pending.promise);
    const { container, unmount } = renderPage();
    await upload(container);

    const original = screen.getByAltText('Original').getAttribute('src');
    unmount();
    await act(async () => { pending.resolve(cleanedResponse()); });

    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(original);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('revokes both preview URLs on replacement and the new URLs on unmount', async () => {
    const { container, unmount } = renderPage();
    await upload(container, 'first.png');
    const firstOriginal = screen.getByAltText('Original').getAttribute('src');
    const firstResult = (await screen.findByAltText('Cleaned')).getAttribute('src');

    fireEvent.click(screen.getByRole('button', { name: 'Choose another image' }));
    await upload(container, 'second.png');
    const nextOriginal = screen.getByAltText('Original').getAttribute('src');
    const nextResult = (await screen.findByAltText('Cleaned')).getAttribute('src');

    expect(URL.revokeObjectURL.mock.calls).toEqual([[firstOriginal], [firstResult]]);
    unmount();
    expect(URL.revokeObjectURL.mock.calls).toEqual([[firstOriginal], [firstResult], [nextOriginal], [nextResult]]);
  });
});

describe('Image Cleaner GPU jobs', () => {
  const complete = (jobId) => act(async () => {
    socket.emit('image-gen:completed', { generationId: jobId });
  });

  beforeEach(() => {
    getRegenAvailability.mockResolvedValue({
      available: true, modelId: 'flux-example', strengthMin: 0.1, strengthMax: 0.5, strengthDefault: 0.32,
    });
  });

  it('selects FLUX from availability but waits for an explicit run, then displays and saves the result', async () => {
    cleanImage.mockResolvedValueOnce(cleanedResponse()).mockResolvedValueOnce({ gpu: true, job: { jobId: 'gpu-1' } });
    fetchCleanResult.mockResolvedValue(cleanedResponse());
    saveCleanResult
      .mockRejectedValueOnce(new Error('Gallery unavailable'))
      .mockResolvedValueOnce({ filename: 'saved.png' });
    const { container } = renderPage();
    const file = await upload(container);
    toggleStep(/Disrupt SynthID/);

    expect(cleanImage).toHaveBeenCalledTimes(1);
    const strength = screen.getByRole('slider', { name: 'Denoise strength' });
    expect(strength).toHaveValue('0.32');
    expect(strength).toHaveAttribute('min', '0.1');
    expect(strength).toHaveAttribute('max', '0.5');
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Max render MP' }), { target: { value: '3.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run GPU clean' }));

    expect(await screen.findByText('Queued (GPU)')).toBeInTheDocument();
    expect(cleanImage).toHaveBeenLastCalledWith(file, {
      metadata: true, denoise: false, diffusion: 'gpu', strength: 0.32, maxMp: 3.5,
    });
    expect(fetchCleanResult).not.toHaveBeenCalled();
    await complete('gpu-1');

    expect(fetchCleanResult).toHaveBeenCalledWith('gpu-1');
    const preview = await screen.findByAltText('Cleaned');
    expect(screen.getByRole('link', { name: 'Download' })).toHaveAttribute('href', preview.getAttribute('src'));
    const save = screen.getByRole('button', { name: 'Save to gallery' });
    await act(async () => { fireEvent.click(save); });
    expect(toast.error).toHaveBeenCalledWith('Gallery unavailable');
    expect(save).toBeEnabled();
    expect(preview).toBeInTheDocument();

    await act(async () => { fireEvent.click(save); });
    expect(saveCleanResult.mock.calls).toEqual([
      ['gpu-1', { silent: true }],
      ['gpu-1', { silent: true }],
    ]);
    expect(screen.getByRole('button', { name: 'Saved to gallery' })).toBeDisabled();
  });

  it('ignores completion events and fetched bytes for a superseded job', async () => {
    const stale = deferred();
    cleanImage
      .mockResolvedValueOnce(cleanedResponse())
      .mockResolvedValueOnce({ gpu: true, job: { jobId: 'gpu-old' } })
      .mockResolvedValueOnce({ gpu: true, job: { jobId: 'gpu-new' } });
    fetchCleanResult.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(cleanedResponse());
    const { container } = renderPage();
    await upload(container, 'first.png');
    toggleStep(/Disrupt SynthID/);
    fireEvent.click(screen.getByRole('button', { name: 'Run GPU clean' }));
    await screen.findByText('Queued (GPU)');
    await complete('gpu-old');

    fireEvent.click(screen.getByRole('button', { name: 'Choose another image' }));
    await upload(container, 'second.png');
    fireEvent.click(screen.getByRole('button', { name: 'Run GPU clean' }));
    await screen.findByText('Queued (GPU)');
    await complete('gpu-old');
    expect(fetchCleanResult.mock.calls).toEqual([['gpu-old']]);
    expect(screen.queryByAltText('Cleaned')).not.toBeInTheDocument();

    await complete('gpu-new');
    expect(fetchCleanResult.mock.calls).toEqual([['gpu-old'], ['gpu-new']]);
    const currentSrc = (await screen.findByAltText('Cleaned')).getAttribute('src');
    await act(async () => { stale.resolve(cleanedResponse()); });

    expect(screen.getByAltText('Cleaned')).toHaveAttribute('src', currentSrc);
    expect(screen.getByRole('link', { name: 'Download' })).toHaveAttribute('download', 'second.cleaned.png');
  });
});
