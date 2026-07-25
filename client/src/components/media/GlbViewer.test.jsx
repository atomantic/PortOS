import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three';

// The three.js stack can't run in jsdom (no WebGL context) and none of it is
// under test here — this file covers the chrome AROUND the canvas (the download
// link + the empty-src guard). Bounds drops the model subtree: mounting
// <primitive>/<mesh> would surface unknown DOM elements and r3f hands back
// HTMLElement refs without the three.js API. Canvas retains the lighting and
// environment elements so their interactive wiring stays covered.
vi.mock('@react-three/fiber', () => ({ Canvas: ({ children }) => <div data-testid="glb-canvas">{children}</div> }));
vi.mock('@react-three/drei', () => ({
  Canvas: () => null,
  OrbitControls: () => null,
  Environment: ({ background, children }) => (
    <div data-testid="glb-environment" data-background={background ? 'visible' : 'hidden'}>{children}</div>
  ),
  Lightformer: () => null,
  Bounds: () => null,
  useGLTF: Object.assign(() => ({ scene: {} }), { clear: vi.fn() }),
}));

import GlbViewer, { cloneGlbSceneWithOpaqueMaterials } from './GlbViewer';

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

  it('lets the user change the mesh preview background', () => {
    render(<GlbViewer src="/data/models3d/robot-a1b2.glb" />);
    const picker = screen.getByLabelText('Mesh preview background');
    expect(picker).toHaveValue('#050505');

    fireEvent.change(picker, { target: { value: '#f5f5f5' } });

    expect(picker).toHaveValue('#f5f5f5');
    expect(screen.getByTestId('glb-preview-surface'))
      .toHaveStyle({ backgroundColor: '#f5f5f5' });
  });

  it('offers basic lighting controls and can show the HDRI environment as the background', () => {
    render(<GlbViewer src="/data/models3d/robot-a1b2.glb" />);

    const ambient = screen.getByLabelText('Ambient light');
    const key = screen.getByLabelText('Key light');
    const fill = screen.getByLabelText('Fill light');
    expect(ambient).toHaveValue('0.9');
    expect(key).toHaveValue('1.1');
    expect(fill).toHaveValue('0.4');
    expect(screen.getByTestId('glb-environment')).toHaveAttribute('data-background', 'hidden');

    fireEvent.change(ambient, { target: { value: '1.4' } });
    fireEvent.change(key, { target: { value: '2.2' } });
    fireEvent.change(fill, { target: { value: '0.8' } });
    fireEvent.click(screen.getByLabelText('Show HDRI background'));

    expect(ambient).toHaveValue('1.4');
    expect(key).toHaveValue('2.2');
    expect(fill).toHaveValue('0.8');
    expect(screen.getByLabelText('Show HDRI background')).toBeChecked();
    expect(screen.getByTestId('glb-environment')).toHaveAttribute('data-background', 'visible');
  });

  it('honors an explicit downloadName over the derived one', () => {
    render(<GlbViewer src="/data/models3d/x.glb?v=2" downloadName="my-mesh.glb" />);
    expect(screen.getByRole('link', { name: /Download \.glb/i })).toHaveAttribute('download', 'my-mesh.glb');
  });

  it('falls back to model.glb when the src has no .glb tail', () => {
    render(<GlbViewer src="/data/models3d/streaming-endpoint" />);
    expect(screen.getByRole('link', { name: /Download \.glb/i })).toHaveAttribute('download', 'model.glb');
  });

  it('clones and makes legacy generated materials opaque without mutating the cached scene', () => {
    const scene = new Group();
    const material = new MeshStandardMaterial({
      opacity: 0.2,
      transparent: true,
      depthWrite: false,
      alphaTest: 0.5,
    });
    scene.add(new Mesh(new BoxGeometry(1, 1, 1), material));

    const clone = cloneGlbSceneWithOpaqueMaterials(scene);
    const clonedMaterial = clone.children[0].material;
    expect(clone).not.toBe(scene);
    expect(clonedMaterial).not.toBe(material);
    expect(clonedMaterial).toMatchObject({
      transparent: false,
      opacity: 1,
      alphaTest: 0,
      depthWrite: true,
    });
    expect(material).toMatchObject({ transparent: true, opacity: 0.2, depthWrite: false });
  });
});
