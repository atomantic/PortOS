import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const { fetchPage, deleteImage, saveAnnotation } = vi.hoisted(() => ({ fetchPage: vi.fn(), deleteImage: vi.fn(), saveAnnotation: vi.fn() }));
vi.mock('../services/apiImageVideo', () => ({ listMediaGalleryPage: fetchPage }));
vi.mock('../services/api', () => ({ listMediaGalleryPage: fetchPage, deleteImage, deleteVideoHistoryItem: vi.fn(), stitchVideos: vi.fn() }));
vi.mock('../hooks/useMediaCompletionRefresh', () => ({ useMediaCompletionRefresh: () => {} }));
vi.mock('../hooks/useMediaAnnotations', () => ({ useMediaAnnotations: () => ({ annotations: {}, updateAnnotation: saveAnnotation, getCardProps: () => ({}) }) }));
vi.mock('../hooks/useMediaPreviewActions', () => ({ default: () => ({}) }));
vi.mock('../components/media/VideoUpscaleDrawer', () => ({ default: () => null }));
vi.mock('../components/media/MediaPreview', () => ({ default: ({ preview }) => preview ? <div role="dialog">{preview.prompt}</div> : null }));
vi.mock('../components/media/MediaCard', () => ({ default: ({ item, onDelete, onToggleStar }) => <div><span>{item.prompt}</span><button type="button" onClick={() => onToggleStar(item)}>Favorite {item.filename}</button><button type="button" onClick={() => onDelete(item)}>Delete {item.filename}</button></div> }));
import MediaHistory from './MediaHistory';

let rows;
beforeEach(() => {
  vi.resetAllMocks();
  saveAnnotation.mockResolvedValue({ ok: true });
  rows = Array.from({ length: 61 }, (_, n) => ({ kind: 'image', data: { filename: `${n}.png`, prompt: `Picture ${n}`, createdAt: '2026-01-01' } }));
  fetchPage.mockImplementation(async ({ limit = 60, offset = 0, q = '', filename }) => {
    const matches = rows.filter(row => (!filename || row.data.filename === filename) && row.data.prompt.includes(q));
    return { items: matches.slice(offset, offset + limit), total: matches.length, offset, limit, counts: { all: matches.length, image: matches.length, video: 0 } };
  });
  deleteImage.mockImplementation(async filename => { rows = rows.filter(row => row.data.filename !== filename); return { ok: true }; });
});
const open = (url = '/media/history') => render(<MemoryRouter initialEntries={[url]}><MediaHistory /></MemoryRouter>);

describe('bounded media history', () => {
  it('loads the next server page, retries it without losing existing cards, and searches on the server', async () => {
    open();
    await screen.findByText('Picture 0');
    expect(screen.queryByText('Picture 60')).toBeNull();
    expect(fetchPage).toHaveBeenCalledWith(expect.objectContaining({ limit: 60, offset: 0, summary: true }), { silent: true });
    fetchPage.mockRejectedValueOnce(new Error('Page unavailable'));
    fireEvent.click(screen.getByRole('button', { name: /Show more/ }));
    await screen.findByRole('alert');
    expect(screen.getByText('Picture 0')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('Picture 60');
    expect(fetchPage).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 60 }), { silent: true });
    fireEvent.change(screen.getByLabelText('Search media history'), { target: { value: 'Picture 60' } });
    await waitFor(() => expect(fetchPage).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0, q: 'Picture 60' }), { silent: true }));
    await waitFor(() => expect(screen.queryByText('Picture 0')).toBeNull());
    expect(await screen.findByText('Picture 60')).toBeInTheDocument();
  });

  it('stars the card item by media key', async () => {
    open();
    await screen.findByText('Picture 0');
    fireEvent.click(screen.getByRole('button', { name: 'Favorite 0.png' }));
    await waitFor(() => expect(saveAnnotation).toHaveBeenCalledWith('image:0.png', { starred: true }));
  });

  it('keeps the previously unseen last item reachable after deletion shifts offsets', async () => {
    open();
    await screen.findByText('Picture 0');
    fireEvent.click(screen.getByRole('button', { name: 'Delete 0.png' }));
    await screen.findByText('Picture 60');
    expect(screen.queryByText('Picture 0')).toBeNull();
    expect(screen.queryByRole('button', { name: /Show more/ })).toBeNull();
  });

  it('resolves an older deep-linked preview with a one-item request outside the loaded page', async () => {
    open('/media/history?preview=image:60.png');
    expect(await screen.findByRole('dialog')).toHaveTextContent('Picture 60');
    expect(fetchPage).toHaveBeenCalledWith({ limit: 1, kind: 'image', filename: '60.png' }, { silent: true });
  });
});
