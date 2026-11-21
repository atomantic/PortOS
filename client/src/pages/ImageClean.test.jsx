import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ImageClean from './ImageClean';
import { cleanImage } from '../services/apiMedia.js';

vi.mock('../services/apiMedia.js', () => ({
  cleanImage: vi.fn(),
  fetchCleanResult: vi.fn(),
  saveCleanResult: vi.fn(),
}));
vi.mock('../services/apiImageVideo.js', () => ({
  getRegenAvailability: vi.fn(() => Promise.resolve({ available: false })),
}));
vi.mock('../hooks/useMediaJobProgress', () => ({
  default: () => ({ status: null, progress: 0, error: null }),
}));
vi.mock('../components/ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

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

const upload = async (container, name = 'sample.png') => {
  const input = container.querySelector('input[type="file"]');
  const file = new File(['png-bytes'], name, { type: 'image/png' });
  await act(async () => { fireEvent.change(input, { target: { files: [file] } }); });
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('Image', FakeImage);
  URL.createObjectURL = vi.fn(() => 'blob:example');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
