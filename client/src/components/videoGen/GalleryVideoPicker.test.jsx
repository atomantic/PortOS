import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import GalleryVideoPicker from './GalleryVideoPicker';

const listVideoHistory = vi.fn();
const uploadGalleryVideo = vi.fn();
const readFileAsBase64 = vi.fn();
vi.mock('../../services/apiImageVideo', () => ({
  listVideoHistory: (...args) => listVideoHistory(...args),
  uploadGalleryVideo: (...args) => uploadGalleryVideo(...args),
}));

vi.mock('../../services/apiMedia', () => ({
  uploadFile: vi.fn(),
}));

vi.mock('../../utils/fileUpload', () => ({
  readFileAsBase64: (...args) => readFileAsBase64(...args),
  JSON_UPLOAD_MAX_FILE_SIZE: 41 * 1024 * 1024,
}));

vi.mock('../ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));

const HISTORY = [
  { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', filename: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4', prompt: 'a neon chase', hidden: false },
  { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', filename: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.mp4', prompt: 'a quiet forest walk', hidden: false },
];

describe('GalleryVideoPicker', () => {
  beforeEach(() => {
    listVideoHistory.mockReset();
    listVideoHistory.mockResolvedValue(HISTORY);
    uploadGalleryVideo.mockReset();
    readFileAsBase64.mockReset();
    readFileAsBase64.mockResolvedValue('ZmFrZQ==');
  });

  it('does not fetch when closed', () => {
    render(<GalleryVideoPicker open={false} onClose={vi.fn()} onSelect={vi.fn()} />);
    expect(listVideoHistory).not.toHaveBeenCalled();
  });

  it('lists videos on open and selects one', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<GalleryVideoPicker open onClose={onClose} onSelect={onSelect} />);
    await waitFor(() => expect(screen.getByText('a neon chase')).toBeInTheDocument());
    const tile = screen.getByText('a neon chase').closest('.bg-port-card').querySelector('button');
    fireEvent.click(tile);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'video',
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    }));
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
    fireEvent.change(fileInput, { target: { files: [new File(['x'], 'clip.mp4', { type: 'video/mp4' })] } });
    await waitFor(() => expect(uploadGalleryVideo).toHaveBeenCalledWith('ZmFrZQ==', 'clip.mp4', { silent: true }));
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
