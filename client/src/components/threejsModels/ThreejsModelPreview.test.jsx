import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children, ...props }) => <div data-testid="threejs-canvas" data-alpha={String(props.gl?.alpha)}>{children}</div>,
}));
vi.mock('@react-three/drei', () => ({
  Bounds: ({ children }) => children,
  OrbitControls: () => null,
}));

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
});
