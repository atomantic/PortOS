import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const { fetchPage, deleteImage, saveAnnotation, getGalleryImages, getVideoHistoryItem } = vi.hoisted(() => ({ fetchPage: vi.fn(), deleteImage: vi.fn(), saveAnnotation: vi.fn(), getGalleryImages: vi.fn(), getVideoHistoryItem: vi.fn() }));
vi.mock('../services/apiImageVideo', () => ({ listMediaGalleryPage: fetchPage, getGalleryImages, getVideoHistoryItem }));
vi.mock('../services/api', () => ({ listMediaGalleryPage: fetchPage, deleteImage, deleteVideoHistoryItem: vi.fn(), stitchVideos: vi.fn() }));
vi.mock('../hooks/useMediaCompletionRefresh', () => ({ useMediaCompletionRefresh: () => {} }));
vi.mock('../hooks/useMediaAnnotations', () => ({ useMediaAnnotations: () => ({ annotations: {}, updateAnnotation: saveAnnotation, getCardProps: () => ({}) }) }));
vi.mock('../hooks/useMediaPreviewActions', () => ({ default: () => ({}) }));
vi.mock('../components/media/VideoUpscaleDrawer', () => ({ default: () => null }));
vi.mock('../components/media/MediaPreview', () => ({ default: ({ preview }) => preview ? <div role="dialog">{preview.prompt}{preview.detailError && ' [details unavailable]'}</div> : null }));
vi.mock('../components/media/MediaCard', () => ({ default: ({ item, onDelete, onToggleStar, onPreview }) => <div><button type="button" onClick={() => onPreview(item)}>{item.prompt}</button><button type="button" onClick={() => onToggleStar(item)}>Favorite {item.filename}</button><button type="button" onClick={() => onDelete(item)}>Delete {item.filename}</button></div> }));
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
  getGalleryImages.mockImplementation(async filenames => rows.filter(row => filenames.includes(row.data.filename)).map(row => row.data));
  deleteImage.mockImplementation(async filename => { rows = rows.filter(row => row.data.filename !== filename); return { ok: true }; });
});
const open = (url = '/media/history') => render(<MemoryRouter initialEntries={[url]}><MediaHistory /></MemoryRouter>);

describe('bounded media history', () => {
  it('loads the next server page, retries it without losing existing cards, and searches on the server', async () => {
    open();
    await screen.findByText('Picture 0');
    expect(screen.queryByText('Picture 60')).toBeNull();
    expect(fetchPage).toHaveBeenCalledWith(expect.objectContaining({ limit: 60, offset: 0, summary: true, hidden: false, compact: true }), { silent: true });
    fetchPage.mockRejectedValueOnce(new Error('Page unavailable'));
    fireEvent.click(screen.getByRole('button', { name: /Show more/ }));
    await screen.findByRole('alert');
    expect(screen.getByText('Picture 0')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading' }));
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

  it('opens a compact card by hydrating only that record, and never shows the preview as its prompt', async () => {
    const full = 'Picture 0 ' + 'with a long stored prompt '.repeat(30);
    rows[0].data.prompt = full;
    fetchPage.mockImplementation(async ({ offset = 0 }) => ({
      items: rows.slice(offset, offset + 60).map(row => ({ kind: row.kind, data: { ...row.data, compact: true, prompt: row.data.prompt.slice(0, 12) + '…' } })),
      total: rows.length, offset, limit: 60, counts: { all: rows.length, image: rows.length, video: 0 },
    }));
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Picture 0 wi…' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent(full.trim());
    expect(getGalleryImages).toHaveBeenCalledTimes(1);
    expect(getGalleryImages).toHaveBeenCalledWith(['0.png'], { silent: true });
  });

  it('marks a compact record whose detail read fails instead of passing its preview off as complete', async () => {
    fetchPage.mockImplementation(async ({ offset = 0 }) => ({
      items: rows.slice(offset, offset + 60).map(row => ({ kind: row.kind, data: { ...row.data, compact: true } })),
      total: rows.length, offset, limit: 60, counts: { all: rows.length, image: rows.length, video: 0 },
    }));
    getGalleryImages.mockRejectedValue(new Error('offline'));
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Picture 3' }));
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('Picture 3 [details unavailable]'));
  });

  it('resolves an older deep-linked preview with a one-item request outside the loaded page', async () => {
    open('/media/history?preview=image:60.png');
    expect(await screen.findByRole('dialog')).toHaveTextContent('Picture 60');
    expect(fetchPage).toHaveBeenCalledWith({ limit: 1, kind: 'image', filename: '60.png' }, { silent: true });
  });
});
