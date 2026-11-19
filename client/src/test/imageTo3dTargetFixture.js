/**
 * `imageTo3dTarget(overrides)` — one representative image-to-3D target descriptor for tests.
 *
 * Shared by the `/3d` and Models → 3D suites so a server-side descriptor change is one edit, not two
 * fixtures that can half-update.
 */

/**
 * A representative image-to-3D target descriptor, for tests.
 *
 * Two suites render the same server descriptor from different hosts (the `/3d`
 * render flow and Models → 3D), and the shape is still growing — `degraded`,
 * `repairable`, `gatedRepos` and `installNotes` all landed recently. One fixture
 * means a server-side field rename is a single edit; two copies mean a
 * half-updated pair where one suite stays green while testing a shape the server
 * no longer sends.
 *
 * Values mirror `server/services/imageTo3d/targets.js`; `installed: false` is the
 * default because "available but not installed" is the state most cases vary
 * from.
 * @param {object} [over] fields to override.
 */
export const imageTo3dTarget = (over = {}) => ({
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

export default imageTo3dTarget;
