import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children, ...props }) => <div data-testid="threejs-canvas" data-alpha={String(props.gl?.alpha)}>{children}</div>,
}));
vi.mock('@react-three/drei', () => ({
  Bounds: ({ children }) => children,
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

const part = (id, geometry, materialId) => ({
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
});

describe('ThreejsModelPreview', () => {
  it('offers preset and custom preview backgrounds without changing the scene spec', () => {
    render(<ThreejsModelPreview spec={SPEC} />);

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
    const { container } = render(<ThreejsModelPreview spec={{
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
    const { container } = render(<ThreejsModelPreview spec={{
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
