import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// The three.js stack can't run in jsdom (no WebGL context) and none of it is
// under test here — this file covers the chrome AROUND the canvas (the download
// link + the empty-src guard). The Canvas stub deliberately drops `children`:
// mounting <primitive>/<mesh> would surface unknown DOM elements and r3f hands
// back HTMLElement refs without the three.js API.
vi.mock('@react-three/fiber', () => ({ Canvas: () => <div data-testid="glb-canvas" /> }));
vi.mock('@react-three/drei', () => ({
  Canvas: () => null,
  OrbitControls: () => null,
  Bounds: ({ children }) => children,
  useGLTF: Object.assign(() => ({ scene: {} }), { clear: vi.fn() }),
}));

import GlbViewer from './GlbViewer';

describe('GlbViewer', () => {
  it('renders nothing without a src', () => {
    const { container } = render(<GlbViewer src="" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the canvas and a download link derived from the src filename', () => {
    render(<GlbViewer src="/data/models3d/robot-a1b2.glb" />);
    expect(screen.getByTestId('glb-canvas')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Download \.glb/i });
    expect(link).toHaveAttribute('href', '/data/models3d/robot-a1b2.glb');
    expect(link).toHaveAttribute('download', 'robot-a1b2.glb');
  });

  it('honors an explicit downloadName over the derived one', () => {
    render(<GlbViewer src="/data/models3d/x.glb?v=2" downloadName="my-mesh.glb" />);
    expect(screen.getByRole('link', { name: /Download \.glb/i })).toHaveAttribute('download', 'my-mesh.glb');
  });

  it('falls back to model.glb when the src has no .glb tail', () => {
    render(<GlbViewer src="/data/models3d/streaming-endpoint" />);
    expect(screen.getByRole('link', { name: /Download \.glb/i })).toHaveAttribute('download', 'model.glb');
  });
});
