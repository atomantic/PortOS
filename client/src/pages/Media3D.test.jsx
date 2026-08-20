import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import Media3D from './Media3D';

const getImageTo3dTargets = vi.fn();
const createImageTo3dModel = vi.fn();
const getImageTo3dModel = vi.fn();
const listImageTo3dModels = vi.fn();
const getHfTokenStatus = vi.fn();
vi.mock('../services/api', () => ({
  getImageTo3dTargets: (...a) => getImageTo3dTargets(...a),
  createImageTo3dModel: (...a) => createImageTo3dModel(...a),
  getImageTo3dModel: (...a) => getImageTo3dModel(...a),
  listImageTo3dModels: (...a) => listImageTo3dModels(...a),
  getHfTokenStatus: (...a) => getHfTokenStatus(...a),
}));

// Stub the shared install modal so the test doesn't open a real EventSource;
// assert only that it's opened with the chosen target.
vi.mock('../components/install/RuntimeInstallModal', () => ({
  default: ({ open, runtime, description }) => (open ? <div data-testid="install-modal">
    installing {runtime}<span data-testid="install-description">{description}</span>
  </div> : null),
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
  gatedRepos: [
    {
      label: 'facebook/dinov3-vitl16-pretrain-lvd1689m',
      url: 'https://huggingface.co/facebook/dinov3-vitl16-pretrain-lvd1689m',
    },
    { label: 'briaai/RMBG-2.0', url: 'https://huggingface.co/briaai/RMBG-2.0' },
  ],
  ...over,
});

function LocationProbe() {
  return <output aria-label="Current query">{useLocation().search}</output>;
}

// Media3D reads the source image / target / glb from the URL, so every render
// needs a router. The path is irrelevant to useSearchParams — only the query is.
function renderAt(entry = '/3d', extra = null) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Media3D />
      {extra}
    </MemoryRouter>,
  );
}

describe('Media3D — models & install', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listImageTo3dModels.mockResolvedValue([]);
    getHfTokenStatus.mockResolvedValue({ hfTokenPresent: false, source: 'none' });
  });

  it('shows an Install button for an available, not-installed target and opens the modal', async () => {
    getImageTo3dTargets.mockResolvedValue({ capabilities: {}, targets: [target()] });
    renderAt();
    const btn = await screen.findByRole('button', { name: /install/i });
    fireEvent.click(btn);
    expect(await screen.findByTestId('install-modal')).toHaveTextContent('trellis2');
  });

  it('uses the selected target gated-repo count in the install description', async () => {
    getImageTo3dTargets.mockResolvedValue({ capabilities: {}, targets: [target()] });
    renderAt();
    fireEvent.click(await screen.findByRole('button', { name: /install/i }));
    expect(await screen.findByTestId('install-description')).toHaveTextContent('2 gated Hugging Face models');
  });

  it('shows Ready and no Install button when the target is installed', async () => {
    getImageTo3dTargets.mockResolvedValue({ targets: [target({ installed: true })] });
    renderAt();
    expect(await screen.findByText(/ready/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /install/i })).toBeNull();
  });

  // #2952: `setup.sh` exits 0 even when its Metal texture-baking backends failed to
  // build, and such an install renders correct geometry with a scrambled surface —
  // so a flat "Ready" would be a lie, and re-running Install is the repair.
  it('flags a degraded texture bake and offers Repair install', async () => {
    getImageTo3dTargets.mockResolvedValue({
      targets: [target({
        installed: true,
        degraded: { label: 'degraded textures', help: 'Install the Metal Toolchain.', repairable: true },
      })],
    });
    renderAt();
    expect(await screen.findByText(/degraded textures/i)).toBeInTheDocument();
    expect(screen.getByText('Install the Metal Toolchain.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /repair install/i })).toBeInTheDocument();
  });

  // #3041: on a Command-Line-Tools-only host, Repair install would fail the same
  // way — so flag the problem but don't offer a button that can't fix it.
  it('flags a degraded bake but offers no Repair button when the server says it is not repairable', async () => {
    getImageTo3dTargets.mockResolvedValue({
      targets: [target({
        installed: true,
        degraded: {
          label: 'degraded textures', help: 'Install Xcode from the App Store.', repairable: false,
        },
      })],
    });
    renderAt();
    expect(await screen.findByText(/degraded textures/i)).toBeInTheDocument();
    expect(screen.getByText('Install Xcode from the App Store.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /install/i })).toBeNull();
  });

  // The degraded projection is normalized server-side, so a target degraded for an
  // entirely different reason (Pixal3D with no NATTEN) renders through the same path
  // with no per-target UI branch.
  it('renders a non-TRELLIS degradation through the same badge and Repair button', async () => {
    getImageTo3dTargets.mockResolvedValue({
      targets: [target({
        id: 'pixal3dCuda',
        label: 'Pixal3D (CUDA)',
        installed: true,
        degraded: { label: 'NAF fallback', help: 'NATTEN is missing.', repairable: true },
      })],
    });
    renderAt();
    expect(await screen.findByText(/NAF fallback/i)).toBeInTheDocument();
    expect(screen.getByText('NATTEN is missing.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /repair install/i })).toBeInTheDocument();
    // Must NOT leak the other lane's copy.
    expect(screen.queryByText(/metal toolchain/i)).toBeNull();
  });

  it('stays plain Ready when the server reports no degradation', async () => {
    // The server owns the unknown-vs-degraded distinction (a probe that merely failed
    // must not cry wolf) and expresses it by OMITTING `degraded`. Asserting on the
    // absence of that field is what actually exercises the component; a `textureBake`
    // fixture would not, since nothing here reads it.
    getImageTo3dTargets.mockResolvedValue({
      targets: [target({ installed: true })],
    });
    renderAt();
    expect(await screen.findByText(/ready/i)).toBeInTheDocument();
    expect(screen.queryByText(/degraded/i)).toBeNull();
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
    listImageTo3dModels.mockResolvedValue([]);
    getImageTo3dTargets.mockResolvedValue({ targets: [target({ installed: true })] });
    getHfTokenStatus.mockResolvedValue({ hfTokenPresent: false, source: 'none' });
  });

  it('shows the source image from the ?image= deep link', async () => {
    renderAt('/3d?image=example-robot.png');
    expect(await screen.findByAltText('Selected source image')).toBeInTheDocument();
    expect(screen.queryByText(/Pick a source image to continue/i)).not.toBeInTheDocument();
  });

  it('enables Generate when an image + ready target are staged, and previews the produced mesh', async () => {
    createImageTo3dModel.mockResolvedValue({ id: 'm1', status: 'generating', assetPath: null, runs: [] });
    getImageTo3dModel.mockResolvedValue({
      id: 'm1', status: 'ready', assetPath: '/data/image-to-3d/m1/model.glb', runs: [{ percent: 100 }],
    });
    renderAt('/3d?image=example-robot.png');
    const btn = await screen.findByRole('button', { name: /Generate 3D/i });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    await waitFor(() => expect(createImageTo3dModel).toHaveBeenCalledWith(
      expect.objectContaining({ filename: 'example-robot.png', target: 'trellis2', name: 'Example Robot' }),
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
    renderAt('/3d?image=example-robot.png');
    fireEvent.click(await screen.findByRole('button', { name: /Generate 3D/i }));
    expect(await screen.findByText(/could not download a gated model dependency from Hugging Face/i)).toBeInTheDocument();
    // No mesh preview on failure.
    expect(screen.queryByTestId('glb-viewer')).toBeNull();
  });

  it('offers inline token entry, not terminal instructions, when no HF token is stored', async () => {
    renderAt('/3d?image=example-robot.png');
    expect(await screen.findByText(/needs a free Hugging Face account/i)).toBeInTheDocument();
    // The fix for #3032: a paste-and-save field, not a "run huggingface-cli login" nag.
    expect(screen.getByPlaceholderText('hf_…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save token/i })).toBeInTheDocument();
    expect(screen.queryByText(/huggingface-cli login/i)).toBeNull();
    // Both gated repos stay linked — terms acceptance is separate from having a token.
    expect(screen.getByRole('link', { name: /dinov3-vitl16-pretrain-lvd1689m/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /RMBG-2\.0/i })).toBeInTheDocument();
  });

  it('renders no gated-access notice when the selected target omits gatedRepos', async () => {
    getImageTo3dTargets.mockResolvedValue({ targets: [target({ gatedRepos: undefined, installed: true })] });
    renderAt('/3d?image=example-robot.png');
    await screen.findByRole('button', { name: /Generate 3D/i });
    await waitFor(() => expect(getHfTokenStatus).toHaveBeenCalled());
    expect(screen.queryByPlaceholderText('hf_…')).toBeNull();
    expect(screen.queryByText(/Hugging Face token configured/i)).toBeNull();
    expect(screen.queryByRole('link', { name: /dinov3-vitl16-pretrain-lvd1689m/i })).toBeNull();
  });

  it('collapses to a confirmation naming the source when a token already exists', async () => {
    // The user's real complaint: an HF_TOKEN set for imagegen/local-LLM downloads was
    // ignored here, so the page kept demanding a terminal login.
    getHfTokenStatus.mockResolvedValue({ hfTokenPresent: true, source: 'env' });
    renderAt('/3d?image=example-robot.png');
    expect(await screen.findByText(/Hugging Face token configured/i)).toBeInTheDocument();
    expect(screen.getByText(/HF_TOKEN environment variable/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('hf_…')).toBeNull();
    // Terms links persist — a token alone doesn't grant gated access.
    expect(screen.getByRole('link', { name: /dinov3-vitl16-pretrain-lvd1689m/i })).toBeInTheDocument();
  });

  it('lets a user with a configured token reach the paste form to replace a stale one', async () => {
    // The runner's HF-auth guidance also fires on `401` / `Invalid user token` and
    // tells the user to add a token on THIS page — so the form must stay reachable
    // when one is already configured, or that instruction can't be followed here.
    getHfTokenStatus.mockResolvedValue({ hfTokenPresent: true, source: 'stored' });
    renderAt('/3d?image=example-robot.png');
    fireEvent.click(await screen.findByRole('button', { name: /use a different token/i }));
    expect(screen.getByPlaceholderText('hf_…')).toBeInTheDocument();
  });

  it('shows neither the banner nor the confirmation while token status is still unknown', async () => {
    // Absent-vs-failed: a pending/failed status must not flash "add a token" at a user
    // who has one (nor claim one is configured).
    getHfTokenStatus.mockRejectedValue(new Error('offline'));
    renderAt('/3d?image=example-robot.png');
    await screen.findByRole('button', { name: /Generate 3D/i });
    expect(screen.queryByPlaceholderText('hf_…')).toBeNull();
    expect(screen.queryByText(/Hugging Face token configured/i)).toBeNull();
  });

  it('keeps Generate disabled and explains why when no image is picked', async () => {
    renderAt('/3d');
    const btn = await screen.findByRole('button', { name: /Generate 3D/i });
    expect(btn).toBeDisabled();
    expect(screen.getByText(/Pick a source image to continue/i)).toBeInTheDocument();
  });

  it('gates Generate when the chosen target still needs installing', async () => {
    getImageTo3dTargets.mockResolvedValue({ targets: [target({ installed: false })] });
    renderAt('/3d?image=example-robot.png');
    const btn = await screen.findByRole('button', { name: /Generate 3D/i });
    expect(btn).toBeDisabled();
    expect(screen.getByText(/Install TRELLIS\.2 below before generating/i)).toBeInTheDocument();
  });

  it('writes a picked image into the shareable URL', async () => {
    renderAt('/3d', <LocationProbe />);
    fireEvent.click(await screen.findByRole('button', { name: /Pick source image/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Pick hero' }));
    await waitFor(() => {
      expect(screen.getByLabelText('Current query')).toHaveTextContent('image=picked-hero.png');
    });
  });

  it('reflects the resolved default target back into the URL', async () => {
    renderAt('/3d', <LocationProbe />);
    await waitFor(() => {
      expect(screen.getByLabelText('Current query')).toHaveTextContent('target=trellis2');
    });
  });

  it('renders the mesh preview from a ?glb= deep link', async () => {
    renderAt('/3d?image=example-robot.png&glb=%2Fdata%2Fmodels3d%2Frobot.glb');
    expect(await screen.findByTestId('glb-viewer')).toHaveTextContent('/data/models3d/robot.glb');
  });

  it('lists existing 3D records as deep links to their detail route', async () => {
    listImageTo3dModels.mockResolvedValue([
      { id: 'image3d-abc', name: 'Example Beacon', status: 'ready', updatedAt: new Date(0).toISOString(), sourceImage: { path: '/data/images/beacon.png' } },
    ]);
    renderAt();
    const link = await screen.findByRole('link', { name: /Example Beacon/i });
    expect(link.getAttribute('href')).toBe('/3d/image3d-abc');
  });
});
