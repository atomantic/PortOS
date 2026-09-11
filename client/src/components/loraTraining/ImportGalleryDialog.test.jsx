import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ImportGalleryDialog from './ImportGalleryDialog';

const api = vi.hoisted(() => ({
  listImageGalleryPage: vi.fn(),
  importLoraDatasetGalleryImages: vi.fn(),
}));
vi.mock('../../services/api', () => api);
vi.mock('../media/MediaCard', () => ({
  default: ({ item, onClick }) => <button onClick={() => onClick(item)}>{item.filename}</button>,
}));
vi.mock('../ui/Modal', () => ({ default: ({ children }) => <div>{children}</div> }));

describe('gallery import paging', () => {
  it('pages and searches on the server while retaining selected filenames', async () => {
    api.listImageGalleryPage.mockImplementation(async ({ offset, q }) => ({
      items: [{ filename: q ? 'found.png' : offset ? 'second.png' : 'first.png' }],
      total: q ? 1 : 2, limit: 60, offset,
    }));
    api.importLoraDatasetGalleryImages.mockResolvedValue({ images: [] });
    render(<ImportGalleryDialog dataset={{ id: 'dataset' }} />);
    fireEvent.click(await screen.findByText('first.png'));
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await screen.findByText('second.png');
    expect(api.listImageGalleryPage).toHaveBeenCalledWith(
      { limit: 60, offset: 1, q: '', hidden: false }, { silent: true });
    fireEvent.change(screen.getByLabelText('Search gallery images'), { target: { value: 'fox' } });
    await screen.findByText('found.png');
    expect(screen.queryByText('first.png')).toBeNull();
    expect(api.listImageGalleryPage).toHaveBeenLastCalledWith(
      { limit: 60, offset: 0, q: 'fox', hidden: false }, { silent: true });
    fireEvent.click(screen.getByRole('button', { name: 'Import 1' }));
    await waitFor(() => expect(api.importLoraDatasetGalleryImages).toHaveBeenCalledWith('dataset', ['first.png']));
  });
});
