import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Media3D from './Media3D';

const getImageTo3dTargets = vi.fn();
vi.mock('../services/api', () => ({
  getImageTo3dTargets: (...a) => getImageTo3dTargets(...a),
}));

// Stub the shared install modal so the test doesn't open a real EventSource;
// assert only that it's opened with the chosen target.
vi.mock('../components/install/RuntimeInstallModal', () => ({
  default: ({ open, runtime }) => (open ? <div data-testid="install-modal">installing {runtime}</div> : null),
}));

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

describe('Media3D', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows an Install button for an available, not-installed target and opens the modal', async () => {
    getImageTo3dTargets.mockResolvedValue({ capabilities: {}, targets: [target()] });
    render(<Media3D />);
    const btn = await screen.findByRole('button', { name: /install/i });
    fireEvent.click(btn);
    expect(await screen.findByTestId('install-modal')).toHaveTextContent('trellis2');
  });

  it('shows Ready and no Install button when the target is installed', async () => {
    getImageTo3dTargets.mockResolvedValue({ targets: [target({ installed: true })] });
    render(<Media3D />);
    expect(await screen.findByText(/ready/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /install/i })).toBeNull();
  });

  it('shows the unsupported reason and no Install button when the host cannot run it', async () => {
    getImageTo3dTargets.mockResolvedValue({
      targets: [target({ available: false, unavailableReason: 'requires-apple-silicon' })],
    });
    render(<Media3D />);
    expect(await screen.findByText(/requires an apple silicon mac/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /install/i })).toBeNull();
  });

  it('surfaces a load error with Retry, and recovers on retry', async () => {
    getImageTo3dTargets.mockRejectedValueOnce(new Error('boom'));
    render(<Media3D />);
    expect(await screen.findByText('boom')).toBeInTheDocument();

    getImageTo3dTargets.mockResolvedValueOnce({ targets: [target({ installed: true })] });
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText(/ready/i)).toBeInTheDocument();
  });
});
