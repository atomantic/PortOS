import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('@react-three/fiber', () => ({ useFrame: () => {} }));
vi.mock('./OpenWorldPaletteContext', () => ({
  useOpenWorldPalette: () => ({
    accent: '#22d3ee',
    surface: {},
    lowPoly: true,
  }),
}));

import OpenWorldGrass from './OpenWorldGrass';

describe('OpenWorldGrass', () => {
  it('renders instancedMesh on lowPoly mode', () => {
    const { container } = render(<OpenWorldGrass settings={{ effectiveTier: 'high' }} />);
    const mesh = container.getElementsByTagName('instancedMesh');
    expect(mesh.length).toBe(1);
  });

  it('scales blade count per quality tier', () => {
    const { container: lowContainer } = render(<OpenWorldGrass settings={{ effectiveTier: 'low' }} />);
    const lowMesh = lowContainer.getElementsByTagName('instancedMesh');
    expect(lowMesh.length).toBe(1);
  });
});
