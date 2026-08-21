import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import Media3DDetail from './Media3DDetail';

const getImageTo3dModel = vi.fn();
const generateImageTo3dModel = vi.fn();
const deleteImageTo3dModel = vi.fn();
vi.mock('../services/api', () => ({
  getImageTo3dModel: (...a) => getImageTo3dModel(...a),
  generateImageTo3dModel: (...a) => generateImageTo3dModel(...a),
  deleteImageTo3dModel: (...a) => deleteImageTo3dModel(...a),
  imageTo3dAssetUrl: (id) => `/api/image-to-3d/models/${id}/asset`,
  imageTo3dFullMeshUrl: (id) => `/api/image-to-3d/models/${id}/full-mesh`,
}));

// GlbViewer wraps a WebGL canvas jsdom can't render — stub to a marker echoing src.
vi.mock('../components/media/GlbViewer', () => ({
  default: ({ src, forceOpaque }) => (
    <div data-testid="glb-viewer" data-force-opaque={String(forceOpaque)}>{src}</div>
  ),
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
    <MemoryRouter initialEntries={[`/3d/${id}`]}>
      <Routes>
        <Route path="/3d" element={<div>3D index</div>} />
        <Route path="/3d/:id" element={<Media3DDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Media3DDetail', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the mesh viewer and source image for a ready record', async () => {
    getImageTo3dModel.mockResolvedValue(record({ generatedAt: '2026-07-25T12:34:56.000Z' }));
    renderAt();
    expect(await screen.findByText('Example Beacon')).toBeInTheDocument();
    expect(screen.getByTestId('glb-viewer')).toHaveTextContent(
      '/data/image-to-3d/image3d-1/model.glb?v=2026-07-25T12%3A34%3A56.000Z',
    );
    expect(screen.getByTestId('glb-viewer')).toHaveAttribute('data-force-opaque', 'true');
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

  it('re-render sends the chosen per-run options (blank seed omitted → server rolls fresh)', async () => {
    getImageTo3dModel.mockResolvedValue(record());
    generateImageTo3dModel.mockResolvedValue(record({ status: 'generating' }));
    renderAt();
    await screen.findByText('Example Beacon');

    fireEvent.change(screen.getByLabelText(/quality/i), { target: { value: '24' } });
    fireEvent.click(screen.getByRole('button', { name: /re-render/i }));

    await waitFor(() => expect(generateImageTo3dModel).toHaveBeenCalledWith(
      'image3d-1',
      // normalMap is sent explicitly rather than omitted. It defaults OFF (the bake
      // can lose a render outright), and stating it keeps the body honest about what
      // the run asked for even if that default ever moves.
      { steps: 24, keyBackground: false, normalMap: false },
      { silent: true },
    ));
  });

  it('seeds steps/keying from the latest run but leaves the seed blank (stays random)', async () => {
    getImageTo3dModel.mockResolvedValue(record({
      runs: [{ operationId: 'op-1', status: 'completed', percent: 100, steps: 48, seed: 1234, keyBackground: false }],
    }));
    generateImageTo3dModel.mockResolvedValue(record({ status: 'generating' }));
    renderAt();
    await screen.findByText('Example Beacon');

    // The seeding effect commits one render after the record lands — wait for it.
    await waitFor(() => expect(screen.getByLabelText(/quality/i)).toHaveValue('48'));
    // Blank by design — echoing the run's concrete seed back would silently pin
    // it, reintroducing the deterministic-re-render trap.
    expect(screen.getByLabelText(/seed/i)).toHaveValue(null);
    expect(screen.getByLabelText(/key out flat backdrop/i)).not.toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: /re-render/i }));
    await waitFor(() => expect(generateImageTo3dModel).toHaveBeenCalledWith(
      'image3d-1',
      { steps: 48, keyBackground: false, normalMap: false },
      { silent: true },
    ));
  });

  it('carries the detail tier and normal-map choice over from the latest run', async () => {
    // Deliberate quality choices, so they inherit like steps does — unlike seed,
    // which must stay blank.
    getImageTo3dModel.mockResolvedValue(record({
      runs: [{
        operationId: 'op-1', status: 'completed', percent: 100,
        detail: 'fast', alphaMode: 'auto', normalMap: false,
      }],
    }));
    generateImageTo3dModel.mockResolvedValue(record({ status: 'generating' }));
    renderAt();
    await screen.findByText('Example Beacon');

    await waitFor(() => expect(screen.getByLabelText(/detail/i)).toHaveValue('fast'));
    expect(screen.getByLabelText(/transparency/i)).toHaveValue('auto');
    expect(screen.getByLabelText(/bake normal map/i)).not.toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: /re-render/i }));
    await waitFor(() => expect(generateImageTo3dModel).toHaveBeenCalledWith(
      'image3d-1',
      { keyBackground: false, detail: 'fast', alphaMode: 'auto', normalMap: false },
      { silent: true },
    ));
  });

  it('offers the full-resolution mesh download, labelled as geometry only', async () => {
    // ~1 GB of untextured v/f OBJ. The label has to say so, or someone downloads it
    // expecting a textured model.
    getImageTo3dModel.mockResolvedValue(record());
    renderAt();
    await screen.findByText('Example Beacon');
    const link = screen.getByRole('link', { name: /full-resolution mesh/i });
    expect(link).toHaveAttribute('href', '/api/image-to-3d/models/image3d-1/full-mesh');
    expect(link.textContent).toMatch(/geometry only/i);
  });

  describe('viewer transparency', () => {
    // The viewer is the third layer able to flatten alpha, after the exporter's
    // alpha_mode and PortOS's GLB rewrite. If it keeps forcing opaque, a mesh
    // exported as BLEND still renders solid and reads as a broken exporter.
    it('forces opaque when the run asked for no transparency', async () => {
      getImageTo3dModel.mockResolvedValue(record({
        runs: [{ operationId: 'op-1', status: 'completed', percent: 100 }],
      }));
      renderAt();
      await screen.findByText('Example Beacon');
      expect(screen.getByTestId('glb-viewer')).toHaveAttribute('data-force-opaque', 'true');
    });

    it('stops forcing opaque when the run requested a transparent material', async () => {
      getImageTo3dModel.mockResolvedValue(record({
        runs: [{ operationId: 'op-1', status: 'completed', percent: 100, alphaMode: 'BLEND' }],
      }));
      renderAt();
      await screen.findByText('Example Beacon');
      expect(screen.getByTestId('glb-viewer')).toHaveAttribute('data-force-opaque', 'false');
    });

    it('still forces opaque when the run explicitly asked for OPAQUE', async () => {
      getImageTo3dModel.mockResolvedValue(record({
        runs: [{ operationId: 'op-1', status: 'completed', percent: 100, alphaMode: 'OPAQUE' }],
      }));
      renderAt();
      await screen.findByText('Example Beacon');
      expect(screen.getByTestId('glb-viewer')).toHaveAttribute('data-force-opaque', 'true');
    });
  });

  it('shows the latest run’s seed, steps, and keyed-background badge in the meta line', async () => {
    getImageTo3dModel.mockResolvedValue(record({
      runs: [{ operationId: 'op-1', status: 'completed', percent: 100, seed: 777, steps: 24, sourceKeyed: true }],
    }));
    renderAt();
    await screen.findByText('Example Beacon');
    // Scope to the meta paragraph — the quality <select> also mentions "24 steps".
    const meta = screen.getByText(/seed 777/);
    expect(meta.textContent).toContain('24 steps');
    expect(meta.textContent).toContain('background keyed');
  });
});
