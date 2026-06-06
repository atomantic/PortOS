import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import GalleryImagePicker from './GalleryImagePicker';

const listImageGallery = vi.fn();
vi.mock('../../services/apiImageVideo', () => ({
  listImageGallery: (...args) => listImageGallery(...args),
}));

const GALLERY = [
  { filename: 'neon.png', path: '/data/images/neon.png', prompt: 'a neon sunset', modelId: 'flux2', seed: 1 },
  { filename: 'forest.png', path: '/data/images/forest.png', prompt: 'a quiet forest', modelId: 'sdxl', seed: 2 },
];

describe('GalleryImagePicker', () => {
  beforeEach(() => {
    listImageGallery.mockReset();
    listImageGallery.mockResolvedValue(GALLERY);
  });

  it('does not fetch or render while closed', () => {
    render(<GalleryImagePicker open={false} onClose={vi.fn()} onSelect={vi.fn()} />);
    expect(listImageGallery).not.toHaveBeenCalled();
    expect(screen.queryByText(/Pick from gallery/i)).toBeNull();
  });

  it('fetches and renders gallery images on open', async () => {
    render(<GalleryImagePicker open onClose={vi.fn()} onSelect={vi.fn()} />);
    expect(listImageGallery).toHaveBeenCalledTimes(1);
    expect(await screen.findByAltText('a neon sunset')).toBeTruthy();
    expect(screen.getByAltText('a quiet forest')).toBeTruthy();
  });

  it('filters by query across prompt + model (AND tokens)', async () => {
    render(<GalleryImagePicker open onClose={vi.fn()} onSelect={vi.fn()} />);
    await screen.findByAltText('a neon sunset');
    fireEvent.change(screen.getByPlaceholderText(/Search prompt/i), { target: { value: 'forest sdxl' } });
    await waitFor(() => expect(screen.queryByAltText('a neon sunset')).toBeNull());
    expect(screen.getByAltText('a quiet forest')).toBeTruthy();
  });

  it('calls onSelect with the normalized item and closes on tile click', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<GalleryImagePicker open onSelect={onSelect} onClose={onClose} />);
    const tile = await screen.findByAltText('a neon sunset');
    fireEvent.click(tile);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toMatchObject({ filename: 'neon.png', previewUrl: '/data/images/neon.png' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows an empty state when the gallery is empty', async () => {
    listImageGallery.mockResolvedValue([]);
    render(<GalleryImagePicker open onClose={vi.fn()} onSelect={vi.fn()} />);
    expect(await screen.findByText(/No images in your gallery yet/i)).toBeTruthy();
  });
});
