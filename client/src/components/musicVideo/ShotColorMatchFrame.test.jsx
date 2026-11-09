import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ShotColorMatchFrame from './ShotColorMatchFrame.jsx';

const matched = {
  cameras: [{ id: 'cam', name: 'Observer', kind: 'observer' }],
};

const scene = {
  sceneId: 'a',
  referenceImageId: 'a.png',
  visualLayer: 'still',
  shotSheet: { cameraId: 'cam', location: 'Lawn', timeOfDay: 'Night' },
  takes: [{
    kind: 'image',
    assetId: 'a.png',
    takeId: 't',
    colorMatch: {
      enabled: true,
      strength: 1,
      correction: { black: 0, white: 1.2, gamma: 1, balanceR: 1, balanceB: 1, saturation: 1 },
    },
  }],
};

describe('ShotColorMatchFrame', () => {
  it('returns the picture unchanged when the shot has no correction', () => {
    const { container } = render(
      <ShotColorMatchFrame project={{}} scene={{ sceneId: 'a' }}>
        <img alt="" src="/still.png" />
      </ShotColorMatchFrame>,
    );
    expect(container.querySelector('div')).toBeNull();
    expect(container.querySelector('img').getAttribute('src')).toBe('/still.png');
  });

  it('applies the correction as an inner filter ahead of the film look', () => {
    const { container } = render(
      <ShotColorMatchFrame project={matched} scene={scene}>
        <img alt="" src="/still.png" />
      </ShotColorMatchFrame>,
    );
    const frame = container.querySelector('div');
    const filter = container.querySelector('filter');
    expect(frame.contains(filter)).toBe(false);
    expect(frame.style.filter).toBe(`url(#${filter.id})`);
    expect(filter.querySelector('feFuncR').getAttribute('exponent')).toBe('1');
    expect(frame.querySelector('img').getAttribute('src')).toBe('/still.png');
  });
});
