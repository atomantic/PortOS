import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import Media3DDetail from './Media3DDetail';

const getImageTo3dModel = vi.fn();
const generateImageTo3dModel = vi.fn();
const deleteImageTo3dModel = vi.fn();
vi.mock('../services/api', () => ({
  getImageTo3dModel: (...a) => getImageTo3dModel(...a),
  generateImageTo3dModel: (...a) => generateImageTo3dModel(...a),
  deleteImageTo3dModel: (...a) => deleteImageTo3dModel(...a),
}));

// GlbViewer wraps a WebGL canvas jsdom can't render — stub to a marker echoing src.
vi.mock('../components/media/GlbViewer', () => ({
  default: ({ src }) => <div data-testid="glb-viewer">{src}</div>,
}));
vi.mock('../components/MediaImage', () => ({ default: ({ alt, src }) => <img alt={alt} src={src} /> }));
vi.mock('../components/ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));

const record = (over = {}) => ({
  id: 'image3d-1',
  name: 'Example Beacon',
  status: 'ready',
  assetPath: '/data/image-to-3d/image3d-1/model.glb',
  error: null,
  runs: [],
  sourceImage: { filename: 'beacon.png', path: '/data/images/beacon.png' },
  updatedAt: new Date(0).toISOString(),
  ...over,
});

function renderAt(id = 'image3d-1') {
  return render(
    <MemoryRouter initialEntries={[`/media/3d/${id}`]}>
      <Routes>
        <Route path="/media/3d" element={<div>3D index</div>} />
        <Route path="/media/3d/:id" element={<Media3DDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Media3DDetail', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the mesh viewer and source image for a ready record', async () => {
    getImageTo3dModel.mockResolvedValue(record());
    renderAt();
    expect(await screen.findByText('Example Beacon')).toBeInTheDocument();
    expect(screen.getByTestId('glb-viewer')).toHaveTextContent('/data/image-to-3d/image3d-1/model.glb');
    expect(screen.getByAltText('Source image')).toBeInTheDocument();
  });

  it('surfaces the render error for a failed record', async () => {
    getImageTo3dModel.mockResolvedValue(record({ status: 'failed', assetPath: null, error: 'Accept the Hugging Face terms first.' }));
    renderAt();
    expect(await screen.findByText(/Accept the Hugging Face terms first/i)).toBeInTheDocument();
    expect(screen.queryByTestId('glb-viewer')).toBeNull();
  });

  it('shows a not-found fallback for a stale id', async () => {
    getImageTo3dModel.mockRejectedValue(Object.assign(new Error('nope'), { status: 404 }));
    renderAt('gone');
    expect(await screen.findByText(/no longer exists/i)).toBeInTheDocument();
  });

  it('deletes and navigates back to the index', async () => {
    getImageTo3dModel.mockResolvedValue(record());
    deleteImageTo3dModel.mockResolvedValue({ ok: true });
    renderAt();
    fireEvent.click(await screen.findByRole('button', { name: /delete/i }));
    // The inline confirm row appears; click its Confirm button.
    const confirmRow = await screen.findByText(/Delete "Example Beacon"\?/i);
    fireEvent.click(within(confirmRow.parentElement).getByRole('button', { name: /^delete$/i }));
    await waitFor(() => expect(deleteImageTo3dModel).toHaveBeenCalledWith('image3d-1', { silent: true }));
    expect(await screen.findByText('3D index')).toBeInTheDocument();
  });
});
