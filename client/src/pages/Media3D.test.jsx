import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { imageTo3dTarget } from '../lib/imageTo3dTargetFixture';
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

const target = imageTo3dTarget;

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

// Install/repair moved to Models → 3D (#4728) and is covered by
// `components/models/Image3dRuntimes.test.jsx`. What stays here is the contract
// the generate flow still owns: it must name the runtime state and point at the
// page that fixes it, rather than silently offering a dead Generate button.
describe('Media3D — runtime state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.matchMedia = vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    listImageTo3dModels.mockResolvedValue([]);
    getHfTokenStatus.mockResolvedValue({ hfTokenPresent: false, source: 'none' });
  });

  it('summarizes how many runtimes are ready and links to the manager', async () => {
    getImageTo3dTargets.mockResolvedValue({
      targets: [target({ installed: true }), target({ id: 'pixal3dCuda', label: 'Pixal3D (CUDA)' })],
    });
    renderAt();
    expect(await screen.findByText(/1 of 2 ready on this host/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /manage runtimes/i }).getAttribute('href')).toBe('/models/3d');
  });

  it('surfaces a target-load failure and recovers from it without a page reload', async () => {
    // The same failed list also gates Generate (no target resolves), so leaving the
    // error with no Retry strands the user on a page whose primary action is dead.
    getImageTo3dTargets.mockRejectedValueOnce(new Error('boom'));
    renderAt();
    expect(await screen.findByText('boom')).toBeInTheDocument();

    getImageTo3dTargets.mockResolvedValueOnce({ targets: [target({ installed: true })] });
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText(/1 of 1 ready on this host/i)).toBeInTheDocument();
  });

  it('does not host the install controls any more', async () => {
    getImageTo3dTargets.mockResolvedValue({ targets: [target()] });
    renderAt();
    await screen.findByRole('link', { name: /manage runtimes/i });
    expect(screen.queryByRole('button', { name: /install/i })).toBeNull();
  });
});

describe('Media3D — generation workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.matchMedia = vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
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

  it('sends per-run options chosen after mount, not the values captured at mount', async () => {
    // Guards a stale-closure class of bug: handleGenerate is a useCallback, and a new
    // option added to its body without extending its dependency array silently sends
    // the mount-time default. Found exactly that way on both the create and re-render
    // paths — the existing create assertion used objectContaining and could not see it.
    createImageTo3dModel.mockResolvedValue({ id: 'm3', status: 'generating', runs: [] });
    getImageTo3dModel.mockResolvedValue({ id: 'm3', status: 'generating', runs: [] });
    renderAt('/3d?image=example-robot.png');
    await screen.findByRole('button', { name: /Generate 3D/i });

    fireEvent.change(screen.getByLabelText(/detail/i), { target: { value: 'fast' } });
    fireEvent.change(screen.getByLabelText(/transparency/i), { target: { value: 'BLEND' } });
    // Defaults off, so clicking it turns the bake ON — which is also the direction
    // that matters here: an opt-in the user selected must survive to the request.
    fireEvent.click(screen.getByLabelText(/bake normal map/i));
    fireEvent.click(screen.getByRole('button', { name: /Generate 3D/i }));

    await waitFor(() => expect(createImageTo3dModel).toHaveBeenCalledWith(
      expect.objectContaining({ detail: 'fast', alphaMode: 'BLEND', normalMap: true }),
      expect.anything(),
    ));
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

  it('puts the primary action before closed render options on a narrow viewport', async () => {
    const { container } = renderAt('/3d');
    const generate = await screen.findByRole('button', { name: /Generate 3D/i });
    const options = container.querySelector('details');

    expect(options).toBeInTheDocument();
    expect(options).not.toHaveAttribute('open');
    expect(generate.compareDocumentPosition(options) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('gates Generate when the chosen target still needs installing', async () => {
    getImageTo3dTargets.mockResolvedValue({ targets: [target({ installed: false })] });
    renderAt('/3d?image=example-robot.png');
    const btn = await screen.findByRole('button', { name: /Generate 3D/i });
    expect(btn).toBeDisabled();
    expect(screen.getByText(/Install TRELLIS\.2 from Models → 3D before generating/i)).toBeInTheDocument();
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
