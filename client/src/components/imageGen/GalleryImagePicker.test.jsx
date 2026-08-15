import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import GalleryImagePicker from './GalleryImagePicker';
import toast from '../ui/Toast';

const listImageGallery = vi.fn();
const listMediaCollections = vi.fn();
vi.mock('../../services/apiImageVideo', () => ({
  listImageGallery: (...args) => listImageGallery(...args),
  listMediaCollections: (...args) => listMediaCollections(...args),
}));

const listUniverses = vi.fn();
// universeBuilderShared imports the WORLD_CATEGORY_* constants from this module,
// so the mock has to carry them or the shared lib loads with undefined values.
vi.mock('../../services/apiUniverseBuilder', () => ({
  listUniverses: (...args) => listUniverses(...args),
  WORLD_CATEGORIES: ['landscapes', 'environments', 'structures', 'vehicles'],
  WORLD_CATEGORY_KEY_MAX: 64,
}));

const uploadGalleryImage = vi.fn();
vi.mock('../../services/apiSystem', () => ({
  uploadGalleryImage: (...args) => uploadGalleryImage(...args),
}));

// Only the FileReader round-trip is stubbed — `validateImageFile` and the size
// constants stay real so the upload gate is genuinely under test.
vi.mock('../../utils/fileUpload', async (importOriginal) => ({
  ...(await importOriginal()),
  readFileAsBase64: vi.fn().mockResolvedValue('ZmFrZS1iYXNlNjQ='),
}));

vi.mock('../ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));

const GALLERY = [
  {
    filename: 'neon.png', path: '/data/images/neon.png', prompt: 'a neon sunset', modelId: 'flux2', seed: 1,
    universeId: 'uni-a', universeName: 'Stale Name', entryCategory: 'characters', entryKind: 'canon',
  },
  {
    filename: 'forest.png', path: '/data/images/forest.png', prompt: 'a quiet forest', modelId: 'sdxl', seed: 2,
    universeId: 'uni-b', universeName: 'Second Universe', entryCategory: 'landscapes', entryKind: 'variation',
  },
  {
    filename: 'mecha.png', path: '/data/images/mecha.png', prompt: 'a chrome mecha', modelId: 'flux2', seed: 3,
    universeId: 'uni-a', universeName: 'Stale Name', entryCategory: 'vehicles', entryKind: 'canon',
  },
];

// `items` are `{ kind, ref }` pairs, not bare filenames — the same shape the
// server persists (server/lib/mediaItemKey.js).
const COLLECTIONS = [
  { id: 'col-1', name: 'Mood Board', items: [{ kind: 'image', ref: 'forest.png' }, { kind: 'video', ref: 'clip-1' }] },
  { id: 'col-2', name: 'Video Only', items: [{ kind: 'video', ref: 'clip-2' }] },
];

const UNIVERSES = [{ id: 'uni-a', name: 'Renamed Universe' }];

const scopeSelect = () => screen.getByLabelText(/universe or collection/i);
const typeSelect = () => screen.getByLabelText(/filter by type/i);

describe('GalleryImagePicker', () => {
  beforeEach(() => {
    listImageGallery.mockReset();
    listImageGallery.mockResolvedValue(GALLERY);
    listMediaCollections.mockReset();
    listMediaCollections.mockResolvedValue(COLLECTIONS);
    listUniverses.mockReset();
    listUniverses.mockResolvedValue(UNIVERSES);
    uploadGalleryImage.mockReset();
    toast.error.mockReset();
  });

  // Drop a file on the (portalled) upload input and wait for the grid to settle.
  const pickFile = async (file) => {
    await screen.findByAltText('a neon sunset');
    fireEvent.change(document.querySelector('input[type="file"]'), { target: { files: [file] } });
  };

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

  it('hides the Upload control unless allowUpload is set', async () => {
    render(<GalleryImagePicker open onClose={vi.fn()} onSelect={vi.fn()} />);
    await screen.findByAltText('a neon sunset');
    expect(screen.queryByText(/Upload/i)).toBeNull();
  });

  it('uploads a picked file into the gallery, then selects it and closes', async () => {
    uploadGalleryImage.mockResolvedValue({ filename: 'upload-abcd1234.png', path: '/data/images/upload-abcd1234.png' });
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<GalleryImagePicker open allowUpload onSelect={onSelect} onClose={onClose} />);
    // Modal portals to <body>, so query the whole document for the file input.
    await pickFile(new File(['x'], 'photo.png', { type: 'image/png' }));
    await waitFor(() => expect(uploadGalleryImage).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
    expect(onSelect.mock.calls[0][0]).toMatchObject({ filename: 'upload-abcd1234.png', previewUrl: '/data/images/upload-abcd1234.png' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // A host that stores the picked URL on a record (album cover, artist portrait,
  // author headshot) caps uploads below the wire limit — a drag-drop or a paste
  // bypasses the input's `accept`, so the gate has to live in the handler.
  it('refuses a file over maxBytes without uploading it', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<GalleryImagePicker open allowUpload maxBytes={4} onSelect={onSelect} onClose={onClose} />);
    await pickFile(new File(['0123456789'], 'huge.png', { type: 'image/png' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(toast.error.mock.calls[0][0]).toMatch(/exceeds/i);
    expect(uploadGalleryImage).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('refuses a format the upload endpoint cannot verify', async () => {
    const onSelect = vi.fn();
    render(<GalleryImagePicker open allowUpload onSelect={onSelect} onClose={vi.fn()} />);
    await pickFile(new File(['x'], 'vector.svg', { type: 'image/svg+xml' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(toast.error.mock.calls[0][0]).toMatch(/PNG, JPEG, GIF, WebP/);
    expect(uploadGalleryImage).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  // Hosts are master-detail editors: dismissing the modal mid-upload and picking
  // a different album/artist/author must not write this image onto that record.
  it('drops an upload that lands after the picker was dismissed', async () => {
    let settleUpload;
    uploadGalleryImage.mockReturnValue(new Promise((resolve) => { settleUpload = resolve; }));
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const { rerender } = render(<GalleryImagePicker open allowUpload onSelect={onSelect} onClose={onClose} />);
    await pickFile(new File(['x'], 'photo.png', { type: 'image/png' }));
    await waitFor(() => expect(uploadGalleryImage).toHaveBeenCalledTimes(1));

    // Host dismissed the modal (Esc / backdrop / X) while the POST was in flight.
    rerender(<GalleryImagePicker open={false} allowUpload onSelect={onSelect} onClose={onClose} />);
    await act(async () => { settleUpload({ filename: 'late.png', path: '/data/images/late.png' }); });

    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('allows a large file when no host cap narrows the wire limit', async () => {
    uploadGalleryImage.mockResolvedValue({ filename: 'big.png', path: '/data/images/big.png' });
    render(<GalleryImagePicker open allowUpload onSelect={vi.fn()} onClose={vi.fn()} />);
    await pickFile(new File(['0123456789'], 'big.png', { type: 'image/png' }));

    await waitFor(() => expect(uploadGalleryImage).toHaveBeenCalledTimes(1));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('filters by universe, preferring the fetched record name over the stamped one', async () => {
    render(<GalleryImagePicker open onClose={vi.fn()} onSelect={vi.fn()} />);
    await screen.findByAltText('a neon sunset');
    await waitFor(() => expect(screen.getByRole('option', { name: 'Renamed Universe' })).toBeTruthy());
    expect(screen.queryByRole('option', { name: 'Stale Name' })).toBeNull();

    fireEvent.change(scopeSelect(), { target: { value: 'uni:uni-a' } });
    await waitFor(() => expect(screen.queryByAltText('a quiet forest')).toBeNull());
    expect(screen.getByAltText('a neon sunset')).toBeTruthy();
    expect(screen.getByAltText('a chrome mecha')).toBeTruthy();
  });

  it('filters by collection membership and omits collections with no image in the gallery', async () => {
    render(<GalleryImagePicker open onClose={vi.fn()} onSelect={vi.fn()} />);
    await screen.findByAltText('a neon sunset');
    await waitFor(() => expect(screen.getByRole('option', { name: 'Mood Board' })).toBeTruthy());
    // 'Video Only' holds a video ref, which this image picker can never show.
    expect(screen.queryByRole('option', { name: 'Video Only' })).toBeNull();

    fireEvent.change(scopeSelect(), { target: { value: 'col:col-1' } });
    await waitFor(() => expect(screen.queryByAltText('a neon sunset')).toBeNull());
    expect(screen.getByAltText('a quiet forest')).toBeTruthy();
    expect(screen.queryByAltText('a chrome mecha')).toBeNull();
  });

  it('filters by type across entryCategory and entryKind, with humanized labels', async () => {
    render(<GalleryImagePicker open onClose={vi.fn()} onSelect={vi.fn()} />);
    await screen.findByAltText('a neon sunset');
    expect(screen.getByRole('option', { name: 'Vehicles' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Canon' })).toBeTruthy();

    fireEvent.change(typeSelect(), { target: { value: 'cat:vehicles' } });
    await waitFor(() => expect(screen.queryByAltText('a neon sunset')).toBeNull());
    expect(screen.getByAltText('a chrome mecha')).toBeTruthy();

    // entryKind is matched by the same select — 'variation' only tags forest.
    fireEvent.change(typeSelect(), { target: { value: 'kind:variation' } });
    await waitFor(() => expect(screen.queryByAltText('a chrome mecha')).toBeNull());
    expect(screen.getByAltText('a quiet forest')).toBeTruthy();
  });

  it('keeps a category keyed like an entry kind distinct from that kind', async () => {
    listImageGallery.mockResolvedValue([
      // A user-authored bucket that happens to be keyed 'canon', on a variation.
      { filename: 'a.png', path: '/data/images/a.png', prompt: 'category canon', entryCategory: 'canon', entryKind: 'variation' },
      { filename: 'b.png', path: '/data/images/b.png', prompt: 'kind canon', entryCategory: 'places', entryKind: 'canon' },
    ]);
    render(<GalleryImagePicker open onClose={vi.fn()} onSelect={vi.fn()} />);
    await screen.findByAltText('category canon');

    fireEvent.change(typeSelect(), { target: { value: 'cat:canon' } });
    await waitFor(() => expect(screen.queryByAltText('kind canon')).toBeNull());
    expect(screen.getByAltText('category canon')).toBeTruthy();

    fireEvent.change(typeSelect(), { target: { value: 'kind:canon' } });
    await waitFor(() => expect(screen.queryByAltText('category canon')).toBeNull());
    expect(screen.getByAltText('kind canon')).toBeTruthy();
  });

  it('AND-combines the filters with the text query', async () => {
    render(<GalleryImagePicker open onClose={vi.fn()} onSelect={vi.fn()} />);
    await screen.findByAltText('a neon sunset');
    await waitFor(() => expect(screen.getByRole('option', { name: 'Renamed Universe' })).toBeTruthy());

    fireEvent.change(scopeSelect(), { target: { value: 'uni:uni-a' } });
    fireEvent.change(screen.getByPlaceholderText(/Search prompt/i), { target: { value: 'mecha' } });
    await waitFor(() => expect(screen.queryByAltText('a neon sunset')).toBeNull());
    expect(screen.getByAltText('a chrome mecha')).toBeTruthy();

    // Query that matches only an out-of-scope image yields nothing, not a fallback.
    fireEvent.change(screen.getByPlaceholderText(/Search prompt/i), { target: { value: 'forest' } });
    await waitFor(() => expect(screen.queryByAltText('a chrome mecha')).toBeNull());
    expect(screen.queryByAltText('a quiet forest')).toBeNull();
    expect(screen.getByText(/No images match your search or filters/i)).toBeTruthy();
  });

  it('restores the full grid when the filters are cleared back to All', async () => {
    render(<GalleryImagePicker open onClose={vi.fn()} onSelect={vi.fn()} />);
    await screen.findByAltText('a neon sunset');
    await waitFor(() => expect(screen.getByRole('option', { name: 'Mood Board' })).toBeTruthy());

    fireEvent.change(scopeSelect(), { target: { value: 'col:col-1' } });
    fireEvent.change(typeSelect(), { target: { value: 'kind:variation' } });
    await waitFor(() => expect(screen.queryByAltText('a neon sunset')).toBeNull());

    fireEvent.change(scopeSelect(), { target: { value: '' } });
    fireEvent.change(typeSelect(), { target: { value: '' } });
    await waitFor(() => expect(screen.getByAltText('a neon sunset')).toBeTruthy());
    expect(screen.getByAltText('a quiet forest')).toBeTruthy();
    expect(screen.getByAltText('a chrome mecha')).toBeTruthy();
  });

  it('degrades to image-derived universes and no collections when those fetches fail', async () => {
    listMediaCollections.mockRejectedValue(new Error('nope'));
    listUniverses.mockRejectedValue(new Error('nope'));
    render(<GalleryImagePicker open onClose={vi.fn()} onSelect={vi.fn()} />);
    await screen.findByAltText('a neon sunset');

    // Universe options fall back to the name stamped on the sidecar.
    await waitFor(() => expect(screen.getByRole('option', { name: 'Stale Name' })).toBeTruthy());
    expect(screen.queryByRole('option', { name: 'Mood Board' })).toBeNull();

    fireEvent.change(scopeSelect(), { target: { value: 'uni:uni-b' } });
    await waitFor(() => expect(screen.queryByAltText('a neon sunset')).toBeNull());
    expect(screen.getByAltText('a quiet forest')).toBeTruthy();
  });

  it('passes silent:true so the picker owns its own filter-fetch failure handling', async () => {
    render(<GalleryImagePicker open onClose={vi.fn()} onSelect={vi.fn()} />);
    await screen.findByAltText('a neon sunset');
    expect(listMediaCollections).toHaveBeenCalledWith({ silent: true });
    expect(listUniverses).toHaveBeenCalledWith({ silent: true });
  });

  it('skips malformed sidecar metadata instead of throwing while building options', async () => {
    listImageGallery.mockResolvedValue([
      // Sidecars are unvalidated JSON on disk and arrive from peers.
      { filename: 'bad.png', path: '/data/images/bad.png', prompt: 'bad metadata', entryCategory: 1, entryKind: {}, universeId: 7, universeName: 42 },
      { filename: 'ok.png', path: '/data/images/ok.png', prompt: 'good metadata', entryCategory: 'places', universeId: 'uni-a', universeName: 'Second Universe' },
      // A string, but one that resolves to an inherited member on the label table.
      { filename: 'proto.png', path: '/data/images/proto.png', prompt: 'prototype key', entryCategory: 'constructor' },
    ]);
    listMediaCollections.mockResolvedValue([{ id: 'col-1', name: 5, items: [{ kind: 'image', ref: 'ok.png' }] }]);
    listUniverses.mockResolvedValue([{ id: 'uni-a', name: 99 }]);
    render(<GalleryImagePicker open onClose={vi.fn()} onSelect={vi.fn()} />);
    await screen.findByAltText('bad metadata');

    expect(screen.getByRole('option', { name: 'Places' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Constructor' })).toBeTruthy();
    // The non-string universe/collection names fall back to their ids, not to a throw.
    await waitFor(() => expect(screen.getByRole('option', { name: 'col-1' })).toBeTruthy());
    expect(screen.getByRole('option', { name: 'Second Universe' })).toBeTruthy();

    fireEvent.change(typeSelect(), { target: { value: 'cat:places' } });
    await waitFor(() => expect(screen.queryByAltText('bad metadata')).toBeNull());
    expect(screen.getByAltText('good metadata')).toBeTruthy();
  });

  it('drops the previous collections/universes on close so a reopen cannot filter on stale membership', async () => {
    const { rerender } = render(<GalleryImagePicker open onClose={vi.fn()} onSelect={vi.fn()} />);
    await screen.findByAltText('a neon sunset');
    await waitFor(() => expect(screen.getByRole('option', { name: 'Mood Board' })).toBeTruthy());

    rerender(<GalleryImagePicker open={false} onClose={vi.fn()} onSelect={vi.fn()} />);
    // Reopen with the collections call left pending — the gallery still resolves.
    listMediaCollections.mockReturnValue(new Promise(() => {}));
    rerender(<GalleryImagePicker open onClose={vi.fn()} onSelect={vi.fn()} />);
    await screen.findByAltText('a neon sunset');
    expect(screen.queryByRole('option', { name: 'Mood Board' })).toBeNull();
  });

  it('does not render the filter selects when nothing is filterable', async () => {
    listImageGallery.mockResolvedValue([{ filename: 'plain.png', path: '/data/images/plain.png', prompt: 'plain' }]);
    listMediaCollections.mockResolvedValue([]);
    listUniverses.mockResolvedValue([]);
    render(<GalleryImagePicker open onClose={vi.fn()} onSelect={vi.fn()} />);
    await screen.findByAltText('plain');
    expect(screen.queryByLabelText(/universe or collection/i)).toBeNull();
    expect(screen.queryByLabelText(/filter by type/i)).toBeNull();
  });
});
