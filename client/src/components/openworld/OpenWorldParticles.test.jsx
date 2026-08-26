import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('@react-three/drei', () => ({
  Sparkles: ({ color, count }) => <div data-testid="sparkles" data-color={color} data-count={count} />,
}));
vi.mock('./OpenWorldPaletteContext', () => ({
  useOpenWorldPalette: () => ({
    particles: '#22d3ee',
    lowPoly: true,
  }),
}));

import OpenWorldParticles from './OpenWorldParticles';

describe('OpenWorldParticles', () => {
  it('renders daylight pollen sparkles when dayMix is high', () => {
    const { container } = render(<OpenWorldParticles settings={{ timeOfDay: 'vibesDay' }} />);
    const sparkles = container.querySelectorAll('[data-testid="sparkles"]');
    expect(sparkles.length).toBeGreaterThan(0);
    expect(sparkles[0].getAttribute('data-color')).toBe('#fde047');
  });

  it('renders neon night sparkles when at sunset/night', () => {
    const { container } = render(<OpenWorldParticles settings={{ timeOfDay: 'sunset' }} />);
    const sparkles = container.querySelectorAll('[data-testid="sparkles"]');
    expect(sparkles.length).toBeGreaterThan(1);
  });
});
