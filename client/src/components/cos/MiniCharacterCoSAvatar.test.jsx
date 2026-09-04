import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The guard is what this covers the WIRING of, so it is stubbed to record the
// props it receives. Without this, `resetKey={url}` could be deleted at the
// call site and CoSCanvasGuard's own tests would stay green while switching
// characters after a failed model regressed in production.
const guardProps = vi.hoisted(() => []);
vi.mock('./CoSCanvasGuard', () => ({
  default: (props) => {
    guardProps.push(props);
    return <div data-testid="canvas-guard" data-reset-key={props.resetKey}>{props.children}</div>;
  },
}));
// jsdom has no WebGL context and none of the scene is under test here, so the
// Canvas is stubbed CHILDLESS — rendering the subtree would run three.js object
// code against r3f's HTMLElement stand-ins. Only which props reach the guard
// matters, and the guard sits OUTSIDE the canvas.
vi.mock('@react-three/fiber', () => ({
  Canvas: () => <div data-testid="mini-canvas" />,
  useFrame: vi.fn(),
}));

import MiniCharacterCoSAvatar from './MiniCharacterCoSAvatar';

describe('MiniCharacterCoSAvatar', () => {
  beforeEach(() => {
    guardProps.length = 0;
    // The component HEAD-probes the model before mounting the canvas.
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true })));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  // A single guard instance is reused across variants, so the guard needs to be
  // told when the model changed — otherwise one character's dead GLB leaves the
  // failure panel up for every character picked afterwards.
  it('keys the canvas guard on the model url so switching characters clears a failure', async () => {
    const { rerender } = render(<MiniCharacterCoSAvatar variant="mini-male-c" />);
    await waitFor(() => expect(screen.getByTestId('canvas-guard')).toBeInTheDocument());
    expect(screen.getByTestId('canvas-guard')).toHaveAttribute(
      'data-reset-key',
      '/api/avatar/model.glb?variant=mini-male-c',
    );

    rerender(<MiniCharacterCoSAvatar variant="mini-female-d" />);
    await waitFor(() => expect(screen.getByTestId('canvas-guard')).toHaveAttribute(
      'data-reset-key',
      '/api/avatar/model.glb?variant=mini-female-d',
    ));
  });

  // A rigged record probes through the same variant namespace — the avatar
  // route resolves `rigged-<modelId>` to the record's animated GLB, so the
  // stage needs no special case for record-backed characters.
  it('keys the canvas guard on the rigged variant url for an animated record', async () => {
    render(<MiniCharacterCoSAvatar variant="rigged-image3d-1" coverage={null} />);
    await waitFor(() => expect(screen.getByTestId('canvas-guard')).toHaveAttribute(
      'data-reset-key',
      '/api/avatar/model.glb?variant=rigged-image3d-1',
    ));
  });
});
