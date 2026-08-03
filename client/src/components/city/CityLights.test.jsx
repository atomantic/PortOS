import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

// jsdom has no WebGL context, so the real three.js stack can't mount. `useFrame` is
// stubbed to a no-op — the per-frame intensity maths are irrelevant here; what this file
// covers is which lights get MOUNTED per quality tier (#3397). The r3f primitives
// (<pointLight>, <ambientLight>, …) render as unknown DOM elements, which is exactly what
// makes them countable by tag name.
vi.mock('@react-three/fiber', () => ({ useFrame: () => {} }));
vi.mock('./CityPaletteContext', () => ({ useCityPalette: () => ({ ground: '#22d3ee' }) }));

import CityLights from './CityLights';

const pointLightCount = (settings) => {
  const { container } = render(<CityLights settings={settings} />);
  return container.getElementsByTagName('pointLight').length;
};

describe('CityLights quality-tier culling', () => {
  // Zero-intensity lights still cost a per-fragment iteration in every
  // MeshStandardMaterial's lighting loop, so the low tier has to shed the light
  // by unmounting it — dimming it saves nothing.
  it('drops the two ground-level accent lights on the low tier', () => {
    const full = pointLightCount({ effectiveTier: 'high' });
    expect(pointLightCount({ effectiveTier: 'low' })).toBe(full - 2);
  });

  it('leaves the medium tier and above untouched', () => {
    const high = pointLightCount({ effectiveTier: 'high' });
    expect(pointLightCount({ effectiveTier: 'medium' })).toBe(high);
    expect(pointLightCount({ effectiveTier: 'ultra' })).toBe(high);
  });

  it('keeps every light when no settings are supplied', () => {
    // Legacy/absent payloads fall through cityShowDetail's particleDensity default of 1,
    // so an install that never set effectiveTier keeps the established look.
    expect(pointLightCount(undefined)).toBe(pointLightCount({ effectiveTier: 'high' }));
  });

  it('keeps the key, fill and glow lights on the low tier', () => {
    // The cull is scoped to the two dimmest small-radius accents — the overhead key/fill
    // pair, the broad night glow, the animated side accents and the ambient/hemisphere
    // fill all stay, so the low tier is dimmer in one street corner, not gutted.
    const { container } = render(<CityLights settings={{ effectiveTier: 'low' }} />);
    expect(container.getElementsByTagName('pointLight').length).toBe(9);
    expect(container.getElementsByTagName('ambientLight').length).toBe(1);
    expect(container.getElementsByTagName('hemisphereLight').length).toBe(1);
    expect(container.getElementsByTagName('spotLight').length).toBe(1);
  });
});
