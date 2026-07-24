import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import Media3D from './Media3D';

const getImageTo3dTargets = vi.fn();
const createImageTo3dModel = vi.fn();
const getImageTo3dModel = vi.fn();
vi.mock('../services/api', () => ({
  getImageTo3dTargets: (...a) => getImageTo3dTargets(...a),
  createImageTo3dModel: (...a) => createImageTo3dModel(...a),
  getImageTo3dModel: (...a) => getImageTo3dModel(...a),
}));

// Stub the shared install modal so the test doesn't open a real EventSource;
// assert only that it's opened with the chosen target.
vi.mock('../components/install/RuntimeInstallModal', () => ({
  default: ({ open, runtime }) => (open ? <div data-testid="install-modal">installing {runtime}</div> : null),
}));

// GlbViewer wraps a WebGL canvas jsdom can't render — stub to a marker that
// echoes the src so the ?glb= deep-link wiring is assertable without three.js.
vi.mock('../components/media/GlbViewer', () => ({
  default: ({ src }) => <div data-testid="glb-viewer">{src}</div>,
}));

// Minimal gallery picker that hands back a fixed selection on click.
vi.mock('../components/imageGen/GalleryImagePicker', () => ({
  default: ({ open, onSelect }) => open ? (
    <button type="button" onClick={() => onSelect({ filename: 'picked-hero.png' })}>Pick hero</button>
  ) : null,
}));

vi.mock('../components/MediaImage', () => ({ default: ({ alt }) => <img alt={alt} /> }));

const target = (over = {}) => ({
  id: 'trellis2',
  label: 'TRELLIS.2',
  description: 'Microsoft TRELLIS.2 — single image to a PBR-textured GLB mesh.',
  executionLane: 'local-mps',
  outputKind: 'glb-mesh',
  available: true,
  installed: false,
  unavailableReason: null,
  upstream: 'https://github.com/microsoft/TRELLIS.2',
  port: 'https://github.com/shivampkumar/trellis-mac',
  ...over,
});

function LocationProbe() {
  return <output aria-label="Current query">{useLocation().search}</output>;
}

// Media3D reads the source image / target / glb from the URL, so every render
// needs a router. The path is irrelevant to useSearchParams — only the query is.
function renderAt(entry = '/media/3d', extra = null) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Media3D />
      {extra}
    </MemoryRouter>,
  );
}

describe('Media3D — models & install', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows an Install button for an available, not-installed target and opens the modal', async () => {
    getImageTo3dTargets.mockResolvedValue({ capabilities: {}, targets: [target()] });
    renderAt();
    const btn = await screen.findByRole('button', { name: /install/i });
    fireEvent.click(btn);
    expect(await screen.findByTestId('install-modal')).toHaveTextContent('trellis2');
  });

  it('shows Ready and no Install button when the target is installed', async () => {
    getImageTo3dTargets.mockResolvedValue({ targets: [target({ installed: true })] });
    renderAt();
    expect(await screen.findByText(/ready/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /install/i })).toBeNull();
  });

  it('shows the unsupported reason and no Install button when the host cannot run it', async () => {
    getImageTo3dTargets.mockResolvedValue({
      targets: [target({ available: false, unavailableReason: 'requires-apple-silicon' })],
    });
    renderAt();
    expect(await screen.findAllByText(/requires an apple silicon mac/i)).not.toHaveLength(0);
    expect(screen.queryByRole('button', { name: /install/i })).toBeNull();
  });

  it('surfaces a load error with Retry, and recovers on retry', async () => {
    getImageTo3dTargets.mockRejectedValueOnce(new Error('boom'));
    renderAt();
    expect(await screen.findByText('boom')).toBeInTheDocument();

    getImageTo3dTargets.mockResolvedValueOnce({ targets: [target({ installed: true })] });
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText(/ready/i)).toBeInTheDocument();
  });
});

describe('Media3D — generation workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getImageTo3dTargets.mockResolvedValue({ targets: [target({ installed: true })] });
  });

  it('shows the source image from the ?image= deep link', async () => {
    renderAt('/media/3d?image=example-robot.png');
    expect(await screen.findByAltText('Selected source image')).toBeInTheDocument();
    expect(screen.queryByText(/Pick a source image to continue/i)).not.toBeInTheDocument();
  });

  it('enables Generate when an image + ready target are staged, and previews the produced mesh', async () => {
    createImageTo3dModel.mockResolvedValue({ id: 'm1', status: 'generating', assetPath: null, runs: [] });
    getImageTo3dModel.mockResolvedValue({
      id: 'm1', status: 'ready', assetPath: '/data/image-to-3d/m1/model.glb', runs: [{ percent: 100 }],
    });
    renderAt('/media/3d?image=example-robot.png');
    const btn = await screen.findByRole('button', { name: /Generate 3D/i });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    await waitFor(() => expect(createImageTo3dModel).toHaveBeenCalledWith(
      expect.objectContaining({ filename: 'example-robot.png', target: 'trellis2', name: 'example-robot' }),
      expect.anything(),
    ));
    expect(await screen.findByTestId('glb-viewer')).toHaveTextContent('/data/image-to-3d/m1/model.glb');
  });

  it('surfaces the render error (e.g. the Hugging Face auth guidance) on failure', async () => {
    createImageTo3dModel.mockResolvedValue({ id: 'm2', status: 'generating', runs: [] });
    getImageTo3dModel.mockResolvedValue({
      id: 'm2', status: 'failed', assetPath: null,
      error: 'TRELLIS.2 could not download a gated model dependency from Hugging Face. Accept the terms … huggingface-cli login',
    });
    renderAt('/media/3d?image=example-robot.png');
    fireEvent.click(await screen.findByRole('button', { name: /Generate 3D/i }));
    expect(await screen.findByText(/could not download a gated model dependency from Hugging Face/i)).toBeInTheDocument();
    // No mesh preview on failure.
    expect(screen.queryByTestId('glb-viewer')).toBeNull();
  });

  it('shows the Hugging Face gated-model prerequisite for the TRELLIS.2 target', async () => {
    renderAt('/media/3d?image=example-robot.png');
    expect(await screen.findByText(/needs a free Hugging Face account/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /dinov3-vitl16-pretrain-lvd1689m/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /RMBG-2\.0/i })).toBeInTheDocument();
  });

  it('keeps Generate disabled and explains why when no image is picked', async () => {
    renderAt('/media/3d');
    const btn = await screen.findByRole('button', { name: /Generate 3D/i });
    expect(btn).toBeDisabled();
    expect(screen.getByText(/Pick a source image to continue/i)).toBeInTheDocument();
  });

  it('gates Generate when the chosen target still needs installing', async () => {
    getImageTo3dTargets.mockResolvedValue({ targets: [target({ installed: false })] });
    renderAt('/media/3d?image=example-robot.png');
    const btn = await screen.findByRole('button', { name: /Generate 3D/i });
    expect(btn).toBeDisabled();
    expect(screen.getByText(/Install TRELLIS\.2 below before generating/i)).toBeInTheDocument();
  });

  it('writes a picked image into the shareable URL', async () => {
    renderAt('/media/3d', <LocationProbe />);
    fireEvent.click(await screen.findByRole('button', { name: /Pick source image/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Pick hero' }));
    await waitFor(() => {
      expect(screen.getByLabelText('Current query')).toHaveTextContent('image=picked-hero.png');
    });
  });

  it('reflects the resolved default target back into the URL', async () => {
    renderAt('/media/3d', <LocationProbe />);
    await waitFor(() => {
      expect(screen.getByLabelText('Current query')).toHaveTextContent('target=trellis2');
    });
  });

  it('renders the mesh preview from a ?glb= deep link', async () => {
    renderAt('/media/3d?image=example-robot.png&glb=%2Fdata%2Fmodels3d%2Frobot.glb');
    expect(await screen.findByTestId('glb-viewer')).toHaveTextContent('/data/models3d/robot.glb');
  });
});
