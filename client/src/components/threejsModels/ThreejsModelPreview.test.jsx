import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children, ...props }) => <div data-testid="threejs-canvas" data-alpha={String(props.gl?.alpha)}>{children}</div>,
}));
// A chainable stand-in for drei's Bounds api, so the explode re-fit is
// observable without a real renderer.
const boundsApi = vi.hoisted(() => {
  const api = {};
  api.refresh = vi.fn(() => api);
  api.clip = vi.fn(() => api);
  api.fit = vi.fn(() => api);
  return api;
});
vi.mock('@react-three/drei', () => ({
  Bounds: ({ children }) => children,
  useBounds: () => boundsApi,
  OrbitControls: () => null,
}));

// r3f object props stringify to "[object Object]" under the DOM renderer, so the
// only way to see WHICH geometry the preview attached is to record it as the real
// builder hands it back.
const built = vi.hoisted(() => []);
vi.mock('../../lib/threejsSculpt', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createSculptBufferGeometry: (definition) => {
      const geometry = actual.createSculptBufferGeometry(definition);
      built.push(geometry);
      return geometry;
    },
  };
});

import ThreejsModelPreview from './ThreejsModelPreview';

const SPEC = {
  name: 'Example model',
  schemaVersion: 1,
  background: '#111827',
  camera: { position: [0, 0, 3], fov: 45, target: [0, 0, 0] },
  lights: [],
  materials: {},
  parts: [],
};

const material = (overrides) => ({
  type: 'standard',
  color: '#8b5a2b',
  metalness: 0,
  roughness: 0.6,
  emissive: '#000000',
  emissiveIntensity: 0,
  opacity: 1,
  transparent: false,
  wireframe: false,
  clearcoat: 0,
  clearcoatRoughness: 0,
  ior: 1.5,
  transmission: 0,
  thickness: 0,
  sheen: 0,
  iridescence: 0,
  anisotropy: 0,
  ...overrides,
});

const part = (id, geometry, materialId, overrides = {}) => ({
  id,
  name: id,
  geometry,
  material: materialId,
  position: [0, 0, 0],
  rotationDegrees: [0, 0, 0],
  scale: [1, 1, 1],
  castShadow: true,
  receiveShadow: true,
  children: [],
  ...overrides,
});

// The preview keeps the picked part in the URL, so every render needs a router.
const renderPreview = (ui, entry = '/') =>
  render(ui, { wrapper: ({ children }) => <MemoryRouter initialEntries={[entry]}>{children}</MemoryRouter> });

const box = { type: 'box', width: 1, height: 1, depth: 1 };
const positionOf = (container, name) =>
  container.querySelector(`group[name="${name}"]`).getAttribute('position').split(',').map(Number);
const setExplode = (value) => fireEvent.change(screen.getByLabelText('Explode'), { target: { value: String(value) } });

describe('ThreejsModelPreview', () => {
  it('offers preset and custom preview backgrounds without changing the scene spec', () => {
    renderPreview(<ThreejsModelPreview spec={SPEC} />);

    expect(screen.getByRole('button', { name: 'Black' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Green screen' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByLabelText('Custom preview background color')).toHaveValue('#111827');

    fireEvent.click(screen.getByRole('button', { name: 'White' }));
    expect(screen.getByRole('button', { name: 'White' })).toHaveAttribute('aria-pressed', 'true');
    expect(SPEC.background).toBe('#111827');

    fireEvent.click(screen.getByRole('button', { name: 'Transparent' }));
    expect(screen.getByTestId('threejs-canvas')).toHaveAttribute('data-alpha', 'true');
    expect(screen.getByLabelText('Custom preview background color')).toHaveValue('#000000');
  });

  it('renders extrude and tube parts as built buffer geometries', () => {
    const { container } = renderPreview(<ThreejsModelPreview spec={{
      ...SPEC,
      materials: { body: material() },
      parts: [
        part('plate', {
          type: 'extrude',
          outline: [[-1, -1], [1, -1], [1, 1], [-1, 1]],
          holes: [[[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]]],
          depth: 0.4,
          bevelEnabled: false,
          bevelThickness: 0.1,
          bevelSize: 0.1,
          bevelSegments: 2,
          curveSegments: 8,
          steps: 1,
        }, 'body'),
        part('cable', {
          type: 'tube',
          path: [[0, 0, 0], [0, 1, 0.5], [0.6, 1.6, 0]],
          radius: 0.08,
          tubularSegments: 24,
          radialSegments: 8,
          closed: false,
          curveType: 'centripetal',
          tension: 0.5,
        }, 'body'),
      ],
    }} />);

    expect(container.querySelectorAll('primitive[attach="geometry"]')).toHaveLength(2);
    expect(built.map((geometry) => geometry.type)).toEqual(['ExtrudeGeometry', 'TubeGeometry']);
    expect(built.every((geometry) => geometry.getAttribute('position').count > 0)).toBe(true);
  });

  it('forwards physical material channels only to physical materials', () => {
    const { container } = renderPreview(<ThreejsModelPreview spec={{
      ...SPEC,
      materials: {
        glass: material({ type: 'physical', ior: 1.45, transmission: 0.8, thickness: 0.6, sheen: 0.3, iridescence: 0.7, anisotropy: 0.9 }),
        paint: material(),
      },
      parts: [
        part('pane', { type: 'box', width: 1, height: 1, depth: 1 }, 'glass'),
        part('frame', { type: 'box', width: 1, height: 1, depth: 1 }, 'paint'),
      ],
    }} />);

    const physical = container.querySelector('meshPhysicalMaterial');
    expect(physical.getAttribute('ior')).toBe('1.45');
    expect(physical.getAttribute('transmission')).toBe('0.8');
    expect(physical.getAttribute('thickness')).toBe('0.6');
    expect(physical.getAttribute('sheen')).toBe('0.3');
    expect(physical.getAttribute('iridescence')).toBe('0.7');
    expect(physical.getAttribute('anisotropy')).toBe('0.9');

    const standard = container.querySelector('meshStandardMaterial');
    expect(standard.getAttribute('ior')).toBeNull();
    expect(standard.getAttribute('transmission')).toBeNull();
  });
});

// A knife: one blade carrying surface relief that must not fly off on its own,
// plus a separate handle so there is something to separate FROM.
const knifeSpec = () => ({
  ...SPEC,
  materials: { steel: material() },
  parts: [
    part('blade', box, 'steel', {
      name: 'Blade',
      position: [-1, 0, 0],
      children: [part('serrations', box, 'steel', { name: 'Serrations', position: [0, 0.5, 0], explodeWithParent: true })],
    }),
    part('handle', box, 'steel', { name: 'Handle', position: [1, 0, 0] }),
  ],
});

describe('ThreejsModelPreview disassembly', () => {
  beforeEach(() => {
    boundsApi.fit.mockClear();
  });

  it('separates the parts by scaling the layout about the centre, keeping relief on its part', () => {
    const { container } = renderPreview(<ThreejsModelPreview spec={knifeSpec()} />);

    expect(positionOf(container, 'Blade')).toEqual([-1, 0, 0]);
    expect(positionOf(container, 'Handle')).toEqual([1, 0, 0]);

    setExplode(1);

    // Assembled spread is ±1, so a full explode puts each part at ±(2 + clearance) —
    // a real gap opens between them rather than the pair sliding together.
    const [bladeX] = positionOf(container, 'Blade');
    const [handleX] = positionOf(container, 'Handle');
    expect(bladeX).toBeCloseTo(-2.18, 6);
    expect(handleX).toBeCloseTo(2.18, 6);

    // Relief rides the blade — its own transform never changes.
    expect(positionOf(container, 'Serrations')).toEqual([0, 0.5, 0]);
  });

  it('re-fits the camera when the layout actually grows', () => {
    renderPreview(<ThreejsModelPreview spec={knifeSpec()} />);
    boundsApi.fit.mockClear();

    setExplode(0.5);
    expect(boundsApi.refresh).toHaveBeenCalled();
    expect(boundsApi.fit).toHaveBeenCalledTimes(1);

    // Same layout, no wasted re-fit.
    setExplode(0.5);
    expect(boundsApi.fit).toHaveBeenCalledTimes(1);
  });

  it('disables the explode control when there is only one part to move', () => {
    renderPreview(<ThreejsModelPreview spec={{ ...SPEC, materials: { steel: material() }, parts: [part('solo', box, 'steel')] }} />);
    expect(screen.getByLabelText('Explode')).toBeDisabled();
  });

  it('resolves a click on surface relief up to the part it belongs to and highlights that subtree', () => {
    const { container } = renderPreview(<ThreejsModelPreview spec={knifeSpec()} />);

    expect(screen.queryByRole('button', { name: 'Clear part selection' })).not.toBeInTheDocument();

    fireEvent.click(container.querySelector('group[name="Serrations"] mesh'));

    // The sliver is not the answer — the blade it rides is.
    expect(screen.getByText('Blade')).toBeInTheDocument();
    expect(screen.getByText('blade')).toBeInTheDocument();

    const highlighted = container.querySelectorAll('meshStandardMaterial[emissive="#38bdf8"]');
    // Blade + its relief light up together; the handle stays as authored.
    expect(highlighted).toHaveLength(2);
    expect(container.querySelector('group[name="Handle"] meshStandardMaterial').getAttribute('emissive')).toBe('#000000');
  });

  it('moves a container-with-geometry\'s own shell without dragging its child part', () => {
    const { container } = renderPreview(<ThreejsModelPreview spec={{
      ...SPEC,
      materials: { steel: material() },
      parts: [part('body', box, 'steel', {
        name: 'Body',
        children: [
          part('trim', box, 'steel', { name: 'Trim', position: [0, 0, 1] }),
          part('engraving', box, 'steel', { name: 'Engraving', position: [0, 0.5, 0], explodeWithParent: true }),
        ],
      })],
    }} />);

    // Assembled: the body's group sits at the origin and its shell is not offset.
    expect(container.querySelector('group[name="Body"] > group:not([name])')).toBeNull();

    setExplode(1);

    // The body's GROUP must not move — that would carry the trim with it and
    // separate nothing. Its shell moves inside an offset group instead.
    expect(positionOf(container, 'Body')).toEqual([0, 0, 0]);
    const shell = container.querySelector('group[name="Body"] > group:not([name])');
    expect(shell.getAttribute('position').split(',').map(Number).some((value) => value !== 0)).toBe(true);
    expect(shell.querySelector('mesh')).not.toBeNull();
    // The shell's own engraving rides INSIDE that offset group — its authored
    // transform is untouched; it moves only because its wrapper does. Hoist it
    // out and the body separates from its own surface detail.
    expect(container.querySelector('group[name="Body"] > group:not([name]) > group[name="Engraving"]')).not.toBeNull();
    expect(positionOf(container, 'Engraving')).toEqual([0, 0.5, 0]);
    // And the trim moves on its own.
    expect(positionOf(container, 'Trim')).not.toEqual([0, 0, 1]);
  });

  it('keeps the picked part in the URL so it survives a reload and a stale id degrades', () => {
    const { container, unmount } = renderPreview(<ThreejsModelPreview spec={knifeSpec()} />, '/?part=handle');
    expect(screen.getByText('Handle')).toBeInTheDocument();
    expect(container.querySelectorAll('meshStandardMaterial[emissive="#38bdf8"]')).toHaveLength(1);
    unmount();

    // A link to a part this model no longer has must not render an empty label.
    renderPreview(<ThreejsModelPreview spec={knifeSpec()} />, '/?part=noSuchPart');
    expect(screen.queryByRole('button', { name: 'Clear part selection' })).not.toBeInTheDocument();
  });

  it('selects a plain part on its own and clears the selection', () => {
    const { container } = renderPreview(<ThreejsModelPreview spec={knifeSpec()} />);

    fireEvent.click(container.querySelector('group[name="Handle"] mesh'));
    expect(screen.getByText('Handle')).toBeInTheDocument();
    expect(container.querySelectorAll('meshStandardMaterial[emissive="#38bdf8"]')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Clear part selection' }));
    expect(container.querySelectorAll('meshStandardMaterial[emissive="#38bdf8"]')).toHaveLength(0);
  });
});

// The knife again, this time with a declared articulation graph: the handle is
// the root and the blade pivots about a named socket.
const articulatedKnifeSpec = () => ({
  ...knifeSpec(),
  sockets: [{ name: 'bladePivot', parentPartId: 'handle', position: [0, 0, 0], rotationDegrees: [0, 0, 0] }],
  articulation: {
    joints: [
      { id: 'rootJoint', partId: 'handle', parentJointId: null, pivotSocket: null },
      { id: 'bladeJoint', partId: 'blade', parentJointId: 'rootJoint', pivotSocket: 'bladePivot' },
    ],
    attachmentPartIds: [],
  },
});

describe('ThreejsModelPreview articulation status', () => {
  it('calls a spec with no articulation a static assembly, never animation-ready', () => {
    renderPreview(<ThreejsModelPreview spec={knifeSpec()} />);
    expect(screen.getByText('Static assembly')).toBeInTheDocument();
    expect(screen.queryByText(/Articulation-ready/)).not.toBeInTheDocument();
  });

  it('reports a usable graph with its joint and pivot counts', () => {
    renderPreview(<ThreejsModelPreview spec={articulatedKnifeSpec()} />);
    expect(screen.getByText('Articulation-ready · 2 joints · 1 pivot')).toBeInTheDocument();
  });

  // Schema-valid but rig-useless: the child joint has no axis, so the badge must
  // agree with the server's report instead of claiming a rig off mere presence.
  it('stays static when a child joint names no pivot socket, and says how many joints it saw', () => {
    const spec = articulatedKnifeSpec();
    spec.articulation.joints[1].pivotSocket = null;
    renderPreview(<ThreejsModelPreview spec={spec} />);
    expect(screen.getByText('Static assembly · 2 joints declared')).toBeInTheDocument();
  });

  it('names the joint driving a picked part, and the fact when it has no pivot', () => {
    const { container } = renderPreview(<ThreejsModelPreview spec={articulatedKnifeSpec()} />);

    fireEvent.click(container.querySelector('group[name="Blade"] mesh'));
    expect(screen.getByText('joint bladeJoint · pivot bladePivot')).toBeInTheDocument();

    fireEvent.click(container.querySelector('group[name="Handle"] mesh'));
    expect(screen.getByText('joint rootJoint · no pivot')).toBeInTheDocument();
  });

  it('renders a legacy spec with no articulation key without crashing the picker', () => {
    const { container } = renderPreview(<ThreejsModelPreview spec={knifeSpec()} />);
    fireEvent.click(container.querySelector('group[name="Handle"] mesh'));
    expect(screen.getByText('Handle')).toBeInTheDocument();
    expect(screen.queryByText(/^joint /)).not.toBeInTheDocument();
  });
});
