import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The three.js stack can't run in jsdom (no WebGL context) and none of it is
// under test here — this file covers the chrome AROUND the canvas (the download
// link, the empty-src guard, the load-failure panel). The model subtree mounts
// so `useGLTF` is really called (that is what throws on a bad asset), with
// GltfPrimitive stubbed out: rendering <primitive>/<mesh> would surface unknown
// DOM elements and r3f hands back HTMLElement refs without the three.js API.
// Canvas retains the lighting and environment elements so their interactive
// wiring stays covered.
// `mockScene` stands in for the three.js scene `useThree` hands the viewer, so
// the environment-intensity assertions below check the value the component
// actually writes onto the scene — not merely a prop handed to a mocked
// <Environment>, which would stay green through the exact regression the
// source guards against (memoizing the environment children).
// The two failure modes are mocked separately because they behave differently:
// `gltf.error` fails the LOADER the way drei does, mirroring suspend-react's real
// caching (the rejection is remembered against the URL and re-thrown from the
// render phase until `useGLTF.clear(url)` drops it — without that, nothing could
// tell a working Retry from one that only looks like it re-fetched), while
// `canvas.error` fails the CANVAS ITSELF, which is how r3f surfaces a WebGL
// context failure: from its own render, with nothing cached to evict.
// `hdri.error` fails the ENVIRONMENT only — a missing or corrupt .hdr (a partial
// checkout, a stale service-worker cache). It is deliberately separate from
// `gltf.error`: the whole point of the HDRI's own boundary is that the two
// failures must not produce the same outcome.
const { mockScene, gltf, canvas, hdri } = vi.hoisted(() => ({
  mockScene: {},
  gltf: { error: null, rejections: new Map() },
  canvas: { error: null },
  hdri: { error: null },
}));
vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children }) => {
    if (canvas.error) throw canvas.error;
    return <div data-testid="glb-canvas">{children}</div>;
  },
  useThree: (selector) => selector({ scene: mockScene }),
}));
vi.mock('@react-three/drei', () => ({
  Canvas: () => null,
  OrbitControls: () => null,
  Environment: ({ background, backgroundBlurriness, files, children }) => {
    if (hdri.error) throw hdri.error;
    return (
    <div
      data-testid="glb-environment"
      data-background={background ? 'visible' : 'hidden'}
      data-background-blurriness={backgroundBlurriness}
      data-files={files}
    >
      {children}
    </div>
    );
  },
  Bounds: ({ children }) => children,
  useGLTF: Object.assign((url) => {
    if (gltf.error) gltf.rejections.set(url, gltf.error);
    const cached = gltf.rejections.get(url);
    if (cached) throw cached;
    return { scene: {} };
  }, { clear: vi.fn((url) => gltf.rejections.delete(url)) }),
}));
vi.mock('../../hooks/useClonedGltf', () => ({ GltfPrimitive: () => null }));

import { useGLTF } from '@react-three/drei';
import GlbViewer, { cloneGlbSceneWithOpaqueMaterials } from './GlbViewer';

const openControls = () => fireEvent.click(screen.getByLabelText('Preview display settings'));

beforeEach(() => {
  gltf.error = null;
  gltf.rejections.clear();
  canvas.error = null;
  hdri.error = null;
  useGLTF.clear.mockClear();
});

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

  // The controls used to be an always-mounted overlay pinned inside the canvas,
  // which covered the upper-right quadrant of every model.
  it('keeps the display controls collapsed and outside the render surface', () => {
    render(<GlbViewer src="/data/models3d/robot-a1b2.glb" />);
    expect(screen.queryByLabelText('Mesh preview background')).not.toBeInTheDocument();

    openControls();

    const picker = screen.getByLabelText('Mesh preview background');
    expect(screen.getByTestId('glb-preview-surface')).not.toContainElement(picker);
    expect(screen.getByLabelText('Preview display settings')).toHaveAttribute('aria-expanded', 'true');

    openControls();
    expect(screen.queryByLabelText('Mesh preview background')).not.toBeInTheDocument();
  });

  it('lets the user change the mesh preview background', () => {
    render(<GlbViewer src="/data/models3d/robot-a1b2.glb" />);
    openControls();
    const picker = screen.getByLabelText('Mesh preview background');
    expect(picker).toHaveValue('#050505');

    fireEvent.change(picker, { target: { value: '#f5f5f5' } });

    expect(picker).toHaveValue('#f5f5f5');
    expect(screen.getByTestId('glb-preview-surface'))
      .toHaveStyle({ backgroundColor: '#f5f5f5' });
  });

  it('loads the bundled HDRI as a softly blurred background by default', () => {
    render(<GlbViewer src="/data/models3d/robot-a1b2.glb" />);
    openControls();

    const ambient = screen.getByLabelText('Ambient light');
    const key = screen.getByLabelText('Key light');
    const fill = screen.getByLabelText('Fill light');
    expect(ambient).toHaveValue('0.6');
    expect(key).toHaveValue('1.2');
    expect(fill).toHaveValue('0.4');
    expect(screen.getByTestId('glb-environment')).toHaveAttribute(
      'data-files',
      '/hdri/studio-small-08-1k.hdr',
    );
    expect(screen.getByTestId('glb-environment')).toHaveAttribute('data-background', 'visible');
    expect(screen.getByTestId('glb-environment')).toHaveAttribute(
      'data-background-blurriness',
      '0.2',
    );
    expect(screen.getByLabelText('Show HDRI background')).toBeChecked();

    fireEvent.change(ambient, { target: { value: '1.4' } });
    fireEvent.change(key, { target: { value: '2.2' } });
    fireEvent.change(fill, { target: { value: '0.8' } });
    fireEvent.click(screen.getByLabelText('Show HDRI background'));

    expect(ambient).toHaveValue('1.4');
    expect(key).toHaveValue('2.2');
    expect(fill).toHaveValue('0.8');
    expect(screen.getByLabelText('Show HDRI background')).not.toBeChecked();
    expect(screen.getByTestId('glb-environment')).toHaveAttribute('data-background', 'hidden');
  });

  it('ships the referenced environment as a Radiance HDR asset', () => {
    const hdriPath = resolve(process.cwd(), 'public/hdri/studio-small-08-1k.hdr');
    const header = readFileSync(hdriPath).subarray(0, 128).toString('ascii');
    expect(header).toMatch(/^#\?RADIANCE/);
  });

  // The image-based lighting drowned out the three light sliders at full
  // strength — dialing the environment down is what makes them visible.
  it('writes the environment intensity onto the scene from its own slider', () => {
    delete mockScene.environmentIntensity;
    render(<GlbViewer src="/data/models3d/robot-a1b2.glb" />);
    openControls();

    const environment = screen.getByLabelText('Environment light');
    expect(environment).toHaveValue('0.6');
    expect(mockScene.environmentIntensity).toBe(0.6);

    fireEvent.change(environment, { target: { value: '0' } });

    expect(environment).toHaveValue('0');
    // 0 is a meaningful value (lights-only), not an absent one.
    expect(mockScene.environmentIntensity).toBe(0);
  });

  // drei's Environment snapshots scene.environmentIntensity before we write it
  // and restores that snapshot whenever its own effect re-runs — and toggling
  // the HDRI background is the one thing that still re-runs it. Without a
  // re-assert the IBL silently returns to full strength while the slider still
  // reads the user's value. The mocked Environment can't perform the restore,
  // so stand in for it by writing the pre-write default back onto the scene.
  it('re-asserts the environment intensity when the HDRI background is toggled', () => {
    delete mockScene.environmentIntensity;
    render(<GlbViewer src="/data/models3d/robot-a1b2.glb" />);
    openControls();
    fireEvent.change(screen.getByLabelText('Environment light'), { target: { value: '0' } });
    expect(mockScene.environmentIntensity).toBe(0);

    mockScene.environmentIntensity = 1; // drei restoring its pre-write snapshot
    fireEvent.click(screen.getByLabelText('Show HDRI background'));

    expect(mockScene.environmentIntensity).toBe(0);
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

describe('GlbViewer load failures', () => {
  // React and the shared ErrorBoundary both log every caught error.
  let logged;
  beforeEach(() => {
    logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  // The reported failure: a dev server answering an unproxied /data path with
  // index.html, so the glTF parser JSON.parses HTML. It escaped the canvas and
  // replaced the entire route with the router's error page.
  it('shows an inline panel instead of letting a load error take the page down', () => {
    gltf.error = new Error(
      "Could not load /data/image-to-3d/abc/model.glb?v=1: Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON",
    );
    // Nothing catches this above the viewer: without its own boundary the throw
    // escapes `render` here, exactly as it escapes to the router in the app.
    render(<GlbViewer src="/data/image-to-3d/abc/model.glb?v=1" />);

    // `role="alert"`: the panel replaces the canvas without a navigation, so a
    // screen reader only hears about it if it announces itself.
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('This 3D model could not be loaded')).toBeInTheDocument();
    expect(screen.getByText(/answered with a web page instead of the mesh file/i)).toBeInTheDocument();
    expect(screen.queryByTestId('glb-canvas')).not.toBeInTheDocument();
    // The download link survives; the controls that drive the now-unmounted
    // canvas do not — the settings toggle sits `z-10` OVER this panel.
    expect(screen.getByRole('link', { name: /Download \.glb/i })).toBeInTheDocument();
    expect(screen.queryByText(/Drag to orbit/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Preview display settings')).not.toBeInTheDocument();
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('💥 React Error'), expect.anything());
  });

  it('drops the cached rejection when the user retries', () => {
    gltf.error = new Error('Could not load /data/image-to-3d/abc/model.glb: 404 Not Found');
    render(<GlbViewer src="/data/image-to-3d/abc/model.glb" />);
    expect(screen.getByText(/no longer on disk/i)).toBeInTheDocument();

    gltf.error = null;
    fireEvent.click(screen.getByRole('button', { name: /Retry/i }));

    // Without the clear, suspend-react re-throws the SAME cached rejection for
    // this URL on every later render and Retry can never recover.
    expect(useGLTF.clear).toHaveBeenCalledWith('/data/image-to-3d/abc/model.glb');
    expect(screen.queryByTestId('glb-load-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('glb-canvas')).toBeInTheDocument();
  });

  // The failure is remembered against the src that produced it, so one record's
  // dead mesh can't stick to the next model the viewer is pointed at.
  it('clears the failure when the viewer is pointed at another mesh', () => {
    gltf.error = new Error('Could not load /a.glb: boom');
    const { rerender } = render(<GlbViewer src="/a.glb" />);
    expect(screen.getByTestId('glb-load-error')).toBeInTheDocument();

    gltf.error = null;
    rerender(<GlbViewer src="/b.glb" />);

    expect(screen.queryByTestId('glb-load-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('glb-canvas')).toBeInTheDocument();
  });

  // `useGLTF.clear` evicts a parsed scene as readily as a rejection, so a
  // failure thrown AFTER the bytes landed must not cost a multi-MB re-download.
  it('keeps the cached mesh when the failure was not a load failure', () => {
    canvas.error = new Error('THREE.WebGLRenderer: Error creating WebGL context.');
    render(<GlbViewer src="/data/image-to-3d/abc/model.glb" />);
    expect(screen.getByText(/cannot create a WebGL context/i)).toBeInTheDocument();

    canvas.error = null;
    fireEvent.click(screen.getByRole('button', { name: /Retry/i }));

    expect(useGLTF.clear).not.toHaveBeenCalled();
    expect(screen.getByTestId('glb-canvas')).toBeInTheDocument();
  });
});

describe('GlbViewer HDRI failures', () => {
  let logged;
  beforeEach(() => {
    logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  // The HDRI is image-based LIGHTING, which the three lights already stand in
  // for. Sharing the mesh's boundary meant a missing .hdr reported "This 3D
  // model could not be loaded" and took a perfectly good mesh down with it.
  it('degrades to lights-only when the HDRI fails, keeping the mesh', () => {
    hdri.error = new Error('Could not load /hdri/studio-small-08-1k.hdr: 404 Not Found');
    render(<GlbViewer src="/data/image-to-3d/abc/model.glb" />);

    expect(screen.queryByTestId('glb-load-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('glb-canvas')).toBeInTheDocument();
    // The environment is the only thing gone — the viewer is NOT in failure
    // mode, so the controls driving the still-live canvas are still mounted.
    expect(screen.queryByTestId('glb-environment')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Preview display settings')).toBeInTheDocument();
    openControls();
    expect(screen.getByLabelText('Ambient light')).toBeInTheDocument();
    // ...but the two knobs that drove the now-unmounted Environment are gone,
    // replaced by a line saying why, instead of sitting there doing nothing.
    expect(screen.queryByLabelText('Environment light')).not.toBeInTheDocument();
    expect(screen.queryByText('Show HDRI background')).not.toBeInTheDocument();
    expect(screen.getByText(/Environment lighting unavailable/i)).toBeInTheDocument();
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('💥 React Error'), expect.anything());
  });

  // The AR/USDZ export re-serializes the graph the viewer loaded, so the handle
  // has to reach the parent — and has to be RETRACTED when the mesh unloads,
  // because the force-opaque cleanup disposes that clone's materials. A retained
  // handle would export a scene whose textures are gone.
  it('hands the loaded scene to onSceneLoaded and clears it on unmount', () => {
    const onSceneLoaded = vi.fn();
    const { unmount } = render(
      <GlbViewer src="/data/image-to-3d/abc/model.glb" onSceneLoaded={onSceneLoaded} />,
    );
    expect(onSceneLoaded).toHaveBeenCalledWith(expect.any(Object));
    onSceneLoaded.mockClear();
    unmount();
    expect(onSceneLoaded).toHaveBeenCalledWith(null);
  });

  // The other half of the split: the mesh's own failure must still surface.
  it('still shows the failure panel when the MESH is what failed', () => {
    gltf.error = new Error('Could not load /data/image-to-3d/abc/model.glb: 404 Not Found');
    render(<GlbViewer src="/data/image-to-3d/abc/model.glb" />);

    expect(screen.getByTestId('glb-load-error')).toBeInTheDocument();
    expect(screen.queryByTestId('glb-canvas')).not.toBeInTheDocument();
  });
});
