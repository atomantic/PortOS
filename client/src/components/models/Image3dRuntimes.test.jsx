/**
 * Models → 3D: the image-to-3D runtime manager.
 *
 * These cases moved here wholesale from `pages/Media3D.test.jsx` when the
 * install/repair half of the 3D page moved into the Models section (#4728) —
 * they were always about runtime state, not about rendering a mesh.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { imageTo3dTarget } from '../../lib/imageTo3dTargetFixture';
import Image3dRuntimes from './Image3dRuntimes';

const getImageTo3dTargets = vi.fn();
const getHfTokenStatus = vi.fn();
vi.mock('../../services/api', () => ({
  getImageTo3dTargets: (...a) => getImageTo3dTargets(...a),
  getHfTokenStatus: (...a) => getHfTokenStatus(...a),
}));

// Stub the shared install modal so the test doesn't open a real EventSource;
// assert only that it's opened with the chosen target.
vi.mock('../install/RuntimeInstallModal', () => ({
  default: ({ open, runtime, description }) => (open ? <div data-testid="install-modal">
    installing {runtime}
    <span data-testid="install-description">
      {/* The real modal defaults this via a default PARAMETER, so only `undefined`
          reaches the fallback — rendering the raw value would make '' (a blank panel)
          indistinguishable from "use your default". Mark the absent case explicitly. */}
      {description === undefined ? '(default)' : description}
    </span>
  </div> : null),
}));

const target = imageTo3dTarget;

const renderPanel = () => render(<MemoryRouter><Image3dRuntimes /></MemoryRouter>);

describe('Image3dRuntimes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getHfTokenStatus.mockResolvedValue({ hfTokenPresent: false, source: 'none' });
  });

  it('shows an Install button for an available, not-installed target and opens the modal', async () => {
    getImageTo3dTargets.mockResolvedValue({ capabilities: {}, targets: [target()] });
    renderPanel();
    const btn = await screen.findByRole('button', { name: /^install$/i });
    fireEvent.click(btn);
    expect(await screen.findByTestId('install-modal')).toHaveTextContent('trellis2');
  });

  it('uses the selected target gated-repo count in the install description', async () => {
    getImageTo3dTargets.mockResolvedValue({ capabilities: {}, targets: [target()] });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /^install$/i }));
    expect(await screen.findByTestId('install-description')).toHaveTextContent('2 gated Hugging Face models');
  });

  it('shows Ready and no Install button when the target is installed', async () => {
    getImageTo3dTargets.mockResolvedValue({ targets: [target({ installed: true })] });
    renderPanel();
    expect(await screen.findByText(/ready/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /install/i })).toBeNull();
  });

  it.each([false, true])('shows the profile blocker without Install or Repair (installed: %s)', async (installed) => {
    const reason = 'Install and Repair require a locked TRELLIS.2 Metal profile.';
    getImageTo3dTargets.mockResolvedValue({ targets: [target({
      installed,
      installBlockedReason: reason,
      ...(installed ? { degraded: { label: 'degraded textures', repairable: true } } : {}),
    })] });
    renderPanel();
    expect(await screen.findByText(reason)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /install/i })).toBeNull();
    if (installed) expect(screen.getByText(/ready · degraded textures/i)).toBeInTheDocument();
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
    renderPanel();
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
    renderPanel();
    expect(await screen.findByText(/degraded textures/i)).toBeInTheDocument();
    expect(screen.getByText('Install Xcode from the App Store.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /install/i })).toBeNull();
  });

  // #4636: the help text names the REMEDY; on its own, a Repair that keeps failing
  // just reprints it, with no way to tell why. `detail` names what is actually broken.
  it('names the missing modules under the degraded help text', async () => {
    getImageTo3dTargets.mockResolvedValue({
      targets: [target({
        installed: true,
        degraded: {
          label: 'degraded textures',
          help: 'Install the Metal Toolchain.',
          repairable: true,
          detail: 'Missing: o_voxel, mtlbvh',
        },
      })],
    });
    renderPanel();
    expect(await screen.findByText('Missing: o_voxel, mtlbvh')).toBeInTheDocument();
  });

  // The server OMITS `detail` rather than sending an empty label (a probe that could
  // not run names nothing), so the card must render no orphan "Missing:" line.
  it('renders no missing-module line when the server named nothing', async () => {
    getImageTo3dTargets.mockResolvedValue({
      targets: [target({
        installed: true,
        degraded: { label: 'degraded textures', help: 'Install the Metal Toolchain.', repairable: true },
      })],
    });
    renderPanel();
    expect(await screen.findByText('Install the Metal Toolchain.')).toBeInTheDocument();
    expect(screen.queryByText(/missing:/i)).toBeNull();
  });

  // The adapter contract makes BOTH `help` and `detail` optional, so the panel must
  // not hang off `help` alone — a target that names the culprit without prose would
  // otherwise have it swallowed silently.
  it('renders a detail-only degraded panel when the server sent no help text', async () => {
    getImageTo3dTargets.mockResolvedValue({
      targets: [target({
        installed: true,
        degraded: { label: 'degraded textures', repairable: true, detail: 'Missing: o_voxel' },
      })],
    });
    renderPanel();
    expect(await screen.findByText('Missing: o_voxel')).toBeInTheDocument();
  });

  // A `degraded` carrying neither key must leave the modal on its OWN default copy —
  // an empty string would render a blank description panel instead.
  it('falls back to the modal default when a degraded target says nothing', async () => {
    getImageTo3dTargets.mockResolvedValue({
      targets: [target({
        installed: true,
        degraded: { label: 'degraded textures', repairable: true },
      })],
    });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /repair install/i }));
    expect(await screen.findByTestId('install-description')).toHaveTextContent('(default)');
  });

  // The Repair modal is where a user who already ran Repair once lands, so it must
  // carry the culprit too — otherwise the retry offers the identical sentence that
  // did not work the first time.
  it('carries the missing modules into the Repair install modal', async () => {
    getImageTo3dTargets.mockResolvedValue({
      targets: [target({
        installed: true,
        degraded: {
          label: 'degraded textures',
          help: 'Install the Metal Toolchain.',
          repairable: true,
          detail: 'Missing: o_voxel',
        },
      })],
    });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /repair install/i }));
    expect(await screen.findByTestId('install-description'))
      .toHaveTextContent('Install the Metal Toolchain. Missing: o_voxel.');
  });

  // With nothing named, the description must stay exactly the help text — no dangling
  // separator, no empty label.
  it('leaves the Repair modal description untouched when nothing was named', async () => {
    getImageTo3dTargets.mockResolvedValue({
      targets: [target({
        installed: true,
        degraded: { label: 'degraded textures', help: 'Install the Metal Toolchain.', repairable: true },
      })],
    });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /repair install/i }));
    expect(await screen.findByTestId('install-description'))
      .toHaveTextContent(/^Install the Metal Toolchain\.$/);
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
    renderPanel();
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
    getImageTo3dTargets.mockResolvedValue({ targets: [target({ installed: true })] });
    renderPanel();
    expect(await screen.findByText(/ready/i)).toBeInTheDocument();
    expect(screen.queryByText(/degraded/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /install/i })).toBeNull();
  });

  it('shows the unsupported reason and no Install button when the host cannot run it', async () => {
    getImageTo3dTargets.mockResolvedValue({
      targets: [target({ available: false, unavailableReason: 'requires-apple-silicon' })],
    });
    renderPanel();
    expect(await screen.findAllByText(/requires an apple silicon mac/i)).not.toHaveLength(0);
    expect(screen.queryByRole('button', { name: /install/i })).toBeNull();
  });

  it('surfaces a load error with Retry, and recovers on retry', async () => {
    getImageTo3dTargets.mockRejectedValueOnce(new Error('boom'));
    renderPanel();
    expect(await screen.findByText('boom')).toBeInTheDocument();

    getImageTo3dTargets.mockResolvedValueOnce({ targets: [target({ installed: true })] });
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText(/ready/i)).toBeInTheDocument();
  });

  it('lists each gated repo once across targets that share it', async () => {
    // Both lanes gate on the same two repos. The token is central, so listing the
    // pair twice would just be noise in the prerequisite notice.
    getImageTo3dTargets.mockResolvedValue({
      targets: [target(), target({ id: 'pixal3dCuda', label: 'Pixal3D (CUDA)' })],
    });
    renderPanel();
    expect(await screen.findAllByRole('link', { name: /briaai\/RMBG-2\.0/ })).toHaveLength(1);
  });

  it('omits an unavailable target’s gated repos — its terms are moot on this host', async () => {
    getImageTo3dTargets.mockResolvedValue({
      targets: [target({ available: false, unavailableReason: 'requires-apple-silicon' })],
    });
    renderPanel();
    await screen.findAllByText(/requires an apple silicon mac/i);
    expect(screen.queryByRole('link', { name: /briaai\/RMBG-2\.0/ })).toBeNull();
  });
});
