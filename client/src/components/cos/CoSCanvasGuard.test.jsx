import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The guard's whole job is deciding WHICH failure the user is looking at, and
// the two inputs to that decision are the WebGL pre-gate and whatever the
// canvas throws. Both are mocked so each case can be driven independently.
const webgl = vi.hoisted(() => ({ available: true }));
vi.mock('../../lib/webglSupport', () => ({ isWebGLAvailable: () => webgl.available }));

const recovery = vi.hoisted(() => ({ attempt: vi.fn() }));
vi.mock('../../utils/staleChunkReload', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, reloadOnceForStaleChunk: recovery.attempt };
});

import CoSCanvasGuard from './CoSCanvasGuard';

const Boom = ({ error }) => { throw error; };

describe('CoSCanvasGuard', () => {
  let logged;
  beforeEach(() => {
    webgl.available = true;
    recovery.attempt.mockReset().mockResolvedValue(false);
    logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders the canvas when WebGL is available and nothing throws', () => {
    render(<CoSCanvasGuard><div data-testid="avatar-canvas" /></CoSCanvasGuard>);
    expect(screen.getByTestId('avatar-canvas')).toBeInTheDocument();
    expect(screen.queryByTestId('cos-avatar-asset-error')).not.toBeInTheDocument();
  });

  it('still shows the WebGL hint on a display that cannot render 3D', () => {
    webgl.available = false;
    render(<CoSCanvasGuard><div data-testid="avatar-canvas" /></CoSCanvasGuard>);
    expect(screen.getByText(/This display has no WebGL/i)).toBeInTheDocument();
    expect(screen.queryByTestId('avatar-canvas')).not.toBeInTheDocument();
  });

  // The reported bug: these avatars load remote GLBs, so a model 404 was
  // reported as "no WebGL" and sent the user to change an unrelated setting.
  it('reports an asset failure as an asset failure, not as missing WebGL', () => {
    render(
      <CoSCanvasGuard>
        <Boom error={new Error('Could not load /api/avatar/model.glb: 404 Not Found')} />
      </CoSCanvasGuard>,
    );

    expect(screen.getByTestId('cos-avatar-asset-error')).toBeInTheDocument();
    expect(screen.getByText(/no longer on disk/i)).toBeInTheDocument();
    expect(screen.queryByText(/This display has no WebGL/i)).not.toBeInTheDocument();
    // The private AvatarErrorBoundary is gone; the shared one logs this.
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('💥 React Error'), expect.anything());
  });

  // A WebGL context that dies at RUNTIME (rather than failing the pre-gate) is
  // still a WebGL problem, and the shared hint table is what says so.
  it('names a runtime WebGL context failure for what it is', () => {
    render(
      <CoSCanvasGuard>
        <Boom error={new Error('THREE.WebGLRenderer: Error creating WebGL context.')} />
      </CoSCanvasGuard>,
    );
    expect(screen.getByText(/cannot create a WebGL context/i)).toBeInTheDocument();
  });

  // Nothing in the shared table recognizes this, so the raw message is better
  // than inventing a cause.
  it('falls back to the raw message for an unrecognized failure', () => {
    render(<CoSCanvasGuard><Boom error={new Error('something went sideways')} /></CoSCanvasGuard>);
    expect(screen.getByText('something went sideways')).toBeInTheDocument();
  });

  it('checks for a newer build when an avatar render hits a missing runtime export', async () => {
    render(
      <CoSCanvasGuard>
        <Boom error={new Error("undefined is not an object (evaluating 'rv.jsx')")} />
      </CoSCanvasGuard>,
    );

    await vi.waitFor(() => expect(recovery.attempt).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(screen.getByTestId('cos-avatar-asset-error')).toBeInTheDocument());
    expect(screen.getByText(/undefined is not an object/i)).toBeInTheDocument();
  });

  it('leaves avatar error reporting to recovery when a newer build is confirmed', async () => {
    recovery.attempt.mockResolvedValue(true);
    render(
      <CoSCanvasGuard>
        <Boom error={new Error("undefined is not an object (evaluating 'rv.jsx')")} />
      </CoSCanvasGuard>,
    );

    await vi.waitFor(() => expect(recovery.attempt).toHaveBeenCalledOnce());
    expect(screen.queryByTestId('cos-avatar-asset-error')).not.toBeInTheDocument();
    expect(logged).not.toHaveBeenCalledWith(expect.stringContaining('💥 React Error'), expect.anything());
  });

  // Without the resetKey the panel sticks forever: once it is up the boundary
  // is unmounted, so nothing can retry. The mini-character wrappers switch
  // `variant` (and with it the GLB URL) on the same guard instance.
  it('clears a failure when the caller points the guard at another model', () => {
    const { rerender } = render(
      <CoSCanvasGuard resetKey="/api/avatar/a.glb">
        <Boom error={new Error('Could not load /api/avatar/a.glb: 404 Not Found')} />
      </CoSCanvasGuard>,
    );
    expect(screen.getByTestId('cos-avatar-asset-error')).toBeInTheDocument();

    rerender(
      <CoSCanvasGuard resetKey="/api/avatar/b.glb">
        <div data-testid="avatar-canvas" />
      </CoSCanvasGuard>,
    );
    expect(screen.queryByTestId('cos-avatar-asset-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('avatar-canvas')).toBeInTheDocument();
  });

  // Both panels are the guard's own. The GLB-loading callers used to pass a
  // "no model — run setup" hint here, but they only reach the guard after a HEAD
  // request proved the model IS there, so that hint was wrong on both branches.
  it('owns both panels, ignoring a fallback a caller tries to pass', () => {
    // The prop is gone, so this passes one anyway: restoring the old override
    // would make the guard render it and fail here. Without a hostile prop the
    // test would stay green through exactly the regression it guards.
    const hostile = { fallback: <div data-testid="caller-fallback" /> };

    cleanup();
    webgl.available = false;
    render(<CoSCanvasGuard {...hostile}><div /></CoSCanvasGuard>);
    expect(screen.getByText(/This display has no WebGL/i)).toBeInTheDocument();
    expect(screen.queryByTestId('caller-fallback')).not.toBeInTheDocument();

    cleanup();
    webgl.available = true;
    render(<CoSCanvasGuard {...hostile}><Boom error={new Error('boom')} /></CoSCanvasGuard>);
    expect(screen.getByTestId('cos-avatar-asset-error')).toBeInTheDocument();
    expect(screen.queryByTestId('caller-fallback')).not.toBeInTheDocument();
  });
});
