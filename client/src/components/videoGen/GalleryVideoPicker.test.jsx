import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import GalleryVideoPicker from './GalleryVideoPicker';

const listMediaGalleryPage = vi.fn();
const uploadGalleryVideo = vi.fn();
const uploadFile = vi.fn();
vi.mock('../../services/apiImageVideo', () => ({
  listMediaGalleryPage: (...args) => listMediaGalleryPage(...args),
  uploadGalleryVideo: (...args) => uploadGalleryVideo(...args),
}));

vi.mock('../../services/apiMedia', () => ({
  uploadFile: (...args) => uploadFile(...args),
}));

vi.mock('../ui/Toast');

const HISTORY = [
  { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', filename: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4', prompt: 'a neon chase', trimmedFrom: 'original-clip', hidden: false },
  { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', filename: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.mp4', prompt: 'a quiet forest walk', hidden: false },
];

const videoPage = (records, total = records.length) => ({
  items: records.map(data => ({ kind: 'video', data })),
  total,
});
const pageRequest = (q = '', offset = 0) => [
  { limit: 60, offset, compact: true, kind: 'video', hidden: false, q },
  { silent: true },
];

describe('GalleryVideoPicker', () => {
  beforeEach(() => {
    listMediaGalleryPage.mockReset();
    listMediaGalleryPage.mockResolvedValue(videoPage(HISTORY));
    uploadGalleryVideo.mockReset();
    uploadFile.mockReset();
  });

  it('does not fetch when closed', () => {
    render(<GalleryVideoPicker open={false} onClose={vi.fn()} onSelect={vi.fn()} />);
    expect(listMediaGalleryPage).not.toHaveBeenCalled();
  });

  it('lists videos on open and selects one', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<GalleryVideoPicker open onClose={onClose} onSelect={onSelect} />);
    await waitFor(() => expect(screen.getByText('a neon chase')).toBeInTheDocument());
    expect(screen.getByText('trimmed')).toBeInTheDocument();
    const tile = screen.getByText('a neon chase').closest('.bg-port-card').querySelector('button');
    fireEvent.click(tile);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'video',
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    }));
    expect(onClose).toHaveBeenCalled();
  });

  it('loads older videos from the next compact gallery page', async () => {
    const full = Array.from({ length: 60 }, (_, i) => ({ ...HISTORY[0], id: `id-${i}`, filename: `v${i}.mp4`, prompt: `clip ${i}` }));
    listMediaGalleryPage.mockResolvedValueOnce(videoPage(full, 61));
    listMediaGalleryPage.mockRejectedValueOnce(new Error('Next page unavailable'));
    listMediaGalleryPage.mockResolvedValueOnce(videoPage([HISTORY[1]], 61));
    render(<GalleryVideoPicker open onClose={vi.fn()} onSelect={vi.fn()} />);

    const showMore = await screen.findByRole('button', { name: 'Show more (1 remaining)' });
    expect(listMediaGalleryPage).toHaveBeenLastCalledWith(...pageRequest());
    fireEvent.click(showMore);
    expect(await screen.findByRole('alert')).toHaveTextContent('Next page unavailable');
    expect(screen.getByText('clip 0')).toBeInTheDocument();
    expect(listMediaGalleryPage).toHaveBeenLastCalledWith(...pageRequest('', 60));

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('a quiet forest walk')).toBeInTheDocument();
    expect(listMediaGalleryPage).toHaveBeenLastCalledWith(...pageRequest('', 60));
    expect(screen.getByText('clip 0')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Show more/ })).toBeNull();
  });

  it('searches server-side and clearing restores the first unfiltered page', async () => {
    listMediaGalleryPage.mockResolvedValueOnce(videoPage([HISTORY[0]]));
    render(<GalleryVideoPicker open onClose={vi.fn()} onSelect={vi.fn()} />);
    await screen.findByText('a neon chase');

    listMediaGalleryPage.mockResolvedValueOnce(videoPage([HISTORY[1]]));
    fireEvent.change(screen.getByLabelText('Search videos'), { target: { value: ' forest ' } });
    expect(listMediaGalleryPage).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('a quiet forest walk')).toBeInTheDocument();
    expect(listMediaGalleryPage).toHaveBeenLastCalledWith(...pageRequest('forest'));
    expect(screen.queryByText('a neon chase')).toBeNull();

    listMediaGalleryPage.mockResolvedValueOnce(videoPage([]));
    fireEvent.change(screen.getByLabelText('Search videos'), { target: { value: 'zzz' } });
    expect(await screen.findByText('No videos match your search.')).toBeInTheDocument();

    listMediaGalleryPage.mockResolvedValueOnce(videoPage([HISTORY[0]]));
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(await screen.findByText('a neon chase')).toBeInTheDocument();
    expect(listMediaGalleryPage).toHaveBeenLastCalledWith(...pageRequest());
  });

  it('starts with an unfiltered first request on reopening after a search', async () => {
    const { rerender } = render(<GalleryVideoPicker open />);
    await screen.findByText('a neon chase');
    listMediaGalleryPage.mockResolvedValueOnce(videoPage([HISTORY[1]]));
    fireEvent.change(screen.getByLabelText('Search videos'), { target: { value: 'forest' } });
    await waitFor(() => expect(screen.queryByText('a neon chase')).toBeNull());

    listMediaGalleryPage.mockClear();
    rerender(<GalleryVideoPicker open={false} />);
    rerender(<GalleryVideoPicker open />);
    await screen.findByText('a neon chase');
    expect(screen.getByLabelText('Search videos')).toHaveValue('');
    expect(listMediaGalleryPage).toHaveBeenNthCalledWith(1, ...pageRequest());
  });

  it('shows a load error with Retry instead of the empty copy when the gallery read fails', async () => {
    listMediaGalleryPage.mockRejectedValueOnce(new Error('Gallery unavailable'));
    render(<GalleryVideoPicker open onClose={vi.fn()} onSelect={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load your video gallery — Gallery unavailable');
    expect(screen.queryByText('No videos in your gallery yet.')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('a neon chase')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the accept override and returns a scratch reference when uploading outside the gallery', async () => {
    uploadFile.mockResolvedValue({ filename: 'scratch.webm' });
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const { rerender } = render(<GalleryVideoPicker open onClose={onClose} onSelect={onSelect} />);
    expect(document.querySelector('input[type="file"]')).toBeNull();

    rerender(<GalleryVideoPicker open onClose={onClose} onSelect={onSelect} allowUpload accept="video/webm" />);
    const fileInput = document.querySelector('input[type="file"]');
    expect(fileInput).toHaveAttribute('accept', 'video/webm');
    const file = new File(['x'], 'clip.webm', { type: 'video/webm' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => expect(onSelect).toHaveBeenCalledWith({
      kind: 'upload', filename: 'scratch.webm', label: 'clip.webm', previewUrl: null,
    }));
    expect(uploadFile).toHaveBeenCalledWith(file, file.name, { silent: true });
    expect(uploadGalleryVideo).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('uploads into the gallery and selects the normalized entry with uploadToGallery (#4188)', async () => {
    uploadGalleryVideo.mockResolvedValue({
      id: 'upload-ab12cd34', filename: 'upload-ab12cd34.mp4', thumbnail: 'upload-ab12cd34.jpg', source: 'upload',
    });
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <GalleryVideoPicker open onClose={onClose} onSelect={onSelect} allowUpload uploadToGallery />,
    );
    await waitFor(() => expect(screen.getByText('a neon chase')).toBeInTheDocument());
    // The modal renders through a portal, so query the document, not the container.
    const fileInput = document.querySelector('input[type="file"]');
    const largeFile = new File(['x'], 'clip.mp4', { type: 'video/mp4' });
    Object.defineProperty(largeFile, 'size', { value: 2 ** 32 });
    fireEvent.change(fileInput, { target: { files: [largeFile] } });
    await waitFor(() => expect(uploadGalleryVideo).toHaveBeenCalledWith(expect.any(File), 'clip.mp4', { silent: true }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'video',
        filename: 'upload-ab12cd34.mp4',
        previewUrl: '/data/video-thumbnails/upload-ab12cd34.jpg',
      }),
      { origin: 'upload' },
    ));
    expect(onClose).toHaveBeenCalled();
  });

  it('drops a gallery upload that lands after the picker was dismissed', async () => {
    let settleUpload;
    uploadGalleryVideo.mockReturnValue(new Promise((resolve) => { settleUpload = resolve; }));
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const { rerender } = render(<GalleryVideoPicker open onClose={onClose} onSelect={onSelect} allowUpload uploadToGallery />);
    const fileInput = document.querySelector('input[type="file"]');
    fireEvent.change(fileInput, { target: { files: [new File(['x'], 'clip.mp4', { type: 'video/mp4' })] } });
    await waitFor(() => expect(uploadGalleryVideo).toHaveBeenCalledTimes(1));

    rerender(<GalleryVideoPicker open={false} onClose={onClose} onSelect={onSelect} allowUpload uploadToGallery />);
    await act(async () => { settleUpload({ id: 'upload-ab12cd34', filename: 'late.mp4', thumbnail: 'late.jpg' }); });

    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    rerender(<GalleryVideoPicker open onClose={onClose} onSelect={onSelect} allowUpload uploadToGallery />);
    await screen.findByText('a neon chase');
    expect(document.querySelector('input[type="file"]')).toBeEnabled();
  });

  it('drops a gallery upload that lands after the picker unmounted', async () => {
    let settleUpload;
    uploadGalleryVideo.mockReturnValue(new Promise((resolve) => { settleUpload = resolve; }));
    const onSelect = vi.fn();
    const { unmount } = render(<GalleryVideoPicker open onClose={vi.fn()} onSelect={onSelect} allowUpload uploadToGallery />);
    const fileInput = document.querySelector('input[type="file"]');
    fireEvent.change(fileInput, { target: { files: [new File(['x'], 'clip.mp4', { type: 'video/mp4' })] } });
    await waitFor(() => expect(uploadGalleryVideo).toHaveBeenCalledTimes(1));

    unmount();
    await act(async () => { settleUpload({ id: 'upload-ab12cd34', filename: 'late.mp4', thumbnail: 'late.jpg' }); });

    expect(onSelect).not.toHaveBeenCalled();
  });
});
