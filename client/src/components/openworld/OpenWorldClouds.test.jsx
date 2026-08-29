import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

const palette = vi.hoisted(() => ({ lowPoly: true }));

vi.mock('@react-three/fiber', () => ({ useFrame: () => {} }));
vi.mock('./OpenWorldPaletteContext', () => ({
  useOpenWorldPalette: () => ({
    accent: '#22d3ee',
    lowPoly: palette.lowPoly,
    surface: { flatShading: true },
  }),
}));

import OpenWorldClouds from './OpenWorldClouds';

describe('OpenWorldClouds', () => {
  beforeEach(() => {
    palette.lowPoly = true;
  });

  it('renders a repeating instanced cloud bank in the bright low-poly world', () => {
    const { container } = render(<OpenWorldClouds settings={{ effectiveTier: 'high' }} />);
    expect(container.getElementsByTagName('instancedMesh')).toHaveLength(3);
  });

  it('keeps the cloud bank out of the cyber world', () => {
    palette.lowPoly = false;
    const { container } = render(<OpenWorldClouds settings={{ effectiveTier: 'high' }} />);
    expect(container.getElementsByTagName('instancedMesh')).toHaveLength(0);
  });

  it('retains a signature cloud bank on the adaptive low tier', () => {
    const { container } = render(<OpenWorldClouds settings={{ effectiveTier: 'low' }} />);
    expect(container.getElementsByTagName('instancedMesh')).toHaveLength(3);
  });
});
